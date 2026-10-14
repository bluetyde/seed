// The replay policy of an adapter (docs/replay.md): how close a second run of the same case must be to count as the same result. It lives in
// SEED, in `adapters/<id>/replay.json` beside the adapter, because it is SEED's judgment about the app and not something a run or a client may
// supply. A missing or malformed file refuses the replay: there is no default policy, because a default would decide what "the same" means for
// an adapter nobody has looked at.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validReplayPolicy, type ReplayPolicy } from "./replay";
import type { TypedError } from "./validate";

export const REPLAY_POLICY_SCHEMA = "seed.replay-policy/0.1";
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_BYTES = 16 * 1024;

export type ReplayPolicyFile = { adapter: string; policy: ReplayPolicy; basis: string };
export type ReplayPolicyResult = ({ ok: true } & ReplayPolicyFile) | { ok: false; errors: TypedError[] };

const refuse = (code: string, message: string, field = ""): ReplayPolicyResult => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });
/**
 * Where the policies are: the `adapters` folder of this installation, or the absolute folder the trusted environment names in SEED_REPLAY_POLICY_DIR
 * (a host setting like SEED_HOST_CONFIG; a client of the CLI or MCP cannot set it).
 */
export const defaultAdaptersDir = (): string => {
  const set = process.env.SEED_REPLAY_POLICY_DIR;
  return set && isAbsolute(set) ? set : join(__dirname, "..", "..", "adapters");
};

/** Reads and checks `<adaptersDir>/<adapterId>/replay.json`. Never throws for a bad file; says what is wrong. */
export function loadReplayPolicy(adapterId: string, adaptersDir: string = defaultAdaptersDir()): ReplayPolicyResult {
  if (typeof adapterId !== "string" || !ID.test(adapterId)) return refuse("E_SCHEMA_INVALID", "the adapter id is not a valid id", "/adapter");
  const file = join(adaptersDir, adapterId, "replay.json");
  if (!existsSync(file)) {
    return refuse("E_SETUP_REQUIRED", `no replay policy for adapter ${adapterId} (expected ${join("adapters", adapterId, "replay.json")}); a replay is refused until the adapter has one`);
  }
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return refuse("E_SETUP_REQUIRED", `the replay policy of adapter ${adapterId} is not a regular file`);
    if (st.size > MAX_BYTES) return refuse("E_SCHEMA_INVALID", `the replay policy of adapter ${adapterId} is larger than ${MAX_BYTES} bytes`);
    text = readFileSync(file, "utf8");
  } catch (e) {
    return refuse("E_SETUP_REQUIRED", `the replay policy of adapter ${adapterId} cannot be read: ${(e as Error).message}`);
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { return refuse("E_SCHEMA_INVALID", `the replay policy of adapter ${adapterId} is not JSON: ${(e as Error).message}`); }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return refuse("E_SCHEMA_INVALID", "the replay policy must be an object");
  const d = doc as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => !["schema", "adapter", "policy", "basis"].includes(k));
  if (extra.length) return refuse("E_SCHEMA_INVALID", `the replay policy has fields it does not know: ${extra.join(", ")}`, `/${extra[0]}`);
  if (d.schema !== REPLAY_POLICY_SCHEMA) return refuse("E_SCHEMA_VERSION", `the replay policy schema must be ${REPLAY_POLICY_SCHEMA}`, "/schema");
  if (d.adapter !== adapterId) return refuse("E_SCHEMA_INVALID", `the replay policy file says it is for adapter ${String(d.adapter)}, not ${adapterId}`, "/adapter");
  if (typeof d.basis !== "string" || d.basis.trim().length < 10 || d.basis.length > 1000) return refuse("E_SCHEMA_INVALID", "the policy must say, in 10 to 1000 characters, why it was chosen", "/basis");
  const bad = validReplayPolicy(d.policy as ReplayPolicy);
  if (bad) return refuse("E_SCHEMA_INVALID", bad, "/policy");
  return { ok: true, adapter: adapterId, policy: d.policy as ReplayPolicy, basis: d.basis };
}
