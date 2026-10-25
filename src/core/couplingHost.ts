/**
 * Coupling loops through the trusted host (docs/coupling-prerequisites.md sections 4, 5 and 7). Same discipline as the transfer and run hosts: a
 * configuration chosen by the trusted environment (never by a request) names the project, the state folder, the actor, the study, the apps with
 * their oracle evidence and accepted pins, and the registered loops. A request is `{ requestId, loopId }` and nothing else. Running a loop is the
 * operation `enable_coupling`, which needs a human grant naming the exact input revisions of every app in the loop. The controller
 * (`coupling.ts`) decides convergence; this file decides whether a loop may start, builds the passes through a registered pass builder, and keeps
 * a hash-chained journal of the start, every pass and the end in `<state>/coupling-journal/`.
 *
 * A loop writes nothing to the project. A converged state is a result in the reply and the journal; writing it back as one new revision approved
 * by a person is a separate step that is not built yet.
 */
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson, sha256Hex } from "./canonical";
import { runCoupling, validateLoop, type CouplingOutcome, type LoopDefinition, type PassFunction } from "./coupling";
import { appendAdmission, inside, readAdmissions, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { loadOracleAuthority, oracleFlags, type OracleSource } from "./oracleAuthority";
import type { PinSet } from "./oracle";
import { evaluateGate, issueGrant, type Actor, type Grant, type PolicyStudy, type Revision } from "./policy";
import { openProject, withProjectLockAsync } from "./projectStore";
import type { TypedError } from "./validate";

export type CouplingLoopRegistration = {
  /** Said in every record and reply: a plumbing test checks the exchange, not the physics. */
  purpose: "plumbing-test" | "physics";
  /** Names the pass builder that turns this registration into passes (for example `lumped-power-temperature`). */
  kind: string;
  apps: string[];
  /** The exact artifact revisions of the project the loop runs on; a grant names these, and a changed project makes the loop stale. */
  inputs: Revision[];
  definition: unknown;
  start: Record<string, number>;
};
export type CouplingHostConfig = {
  schema: "seed.coupling-host/0.1";
  projectRoot: string;
  stateRoot: string;
  actor: Actor;
  study: PolicyStudy;
  grants?: Grant[];
  apps: Record<string, { adapter: { id: string; version: string }; oracles: OracleSource; acceptedPins: PinSet }>;
  loops: Record<string, CouplingLoopRegistration>;
};
export type CouplingRequest = { requestId: string; loopId: string };

/** What a pass builder sees: the validated registration and the places it may use. It returns the pass function, or refuses before pass 1. */
export type PassContext = {
  loopId: string;
  requestId: string;
  loop: CouplingLoopRegistration;
  config: CouplingHostConfig;
  projectRoot: string;
  stateRoot: string;
  /** The folder the loop may write its scratch iterates to: inside the state folder, outside the project. */
  scratchRoot: string;
};
export type PassBuilder = (ctx: PassContext) => PassFunction | { ok: false; errors: TypedError[] };

/** Builders by `kind`. Passes that run real apps are registered here by their own module. */
export const PASS_BUILDERS: Record<string, PassBuilder> = {};

export type CouplingHostOutcome =
  | {
      ok: true;
      loopId: string;
      requestId: string;
      purpose: CouplingLoopRegistration["purpose"];
      /** What the result stands for, in words; repeated in the journal. */
      claim: string;
      /** A coupled result has no oracle of its own yet (section 4.6), whatever the single-app oracles say. */
      verification: "unverified";
      outcome: CouplingOutcome;
      grantId?: string;
    }
  | { ok: false; errors: TypedError[] };

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, "../../schema/common.schema.json"), "utf8")));
const check = ajv.compile(JSON.parse(readFileSync(join(__dirname, "../../schema/coupling-host.schema.json"), "utf8")));

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const fail = (code: string, message: string, field = ""): { ok: false; errors: TypedError[] } => ({ ok: false, errors: [err(code, field, message)] });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export function claimOf(purpose: CouplingLoopRegistration["purpose"]): string {
  return purpose === "plumbing-test"
    ? "a plumbing test: it checks the exchange, the scratch iterates, the records and the gate, not the physics; every quantity is unverified"
    : "a coupled calculation; every quantity is unverified until a coupled oracle entry has passed";
}

export function validateCouplingHostConfig(value: unknown): CouplingHostConfig {
  if (!check(value)) throw Error("invalid seed.coupling-host/0.1 configuration: " + ajv.errorsText(check.errors));
  const c = structuredClone(value) as CouplingHostConfig;
  const paths = [c.projectRoot, c.stateRoot];
  for (const a of Object.values(c.apps)) paths.push(a.oracles.repository, a.oracles.entriesDir, a.oracles.inputsRoot, a.oracles.evidenceFile);
  if (paths.some((p) => !isAbsolute(p))) throw Error("host paths must be absolute");
  const seen = new Set<string>();
  for (const b of c.study.parameters) {
    if (b.min > b.max || seen.has(b.id)) throw Error("invalid or duplicate parameter bound");
    seen.add(b.id);
  }
  for (const grant of c.grants ?? []) {
    const { approvedBy, revoked, ...body } = grant;
    if (!issueGrant(approvedBy, body).ok) throw Error("invalid persisted grant");
  }
  for (const [loopId, loop] of Object.entries(c.loops)) {
    if (FORBIDDEN.has(loopId)) throw Error(`the loop id ${loopId} is not allowed`);
    for (const a of loop.apps) if (!Object.hasOwn(c.apps, a)) throw Error(`loop ${loopId} names the app ${a}, which is not configured`);
    const def = validateLoop(loop.definition);
    if (!def.ok) throw Error(`loop ${loopId} has an invalid definition: ${def.errors.join("; ")}`);
    for (const q of def.def.exchanged) {
      if (!Object.hasOwn(loop.start, q.id)) throw Error(`loop ${loopId} has no start value for ${q.id}`);
    }
    for (const id of Object.keys(loop.start)) if (!def.def.exchanged.some((q) => q.id === id)) throw Error(`loop ${loopId} has a start value for ${id}, which is not exchanged`);
    loop.definition = def.def;
  }
  return c;
}

/** Trusted setup code writes the configuration; no verb does. It must live outside the project. */
export function saveCouplingHostConfig(file: string, value: unknown): void {
  const c = validateCouplingHostConfig(value);
  if (!isAbsolute(file) || inside(realpathSync(c.projectRoot), realpathSync(dirname(file)))) throw Error("host configuration must live outside the project");
  writeHostJson(file, c);
}

/** Agent or person: run a registered loop. Needs a human grant (`enable_coupling`) naming the loop's exact input revisions. */
export async function runCouplingFromHostFile(file: string, request: unknown, builders: Record<string, PassBuilder> = PASS_BUILDERS): Promise<CouplingHostOutcome> {
  let journal: string | undefined;
  const audit = (event: Record<string, unknown>) => { if (journal) appendAdmission(journal, event); };
  try {
    const r = request as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 2 || typeof r.requestId !== "string" || !ID.test(r.requestId) || typeof r.loopId !== "string" || !ID.test(r.loopId)) {
      return fail("E_SCHEMA_INVALID", "the request is { requestId, loopId } and nothing else");
    }
    const { requestId, loopId } = r as CouplingRequest;
    if (!isAbsolute(file)) return fail("E_SETUP_REQUIRED", "the coupling host configuration path must be absolute");
    regularFile(file);
    const bytes = readFileSync(file);
    const config = validateCouplingHostConfig(JSON.parse(bytes.toString("utf8")));
    const project = realpathSync(config.projectRoot), state = realpathSync(config.stateRoot);
    if (inside(project, realpathSync(file)) || inside(project, state)) return fail("E_SETUP_REQUIRED", "the host configuration and state must be outside the project");
    const opened = openProject(project);
    if (!opened.ok) return { ok: false, errors: opened.errors };
    const projectId = String(opened.value.manifest.projectId);
    journal = safeChild(state, "coupling-journal", true);
    mkdirSync(journal, { recursive: true });
    const base = { projectId, configHash: sha256Hex(bytes), actor: config.actor, requestId, loopId };

    if (!Object.hasOwn(config.loops, loopId)) {
      audit({ phase: "refused", ...base, reason: "unknown loop" });
      return fail("E_NOT_FOUND", `no loop ${loopId} is registered`, "/loopId");
    }
    const loop = config.loops[loopId] as CouplingLoopRegistration;
    const def = loop.definition as LoopDefinition;

    // The project must still be the one the loop was registered and granted on.
    const artifacts = opened.value.manifest.artifacts as { id: string; revision: { hash: string } }[];
    for (const pin of loop.inputs) {
      const have = artifacts.find((a) => a.id === pin.artifact);
      if (!have || have.revision.hash !== pin.revision) {
        audit({ phase: "refused", ...base, reason: "stale input", artifact: pin.artifact });
        return fail("E_STALE_REVISION", `the artifact ${pin.artifact} is not at the revision this loop was registered on`, "/loopId");
      }
    }

    // Every app of the loop: its oracle set must be clear and its pins as a person accepted them.
    let pinsChanged = false, oracleBlocked = false;
    for (const id of loop.apps) {
      const app = config.apps[id] as CouplingHostConfig["apps"][string];
      const auth = loadOracleAuthority(app.oracles, app.adapter, state);
      const flags = oracleFlags({ acceptedPins: app.acceptedPins, ...auth }, app.adapter);
      pinsChanged ||= flags.pinsChanged;
      oracleBlocked ||= flags.oracleBlocked;
    }
    const decision = evaluateGate(
      { operation: "enable_coupling", actor: config.actor, studyId: config.study.studyId, inputRevisions: loop.inputs, cases: def.maxPasses * loop.apps.length },
      { study: config.study, grants: config.grants ?? [], pinsChanged, oracleBlocked }
    );
    if (!decision.allow) {
      audit({ phase: "refused", ...base, reason: "gate", gateStop: decision.gateStop, errors: decision.errors });
      return { ok: false, errors: decision.errors };
    }

    const builder = Object.hasOwn(builders, loop.kind) ? builders[loop.kind] : undefined;
    if (!builder) return fail("E_SETUP_REQUIRED", `no pass builder is registered for the loop kind ${loop.kind}`, "/loopId");

    const under = (parent: string, child: string): string => {
      const dir = safeChild(state, parent, true);
      mkdirSync(dir, { recursive: true });
      return safeChild(dir, child, true);
    };
    const lockDir = under("coupling-locks", loopId);
    mkdirSync(lockDir, { recursive: true });
    const scratchRoot = under("coupling-scratch", sha256Hex(projectId + "\n" + loopId + "\n" + requestId).slice(0, 24));
    const locked = await withProjectLockAsync(lockDir, async (): Promise<CouplingHostOutcome> => {
      // A request id is used once: a rerun is a new request, never a silent replay.
      const rows = readAdmissions(journal as string);
      if (rows.some((row) => (row.event as { phase?: string; requestId?: string }).phase === "start" && (row.event as { requestId?: string }).requestId === requestId)) {
        return fail("E_REQUEST_CONFLICT", `the request id ${requestId} was used before; use a new one`, "/requestId");
      }
      const claim = claimOf(loop.purpose);
      audit({
        phase: "start", ...base, purpose: loop.purpose, claim, kind: loop.kind, apps: loop.apps, inputs: loop.inputs, definition: def, definitionSha256: sha256Hex(canonicalJson(def)),
        start: loop.start, via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {})
      });
      const made = builder({ loopId, requestId, loop, config, projectRoot: project, stateRoot: state, scratchRoot });
      if (typeof made !== "function") {
        audit({ phase: "outcome", ...base, state: "refused", reason: "the pass builder refused before pass 1", errors: made.errors, passes: [] });
        return { ok: false, errors: made.errors };
      }
      const wrapped: PassFunction = async (iterate, index) => {
        let res: Awaited<ReturnType<PassFunction>>;
        try {
          res = await made(iterate, index);
        } catch (e) {
          res = { ok: false, reason: "the pass threw: " + (e instanceof Error ? e.message : String(e)) };
        }
        audit({ phase: "pass", ...base, index, iterate, ...(res.ok ? { calc: res.calc, ...(res.noise ? { noise: res.noise } : {}), ...(res.conservation ? { conservation: res.conservation } : {}) } : { failed: res.reason }), ...(res.runs ? { runs: res.runs } : {}) });
        return res;
      };
      const outcome = await runCoupling(def, loop.start, wrapped);
      audit({ phase: "outcome", ...base, state: outcome.state, reason: outcome.reason, passes: outcome.passes, ...(outcome.result ? { result: outcome.result } : {}), purpose: loop.purpose, claim, verification: "unverified" });
      return { ok: true, loopId, requestId, purpose: loop.purpose, claim, verification: "unverified", outcome, ...(decision.grantId ? { grantId: decision.grantId } : {}) };
    });
    if (!locked.ok) return { ok: false, errors: locked.errors };
    return locked.value;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const message = e instanceof Error ? e.message : "coupling host failed";
    try { audit({ phase: "error", message }); } catch { /* the journal is best effort for a failed setup */ }
    return fail(typeof code === "string" && /^[EW]_[A-Z0-9_]{2,40}$/.test(code) ? code : "E_SETUP_REQUIRED", message);
  }
}
