import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inside, readHostJson, regularFile } from "./hostFiles";
import { validateHostConfiguration } from "./fileRunHost";
import { loadOracleAuthority } from "./oracleAuthority";
import { clearFailure, journalBlock, readResultFile, recordEvaluation } from "./oracleJournal";

/** Human-only verbs of the admin CLI for the oracle evaluation journal (L1). Each needs a host configuration whose actor is a human. */
type Outcome = { ok: true; [k: string]: unknown } | { ok: false; errors: { code: string; field: string; message: string; source: "seed" }[] };
const fail = (message: string, code = "E_NOT_PERMITTED"): Outcome => ({ ok: false, errors: [{ code, field: "", message, source: "seed" }] });

function open(file: string) {
  if (!isAbsolute(file)) throw Object.assign(Error("SEED_ADMIN_HOST_CONFIG must be an absolute path"), { code: "E_SETUP_REQUIRED" });
  regularFile(file);
  const c = validateHostConfiguration(readHostJson(file));
  if (c.actor.kind !== "human") throw Error("the oracle journal is written only by a human host identity");
  const project = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
  if (inside(project, realpathSync(file)) || inside(project, state)) throw Error("host files must be outside the project");
  return { c, project, state };
}
function wrap(body: () => Outcome): Outcome {
  try {
    return body();
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return fail(e instanceof Error ? e.message : "oracle journal operation failed", typeof code === "string" && /^E_[A-Z_]+$/.test(code) ? code : "E_NOT_PERMITTED");
  }
}
const only = (request: unknown, keys: string[]): Record<string, unknown> => {
  if (request === null || typeof request !== "object" || Array.isArray(request) || Object.keys(request).sort().join() !== [...keys].sort().join()) {
    throw Object.assign(Error(`the request has exactly these fields: ${keys.join(", ")}`), { code: "E_SCHEMA_INVALID" });
  }
  return request as Record<string, unknown>;
};

/** Records one evaluation (a result file of an oracle set run) in the journal. A failure then blocks the gate until a human clears it. */
export function recordOracleEvaluation(file: string, request: unknown): Outcome {
  return wrap(() => {
    const { c, project, state } = open(file);
    const r = only(request, ["resultFile"]);
    const { result, sha256 } = readResultFile(r.resultFile as string, project);
    const row = recordEvaluation(state, c.adapter, result, sha256, c.actor);
    const ev = row.event as { verdict: string; failed: unknown[] };
    return { ok: true, state: ev.verdict === "pass" ? "recorded-pass" : "recorded-failure", rowHash: row.hash, seq: row.seq, failed: ev.failed.length };
  });
}

/** Clears the failure that is blocking now; names its row hash and gives a reason. */
export function clearOracleFailure(file: string, request: unknown): Outcome {
  return wrap(() => {
    const { c, state } = open(file);
    const r = only(request, ["rowHash", "reason"]);
    const auth = loadOracleAuthority(c.oracles, c.adapter.id);
    const row = clearFailure(state, c.adapter, auth.currentPins, String(r.rowHash), String(r.reason), c.actor);
    return { ok: true, state: "cleared", rowHash: row.hash, seq: row.seq };
  });
}

/** What the journal says about the current pins. */
export function oracleJournalStatus(file: string, request: unknown): Outcome {
  return wrap(() => {
    const { c, state } = open(file);
    only(request, []);
    const auth = loadOracleAuthority(c.oracles, c.adapter.id);
    const b = journalBlock(state, c.adapter.id, c.adapter.version, auth.currentPins);
    return { ok: true, state: b.blocked ? "blocked" : "clear", ...(b.reason ? { reason: b.reason } : {}), ...(b.rowHash ? { rowHash: b.rowHash } : {}) };
  });
}
