/**
 * The oracle evidence a host holds for one app, and what it means for the policy gate. One place for the rule that a failed oracle set,
 * or pins changed since a human accepted them, block run operations and transfers (docs/policy-and-oracles.md).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sha256Hex } from "./canonical";
import { regularFile } from "./hostFiles";
import { checkOracleInputs, comparePins, latestEntries, loadOracleEntries, pinsOf, type PinSet, type SetResult } from "./oracle";

export type OracleSource = { repository: string; entriesDir: string; inputsRoot: string; evidenceFile: string; evidenceSha256: string };
export type OracleAuthority = { currentPins: PinSet; oracleResult: SetResult };

/** Reads the hash-pinned evidence file and the current entries and app commit. Throws with a reason when anything cannot be verified. */
export function loadOracleAuthority(o: OracleSource, adapterId: string): OracleAuthority {
  regularFile(o.evidenceFile);
  const bytes = readFileSync(o.evidenceFile);
  if (sha256Hex(bytes) !== o.evidenceSha256) throw Error("oracle evidence changed since host approval");
  const result = JSON.parse(bytes.toString("utf8")) as SetResult;
  const entries = loadOracleEntries(o.entriesDir);
  if (entries.errors.length) throw Error("oracle entry could not be verified");
  const currentEntries = latestEntries(entries.entries, adapterId);
  for (const item of currentEntries) if (checkOracleInputs(item.entry, o.inputsRoot).length) throw Error("oracle inputs changed");
  const git = spawnSync("git", ["-C", o.repository, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 });
  if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim())) throw Error("could not determine app commit");
  return { currentPins: pinsOf(currentEntries, git.stdout.trim()), oracleResult: result };
}

/** The two gate flags for one app: pins changed since accepted, and the oracle set not clear. */
export function oracleFlags(
  a: { acceptedPins?: PinSet; currentPins: PinSet; oracleResult?: SetResult },
  adapter: { id: string; version: string },
): { pinsChanged: boolean; oracleBlocked: boolean } {
  const result = a.oracleResult;
  const pinsChanged =
    !a.acceptedPins || comparePins(a.acceptedPins, a.currentPins).length > 0 || !result || comparePins(result.pins, a.currentPins).length > 0;
  const oracleBlocked =
    !/^[0-9a-f]{40}$/.test(a.currentPins.appCommit) ||
    a.currentPins.oracleFiles.some(
      (pin) => !/^[0-9a-f]{64}$/.test(pin.sha256) || !result?.results.some((r) => r.oracleId === pin.oracleId && r.entryVersion === pin.entryVersion),
    ) ||
    !result ||
    result.blocked !== false ||
    result.verdict !== "pass" ||
    result.inputsVerified !== true ||
    result.adapter !== adapter.id ||
    result.adapterVersion !== adapter.version ||
    !result.results.some((r) => r.tag === "good" && r.verdict === "pass") ||
    result.results.some((r) => r.tag !== "known-limit" && r.verdict !== "pass") ||
    a.currentPins.oracleFiles.length === 0;
  return { pinsChanged, oracleBlocked };
}
