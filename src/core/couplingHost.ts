/**
 * Coupling loops through the trusted host (docs/coupling-prerequisites.md sections 4, 5 and 7). Same discipline as the transfer and run hosts: a
 * configuration chosen by the trusted environment (never by a request) names the project, the state folder, the actor, the study, the apps with
 * their oracle evidence and accepted pins, and the registered loops. A request is `{ requestId, loopId }` and nothing else. Running a loop is the
 * operation `enable_coupling`, which needs a human grant naming the exact input revisions of every app in the loop and the loop's registration
 * (see `couplingRegistrationPin`). The controller (`coupling.ts`) decides convergence; this file decides whether a loop may start and keep going,
 * builds the passes through a registered pass builder, and keeps a hash-chained journal of the start, every pass and the end in
 * `<state>/coupling-journal/`.
 *
 * A loop writes nothing to the project. A converged state is a result in the reply and the journal; writing it back as one new revision approved
 * by a person is a separate step that is not built yet.
 *
 * One lock covers the whole coupling state (the journal's request-id check, its hash chain and the run), so one loop runs at a time and no two
 * requests can use the same request id. The inputs, the oracle sets and the pins are checked under that lock before the start and again before
 * every pass; a loop whose project or apps changed while it ran ends there, with the earlier passes kept.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson, sha256Hex } from "./canonical";
import { LUMPED_KIND, lumpedPowerTemperature } from "./couplingLumped";
import { runCoupling, validateLoop, type CouplingOutcome, type LoopDefinition, type PassFunction } from "./coupling";
import { appendAdmission, inside, readAdmissions, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { loadOracleAuthority, oracleFlags, type OracleSource } from "./oracleAuthority";
import type { PinSet } from "./oracle";
import { resolveInside } from "./paths";
import { evaluateGate, issueGrant, type Actor, type Grant, type PolicyStudy, type Revision } from "./policy";
import { openProject, withProjectLockAsync } from "./projectStore";
import type { TypedError } from "./validate";

export type CouplingLoopRegistration = {
  /** Said in every record and reply: a plumbing test checks the exchange, not the physics. */
  purpose: "plumbing-test" | "physics";
  /** Names the pass builder that turns this registration into passes (for example `lumped-power-temperature`). */
  kind: string;
  apps: string[];
  /** The exact artifact revisions of the project the loop runs on, for each of its apps (at least one each); a grant names these, and a changed project makes the loop stale. */
  inputs: Record<string, Revision[]>;
  definition: unknown;
  start: Record<string, number>;
  /** What the pass builder of this `kind` needs to know (artifact ids, material, slices, power); part of the registration pin, so a grant covers exactly these. */
  options?: Record<string, unknown>;
};
export type CouplingCommand = { command: string; args: string[]; timeoutSeconds?: number };
export type CouplingHostConfig = {
  schema: "seed.coupling-host/0.1";
  projectRoot: string;
  stateRoot: string;
  actor: Actor;
  study: PolicyStudy;
  grants?: Grant[];
  apps: Record<string, { adapter: { id: string; version: string }; oracles: OracleSource; acceptedPins: PinSet; runner?: CouplingCommand; transfer?: CouplingCommand }>;
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

/** Builders by `kind`. */
export const PASS_BUILDERS: Record<string, PassBuilder> = { [LUMPED_KIND]: lumpedPowerTemperature };

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
const MAX_ARTIFACT = 8 * 1024 * 1024;

export function claimOf(purpose: CouplingLoopRegistration["purpose"]): string {
  return purpose === "plumbing-test"
    ? "a plumbing test: it checks the exchange, the scratch iterates, the records and the gate, not the physics; every quantity is unverified"
    : "a coupled calculation; every quantity is unverified until a coupled oracle entry has passed";
}

/** Every artifact revision of every app of the loop, apps in the order the loop names them. */
export const flatInputs = (loop: CouplingLoopRegistration): Revision[] => loop.apps.flatMap((a) => (Object.hasOwn(loop.inputs, a) ? (loop.inputs[a] as Revision[]) : []));

/**
 * The revision a grant for this loop must name beside the input revisions: it stands for the loop's id and its whole registration (kind, purpose,
 * apps, inputs, definition with its pass ceiling, start iterate). A grant for one loop does not open another loop, and a loop whose registration
 * was edited after the grant needs a new one. Compute it from the validated configuration; a person reads the registration it hashes.
 */
export function couplingRegistrationPin(loopId: string, loop: CouplingLoopRegistration): Revision {
  const { purpose, kind, apps, inputs, definition, start, options } = loop;
  return { artifact: `coupling:${loopId}`, revision: sha256Hex(canonicalJson({ loopId, purpose, kind, apps, inputs, definition, start, ...(options === undefined ? {} : { options }) })) };
}

export function validateCouplingHostConfig(value: unknown): CouplingHostConfig {
  if (!check(value)) throw Error("invalid seed.coupling-host/0.1 configuration: " + ajv.errorsText(check.errors));
  const c = structuredClone(value) as CouplingHostConfig;
  const paths = [c.projectRoot, c.stateRoot];
  for (const a of Object.values(c.apps)) paths.push(a.oracles.repository, a.oracles.entriesDir, a.oracles.inputsRoot, a.oracles.evidenceFile, ...(a.runner ? [a.runner.command] : []), ...(a.transfer ? [a.transfer.command] : []));
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
    const inputApps = Object.keys(loop.inputs);
    if (inputApps.length !== loop.apps.length || !loop.apps.every((a) => Object.hasOwn(loop.inputs, a))) throw Error(`loop ${loopId} must pin the input revisions of exactly the apps it names (${loop.apps.join(", ")})`);
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

/** A project artifact's bytes on disk, by the path the manifest gives: a regular file inside the project, not a link. Null when they cannot be read that way. */
function artifactBytes(project: string, rel: string): Buffer | null {
  const abs = resolveInside(project, rel);
  if (!abs.ok) return null;
  try {
    const s = lstatSync(abs.value);
    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_ARTIFACT || !inside(realpathSync(project), realpathSync(abs.value))) return null;
    return readFileSync(abs.value);
  } catch {
    return null;
  }
}

/** Agent or person: run a registered loop. Needs a human grant (`enable_coupling`) naming the loop's exact input revisions and its registration. */
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
    // The state folder and the project must not hold each other: the host writes its journal, locks and scratch under the state folder.
    if (inside(project, realpathSync(file)) || inside(project, state) || inside(state, project)) return fail("E_SETUP_REQUIRED", "the host configuration and state must be outside the project, and the project outside the state folder");

    const under = (parent: string, child: string): string => {
      const dir = safeChild(state, parent, true);
      mkdirSync(dir, { recursive: true });
      return safeChild(dir, child, true);
    };
    journal = safeChild(state, "coupling-journal", true);
    mkdirSync(journal, { recursive: true });
    const lockDir = under("coupling-locks", "state");
    mkdirSync(lockDir, { recursive: true });

    const locked = await withProjectLockAsync(lockDir, async (): Promise<CouplingHostOutcome> => {
      const known = Object.hasOwn(config.loops, loopId);
      const loop = (known ? config.loops[loopId] : undefined) as CouplingLoopRegistration | undefined;
      const def = loop?.definition as LoopDefinition | undefined;
      const openedFirst = openProject(project);
      if (!openedFirst.ok) return { ok: false, errors: openedFirst.errors };
      const projectId = String(openedFirst.value.manifest.projectId);
      const base = { projectId, configHash: sha256Hex(bytes), actor: config.actor, requestId, loopId };
      if (!loop || !def) {
        audit({ phase: "refused", ...base, reason: "unknown loop" });
        return fail("E_NOT_FOUND", `no loop ${loopId} is registered`, "/loopId");
      }
      const pins = [...flatInputs(loop), couplingRegistrationPin(loopId, loop)];

      const registered = pins.at(-1) as Revision;
      /**
       * Everything that must hold now: the configuration as it is on disk now (grants, accepted pins and the loop's registration are read again, so a
       * revoked grant or an edited registration stops the loop at the next pass), the inputs as granted (manifest and bytes), every app's oracle set
       * and pins, and the gate.
       */
      const admit = (): { ok: true; via: "tier" | "grant"; grantId?: string } | { ok: false; reason: string; errors: TypedError[]; gateStop?: unknown } => {
        let now: CouplingHostConfig;
        try {
          now = validateCouplingHostConfig(JSON.parse(readFileSync(file, "utf8")));
        } catch (e) {
          return { ok: false, reason: "configuration unreadable", errors: [err("E_SETUP_REQUIRED", "", "the coupling host configuration cannot be read or is no longer valid: " + (e instanceof Error ? e.message : String(e)))] };
        }
        const nowLoop = Object.hasOwn(now.loops, loopId) ? (now.loops[loopId] as CouplingLoopRegistration) : undefined;
        if (!nowLoop || couplingRegistrationPin(loopId, nowLoop).revision !== registered.revision) {
          return { ok: false, reason: "registration changed", errors: [err("E_STALE_REVISION", "/loopId", `the registration of the loop ${loopId} is not the one this request started with`)] };
        }
        const opened = openProject(project);
        if (!opened.ok) return { ok: false, reason: "the project cannot be opened", errors: opened.errors };
        const artifacts = opened.value.manifest.artifacts as { id: string; path: string; revision: { hash: string } }[];
        for (const pin of flatInputs(loop)) {
          const have = artifacts.find((a) => a.id === pin.artifact);
          if (!have || have.revision.hash !== pin.revision) return { ok: false, reason: `stale input ${pin.artifact}`, errors: [err("E_STALE_REVISION", "/loopId", `the artifact ${pin.artifact} is not at the revision this loop was registered on`)] };
          const content = artifactBytes(project, have.path);
          if (content === null || sha256Hex(content) !== pin.revision) return { ok: false, reason: `changed file ${pin.artifact}`, errors: [err("E_STALE_REVISION", "/loopId", `the file of the artifact ${pin.artifact} is not the revision this loop was registered on`)] };
        }
        let pinsChanged = false, oracleBlocked = false;
        for (const id of loop.apps) {
          const app = now.apps[id] as CouplingHostConfig["apps"][string];
          const auth = loadOracleAuthority(app.oracles, app.adapter, state);
          const flags = oracleFlags({ acceptedPins: app.acceptedPins, ...auth }, app.adapter);
          pinsChanged ||= flags.pinsChanged;
          oracleBlocked ||= flags.oracleBlocked;
        }
        const decision = evaluateGate(
          { operation: "enable_coupling", actor: config.actor, studyId: config.study.studyId, inputRevisions: pins, cases: def.maxPasses * loop.apps.length },
          { study: now.study, grants: now.grants ?? [], pinsChanged, oracleBlocked }
        );
        if (!decision.allow) return { ok: false, reason: "gate", errors: decision.errors, gateStop: decision.gateStop };
        return { ok: true, via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {}) };
      };

      const first = admit();
      if (!first.ok) {
        audit({ phase: "refused", ...base, reason: first.reason, ...(first.gateStop ? { gateStop: first.gateStop } : {}), errors: first.errors });
        return { ok: false, errors: first.errors };
      }
      const builder = Object.hasOwn(builders, loop.kind) ? builders[loop.kind] : undefined;
      if (!builder) return fail("E_SETUP_REQUIRED", `no pass builder is registered for the loop kind ${loop.kind}`, "/loopId");

      // A request id is used once: a rerun is a new request, never a silent replay. The check and the start row are under the one state-wide lock.
      const rows = readAdmissions(journal as string);
      if (rows.some((row) => (row.event as { phase?: string; requestId?: string }).phase === "start" && (row.event as { requestId?: string }).requestId === requestId)) {
        return fail("E_REQUEST_CONFLICT", `the request id ${requestId} was used before; use a new one`, "/requestId");
      }
      const claim = claimOf(loop.purpose);
      audit({
        phase: "start", ...base, purpose: loop.purpose, claim, kind: loop.kind, apps: loop.apps, inputs: loop.inputs, registration: pins.at(-1), definition: def, definitionSha256: sha256Hex(canonicalJson(def)),
        start: loop.start, via: first.via, ...(first.grantId ? { grantId: first.grantId } : {})
      });
      const scratchRoot = under("coupling-scratch", sha256Hex(projectId + "\n" + loopId + "\n" + requestId).slice(0, 24));
      const made = builder({ loopId, requestId, loop, config, projectRoot: project, stateRoot: state, scratchRoot });
      if (typeof made !== "function") {
        audit({ phase: "outcome", ...base, state: "refused", reason: "the pass builder refused before pass 1", errors: made.errors, passes: [] });
        return { ok: false, errors: made.errors };
      }
      const wrapped: PassFunction = async (iterate, index) => {
        let res: Awaited<ReturnType<PassFunction>>;
        try {
          // The project, the apps and the grant are checked again before every pass: a loop does not go on over inputs nobody approved.
          const again = admit();
          res = again.ok ? await made(iterate, index) : { ok: false, reason: `before pass ${index} the loop was no longer admissible: ${again.errors.map((e) => e.message).join("; ")}` };
        } catch (e) {
          res = { ok: false, reason: "the pass threw: " + (e instanceof Error ? e.message : String(e)) };
        }
        audit({ phase: "pass", ...base, index, iterate, ...(res.ok ? { calc: res.calc, ...(res.noise ? { noise: res.noise } : {}), ...(res.conservation ? { conservation: res.conservation } : {}), ...(res.info ? { info: res.info } : {}) } : { failed: res.reason }), ...(res.runs ? { runs: res.runs } : {}) });
        return res;
      };
      const outcome = await runCoupling(def, loop.start, wrapped);
      audit({ phase: "outcome", ...base, state: outcome.state, reason: outcome.reason, passes: outcome.passes, ...(outcome.result ? { result: outcome.result } : {}), purpose: loop.purpose, claim, verification: "unverified" });
      return { ok: true, loopId, requestId, purpose: loop.purpose, claim, verification: "unverified", outcome, ...(first.grantId ? { grantId: first.grantId } : {}) };
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
