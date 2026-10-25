import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./canonical";
import { MAX_HOST_FILE, regularFile, safeChild } from "./hostFiles";
import { withProjectLock } from "./projectStore";
import type { SamplingDefinition } from "./sampling";

/**
 * Sampling proposals (docs/sampling.md, "Who may design a sampling"). An agent may PROPOSE a sampling: a base case, a design, distributions and
 * outputs. Nothing runs until a person APPROVES that exact proposal. The log is one hash-chained file, `sampling-proposals.jsonl`, in the host's
 * state folder (outside every project and study; written only by the host's propose verb and by the admin verbs), read as a whole or refused
 * as a whole, like the install grants. An approved proposal is a registered sampling of its own: the run path looks it up here when the host
 * configuration has no sampling of that id.
 */
export type ProposalActor = { kind: string; name: string; model?: string };
export type ProposalEvent =
  | { type: "proposed"; proposalId: string; actor: ProposalActor; definition: SamplingDefinition; definitionSha256: string; note?: string; /** digest of the registered base case the definition was checked against; approval and every run compare it */ baseCaseSha256?: string }
  | { type: "approved"; proposalId: string; by: ProposalActor; definitionSha256: string }
  | { type: "rejected"; proposalId: string; by: ProposalActor; reason?: string }
  | { type: "withdrawn"; proposalId: string; by: ProposalActor };
export type ProposalRow = { schema: "seed.sampling-proposal-log/0.1"; seq: number; time: string; prev: string | null; event: ProposalEvent; hash: string };
const FILE = "sampling-proposals.jsonl";
export const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
export const MAX_PENDING_PER_ACTOR = 10;
export const MAX_PROPOSALS = 500;

export const definitionHash = (def: SamplingDefinition) => sha256Hex(canonicalJson(def));

export function readProposalLog(stateRoot: string): ProposalRow[] {
  const file = safeChild(stateRoot, FILE);
  const rows: ProposalRow[] = [];
  if (!existsSync(file)) return rows;
  regularFile(file);
  const text = readFileSync(file, "utf8");
  if (text && !text.endsWith("\n")) throw Error("the sampling proposal log has a partial final line");
  let seq = 0;
  let prev: string | null = null;
  const proposed = new Map<string, string>(); // proposalId -> definition hash
  const ended = new Set<string>();
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    const row = JSON.parse(line) as ProposalRow;
    const { hash, ...body } = row;
    if (row.schema !== "seed.sampling-proposal-log/0.1" || row.seq !== seq + 1 || row.prev !== prev || sha256Hex(canonicalJson(body)) !== hash) throw Error("the sampling proposal log hash chain is invalid");
    const e = row.event as ProposalEvent;
    if (e.type === "proposed") {
      if (typeof e.proposalId !== "string" || proposed.has(e.proposalId)) throw Error("the sampling proposal log proposes an id twice or without one");
      if (definitionHash(e.definition) !== e.definitionSha256) throw Error("a proposal in the sampling proposal log does not match its own hash");
      proposed.set(e.proposalId, e.definitionSha256);
    } else if (e.type === "approved" || e.type === "rejected" || e.type === "withdrawn") {
      if (!proposed.has(e.proposalId)) throw Error(`the sampling proposal log has a ${e.type} event for a proposal that was not made before`);
      if (ended.has(e.proposalId)) throw Error(`the sampling proposal log decides ${e.proposalId} twice`);
      if (e.type === "approved" && e.definitionSha256 !== proposed.get(e.proposalId)) throw Error(`the approval of ${e.proposalId} is not for the definition that was proposed`);
      ended.add(e.proposalId);
    } else throw Error("the sampling proposal log has an event of an unknown type");
    seq = row.seq;
    prev = row.hash;
    rows.push(row);
  }
  return rows;
}

export type ProposalState = { proposalId: string; state: "pending" | "approved" | "rejected" | "withdrawn"; proposedBy: ProposalActor; definition: SamplingDefinition; definitionSha256: string; baseCaseSha256?: string; note?: string; decidedBy?: ProposalActor; reason?: string };

/** Every proposal as the log leaves it, in the order they were made. */
export function foldProposals(rows: readonly ProposalRow[]): ProposalState[] {
  const out = new Map<string, ProposalState>();
  for (const { event: e } of rows) {
    if (e.type === "proposed") out.set(e.proposalId, { proposalId: e.proposalId, state: "pending", proposedBy: e.actor, definition: e.definition, definitionSha256: e.definitionSha256, ...(e.baseCaseSha256 ? { baseCaseSha256: e.baseCaseSha256 } : {}), ...(e.note ? { note: e.note } : {}) });
    else {
      const s = out.get(e.proposalId);
      if (!s) continue;
      s.state = e.type === "approved" ? "approved" : e.type === "rejected" ? "rejected" : "withdrawn";
      s.decidedBy = e.by;
      if (e.type === "rejected" && e.reason) s.reason = e.reason;
    }
  }
  return [...out.values()];
}

/** The approved definition registered under `id`, or undefined. The log is read whole: a damaged log throws, and nothing is registered under it. */
export function approvedSampling(stateRoot: string, id: string): SamplingDefinition | undefined {
  const s = foldProposals(readProposalLog(stateRoot)).find((p) => p.proposalId === id);
  return s?.state === "approved" ? s.definition : undefined;
}

/** The digest of the base case an approved proposal was made against, or undefined (not approved, or a proposal from before the digest was kept). */
export function approvedBaseDigest(stateRoot: string, id: string): string | undefined {
  const s = foldProposals(readProposalLog(stateRoot)).find((p) => p.proposalId === id);
  return s?.state === "approved" ? s.baseCaseSha256 : undefined;
}

/** The digest that stands for a registered case: the same case under the same id in another host configuration has the same digest. */
export const caseDigest = (registered: unknown) => sha256Hex(canonicalJson(registered));

/** Every approved definition with its id, in the order they were proposed. A damaged log throws. */
export function approvedSamplings(stateRoot: string): [string, SamplingDefinition][] {
  return foldProposals(readProposalLog(stateRoot)).filter((p) => p.state === "approved").map((p) => [p.proposalId, p.definition]);
}

/** Appends one event under the writer lock of the state folder; `make` sees the log as it is under the lock and may refuse with a message. */
export function appendProposalEvent<T>(stateRoot: string, make: (rows: readonly ProposalRow[]) => { event: ProposalEvent; value: T } | { refuse: string }, now: () => Date = () => new Date()): { ok: true; value: T; row: ProposalRow } | { ok: false; message: string } {
  mkdirSync(stateRoot, { recursive: true });
  const locked = withProjectLock(stateRoot, () => {
    const file = safeChild(stateRoot, FILE);
    const rows = readProposalLog(stateRoot);
    const made = make(rows);
    if ("refuse" in made) return { ok: false as const, message: made.refuse };
    const body = { schema: "seed.sampling-proposal-log/0.1" as const, seq: rows.length + 1, time: now().toISOString(), prev: rows.at(-1)?.hash ?? null, event: made.event };
    const row: ProposalRow = { ...body, hash: sha256Hex(canonicalJson(body)) };
    const bytes = Buffer.from(JSON.stringify(row) + "\n");
    if (existsSync(file) && lstatSync(file).size + bytes.length > MAX_HOST_FILE) return { ok: false as const, message: "the sampling proposal log is full; archive it through trusted host maintenance" };
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      let off = 0;
      while (off < bytes.length) {
        const n = writeSync(fd, bytes, off, bytes.length - off);
        if (n <= 0) throw Error("the sampling proposal log write made no progress");
        off += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true as const, value: made.value, row };
  }, { waitMs: 5000 });
  if (!locked.ok) return { ok: false, message: locked.errors.map((e) => e.message).join("; ") };
  return locked.value;
}
