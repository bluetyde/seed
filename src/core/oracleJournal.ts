/**
 * The oracle evaluation journal (L1, docs/policy-and-oracles.md "Failed evaluations"). The host runs studies on a hash-pinned, human-approved
 * evidence file. Before this journal a later failing evaluation of the same, unchanged inputs was not kept anywhere, so the old passing file
 * went on clearing the gate. Now every recorded evaluation is a row of an append-only, hash-chained file in the host's state folder, and:
 *
 *  - a recorded **failure** for the current pins (app commit, oracle files, adapter version) blocks run operations and transfers;
 *  - a later **pass never clears** it: otherwise an agent could re-run a noisy set until it passed. Only a human's **clearance**, naming the
 *    failure's row hash and giving a reason, does;
 *  - a journal that cannot be read, or whose chain is broken, blocks (fail closed);
 *  - a failure recorded for other pins (an older app commit) has no effect on the current ones.
 *
 * The journal is written only by the human-only admin CLI; an agent-facing tool cannot append to it.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sha256Hex } from "./canonical";
import { appendAdmission, inside, readAdmissions, regularFile, safeChild } from "./hostFiles";
import { comparePins, type PinSet, type SetResult } from "./oracle";
import type { Actor } from "./policy";

export type EvaluationEvent = {
  type: "evaluation";
  adapter: string;
  adapterVersion: string;
  verdict: "pass" | "fail";
  pins: PinSet;
  /** Entries that did not pass (at most 50), so the row says what failed without the whole result. */
  failed: { oracleId: string; entryVersion: number; tag: string; verdict: string; reason?: string }[];
  resultSha256: string;
  actor: { kind: string; name: string };
};
export type ClearanceEvent = { type: "clearance"; clears: string; reason: string; actor: { kind: string; name: string } };
export type JournalBlock = { blocked: boolean; reason?: string; rowHash?: string; openFailures?: number };

/** The folder of one adapter's journal, created on first use. Refuses links and anything that leaves the state folder. */
export function journalRoot(state: string, adapterId: string, create = false): string | null {
  // the same pattern as an id in the contract; checked first, so an id that cannot name a folder is an error and not "no journal yet"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(adapterId)) throw Error("adapter id is not a valid journal name");
  const top = safeChild(state, "oracle-journal", true);
  if (!existsSync(top)) {
    if (!create) return null;
    mkdirSync(top);
  }
  const child = safeChild(top, adapterId, true);
  if (!existsSync(child)) {
    if (!create) return null;
    mkdirSync(child);
  }
  return child;
}

const failing = (r: SetResult): boolean => r.verdict !== "pass" || r.blocked !== false || r.inputsVerified !== true;

/**
 * Is a recorded failure standing against these pins? Reads the whole journal every time; a journal that is unreadable or whose chain is
 * broken counts as blocked, with that as the reason.
 */
export function journalBlock(state: string, adapterId: string, adapterVersion: string, currentPins: PinSet): JournalBlock {
  let root: string | null;
  try {
    root = journalRoot(state, adapterId);
  } catch {
    return { blocked: true, reason: "the oracle journal location is not usable" };
  }
  if (root === null) return { blocked: false };
  let rows;
  try {
    rows = readAdmissions(root);
  } catch {
    return { blocked: true, reason: "the oracle journal is unreadable or its hash chain is broken" };
  }
  // Every failure that stands, oldest first: a clearance removes only the one it names, so clearing the newest never hides an older one.
  const open = new Map<string, string>();
  for (const row of rows) {
    const e = row.event as Record<string, any> | null;
    if (e === null || typeof e !== "object") return { blocked: true, reason: "the oracle journal has a malformed row" };
    if (e.type === "evaluation") {
      if (e.adapterVersion !== adapterVersion || e.pins === undefined || comparePins(e.pins, currentPins).length > 0) continue;
      if (e.verdict === "fail") open.set(row.hash, `a recorded oracle evaluation failed (${row.time})`);
      // a pass does not clear a failure: only a human's clearance does
    } else if (e.type === "clearance") {
      // only a human's clearance counts: a row written by anyone else leaves the failure standing
      if (typeof e.clears === "string" && e.actor !== null && typeof e.actor === "object" && e.actor.kind === "human") open.delete(e.clears);
    } else {
      return { blocked: true, reason: "the oracle journal has a row of an unknown kind" };
    }
  }
  if (open.size === 0) return { blocked: false };
  // the newest standing failure is the one a clearance names first; the others stay until each is cleared
  const [hash, reason] = [...open.entries()][open.size - 1]!;
  return { blocked: true, reason, rowHash: hash, openFailures: open.size };
}

/** Appends one evaluation. A set that did not run says nothing and is refused. The caller has checked who may record. */
export function recordEvaluation(state: string, adapter: { id: string; version: string }, result: SetResult, resultSha256: string, actor: Actor) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.results) || result.pins === undefined) throw Error("not an oracle set result");
  if (result.adapter !== adapter.id) throw Error("the result is for another adapter");
  if (result.adapterVersion !== adapter.version) throw Error("the result is for another adapter version");
  if (result.verdict === "not-run") throw Error("a set that did not run says nothing; run it first");
  if (result.verdict !== "pass" && result.verdict !== "fail") throw Error("the result has no verdict");
  const bad = failing(result);
  const event: EvaluationEvent = {
    type: "evaluation",
    adapter: result.adapter,
    adapterVersion: result.adapterVersion,
    verdict: bad ? "fail" : "pass",
    pins: result.pins,
    failed: result.results
      .filter((r) => r.verdict !== "pass")
      .slice(0, 50)
      .map((r) => ({ oracleId: r.oracleId, entryVersion: r.entryVersion, tag: r.tag, verdict: r.verdict, ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}) })),
    resultSha256,
    actor: { kind: actor.kind, name: actor.name },
  };
  return appendAdmission(journalRoot(state, adapter.id, true)!, event);
}

/** Appends a clearance of the failure that is blocking now. Refused when `rowHash` is not that failure. The caller has checked the actor is a human. */
export function clearFailure(state: string, adapter: { id: string; version: string }, currentPins: PinSet, rowHash: string, reason: string, actor: Actor) {
  if (actor.kind !== "human") throw Error("only a human clears a recorded failure");
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) throw Error("a clearance needs a reason of 3 to 500 characters");
  const now = journalBlock(state, adapter.id, adapter.version, currentPins);
  if (!now.blocked || now.rowHash === undefined) throw Error("no recorded failure is blocking these pins");
  if (now.rowHash !== rowHash) throw Error("that is not the failure that is blocking now");
  const event: ClearanceEvent = { type: "clearance", clears: rowHash, reason: reason.trim(), actor: { kind: actor.kind, name: actor.name } };
  return appendAdmission(journalRoot(state, adapter.id, true)!, event);
}

/** Reads a result file for recording: a bounded regular file, outside the project, with its hash. */
export function readResultFile(path: string, project: string): { result: SetResult; sha256: string } {
  if (typeof path !== "string" || !isAbsolute(path)) throw Error("resultFile must be an absolute path");
  regularFile(path);
  if (inside(project, realpathSync(path))) throw Error("an oracle result must live outside the project");
  // a second name for the same file (a hard link) could be a file of the project under a path outside it
  if (statSync(path).nlink > 1) throw Error("an oracle result must not be a linked file");
  const bytes = readFileSync(path);
  return { result: JSON.parse(bytes.toString("utf8")) as SetResult, sha256: sha256Hex(bytes) };
}

