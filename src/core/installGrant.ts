import { OPERATION_RULES, type Actor } from "./policy";
import type { TypedError } from "./validate";

/**
 * The install gate (W4 follow-up, docs/runtime-contract.md "Decisions of the user", 2026-10-07 no. 2). Pure: it reads and writes nothing.
 *
 *  - `install_component` has the rule `grant` in OPERATION_RULES: an agent or the system may ask for an install, but only inside a grant a
 *    human issued. A human actor needs no grant (the host configuration says who the actor is; it is outside every project and study).
 *  - `remove_component` has the rule `human`: no agent, no system actor, no grant.
 *  - A grant names the actor it is for, the app, the exact add-ons it covers (the core of the app is part of the app; libraries come with the
 *    add-on that needs them), an expiry (at most 31 days) and a **ceiling in download and disk bytes that is spent across all the requests made
 *    under it**, so a standing grant for an unattended setup can not be used again and again to fill a disk. A request is counted when it is
 *    admitted, whether the install then succeeds or not.
 *  - Nothing in a grant, a request or a study supplies a manifest, a url or a command: the app's manifest comes from the host configuration,
 *    pinned there by its hash.
 */

export type InstallGrant = {
  grantId: string;
  actor: { kind: "agent" | "system"; name: string };
  app: string;
  /** Add-on component ids this grant covers. Empty: the core of the app only. */
  components: string[];
  ceiling: { downloadBytes: number; expandedBytes: number };
  issuedAt: string;
  expires: string;
  approvedBy: Actor;
  note?: string;
};
export type Cost = { downloadBytes: number; expandedBytes: number };
export type GrantEvent =
  | { type: "issued"; grant: InstallGrant }
  | { type: "revoked"; grantId: string; by: Actor; reason?: string }
  | { type: "used"; grantId: string; requestId: string; actor: Actor; app: string; components: string[]; cost: Cost };

export const MAX_GRANT_MS = 31 * 24 * 3600 * 1000;
export const MAX_GRANT_COMPONENTS = 16;
export const MAX_CEILING_BYTES = 1e13;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GRANT_ID = /^[0-9a-f]{32}$/;

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_CEILING_BYTES;

/** Only a human can issue a grant, and only for a fixed list of components of one app, with a ceiling and an expiry. */
export function issueInstallGrant(approver: Actor, body: Omit<InstallGrant, "approvedBy">): { ok: true; grant: InstallGrant } | { ok: false; errors: TypedError[] } {
  const errors: TypedError[] = [];
  if (approver.kind !== "human") errors.push(err("E_NOT_PERMITTED", "/approver", "only a human can approve an install grant"));
  if (OPERATION_RULES.install_component !== "grant") errors.push(err("E_NOT_PERMITTED", "/operation", "install_component is not a grantable operation"));
  if (!GRANT_ID.test(body.grantId)) errors.push(err("E_SCHEMA_INVALID", "/grantId", "a grant id is 32 hex characters"));
  if (!body.actor || (body.actor.kind !== "agent" && body.actor.kind !== "system") || typeof body.actor.name !== "string" || body.actor.name.length < 1 || body.actor.name.length > 80)
    errors.push(err("E_SCHEMA_INVALID", "/actor", "a grant is for an agent or system actor with a name (a human needs no grant)"));
  if (typeof body.app !== "string" || !ID.test(body.app)) errors.push(err("E_SCHEMA_INVALID", "/app", "app is a component-manifest id"));
  if (!Array.isArray(body.components) || body.components.length > MAX_GRANT_COMPONENTS || body.components.some((c) => typeof c !== "string" || !ID.test(c)) || new Set(body.components).size !== body.components.length)
    errors.push(err("E_SCHEMA_INVALID", "/components", `components is a list of at most ${MAX_GRANT_COMPONENTS} different component ids`));
  if (!body.ceiling || !isCount(body.ceiling.downloadBytes) || !isCount(body.ceiling.expandedBytes))
    errors.push(err("E_SCHEMA_INVALID", "/ceiling", "the ceiling has downloadBytes and expandedBytes, whole numbers of bytes"));
  const issued = Date.parse(body.issuedAt), expires = Date.parse(body.expires);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) errors.push(err("E_SCHEMA_INVALID", "/expires", "issuedAt and expires must be timestamps"));
  else if (expires <= issued) errors.push(err("E_SCHEMA_INVALID", "/expires", "a grant must expire after it is issued"));
  else if (expires - issued > MAX_GRANT_MS) errors.push(err("E_SCHEMA_INVALID", "/expires", "an install grant lasts at most 31 days; issue another when it has run out"));
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 300)) errors.push(err("E_SCHEMA_INVALID", "/note", "a note is at most 300 characters"));
  if (errors.length) return { ok: false, errors };
  return { ok: true, grant: { ...body, approvedBy: approver } };
}

export type GrantState = { grant: InstallGrant; revoked: boolean; spent: Cost };

/** The grants as the event log leaves them: revoked or not, and how much of each ceiling is spent. */
export function foldGrants(events: readonly GrantEvent[]): GrantState[] {
  const states = new Map<string, GrantState>();
  for (const e of events) {
    if (e.type === "issued") states.set(e.grant.grantId, { grant: e.grant, revoked: false, spent: { downloadBytes: 0, expandedBytes: 0 } });
    else {
      const s = states.get(e.grantId);
      if (!s) continue;
      if (e.type === "revoked") s.revoked = true;
      else {
        s.spent = { downloadBytes: s.spent.downloadBytes + e.cost.downloadBytes, expandedBytes: s.spent.expandedBytes + e.cost.expandedBytes };
      }
    }
  }
  return [...states.values()];
}

export type InstallRequest = {
  operation: string;
  actor: Actor;
  app: string;
  /** The add-ons the request asks for (not the core, not the libraries that come with them). */
  components: string[];
  /** What the request would add: bytes to fetch and bytes on disk. */
  cost: Cost;
};
export type InstallDecision =
  | { allow: true; via: "human" | "grant"; grantId?: string }
  | { allow: false; errors: TypedError[]; gateStop: { request: string; rule: string } };

function stop(req: InstallRequest, rule: string, errors: TypedError[]): InstallDecision {
  return { allow: false, errors, gateStop: { request: `${req.operation} by ${req.actor.kind}:${req.actor.name} for ${req.app}`.slice(0, 200), rule: rule.slice(0, 200) } };
}

/** What a person would have to grant to let this request through: the text of the refusal. */
export function neededGrant(req: InstallRequest): string {
  return `ask a person to issue a grant: app ${req.app}, components ${JSON.stringify(req.components)}, ceiling at least ${req.cost.downloadBytes} bytes to download and ${req.cost.expandedBytes} bytes on disk (admin verb grant-install)`;
}

export function evaluateInstallGate(req: InstallRequest, states: readonly GrantState[], now: Date): InstallDecision {
  const rule = (OPERATION_RULES as Record<string, string>)[req.operation];
  if (req.operation !== "install_component" && req.operation !== "remove_component") return stop(req, "unknown-operation", [err("E_VERB_UNKNOWN", "/operation", "unknown install operation")]);
  if (rule === "human") {
    if (req.actor.kind !== "human") return stop(req, "human-only", [err("E_NOT_PERMITTED", "/operation", `${req.operation} is a human action; no agent or system actor can do it`)]);
    return { allow: true, via: "human" };
  }
  if (req.actor.kind === "human") return { allow: true, via: "human" };
  let reason = "no grant for this app";
  for (const s of states) {
    const g = s.grant;
    if (g.app !== req.app) continue;
    if (g.actor.kind !== req.actor.kind || g.actor.name !== req.actor.name) { reason = "the grant belongs to another actor"; continue; }
    if (g.approvedBy.kind !== "human") { reason = "the grant was not approved by a human"; continue; }
    if (s.revoked) { reason = "the grant was revoked"; continue; }
    const exp = Date.parse(g.expires), iss = Date.parse(g.issuedAt);
    if (!Number.isFinite(exp) || exp <= now.getTime()) { reason = "the grant has expired"; continue; }
    if (!Number.isFinite(iss) || iss > now.getTime()) { reason = "the grant is not valid yet"; continue; }
    const outside = req.components.filter((c) => !g.components.includes(c));
    if (outside.length) { reason = `the grant does not cover ${outside.join(", ")}`; continue; }
    const left = { downloadBytes: g.ceiling.downloadBytes - s.spent.downloadBytes, expandedBytes: g.ceiling.expandedBytes - s.spent.expandedBytes };
    if (req.cost.downloadBytes > left.downloadBytes || req.cost.expandedBytes > left.expandedBytes) {
      reason = `the grant's ceiling is used up: ${left.downloadBytes} bytes of download and ${left.expandedBytes} bytes of disk are left, the request needs ${req.cost.downloadBytes} and ${req.cost.expandedBytes}`;
      continue;
    }
    return { allow: true, via: "grant", grantId: g.grantId };
  }
  return stop(req, "grant-required", [err("E_NOT_PERMITTED", "/operation", `install_component needs a human grant (${reason}); ${neededGrant(req)}`)]);
}
