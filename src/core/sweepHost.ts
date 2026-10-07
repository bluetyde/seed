import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sha256Hex } from "./canonical";
import { allCases, runFromHostFile, validateHostConfiguration } from "./fileRunHost";
import { appendSweepRecord, regularFile } from "./hostFiles";
import { evaluateGate, type Budget } from "./policy";
import type { RunOutcome } from "./runManager";
import { expandSweep } from "./sweep";
import type { TypedError } from "./validate";

/** Client input: a registered sweep and a per-case budget. No values, paths, actor or policy. */
export type SweepRequest = { requestId: string; sweepId: string; budget: Budget };
export type SweepCaseResult = {
  caseId: string;
  requestId: string;
  values: { id: string; value: number }[];
  /** `not-started` after a stop; otherwise the run's lifecycle state, or `refused` with errors. */
  state: string;
  runId?: string;
  errors?: TypedError[];
};
export type SweepOutcome =
  | {
      ok: true;
      sweepId: string;
      requestId: string;
      results: SweepCaseResult[];
      /** True when every case ran to its end (completed, or ended by a trip) and none was refused, failed or left out. */
      complete: boolean;
      stoppedAt?: { caseId: string; reason: string };
    }
  | { ok: false; errors: TypedError[] };

const KEYS = ["maxCores", "maxDiskMB", "maxMemoryMB", "maxWallSeconds"];
const refusal = (message: string, code: string, field = ""): SweepOutcome => ({
  ok: false,
  errors: [{ code, field, message, source: "seed" }]
});
/**
 * A case after which the next may start: completed, or ended by a trip (a result of the experiment, and the host frees
 * the engine). A failed or interrupted run keeps the engine lease until a human has looked, because its record alone
 * cannot prove the native process stopped; so the sweep stops there and the next case would only be refused.
 */
const CONTINUE = new Set(["completed", "terminated-by-trip"]);

/** The request id the sweep gives case `caseId`; a rerun of the same sweep request replays the finished cases. */
export const sweepCaseRequestId = (requestId: string, caseId: string) => `${requestId}.${caseId}`;
/** A run's request id is an id (64 characters at most), so the sweep's request id plus a case id must be one too. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Runs a registered sweep one case after another, each through the guarded run path (policy, pins, oracles, the
 * one-active-case-per-engine limit and the admission record apply to every case). Bounds and budget are checked for
 * the sweep before the first case and again, by the run path, before each. A refusal, a cancelled or interrupted
 * case, or a changed host configuration stops the sweep; the cases not started stay in the table as `not-started`.
 */
export async function runSweepFromHostFile(file: string, request: unknown): Promise<SweepOutcome> {
  const r = request as Partial<SweepRequest> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Object.keys(r).some((k) => !["requestId", "sweepId", "budget"].includes(k)) ||
    typeof r.requestId !== "string" ||
    r.requestId.length < 1 ||
    r.requestId.length > 64 ||
    typeof r.sweepId !== "string" ||
    typeof r.budget !== "object" ||
    r.budget === null ||
    Object.keys(r.budget).sort().join() !== KEYS.join() ||
    Object.values(r.budget).some((v) => !Number.isSafeInteger(v) || (v as number) < 1)
  ) {
    return refusal("invalid sweep request; only requestId, a registered sweepId and budget are accepted", "E_SCHEMA_INVALID");
  }
  const { requestId, sweepId, budget } = r as SweepRequest;
  try {
    if (!isAbsolute(file)) return refusal("SEED_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file);
    const bytes = readFileSync(file);
    const configHash = sha256Hex(bytes);
    const c = validateHostConfiguration(JSON.parse(bytes.toString("utf8")));
    const state = realpathSync(c.stateRoot);
    const note = (event: Record<string, unknown>) =>
      appendSweepRecord(state, { sweepId, requestId, configHash, actor: c.actor, ...event });

    const def = c.sweeps !== undefined && Object.hasOwn(c.sweeps, sweepId) ? c.sweeps[sweepId] : undefined;
    if (def === undefined) {
      note({ phase: "refused", reason: "sweep is not registered" });
      return refusal("sweep is not registered", "E_NOT_PERMITTED", "/sweepId");
    }
    const expanded = expandSweep(sweepId, def, c.cases, c.study);
    if (!expanded.ok) return { ok: false, errors: expanded.errors };
    const base = allCases(c)[def.base];
    const tooLong = expanded.cases.find((x) => !REQUEST_ID.test(sweepCaseRequestId(requestId, x.caseId)));
    if (tooLong !== undefined) {
      note({ phase: "refused", reason: "request id cannot be extended to a case request id" });
      return refusal(
        "the request id must be letters, digits, dots, dashes or underscores, and short enough to carry a case id after it (64 characters in all)",
        "E_SCHEMA_INVALID",
        "/requestId"
      );
    }
    const decision = evaluateGate(
      {
        operation: "run_sweep",
        actor: c.actor,
        studyId: c.study.studyId,
        budget,
        cases: expanded.cases.length,
        inputRevisions: (base?.inputs ?? []).map((i) => ({ artifact: i.path, revision: i.sha256 }))
      },
      { study: c.study, grants: c.grants }
    );
    if (!decision.allow) {
      note({ phase: "refused", cases: expanded.cases.length, gateStop: decision.gateStop, errors: decision.errors });
      return { ok: false, errors: decision.errors };
    }
    note({ phase: "admitted", cases: expanded.cases.length, budget, via: decision.via });

    const results: SweepCaseResult[] = expanded.cases.map((x) => ({
      caseId: x.caseId,
      requestId: sweepCaseRequestId(requestId, x.caseId),
      values: x.values,
      state: "not-started"
    }));
    let stoppedAt: { caseId: string; reason: string } | undefined;
    for (const row of results) {
      let changed = false;
      try {
        regularFile(file);
        changed = sha256Hex(readFileSync(file)) !== configHash;
      } catch {
        changed = true;
      }
      if (changed) {
        stoppedAt = { caseId: row.caseId, reason: "host configuration changed during the sweep" };
        break;
      }
      const outcome: RunOutcome = await runFromHostFile(
        file,
        { requestId: row.requestId, caseId: row.caseId, budget },
        { sweep: { sweepId, index: results.indexOf(row) + 1, count: results.length, values: row.values } }
      );
      if (!outcome.ok) {
        row.state = "refused";
        row.errors = outcome.errors;
        stoppedAt = { caseId: row.caseId, reason: outcome.errors[0]?.message ?? "refused" };
        break;
      }
      row.state = outcome.state;
      row.runId = outcome.runId;
      if (!CONTINUE.has(outcome.state)) {
        stoppedAt = { caseId: row.caseId, reason: `case ended ${outcome.state}` };
        break;
      }
    }
    const complete = stoppedAt === undefined;
    note({ phase: "finished", complete, ...(stoppedAt ? { stoppedAt } : {}), results: results.map((x) => ({ caseId: x.caseId, state: x.state, runId: x.runId })) });
    return { ok: true, sweepId, requestId, results, complete, ...(stoppedAt ? { stoppedAt } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : "sweep setup failed";
    return refusal(message, "E_SETUP_REQUIRED");
  }
}
