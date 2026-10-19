import type { TypedError } from "./validate";

export type Tier = "A0" | "A1" | "A2" | "A3";
export type ActorKind = "human" | "agent" | "system";
export type Actor = { kind: ActorKind; name: string; model?: string; toolVersion?: string };
export type Budget = { maxWallSeconds: number; maxCores: number; maxMemoryMB: number; maxDiskMB: number };
/** The study's limits: per-case resources, and how many cases one sweep may have (default DEFAULT_MAX_CASES). */
export type StudyBudget = Budget & { maxCases?: number };
export const DEFAULT_MAX_CASES = 10;
export type Bound = { id: string; min: number; max: number; unit?: string };
export type Revision = { artifact: string; revision: string };

/** What the gate needs to know about a study: the header fields a human set. */
export type PolicyStudy = { studyId: string; tier: Tier; budget: StudyBudget; parameters: Bound[] };

/**
 * Minimum tier an operation needs. "grant" operations need a human-issued grant even at tier A3
 * ("nothing by default"). "human" operations are never available to an agent or the system.
 */
export const OPERATION_RULES = {
  describe: "A0",
  validate: "A0",
  query_model: "A0",
  read: "A0",
  collect: "A0",
  status: "A1",
  cancel: "A1",
  run_oracles: "A1",
  run_case: "A1",
  run_sweep: "A1",
  append_step: "A1",
  draft_conclusion: "A1",
  new_revision: "A2",
  propose_transfer: "A2",
  accept_material_set: "grant",
  enable_transfer: "grant",
  // runtime components (W4, src/core/installGrant.ts): an agent may ask inside a human grant; removal is a person's
  install_component: "grant",
  remove_component: "human",
  change_tier: "human",
  change_budget: "human",
  change_bounds: "human",
  change_tolerance: "human",
  override_refusal: "human",
  write_outside_roots: "human",
  run_command_from_content: "human",
  install_runtime: "human"
} as const;

export type Operation = keyof typeof OPERATION_RULES;

const TIER_ORDER: Record<Tier, number> = { A0: 0, A1: 1, A2: 2, A3: 3 };
const RUN_OPERATIONS: ReadonlySet<string> = new Set(["run_case", "run_sweep", "new_revision", "propose_transfer"]);
/** Operations that occupy the engine: they obey the one-active-case-per-engine limit. Oracle runs do too. */
const ENGINE_OPERATIONS: ReadonlySet<string> = new Set([...RUN_OPERATIONS, "run_oracles"]);
const BUDGET_KEYS: (keyof Budget)[] = ["maxWallSeconds", "maxCores", "maxMemoryMB", "maxDiskMB"];

export type GateRequest = {
  operation: string;
  actor: Actor;
  studyId: string;
  /** Input revisions the operation will use; a grant must name exactly these. */
  inputRevisions?: Revision[];
  /** The budget this one request asks for. */
  budget?: Budget;
  /** Parameter values the request sets, checked against the study's declared bounds. */
  params?: { id: string; value: number }[];
  /** How many cases a sweep asks for; checked against the study's maxCases. */
  cases?: number;
  /** Engine the request would use, and how many cases already run on it. */
  engine?: string;
  activeOnEngine?: number;
};

/** A human approval for one operation of one actor on given input revisions. */
export type Grant = {
  grantId: string;
  studyId: string;
  actor: { kind: ActorKind; name: string };
  operation: Operation;
  inputRevisions: Revision[];
  issuedAt: string;
  expires: string;
  revoked?: boolean;
  approvedBy: Actor;
};

export type GateContext = {
  study: PolicyStudy;
  grants?: readonly Grant[];
  /** Oracle sets that failed or were never cleared block run operations until a human clears them. */
  oracleBlocked?: boolean;
  /** Pins (oracle file hash, app commit) changed since a human last accepted them. */
  pinsChanged?: boolean;
  now?: () => Date;
};

export type GateStop = { request: string; rule: string };
export type Decision =
  | { allow: true; via: "tier" | "grant"; grantId?: string }
  | { allow: false; errors: TypedError[]; gateStop: GateStop };

function stop(req: GateRequest, rule: string, errors: TypedError[]): Decision {
  const who = `${req.actor.kind}:${req.actor.name}`;
  return {
    allow: false,
    errors,
    gateStop: { request: `${String(req.operation)} by ${who}`.slice(0, 200), rule: rule.slice(0, 200) }
  };
}

function err(code: string, field: string, message: string, extra?: Partial<TypedError>): TypedError {
  return { code, field, message, source: "seed", ...extra };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function sameRevisions(wanted: readonly Revision[], granted: readonly Revision[]): boolean {
  const key = (r: Revision) => `${r.artifact}\u0000${r.revision}`;
  const have = new Set(granted.map(key));
  const need = new Set(wanted.map(key));
  if (have.size !== need.size) return false;
  for (const k of need) if (!have.has(k)) return false;
  return true;
}

/** The first grant that covers the request, or why none does. */
export function findGrant(
  req: GateRequest,
  grants: readonly Grant[],
  now: Date
): { grant: Grant } | { reason: string } {
  let reason = "no grant for this operation";
  for (const g of grants) {
    if (g.operation !== req.operation || g.studyId !== req.studyId) continue;
    if (g.actor.kind !== req.actor.kind || g.actor.name !== req.actor.name) {
      reason = "grant belongs to another actor";
      continue;
    }
    if (g.approvedBy.kind !== "human") {
      reason = "grant was not approved by a human";
      continue;
    }
    if (g.revoked === true) {
      reason = "grant revoked";
      continue;
    }
    const exp = Date.parse(g.expires);
    if (!Number.isFinite(exp) || exp <= now.getTime()) {
      reason = "grant expired";
      continue;
    }
    const issued = Date.parse(g.issuedAt);
    if (!Number.isFinite(issued) || issued > now.getTime()) {
      reason = "grant is not valid yet";
      continue;
    }
    if (!sameRevisions(req.inputRevisions ?? [], g.inputRevisions)) {
      reason = "grant does not cover these input revisions";
      continue;
    }
    return { grant: g };
  }
  return { reason };
}

/**
 * The single enforcement path: GUI, CLI and MCP all call this before any operation that changes a file
 * or starts a process. A refusal returns the typed errors and the gate-stop to record.
 */
export function evaluateGate(req: GateRequest, ctx: GateContext): Decision {
  const now = (ctx.now ?? (() => new Date()))();
  const rule = (OPERATION_RULES as Record<string, string>)[req.operation];
  if (!Object.prototype.hasOwnProperty.call(OPERATION_RULES, req.operation) || rule === undefined) {
    return stop(req, "unknown-operation", [err("E_VERB_UNKNOWN", "/operation", "unknown operation")]);
  }
  if (req.studyId !== ctx.study.studyId) {
    return stop(req, "wrong-study", [err("E_NOT_PERMITTED", "/studyId", "request names a different study")]);
  }
  if (rule === "human") {
    if (req.actor.kind !== "human") {
      return stop(req, "human-only", [
        err("E_NOT_PERMITTED", "/operation", `${req.operation} is a human action; no agent or system actor can do it`)
      ]);
    }
    return { allow: true, via: "tier" };
  }

  if (ctx.pinsChanged === true && RUN_OPERATIONS.has(req.operation)) {
    return stop(req, "pins-changed", [
      err("E_NOT_PERMITTED", "/operation", "oracle file or app commit changed since a human last accepted it")
    ]);
  }
  if (ctx.oracleBlocked === true && RUN_OPERATIONS.has(req.operation)) {
    return stop(req, "oracle-failed", [
      err("E_NOT_PERMITTED", "/operation", "an oracle set failed or has not passed; a human must clear it")
    ]);
  }

  // Tier or grant.
  let via: "tier" | "grant" = "tier";
  let grantId: string | undefined;
  const needsGrant = rule === "grant" || TIER_ORDER[rule as Tier] > TIER_ORDER[ctx.study.tier];
  if (needsGrant && req.actor.kind !== "human") {
    const found = findGrant(req, ctx.grants ?? [], now);
    if ("reason" in found) {
      const why = rule === "grant" ? "needs a human grant" : `needs tier ${rule}, study is ${ctx.study.tier}`;
      return stop(req, rule === "grant" ? "grant-required" : "tier", [
        err("E_NOT_PERMITTED", "/operation", `${req.operation} ${why} (${found.reason})`)
      ]);
    }
    via = "grant";
    grantId = found.grant.grantId;
  }

  // Resource and bound checks apply to everyone: a human GUI request is held to the same study limits.
  const errors: TypedError[] = [];
  if (req.budget !== undefined) {
    for (const k of BUDGET_KEYS) {
      const asked = req.budget[k];
      if (!isFiniteNumber(asked) || asked < 1) {
        errors.push(err("E_SCHEMA_INVALID", `/budget/${k}`, "budget values must be positive numbers"));
      } else if (asked > ctx.study.budget[k]) {
        errors.push(
          err("E_BUDGET_EXCEEDED", `/budget/${k}`, `${k} ${asked} exceeds the study budget ${ctx.study.budget[k]}`, {
            range: { max: ctx.study.budget[k] }
          })
        );
      }
    }
  }
  if (req.operation === "run_sweep") {
    const limit = ctx.study.budget.maxCases ?? DEFAULT_MAX_CASES;
    if (!Number.isSafeInteger(req.cases) || (req.cases as number) < 1) {
      errors.push(err("E_SCHEMA_INVALID", "/cases", "a sweep must say how many cases it has (a positive integer)"));
    } else if ((req.cases as number) > limit) {
      errors.push(
        err("E_BUDGET_EXCEEDED", "/cases", `the sweep has ${req.cases} cases, over the study limit of ${limit}`, {
          range: { max: limit }
        })
      );
    }
  }
  if (req.params !== undefined) {
    for (let i = 0; i < req.params.length; i++) {
      const p = req.params[i];
      if (p === undefined) continue;
      const bound = ctx.study.parameters.find((b) => b.id === p.id);
      if (bound === undefined) {
        errors.push(err("E_BOUNDS_EXCEEDED", `/params/${i}/id`, `parameter ${p.id} is not declared by the study`));
      } else if (!isFiniteNumber(p.value) || p.value < bound.min || p.value > bound.max) {
        errors.push(
          err("E_BOUNDS_EXCEEDED", `/params/${i}/value`, `${p.id} is outside the study bounds`, {
            range: { min: bound.min, max: bound.max },
            ...(bound.unit !== undefined ? { unit: bound.unit } : {})
          })
        );
      }
    }
  }
  if (errors.length > 0) {
    const resource = errors.some((e) => e.code === "E_BOUNDS_EXCEEDED") ? "bounds" : "budget";
    return stop(req, resource, errors);
  }
  if (req.engine !== undefined && (req.activeOnEngine ?? 0) >= 1 && ENGINE_OPERATIONS.has(req.operation)) {
    return stop(req, "per-engine-limit", [
      err("E_BUDGET_EXCEEDED", "/engine", `one active case per engine; ${req.engine} is busy`)
    ]);
  }
  return grantId === undefined ? { allow: true, via } : { allow: true, via, grantId };
}

/** Only a human can issue a grant, and only for an operation that is grantable. */
export function issueGrant(
  approver: Actor,
  grant: Omit<Grant, "approvedBy" | "revoked">
): { ok: true; grant: Grant } | { ok: false; errors: TypedError[] } {
  if (approver.kind !== "human") {
    return { ok: false, errors: [err("E_NOT_PERMITTED", "/approver", "only a human can approve a grant")] };
  }
  const rule = (OPERATION_RULES as Record<string, string>)[grant.operation];
  if (!Object.prototype.hasOwnProperty.call(OPERATION_RULES, grant.operation) || rule === undefined) {
    return { ok: false, errors: [err("E_VERB_UNKNOWN", "/operation", "unknown operation")] };
  }
  if (rule === "human") {
    return { ok: false, errors: [err("E_NOT_PERMITTED", "/operation", `${grant.operation} cannot be granted to an agent`)] };
  }
  if (!Number.isFinite(Date.parse(grant.expires)) || !Number.isFinite(Date.parse(grant.issuedAt))) {
    return { ok: false, errors: [err("E_SCHEMA_INVALID", "/expires", "issuedAt and expires must be timestamps")] };
  }
  if (Date.parse(grant.expires) <= Date.parse(grant.issuedAt)) {
    return { ok: false, errors: [err("E_SCHEMA_INVALID", "/expires", "a grant must expire after it is issued")] };
  }
  return { ok: true, grant: { ...grant, approvedBy: approver } };
}

/** A `step` line (without seq, prev and hash) recording a refusal, valid under seed.study/0.1. */
export function gateStopStep(
  decision: Extract<Decision, { allow: false }>,
  actor: Actor,
  seq: number,
  time: string
): Record<string, unknown> {
  return {
    schema: "seed.study/0.1",
    type: "step",
    seq,
    time,
    actor,
    action: "gate-stop",
    reason: decision.errors.map((e) => e.message).join("; ").slice(0, 2000) || decision.gateStop.rule,
    inputsChanged: [],
    runs: [],
    gateStop: decision.gateStop
  };
}
