import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./canonical";
import { allCases, validateHostConfiguration, type HostConfiguration } from "./fileRunHost";
import { inside, readHostJson, regularFile } from "./hostFiles";
import { expandSampling, type SamplingDefinition } from "./sampling";
import {
  MAX_PENDING_PER_ACTOR, MAX_PROPOSALS, PROPOSAL_ID, appendProposalEvent, definitionHash, foldProposals, readProposalLog, type ProposalActor, type ProposalState
} from "./samplingProposal";
import type { TypedError } from "./validate";

/**
 * Propose, look at, approve and reject samplings (docs/sampling.md). The agent verbs are `propose` and `status`; `approve` and `reject` are the admin
 * CLI's and need a human host identity. An agent can never approve: the verb is not in the agent CLI or the MCP server, and the host refuses an actor
 * that is not a human. Approval names the definition hash the person read, so what is approved is exactly what was proposed.
 */
export type ProposalOutcome<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; errors: TypedError[] };
const refuse = (message: string, code = "E_NOT_PERMITTED", field = ""): { ok: false; errors: TypedError[] } => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });
const MAX_DEFINITION_BYTES = 20_000;

type Loaded = { c: HostConfiguration; state: string };
function load(file: string): Loaded | { ok: false; errors: TypedError[] } {
  if (!isAbsolute(file)) return refuse("the host configuration path must be absolute", "E_SETUP_REQUIRED");
  regularFile(file);
  const c = validateHostConfiguration(readHostJson(file));
  const projectRoot = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
  if (inside(projectRoot, realpathSync(file)) || inside(projectRoot, state)) return refuse("host files must be outside the project", "E_SETUP_REQUIRED");
  return { c, state };
}
const isFailure = (x: Loaded | { ok: false; errors: TypedError[] }): x is { ok: false; errors: TypedError[] } => "ok" in x;
const guard = <T>(fn: () => ProposalOutcome<T>): ProposalOutcome<T> => {
  try { return fn(); } catch (e) { return refuse(e instanceof Error ? e.message : "sampling proposal failed", "E_SETUP_REQUIRED"); }
};
const actorOf = (c: HostConfiguration): ProposalActor => ({ kind: c.actor.kind, name: c.actor.name, ...("model" in c.actor && typeof c.actor.model === "string" ? { model: c.actor.model } : {}) });

/** What a reader needs to judge a proposal. */
export function describe(p: ProposalState) {
  return { proposalId: p.proposalId, state: p.state, proposedBy: p.proposedBy, definitionSha256: p.definitionSha256, definition: p.definition, ...(p.note ? { note: p.note } : {}), ...(p.decidedBy ? { decidedBy: p.decidedBy } : {}), ...(p.reason ? { reason: p.reason } : {}) };
}

/** Agent: proposes a sampling. The definition is checked exactly as a registered one is (bounds, distributions, budget), so a proposal that could not run is refused now. */
export function proposeSamplingFromHost(file: string, request: unknown): ProposalOutcome<{ proposalId: string; state: "pending"; definitionSha256: string; runs: number }> {
  return guard(() => {
    const r = request as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["proposalId", "definition", "note"].includes(k)) || typeof r.proposalId !== "string" || !PROPOSAL_ID.test(r.proposalId) || r.definition === null || typeof r.definition !== "object")
      return refuse("a proposal is { proposalId, definition, note? }: the id is 1 to 56 letters, digits, dots, dashes or underscores", "E_SCHEMA_INVALID");
    if (r.note !== undefined && (typeof r.note !== "string" || r.note.length > 500)) return refuse("the note is at most 500 characters", "E_SCHEMA_INVALID", "/note");
    if (canonicalJson(r.definition).length > MAX_DEFINITION_BYTES) return refuse(`the definition is over ${MAX_DEFINITION_BYTES} characters`, "E_SCHEMA_INVALID", "/definition");
    const loaded = load(file);
    if (isFailure(loaded)) return loaded;
    const { c, state } = loaded;
    const id = r.proposalId;
    if ((c.samplings && Object.hasOwn(c.samplings, id)) || Object.hasOwn(c.cases, id) || (c.sweeps && Object.hasOwn(c.sweeps, id))) return refuse(`the id ${id} is already a case, a sweep or a sampling of this host`, "E_REQUEST_CONFLICT", "/proposalId");
    const def = r.definition as SamplingDefinition;
    const expanded = expandSampling(id, def, c.cases, c.study);
    if (!expanded.ok) return { ok: false, errors: expanded.errors };
    const taken = allCases(c);
    const clash = expanded.cases.find((x) => Object.hasOwn(taken, x.caseId));
    if (clash) return refuse(`the point ${clash.caseId} of this proposal has the id of a case that is already registered; use another proposal id`, "E_REQUEST_CONFLICT", "/proposalId");
    const actor = actorOf(c);
    const made = appendProposalEvent(state, (rows) => {
      const all = foldProposals(rows);
      if (all.some((p) => p.proposalId === id)) return { refuse: `the proposal id ${id} was used before; use a new id` };
      if (all.length >= MAX_PROPOSALS) return { refuse: "the sampling proposal log holds its limit of proposals; a person archives it" };
      if (all.filter((p) => p.state === "pending" && p.proposedBy.name === actor.name && p.proposedBy.kind === actor.kind).length >= MAX_PENDING_PER_ACTOR) return { refuse: `${actor.name} has ${MAX_PENDING_PER_ACTOR} proposals waiting for a person; wait for a decision` };
      const hash = definitionHash(def);
      return { event: { type: "proposed" as const, proposalId: id, actor, definition: def, definitionSha256: hash, ...(typeof r.note === "string" ? { note: r.note } : {}) }, value: hash };
    });
    if (!made.ok) return refuse(made.message, "E_REQUEST_CONFLICT");
    return { ok: true, proposalId: id, state: "pending", definitionSha256: made.value as string, runs: expanded.cases.length };
  });
}

/** Agent or person: one proposal, or all of them. */
export function samplingProposalStatus(file: string, request: unknown): ProposalOutcome<{ proposals: ReturnType<typeof describe>[] }> {
  return guard(() => {
    const r = (request ?? {}) as Record<string, unknown>;
    if (typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => k !== "proposalId") || (r.proposalId !== undefined && (typeof r.proposalId !== "string" || !PROPOSAL_ID.test(r.proposalId))))
      return refuse("the request is {} or { proposalId }", "E_SCHEMA_INVALID");
    const loaded = load(file);
    if (isFailure(loaded)) return loaded;
    const all = foldProposals(readProposalLog(loaded.state));
    const shown = r.proposalId === undefined ? all : all.filter((p) => p.proposalId === r.proposalId);
    if (r.proposalId !== undefined && shown.length === 0) return refuse(`no proposal ${String(r.proposalId)}`, "E_NOT_FOUND", "/proposalId");
    return { ok: true, proposals: shown.map(describe) };
  });
}

function decide(file: string, request: unknown, kind: "approved" | "rejected"): ProposalOutcome<{ proposalId: string; state: "approved" | "rejected" }> {
  return guard(() => {
    const r = request as Record<string, unknown> | null;
    const keys = kind === "approved" ? ["proposalId", "definitionSha256"] : ["proposalId", "reason"];
    if (r === null || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !keys.includes(k)) || typeof r.proposalId !== "string" || !PROPOSAL_ID.test(r.proposalId)) return refuse(`the request is { ${keys.join(", ")} }`, "E_SCHEMA_INVALID");
    if (kind === "approved" && (typeof r.definitionSha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.definitionSha256))) return refuse("approval names the definitionSha256 of the proposal the person read", "E_SCHEMA_INVALID", "/definitionSha256");
    if (kind === "rejected" && r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > 300)) return refuse("the reason is at most 300 characters", "E_SCHEMA_INVALID", "/reason");
    const loaded = load(file);
    if (isFailure(loaded)) return loaded;
    const { c, state } = loaded;
    if (c.actor.kind !== "human") return refuse("a sampling is approved or rejected only by a human host identity");
    const id = r.proposalId;
    const made = appendProposalEvent(state, (rows) => {
      const p = foldProposals(rows).find((x) => x.proposalId === id);
      if (!p) return { refuse: `no proposal ${id}` };
      if (p.state !== "pending") return { refuse: `${id} is already ${p.state}` };
      if (kind === "approved") {
        if (p.definitionSha256 !== r.definitionSha256) return { refuse: "the hash is not the one of this proposal: read it again with the status verb" };
        // the definition must still be valid under today's host configuration (study bounds and budget can have changed since it was proposed)
        const again = expandSampling(id, p.definition, c.cases, c.study);
        if (!again.ok) return { refuse: "the proposal no longer fits this host: " + again.errors.map((e) => e.message).join("; ") };
        // a case registered since the proposal may now hold the id of one of its points; allCases would keep that case and the sampling would run it
        const taken = allCases(c);
        const clash = again.cases.find((x) => Object.hasOwn(taken, x.caseId));
        if (clash) return { refuse: `the point ${clash.caseId} of this proposal now has the id of a case that is registered; nothing is approved` };
        return { event: { type: "approved" as const, proposalId: id, by: actorOf(c), definitionSha256: p.definitionSha256 }, value: undefined };
      }
      return { event: { type: "rejected" as const, proposalId: id, by: actorOf(c), ...(typeof r.reason === "string" ? { reason: r.reason } : {}) }, value: undefined };
    });
    if (!made.ok) return refuse(made.message, "E_REQUEST_CONFLICT");
    return { ok: true, proposalId: id, state: kind === "approved" ? "approved" : "rejected" };
  });
}
export const approveSamplingFromHost = (file: string, request: unknown) => decide(file, request, "approved");
export const rejectSamplingFromHost = (file: string, request: unknown) => decide(file, request, "rejected");
