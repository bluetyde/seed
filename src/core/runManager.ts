import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { callAdapter, type AdapterSpec } from "./adapterClient";
import { appendLine, writeFileAtomic } from "./atomicFile";
import { canonicalJson, sha256Hex } from "./canonical";
import { isPortableRelative, resolveInside } from "./paths";
import { checkResultsAgainstRecord, checkResultsIndex } from "./semantic";
import { validate, type TypedError } from "./validate";

export type Budget = {
  maxWallSeconds: number;
  maxCores: number;
  maxMemoryMB: number;
  maxDiskMB: number;
};

export type RunManagerOptions = {
  projectRoot: string;
  runsFolder: string;
  adapter: AdapterSpec & { id: string; version: string };
  now?: () => Date;
  newId?: () => string;
  pollMs?: number;
  callTimeoutMs?: number;
  /** Trusted host records launch intent and the adapter-issued native identity outside project files. */
  onLaunch?: (identity: { requestId: string; runId: string; jobId?: string }) => void;
};

export type StartRequest = {
  requestId: string;
  actor: { kind: "human" | "agent" | "system"; name: string; model?: string; toolVersion?: string };
  artifact: { path: string; revision: { hash: string; counter: number } };
  inputs: { path: string; sha256: string }[];
  settings?: Record<string, unknown>;
  seed?: number;
  budget: Budget;
  studyBudget?: Budget;
  wallLimitMs?: number;
  extensions?: Record<string, unknown>;
};

export type RunOutcome =
  | { ok: true; runId: string; state: string; record: Record<string, unknown>; replayed?: boolean }
  | { ok: false; errors: TypedError[]; runId?: string };

export const TERMINAL_STATES: readonly string[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "terminated-by-trip",
];

export function isLegalTransition(from: string, to: string): boolean {
  if (from === "queued") {
    return to === "running" || to === "failed" || to === "cancelled" || to === "interrupted";
  }
  if (from === "running") {
    return (
      to === "completed" ||
      to === "failed" ||
      to === "cancelled" ||
      to === "terminated-by-trip" ||
      to === "interrupted"
    );
  }
  return false;
}

function assertResolved(res: { ok: true; value: string } | { ok: false; error: unknown }): string {
  if (!res.ok) {
    throw new Error("Path resolution failed");
  }
  return res.value;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True when targetAbs exists and, after resolving symlinks and junctions, lies inside rootAbs. Fails closed. */
function physicallyInside(rootAbs: string, targetAbs: string): boolean {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync.native(rootAbs);
    realTarget = realpathSync.native(targetAbs);
  } catch {
    return false; // cannot prove containment: refuse
  }
  const rel = relative(realRoot, realTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** True when child is the directory parent or lies inside it (lexical, segment boundary, after normalization). */
function lexicallyInside(parentAbs: string, childAbs: string): boolean {
  const rel = relative(parentAbs, childAbs);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

type RequestEntry = { payloadHash: string; runId: string };

function readRequestsMap(
  path: string
): { ok: true; map: Record<string, RequestEntry> } | { ok: false; message: string } {
  if (!existsSync(path)) return { ok: true, map: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, message: "the request log requests.json is unreadable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "the request log requests.json is not an object" };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = value as Record<string, unknown> | null;
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.payloadHash !== "string" ||
      !SHA256_PATTERN.test(e.payloadHash) ||
      typeof e.runId !== "string" ||
      !RUN_ID_PATTERN.test(e.runId)
    ) {
      return { ok: false, message: "the request log requests.json has a malformed entry for " + JSON.stringify(key) };
    }
  }
  return { ok: true, map: parsed as Record<string, RequestEntry> };
}

function internalRefusal(field: string, message: string): RunOutcome {
  return { ok: false, errors: [{ code: "E_INTERNAL", field, message, source: "seed" }] };
}

interface CancelWaiter {
  (result: { ok: true } | { ok: false; errors: TypedError[]; terminal?: boolean }): void;
}

interface InFlightRequest {
  requestId: string;
  payloadHash: string;
  promise: Promise<RunOutcome>;
}

interface InFlightRun {
  runId: string;
  requestId: string;
  cancelRequested: boolean;
  cancelWaiters: CancelWaiter[];
  promise: Promise<RunOutcome>;
}

function computePayloadHash(req: StartRequest): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (k !== "wallLimitMs" && v !== undefined) {
      clean[k] = v;
    }
  }
  const sanitized = JSON.parse(JSON.stringify(clean));
  return sha256Hex(canonicalJson(sanitized));
}

function updateRequestsFile(
  requestsJsonPath: string,
  requestId: string,
  entry: { payloadHash: string; runId: string }
): void {
  const read = readRequestsMap(requestsJsonPath);
  if (!read.ok) {
    // start() refuses before reaching this point; never overwrite a file we cannot trust.
    throw new Error(read.message);
  }
  const map = read.map;
  // defineProperty: a plain assignment to the key "__proto__" would change the prototype instead of storing the entry
  Object.defineProperty(map, requestId, { value: entry, enumerable: true, writable: true, configurable: true });
  writeFileAtomic(requestsJsonPath, JSON.stringify(map, null, 2) + "\n");
}

export class RunManager {
  private readonly projectRoot: string;
  private readonly runsFolder: string;
  private readonly adapter: AdapterSpec & { id: string; version: string };
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly pollMs: number;
  private readonly callTimeoutMs: number;
  private readonly onLaunch?: RunManagerOptions["onLaunch"];

  private inFlightByRequestId = new Map<string, InFlightRequest>();
  private inFlightRuns = new Map<string, InFlightRun>();

  constructor(opts: RunManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.runsFolder = opts.runsFolder;
    this.adapter = opts.adapter;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomBytes(6).toString("hex"));
    this.pollMs = opts.pollMs ?? 200;
    this.callTimeoutMs = opts.callTimeoutMs ?? 15000;
    this.onLaunch = opts.onLaunch;
  }

  public transition(runId: string, to: string, reason: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error("Invalid run id");
    }
    const runRelDir = `${this.runsFolder}/${runId}`;
    const runAbsDir = assertResolved(resolveInside(this.projectRoot, runRelDir));
    const recPath = join(runAbsDir, "run-record.json");
    if (!existsSync(recPath)) {
      throw new Error(`Run record not found for ${runId}`);
    }
    const record = JSON.parse(readFileSync(recPath, "utf8")) as Record<string, unknown>;
    const from = record.state as string;
    if (!isLegalTransition(from, to)) {
      throw new Error(`Illegal state transition from "${from}" to "${to}"`);
    }
    appendLine(
      join(runAbsDir, "log", "transitions.jsonl"),
      JSON.stringify({
        time: this.now().toISOString(),
        from,
        to,
        reason,
      })
    );
    record.state = to;
    if (TERMINAL_STATES.includes(to)) {
      record.finishedAt = this.now().toISOString();
    }
    const v = validate("run-record", record);
    if (!v.ok) {
      throw new Error("run-record became invalid after transition: " + v.errors.map((e) => e.message).join(", "));
    }
    writeFileAtomic(recPath, JSON.stringify(record, null, 2) + "\n");
  }

  async start(req: StartRequest): Promise<RunOutcome> {
    // 1. Request validation
    if (req.artifact && typeof req.artifact.path === "string") {
      const artPathRes = isPortableRelative(req.artifact.path);
      if (!artPathRes.ok) {
        return {
          ok: false,
          errors: [
            {
              code: artPathRes.error.code,
              field: "/artifact/path",
              message: artPathRes.error.message,
              source: "seed",
            },
          ],
        };
      }
    }

    if (Array.isArray(req.inputs)) {
      for (let i = 0; i < req.inputs.length; i++) {
        const inp = req.inputs[i];
        if (inp && typeof inp.path === "string") {
          const pRes = isPortableRelative(inp.path);
          if (!pRes.ok) {
            return {
              ok: false,
              errors: [
                {
                  code: pRes.error.code,
                  field: `/inputs/${i}/path`,
                  message: pRes.error.message,
                  source: "seed",
                },
              ],
            };
          }
        }
      }
    }

    const candidateRunReq = {
      schema: "seed.adapter-request/0.1",
      verb: "run",
      requestId: req.requestId,
      actor: req.actor,
      snapshot: {
        inputs: req.inputs,
      },
      runDir: `${this.runsFolder}/r-placeholder`,
      budget: req.budget,
      ...(req.settings !== undefined ? { settings: req.settings } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
    };
    const valCandidate = validate("adapter-request", candidateRunReq);
    if (!valCandidate.ok) {
      return { ok: false, errors: valCandidate.errors };
    }

    // 2. Budget gate
    if (req.studyBudget) {
      const budgetKeys: (keyof Budget)[] = ["maxWallSeconds", "maxCores", "maxMemoryMB", "maxDiskMB"];
      const offending: string[] = [];
      const errors: TypedError[] = [];
      for (const k of budgetKeys) {
        if (typeof req.budget[k] === "number" && typeof req.studyBudget[k] === "number") {
          if (req.budget[k] > req.studyBudget[k]) {
            offending.push(k);
            errors.push({
              code: "E_BUDGET_EXCEEDED",
              field: `/budget/${k}`,
              message: `budget.${k} (${req.budget[k]}) exceeds study budget (${req.studyBudget[k]})`,
              source: "seed",
            });
          }
        }
      }
      if (offending.length > 0) {
        const runsDir = join(this.projectRoot, this.runsFolder);
        mkdirSync(runsDir, { recursive: true });
        const gateStopsPath = join(runsDir, "gate-stops.jsonl");
        const gateStopLine = JSON.stringify({
          time: this.now().toISOString(),
          requestId: req.requestId,
          actor: req.actor,
          rule: "budget",
          fields: offending,
        });
        appendLine(gateStopsPath, gateStopLine);
        return { ok: false, errors };
      }
    }

    // 3. Idempotency check
    const payloadHash = computePayloadHash(req);

    // Check if in flight in this manager
    const inFlightReq = this.inFlightByRequestId.get(req.requestId);
    if (inFlightReq) {
      if (inFlightReq.payloadHash !== payloadHash) {
        return {
          ok: false,
          errors: [
            {
              code: "E_REQUEST_CONFLICT",
              field: "/requestId",
              message: `Request conflict for requestId ${req.requestId}`,
              source: "seed",
            },
          ],
        };
      }
      const outcome = await inFlightReq.promise;
      if (outcome.ok) {
        return { ...outcome, replayed: true };
      }
      return outcome;
    }

    // Check requests.json on disk
    const runsDir = join(this.projectRoot, this.runsFolder);
    mkdirSync(runsDir, { recursive: true });
    if (!physicallyInside(this.projectRoot, runsDir)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_PATH_TRAVERSAL",
            field: "/runsFolder",
            message: "the runs folder resolves outside the project (symlink or junction)",
            source: "seed",
          },
        ],
      };
    }
    const requestsJsonPath = join(runsDir, "requests.json");
    // Idempotency memory that cannot be trusted must stop the run: starting anyway could duplicate it and would
    // overwrite the evidence.
    const requestsRead = readRequestsMap(requestsJsonPath);
    if (!requestsRead.ok) {
      return internalRefusal("/requests", requestsRead.message + "; refusing to start a run");
    }
    const requestsMap = requestsRead.map;

    const existingEntry = Object.hasOwn(requestsMap, req.requestId) ? requestsMap[req.requestId] : undefined;
    if (existingEntry) {
      if (existingEntry.payloadHash !== payloadHash) {
        return {
          ok: false,
          errors: [
            {
              code: "E_REQUEST_CONFLICT",
              field: "/requestId",
              message: `Request conflict for requestId ${req.requestId}`,
              source: "seed",
            },
          ],
        };
      }
      const inFlightRun = this.inFlightRuns.get(existingEntry.runId);
      if (inFlightRun) {
        const outcome = await inFlightRun.promise;
        if (outcome.ok) {
          return { ...outcome, replayed: true };
        }
        return outcome;
      }
      const recPath = join(runsDir, existingEntry.runId, "run-record.json");
      if (!existsSync(recPath)) {
        return internalRefusal(
          "/requests",
          "the request log refers to run " + existingEntry.runId + " whose record is missing; use a new requestId or recover the run"
        );
      }
      let replayed: Record<string, unknown>;
      try {
        replayed = JSON.parse(readFileSync(recPath, "utf8")) as Record<string, unknown>;
      } catch {
        return internalRefusal("/requests", "the record of run " + existingEntry.runId + " is unreadable");
      }
      const replayCheck = validate("run-record", replayed);
      if (!replayCheck.ok || replayed.runId !== existingEntry.runId) {
        return internalRefusal("/requests", "the record of run " + existingEntry.runId + " is invalid");
      }
      return {
        ok: true,
        runId: existingEntry.runId,
        state: replayed.state as string,
        record: replayed,
        replayed: true,
      };
    }

    // Reserve the request id on disk before any asynchronous work, so two managers on one project cannot both start it.
    const reservation = join(runsDir, ".reserve-" + sha256Hex(req.requestId).slice(0, 24));
    try {
      mkdirSync(reservation);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          ok: false,
          errors: [
            {
              code: "E_REQUEST_CONFLICT",
              field: "/requestId",
              message: "this requestId is being processed by another manager or a previous start was interrupted; use a new requestId or run recover()",
              source: "seed",
            },
          ],
        };
      }
      throw err;
    }

    // Register in flight promise for this requestId
    let resolveRun!: (outcome: RunOutcome) => void;
    const runPromise = new Promise<RunOutcome>((resolve) => {
      resolveRun = resolve;
    });

    this.inFlightByRequestId.set(req.requestId, {
      requestId: req.requestId,
      payloadHash,
      promise: runPromise,
    });

    try {
      const outcome = await this.executeRun(req, payloadHash, runPromise, requestsJsonPath, requestsMap);
      resolveRun(outcome);
      return outcome;
    } catch (err) {
      const errOutcome: RunOutcome = {
        ok: false,
        errors: [
          {
            code: "E_INTERNAL",
            field: "",
            message: err instanceof Error ? err.message : String(err),
            source: "seed",
          },
        ],
      };
      resolveRun(errOutcome);
      return errOutcome;
    } finally {
      this.inFlightByRequestId.delete(req.requestId);
      rmSync(reservation, { recursive: true, force: true });
    }
  }

  private async executeRun(
    req: StartRequest,
    payloadHash: string,
    runPromise: Promise<RunOutcome>,
    requestsJsonPath: string,
    requestsMap: Record<string, { payloadHash: string; runId: string }>
  ): Promise<RunOutcome> {
    // 4. Snapshot hashing
    for (let i = 0; i < req.inputs.length; i++) {
      const input = req.inputs[i]!;
      const resInside = resolveInside(this.projectRoot, input.path);
      if (!resInside.ok) {
        return {
          ok: false,
          errors: [
            {
              code: resInside.error.code,
              field: `/inputs/${i}/path`,
              message: resInside.error.message,
              source: "seed",
            },
          ],
        };
      }
      const inputAbs = resInside.value;
      if (existsSync(inputAbs) && !physicallyInside(this.projectRoot, inputAbs)) {
        return {
          ok: false,
          errors: [
            {
              code: "E_PATH_TRAVERSAL",
              field: `/inputs/${i}/path`,
              message: "input resolves outside the project (symlink or junction)",
              source: "seed",
            },
          ],
        };
      }
      if (!existsSync(inputAbs)) {
        return {
          ok: false,
          errors: [
            {
              code: "E_PROP_MISSING",
              field: `/inputs/${i}/path`,
              message: `Input file does not exist: ${input.path}`,
              source: "seed",
            },
          ],
        };
      }
      const fileBytes = readFileSync(inputAbs);
      const actualHash = sha256Hex(fileBytes);
      if (actualHash !== input.sha256) {
        return {
          ok: false,
          errors: [
            {
              code: "E_STALE_REVISION",
              field: `/inputs/${i}/sha256`,
              message: `Input sha256 mismatch: declared ${input.sha256}, actual ${actualHash}`,
              source: "seed",
            },
          ],
        };
      }
    }

    // 5. Validate verb
    const valReq = {
      schema: "seed.adapter-request/0.1",
      verb: "validate",
      requestId: req.requestId,
      actor: req.actor,
      artifact: req.artifact,
      operation: "run",
      ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
    };
    const valOutcome = await callAdapter(this.adapter, valReq, {
      projectRoot: this.projectRoot,
      timeoutMs: this.callTimeoutMs,
    });
    if (!valOutcome.ok) {
      return { ok: false, errors: valOutcome.errors };
    }
    const valReply = valOutcome.reply as Record<string, unknown>;
    if (!valReply.ok) {
      return { ok: false, errors: valReply.errors as TypedError[] };
    }
    const valResult = valReply.result as { valid: boolean; problems?: TypedError[] };
    if (valResult.valid === false) {
      const eProblems = (valResult.problems ?? []).filter((p) => p.code.startsWith("E_"));
      return { ok: false, errors: eProblems };
    }

    // 6. Create the run
    const runId = "r-" + this.newId();
    const runRelDir = `${this.runsFolder}/${runId}`;
    const runAbsDir = assertResolved(resolveInside(this.projectRoot, runRelDir));

    mkdirSync(join(runAbsDir, "inputs"), { recursive: true });
    mkdirSync(join(runAbsDir, "native"), { recursive: true });
    mkdirSync(join(runAbsDir, "log"), { recursive: true });

    let copyMismatch = false;
    let mismatchIndex = 0;
    for (let i = 0; i < req.inputs.length; i++) {
      const input = req.inputs[i]!;
      const src = assertResolved(resolveInside(this.projectRoot, input.path));
      const dest = assertResolved(resolveInside(runAbsDir, `inputs/${input.path}`));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      const copyHash = sha256Hex(readFileSync(dest));
      if (copyHash !== input.sha256) {
        copyMismatch = true;
        mismatchIndex = i;
        break;
      }
    }

    const declaredInputs = req.inputs.map((i) => ({ path: i.path, sha256: i.sha256 }));
    const cacheKey = sha256Hex(
      canonicalJson({
        adapter: { id: this.adapter.id, version: this.adapter.version },
        inputs: declaredInputs,
        seed: req.seed ?? null,
        settings: req.settings ?? {},
      })
    );

    const record: Record<string, unknown> = {
      schema: "seed.run-record/0.1",
      runId,
      attempt: 1,
      adapter: { id: this.adapter.id, version: this.adapter.version },
      state: "queued",
      inputs: declaredInputs,
      settings: req.settings ?? {},
      budget: req.budget,
      createdAt: this.now().toISOString(),
      cacheKey,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
    };

    if (copyMismatch) {
      const copyErr: TypedError[] = [
        {
          code: "E_STALE_REVISION",
          field: `/inputs/${mismatchIndex}/sha256`,
          message: "Source input changed during copy",
          source: "seed",
        },
      ];
      writeFileAtomic(join(runAbsDir, "log", "errors.json"), JSON.stringify(copyErr, null, 2) + "\n");
      appendLine(
        join(runAbsDir, "log", "transitions.jsonl"),
        JSON.stringify({
          time: this.now().toISOString(),
          from: "queued",
          to: "failed",
          reason: "stale revision during copy",
        })
      );
      record.state = "failed";
      record.finishedAt = this.now().toISOString();
      const v = validate("run-record", record);
      if (!v.ok) {
        return {
          ok: false,
          errors: [
            {
              code: "E_INTERNAL",
              field: "",
              message: "run-record failed schema validation: " + v.errors.map((e) => e.message).join(", "),
              source: "seed",
            },
          ],
        };
      }
      writeFileAtomic(join(runAbsDir, "run-record.json"), JSON.stringify(record, null, 2) + "\n");
      updateRequestsFile(requestsJsonPath, req.requestId, { payloadHash, runId });
      return { ok: true, runId, state: "failed", record };
    }

    const vRec = validate("run-record", record);
    if (!vRec.ok) {
      return {
        ok: false,
        errors: [
          {
            code: "E_INTERNAL",
            field: "",
            message: "run-record failed schema validation: " + vRec.errors.map((e) => e.message).join(", "),
            source: "seed",
          },
        ],
      };
    }

    writeFileAtomic(join(runAbsDir, "run-record.json"), JSON.stringify(record, null, 2) + "\n");
    updateRequestsFile(requestsJsonPath, req.requestId, { payloadHash, runId });

    const inFlightRun: InFlightRun = {
      runId,
      requestId: req.requestId,
      cancelRequested: false,
      cancelWaiters: [],
      promise: runPromise,
    };
    this.inFlightRuns.set(runId, inFlightRun);

    const transition = (to: string, reason: string): void => {
      const from = record.state as string;
      if (!isLegalTransition(from, to)) {
        throw new Error(`Illegal state transition from "${from}" to "${to}"`);
      }
      appendLine(
        join(runAbsDir, "log", "transitions.jsonl"),
        JSON.stringify({
          time: this.now().toISOString(),
          from,
          to,
          reason,
        })
      );
      record.state = to;
      if (TERMINAL_STATES.includes(to)) {
        record.finishedAt = this.now().toISOString();
      }
      const v = validate("run-record", record);
      if (!v.ok) {
        throw new Error("run-record became invalid after transition: " + v.errors.map((e) => e.message).join(", "));
      }
      writeFileAtomic(join(runAbsDir, "run-record.json"), JSON.stringify(record, null, 2) + "\n");
    };

    try {
      // Check if cancellation was requested before start
      if (inFlightRun.cancelRequested) {
        record.native = { status: "cancelled" };
        transition("cancelled", "cancelled before job started");
        this.settleCancel(inFlightRun, { ok: true });
        return { ok: true, runId, state: "cancelled", record };
      }

      // 7. Run verb
      const runReq = {
        schema: "seed.adapter-request/0.1",
        verb: "run",
        requestId: req.requestId,
        actor: req.actor,
        snapshot: {
          inputs: declaredInputs,
        },
        runDir: runRelDir,
        budget: req.budget,
        ...(req.settings !== undefined ? { settings: req.settings } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
      };

      this.onLaunch?.({ requestId: req.requestId, runId });
      const runOutcome = await callAdapter(this.adapter, runReq, {
        projectRoot: this.projectRoot,
        timeoutMs: this.callTimeoutMs,
      });

      if (!runOutcome.ok || !(runOutcome.reply as Record<string, unknown>).ok) {
        const errs: TypedError[] = !runOutcome.ok
          ? runOutcome.errors
          : ((runOutcome.reply as Record<string, unknown>).errors as TypedError[]) ?? [];
        const firstCode = errs[0]?.code ?? "unknown";
        record.native = { status: "adapter-error", detail: firstCode };
        writeFileAtomic(join(runAbsDir, "log", "errors.json"), JSON.stringify(errs, null, 2) + "\n");
        transition("failed", "adapter run failed");
        return { ok: true, runId, state: "failed", record };
      }

      const runReply = runOutcome.reply as Record<string, unknown>;
      const runResult = runReply.result as { jobId: string; runDir: string; lifecycle: string };

      record.jobId = runResult.jobId;
      record.startedAt = this.now().toISOString();
      transition("running", "adapter started job");
      this.onLaunch?.({ requestId: req.requestId, runId, jobId: runResult.jobId });

      // 8. Poll loop
      const startTime = performance.now();
      const wallLimitMs = req.wallLimitMs ?? req.budget.maxWallSeconds * 1000;
      let consecutiveStatusFailures = 0;

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));

        // Timeout check
        const elapsed = performance.now() - startTime;
        if (elapsed >= wallLimitMs) {
          const stop = await this.requestCancel(req, record.jobId as string);
          const timeoutErrors: TypedError[] = [
            {
              code: "E_TIMEOUT",
              field: "",
              message: `Run timed out after ${elapsed.toFixed(0)} ms`,
              source: "seed",
            },
          ];
          if (!stop.confirmed) {
            timeoutErrors.push(...stop.errors);
          }
          writeFileAtomic(join(runAbsDir, "log", "errors.json"), JSON.stringify(timeoutErrors, null, 2) + "\n");
          record.native = stop.confirmed ? { status: "timeout" } : { status: "timeout", detail: "the job could not be confirmed stopped and may still be running" };
          this.settleCancel(inFlightRun, { ok: false, terminal: true, errors: [{ code: "E_TIMEOUT", field: "", message: "run ended by the wall-clock limit", source: "seed" }] });
          transition("failed", "timeout");
          return { ok: true, runId, state: "failed", record };
        }

        // Cancel requested check
        if (inFlightRun.cancelRequested) {
          const stop = await this.requestCancel(req, record.jobId as string);
          if (stop.confirmed) {
            record.native = { status: "cancelled" };
            transition("cancelled", "cancelled by user");
            this.settleCancel(inFlightRun, { ok: true });
            return { ok: true, runId, state: "cancelled", record };
          }
          if (stop.terminal === "completed") {
            this.settleCancel(inFlightRun, { ok: true });
            return await this.collectAndFinalize(record, runAbsDir, runRelDir, req, transition);
          }
          if (stop.terminal !== undefined) {
            transition(stop.terminal, `job finished with ${stop.terminal}`);
            this.settleCancel(inFlightRun, { ok: true });
            return { ok: true, runId, state: stop.terminal, record };
          }
          // Not confirmed: the job may still be running. Keep watching it and tell the caller.
          inFlightRun.cancelRequested = false;
          this.settleCancel(inFlightRun, { ok: false, errors: stop.errors });
        }

        // Status call
        const statusOutcome = await callAdapter(
          this.adapter,
          {
            schema: "seed.adapter-request/0.1",
            verb: "status",
            requestId: `status-${this.newId()}`,
            actor: req.actor,
            jobId: record.jobId,
            ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
          },
          { projectRoot: this.projectRoot, timeoutMs: this.callTimeoutMs }
        );

        if (!statusOutcome.ok || !(statusOutcome.reply as Record<string, unknown>).ok) {
          consecutiveStatusFailures++;
          if (consecutiveStatusFailures >= 3) {
            const stop = await this.requestCancel(req, record.jobId as string);
            const appFailedErrors: TypedError[] = [
              {
                code: "E_APP_FAILED",
                field: "",
                message: "Status call failed 3 consecutive times",
                source: "seed",
              },
            ];
            if (!stop.confirmed) {
              appFailedErrors.push(...stop.errors);
            }
            writeFileAtomic(join(runAbsDir, "log", "errors.json"), JSON.stringify(appFailedErrors, null, 2) + "\n");
            record.native = { status: "status-unavailable" };
            transition("failed", "status unavailable");
            return { ok: true, runId, state: "failed", record };
          }
          continue;
        }

        consecutiveStatusFailures = 0;
        const statusReply = statusOutcome.reply as Record<string, unknown>;
        const statusResult = statusReply.result as {
          jobId: string;
          lifecycle: string;
          native: { status: string; detail?: string };
          startedAt?: string;
          finishedAt?: string;
        };

        let nativeChanged = false;
        const curNative = record.native as { status: string; detail?: string } | undefined;
        if (!curNative || curNative.status !== statusResult.native.status || curNative.detail !== statusResult.native.detail) {
          record.native = {
            status: statusResult.native.status,
            ...(statusResult.native.detail ? { detail: statusResult.native.detail } : {}),
          };
          nativeChanged = true;
        }
        if (statusResult.startedAt && !record.startedAt) {
          record.startedAt = statusResult.startedAt;
          nativeChanged = true;
        }

        if (nativeChanged && record.state === "running") {
          const v = validate("run-record", record);
          if (v.ok) {
            writeFileAtomic(join(runAbsDir, "run-record.json"), JSON.stringify(record, null, 2) + "\n");
          }
        }

        const lc = statusResult.lifecycle;
        if (lc === "running" || lc === "queued") {
          continue;
        }

        if (lc === "completed") {
          return await this.collectAndFinalize(record, runAbsDir, runRelDir, req, transition);
        }

        if (lc === "failed") {
          transition("failed", "adapter reported failed");
          return { ok: true, runId, state: "failed", record };
        }

        if (lc === "terminated-by-trip") {
          transition("terminated-by-trip", "adapter reported trip");
          return { ok: true, runId, state: "terminated-by-trip", record };
        }

        if (lc === "cancelled") {
          transition("cancelled", "adapter reported cancelled");
          return { ok: true, runId, state: "cancelled", record };
        }

        if (lc === "interrupted") {
          transition("interrupted", "adapter reported interrupted");
          return { ok: true, runId, state: "interrupted", record };
        }
      }
    } finally {
      this.settleCancel(inFlightRun, { ok: true });
      this.inFlightRuns.delete(runId);
    }
  }

  /** Resolves every pending cancel() call with the outcome of the cancel attempt. */
  private settleCancel(run: InFlightRun, result: { ok: true } | { ok: false; errors: TypedError[]; terminal?: boolean }): void {
    const waiters = run.cancelWaiters.splice(0);
    for (const w of waiters) w(result);
  }

  /**
   * Asks the adapter to stop a job. `confirmed` is true only when the adapter affirms it; `terminal` is set when the job
   * had already reached a final lifecycle; otherwise the stop is NOT confirmed and `errors` says why.
   */
  private async requestCancel(
    req: StartRequest,
    jobId: string
  ): Promise<{ confirmed: true } | { confirmed: false; terminal?: string; errors: TypedError[] }> {
    const outcome = await callAdapter(
      this.adapter,
      {
        schema: "seed.adapter-request/0.1",
        verb: "cancel",
        requestId: `cancel-${this.newId()}`,
        actor: req.actor,
        jobId,
        ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
      },
      { projectRoot: this.projectRoot, timeoutMs: this.callTimeoutMs }
    );
    if (!outcome.ok) {
      return { confirmed: false, errors: outcome.errors };
    }
    const reply = outcome.reply as Record<string, unknown>;
    if (!reply.ok) {
      return { confirmed: false, errors: reply.errors as TypedError[] };
    }
    const result = reply.result as { lifecycle: string; cancelled: boolean };
    if (result.cancelled === true) {
      return { confirmed: true };
    }
    if (TERMINAL_STATES.includes(result.lifecycle)) {
      return { confirmed: false, terminal: result.lifecycle, errors: [] };
    }
    return {
      confirmed: false,
      errors: [
        {
          code: "E_APP_FAILED",
          field: "",
          message: "the adapter did not confirm that the job was stopped; it may still be running",
          source: "seed",
        },
      ],
    };
  }

  private async collectAndFinalize(
    record: Record<string, unknown>,
    runAbsDir: string,
    runRelDir: string,
    req: StartRequest,
    transition: (to: string, reason: string) => void
  ): Promise<RunOutcome> {
    const runId = record.runId as string;
    const collectReq = {
      schema: "seed.adapter-request/0.1",
      verb: "collect",
      requestId: `collect-${this.newId()}`,
      actor: req.actor,
      jobId: record.jobId,
      runDir: runRelDir,
      ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
    };

    const collectOutcome = await callAdapter(this.adapter, collectReq, {
      projectRoot: this.projectRoot,
      timeoutMs: this.callTimeoutMs,
    });

    const markCollectFailed = (errors: TypedError[], reason: string): RunOutcome => {
      writeFileAtomic(join(runAbsDir, "log", "errors.json"), JSON.stringify(errors, null, 2) + "\n");
      delete record.outputs;
      transition("failed", reason);
      return { ok: true, runId, state: "failed", record };
    };

    if (!collectOutcome.ok || !(collectOutcome.reply as Record<string, unknown>).ok) {
      const errs: TypedError[] = !collectOutcome.ok
        ? collectOutcome.errors
        : ((collectOutcome.reply as Record<string, unknown>).errors as TypedError[]) ?? [];
      return markCollectFailed(errs, "adapter collect failed");
    }

    const collectReply = collectOutcome.reply as Record<string, unknown>;
    const collectResult = collectReply.result as {
      jobId: string;
      lifecycle: string;
      resultsIndex: string;
      resultsSha256: string;
    };

    const resolvedIndex = resolveInside(this.projectRoot, collectResult.resultsIndex);
    if (resolvedIndex.ok && !this.insideRun(runAbsDir, resolvedIndex.value)) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/resultsIndex",
            message: "resultsIndex is not inside this run's directory",
            source: "seed",
          },
        ],
        "resultsIndex outside the run directory"
      );
    }
    if (!resolvedIndex.ok) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/resultsIndex",
            message: resolvedIndex.error.message,
            source: "seed",
          },
        ],
        "resultsIndex path invalid"
      );
    }

    if (!existsSync(resolvedIndex.value)) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/resultsIndex",
            message: "resultsIndex file not found",
            source: "seed",
          },
        ],
        "resultsIndex file not found"
      );
    }

    const indexBytes = readFileSync(resolvedIndex.value);
    const actualIndexSha = sha256Hex(indexBytes);
    if (actualIndexSha !== collectResult.resultsSha256) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/resultsIndex",
            message: `resultsSha256 mismatch: declared ${collectResult.resultsSha256}, actual ${actualIndexSha}`,
            source: "seed",
          },
        ],
        "resultsSha256 mismatch"
      );
    }

    let indexDoc: Record<string, unknown>;
    try {
      indexDoc = JSON.parse(indexBytes.toString("utf8"));
    } catch {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/resultsIndex",
            message: "resultsIndex is not valid JSON",
            source: "seed",
          },
        ],
        "resultsIndex json parse error"
      );
    }

    const vIdx = validate("results-index", indexDoc);
    if (!vIdx.ok) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: vIdx.errors[0]?.field || "/resultsIndex",
            message: `results-index schema validation failed: ${vIdx.errors[0]?.message}`,
            source: "seed",
          },
        ],
        "resultsIndex schema error"
      );
    }

    const semanticErrs = checkResultsIndex(indexDoc);
    if (semanticErrs.length > 0) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: semanticErrs[0]?.field || "/resultsIndex",
            message: `results-index semantic check failed: ${semanticErrs[0]?.message}`,
            source: "seed",
          },
        ],
        "resultsIndex semantic error"
      );
    }

    if (indexDoc.runId !== runId) {
      return markCollectFailed(
        [
          {
            code: "E_OUTPUT_INCOMPLETE",
            field: "/runId",
            message: `results-index runId ${indexDoc.runId} does not match runId ${runId}`,
            source: "seed",
          },
        ],
        "runId mismatch in resultsIndex"
      );
    }

    // The results must belong to THIS snapshot: same inputs, and every quantity derived from them.
    const provenanceErrors = checkResultsAgainstRecord(indexDoc, record);
    if (provenanceErrors.length > 0) {
      return markCollectFailed(
        provenanceErrors.map((e) => ({ ...e, code: "E_OUTPUT_INCOMPLETE" })),
        "results do not belong to the run snapshot"
      );
    }

    const quantities = (indexDoc.quantities as Array<{ data?: { path?: string; sha256?: string } }>) ?? [];
    const outputsMap = new Map<string, string>();
    outputsMap.set(collectResult.resultsIndex, collectResult.resultsSha256);

    for (let i = 0; i < quantities.length; i++) {
      const q = quantities[i]!;
      if (!q.data || typeof q.data.path !== "string" || typeof q.data.sha256 !== "string") {
        return markCollectFailed(
          [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/quantities/${i}/data`,
              message: "Missing quantity data path or sha256",
              source: "seed",
            },
          ],
          "quantity data incomplete"
        );
      }

      const resolvedData = resolveInside(this.projectRoot, q.data.path);
      if (!resolvedData.ok) {
        return markCollectFailed(
          [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/quantities/${i}/data/path`,
              message: resolvedData.error.message,
              source: "seed",
            },
          ],
          "quantity data path invalid"
        );
      }

      if (!this.insideRun(runAbsDir, resolvedData.value)) {
        return markCollectFailed(
          [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/quantities/${i}/data/path`,
              message: "quantity data is not inside this run's directory",
              source: "seed",
            },
          ],
          "quantity data outside the run directory"
        );
      }

      if (!existsSync(resolvedData.value)) {
        return markCollectFailed(
          [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/quantities/${i}/data/path`,
              message: `Data file not found: ${q.data.path}`,
              source: "seed",
            },
          ],
          "quantity data file not found"
        );
      }

      const dataBytes = readFileSync(resolvedData.value);
      const actualDataSha = sha256Hex(dataBytes);
      if (actualDataSha !== q.data.sha256) {
        return markCollectFailed(
          [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/quantities/${i}/data/sha256`,
              message: `Quantity data sha256 mismatch: declared ${q.data.sha256}, actual ${actualDataSha}`,
              source: "seed",
            },
          ],
          "quantity data sha256 mismatch"
        );
      }

      outputsMap.set(q.data.path, q.data.sha256);
    }

    const outputs = Array.from(outputsMap.entries()).map(([path, sha256]) => ({ path, sha256 }));
    record.outputs = outputs;
    transition("completed", "collected all valid outputs");
    return { ok: true, runId, state: "completed", record };
  }

  /** An output path must lie inside the run's own directory, lexically and after resolving symlinks. */
  private insideRun(runAbsDir: string, candidateAbs: string): boolean {
    if (!lexicallyInside(runAbsDir, candidateAbs)) return false;
    // A path that does not exist yet is judged by the caller's existence check; containment of existing files is physical.
    return !existsSync(candidateAbs) || physicallyInside(runAbsDir, candidateAbs);
  }

  /** Owner-only routing: transports never select a native job or process ID. */
  hasActiveRequest(requestId: string): boolean { return [...this.inFlightRuns.values()].some(r => r.requestId === requestId); }

  cancelRequest(requestId: string): Promise<RunOutcome> | undefined {
    const run = [...this.inFlightRuns.values()].find(r => r.requestId === requestId);
    return run ? this.cancel(run.runId) : undefined;
  }

  async cancel(runId: string): Promise<RunOutcome> {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      return {
        ok: false,
        errors: [{ code: "E_PROP_MISSING", field: "/runId", message: "Unknown runId", source: "seed" }],
      };
    }
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) {
      const attempt = new Promise<{ ok: true } | { ok: false; errors: TypedError[]; terminal?: boolean }>((resolve) => {
        inFlight.cancelWaiters.push(resolve);
      });
      inFlight.cancelRequested = true;
      const result = await attempt;
      if (!result.ok && !result.terminal) {
        return { ok: false, errors: result.errors, runId };
      }
      return await inFlight.promise;
    }

    const runRelDir = `${this.runsFolder}/${runId}`;
    const runAbsDirRes = resolveInside(this.projectRoot, runRelDir);
    if (!runAbsDirRes.ok) {
      return {
        ok: false,
        errors: [
          {
            code: "E_PROP_MISSING",
            field: "/runId",
            message: `Unknown runId: ${runId}`,
            source: "seed",
          },
        ],
      };
    }

    const runAbsDir = runAbsDirRes.value;
    const recordPath = join(runAbsDir, "run-record.json");

    if (!existsSync(recordPath)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_PROP_MISSING",
            field: "/runId",
            message: `Unknown runId: ${runId}`,
            source: "seed",
          },
        ],
      };
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: "E_PROP_MISSING",
            field: "/runId",
            message: `Cannot read run-record for ${runId}`,
            source: "seed",
          },
        ],
      };
    }

    if (record.runId !== runId) {
      return {
        ok: false,
        errors: [{ code: "E_INTERNAL", field: "/runId", message: "the record does not belong to this run id", source: "seed" }],
      };
    }
    const curState = record.state as string;
    if (TERMINAL_STATES.includes(curState)) {
      return { ok: true, runId, state: curState, record };
    }

    if (record.jobId && typeof record.jobId === "string") {
      const cancelOutcome = await callAdapter(
        this.adapter,
        {
          schema: "seed.adapter-request/0.1",
          verb: "cancel",
          requestId: `cancel-${this.newId()}`,
          actor: { kind: "system", name: "seed-cancel" },
          jobId: record.jobId,
        },
        { projectRoot: this.projectRoot, timeoutMs: this.callTimeoutMs }
      );

      if (!cancelOutcome.ok) {
        return { ok: false, errors: cancelOutcome.errors };
      }

      const cancelReply = cancelOutcome.reply as Record<string, unknown>;
      if (!cancelReply.ok) {
        return { ok: false, errors: cancelReply.errors as TypedError[] };
      }

      const cancelResult = cancelReply.result as { jobId: string; lifecycle: string; cancelled: boolean };
      if (cancelResult.cancelled) {
        if (!isLegalTransition(curState, "cancelled")) {
          throw new Error(`Illegal state transition from "${curState}" to "cancelled"`);
        }
        appendLine(
          join(runAbsDir, "log", "transitions.jsonl"),
          JSON.stringify({
            time: this.now().toISOString(),
            from: curState,
            to: "cancelled",
            reason: "cancelled via external cancel",
          })
        );
        record.state = "cancelled";
        record.native = { status: "cancelled" };
        record.finishedAt = this.now().toISOString();
        const v = validate("run-record", record);
        if (!v.ok) {
          throw new Error("run-record became invalid after cancel: " + v.errors.map((e) => e.message).join(", "));
        }
        writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
        return { ok: true, runId, state: "cancelled", record };
      } else if (TERMINAL_STATES.includes(cancelResult.lifecycle)) {
        return { ok: true, runId, state: curState, record };
      } else {
        return {
          ok: false,
          runId,
          errors: [
            {
              code: "E_APP_FAILED",
              field: "",
              message: "the adapter did not confirm that the job was stopped; it may still be running",
              source: "seed",
            },
          ],
        };
      }
    } else {
      if (!isLegalTransition(curState, "cancelled")) {
        throw new Error(`Illegal state transition from "${curState}" to "cancelled"`);
      }
      appendLine(
        join(runAbsDir, "log", "transitions.jsonl"),
        JSON.stringify({
          time: this.now().toISOString(),
          from: curState,
          to: "cancelled",
          reason: "cancelled before start",
        })
      );
      record.state = "cancelled";
      record.native = { status: "cancelled" };
      record.finishedAt = this.now().toISOString();
      const v = validate("run-record", record);
      if (!v.ok) {
        throw new Error("run-record became invalid after cancel: " + v.errors.map((e) => e.message).join(", "));
      }
      writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
      return { ok: true, runId, state: "cancelled", record };
    }
  }

  async recover(): Promise<{ runId: string; from: string; to: string }[]> {
    const runsDirRes = resolveInside(this.projectRoot, this.runsFolder);
    if (!runsDirRes.ok) {
      return [];
    }
    const runsDir = runsDirRes.value;
    if (!existsSync(runsDir)) {
      return [];
    }

    const entries = readdirSync(runsDir, { withFileTypes: true });
    const results: { runId: string; from: string; to: string }[] = [];

    // Request reservations left behind by a stopped manager would block those requestIds forever.
    const liveReservations = new Set(
      Array.from(this.inFlightByRequestId.keys()).map((id) => ".reserve-" + sha256Hex(id).slice(0, 24))
    );
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(".reserve-") && !liveReservations.has(entry.name)) {
        rmSync(join(runsDir, entry.name), { recursive: true, force: true });
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runAbsDir = join(runsDir, entry.name);
      const recPath = join(runAbsDir, "run-record.json");
      if (!existsSync(recPath)) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(readFileSync(recPath, "utf8"));
      } catch {
        results.push({ runId: entry.name, from: "invalid", to: "invalid" });
        continue;
      }

      const val = validate("run-record", record);
      if (!val.ok) {
        const parsedId = typeof record.runId === "string" ? record.runId : entry.name;
        results.push({ runId: parsedId, from: "invalid", to: "invalid" });
        continue;
      }

      const runId = record.runId as string;
      const fromState = record.state as string;

      if (fromState !== "queued" && fromState !== "running") {
        continue;
      }
      if (this.inFlightRuns.has(runId)) {
        continue;
      }

      const recTransition = (to: string, reason: string): void => {
        if (!isLegalTransition(record.state as string, to)) {
          throw new Error(`Illegal state transition from "${record.state}" to "${to}"`);
        }
        appendLine(
          join(runAbsDir, "log", "transitions.jsonl"),
          JSON.stringify({
            time: this.now().toISOString(),
            from: record.state,
            to,
            reason,
          })
        );
        record.state = to;
        record.finishedAt = this.now().toISOString();
        const v = validate("run-record", record);
        if (!v.ok) {
          throw new Error("run-record became invalid after recovery: " + v.errors.map((e) => e.message).join(", "));
        }
        writeFileAtomic(recPath, JSON.stringify(record, null, 2) + "\n");
      };

      let toState: string = "interrupted";
      let nativeStatus: { status: string; detail?: string } = {
        status: "host-lost",
        detail: "run was not finished when the host stopped",
      };

      if (record.jobId && typeof record.jobId === "string") {
        const statusOutcome = await callAdapter(
          this.adapter,
          {
            schema: "seed.adapter-request/0.1",
            verb: "status",
            requestId: `status-${this.newId()}`,
            actor: { kind: "system", name: "seed-recovery" },
            jobId: record.jobId,
          },
          { projectRoot: this.projectRoot, timeoutMs: this.callTimeoutMs }
        );

        if (statusOutcome.ok && (statusOutcome.reply as Record<string, unknown>).ok) {
          const reply = statusOutcome.reply as Record<string, unknown>;
          const res = reply.result as {
            jobId: string;
            lifecycle: string;
            native: { status: string; detail?: string };
          };
          const lc = res.lifecycle;
          if (TERMINAL_STATES.includes(lc)) {
            if (lc === "completed") {
              const startReqForCollect: StartRequest = {
                requestId: `recover-${this.newId()}`,
                actor: { kind: "system", name: "seed-recovery" },
                artifact: { path: "dummy", revision: { hash: "0".repeat(64), counter: 1 } },
                inputs: (record.inputs as { path: string; sha256: string }[]) ?? [],
                budget: record.budget as Budget,
              };
              const collectOutcome = await this.collectAndFinalize(
                record,
                runAbsDir,
                `${this.runsFolder}/${runId}`,
                startReqForCollect,
                recTransition
              );
              toState = collectOutcome.ok ? collectOutcome.state : "failed";
              results.push({ runId, from: fromState, to: toState });
              continue;
            } else {
              toState = lc;
              nativeStatus = res.native;
            }
          }
        }
      }

      record.native = nativeStatus;
      recTransition(toState, "recovery");
      results.push({ runId, from: fromState, to: toState });
    }

    return results;
  }
}
