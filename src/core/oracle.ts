import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { resolveInside } from "./paths";
import type { Actor } from "./policy";
import { checkOracleHash } from "./semantic";
import { validate, type TypedError } from "./validate";

export type OracleEntry = Record<string, unknown> & {
  oracleId: string;
  entryVersion: number;
  adapter: string;
  adapterVersions: string[];
  tag: "good" | "bad-input" | "known-limit";
  inputs: { path: string; sha256: string }[];
  expected: Record<string, unknown>;
  tolerance?: { abs: number; rel: number };
  coverage: { quantities: string[]; domain: string };
  toleranceHash: string;
};

export type IndexedOracle = { entry: OracleEntry; file: string; fileSha256: string };

export type Observed =
  | { kind: "value"; quantity: string; value: number; unit: string }
  | { kind: "refusal"; code: string }
  | { kind: "verdict"; verdict: string };

export type EntryVerdict = "pass" | "fail" | "not-run" | "invalid";

function err(code: string, field: string, message: string): TypedError {
  return { code, field, message, source: "seed" };
}

/** Compare one observation with an entry's expectation. Never throws. */
export function evaluateOracle(entry: OracleEntry, observed: unknown): { verdict: "pass" | "fail"; reason?: string } {
  const fail = (reason: string) => ({ verdict: "fail" as const, reason });
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return fail("observation is not an object");
  const o = observed as Record<string, unknown>;
  const exp = entry.expected;
  if ("value" in exp) {
    if (o.kind !== "value") return fail(`expected a value, observed ${String(o.kind)}`);
    if (o.quantity !== exp.quantity) return fail(`quantity ${String(o.quantity)} is not ${String(exp.quantity)}`);
    if (o.unit !== exp.unit) return fail(`unit ${String(o.unit)} is not ${String(exp.unit)}`);
    const want = exp.value;
    const got = o.value;
    if (typeof got !== "number" || !Number.isFinite(got)) return fail("observed value is not a finite number");
    if (typeof want !== "number" || !Number.isFinite(want) || entry.tolerance === undefined) return fail("entry has no usable value or tolerance");
    const limit = entry.tolerance.abs + entry.tolerance.rel * Math.abs(want);
    const diff = Math.abs(got - want);
    if (!Number.isFinite(limit) || !Number.isFinite(diff)) return fail("comparison overflowed; refusing to judge it");
    return diff <= limit ? { verdict: "pass" } : fail(`|${got} - ${want}| = ${diff} exceeds ${limit}`);
  }
  if ("refusalCode" in exp) {
    if (o.kind !== "refusal") return fail(`expected refusal ${String(exp.refusalCode)}, observed ${String(o.kind)}`);
    return o.code === exp.refusalCode ? { verdict: "pass" } : fail(`refusal ${String(o.code)} is not ${String(exp.refusalCode)}`);
  }
  if ("verdict" in exp) {
    if (o.kind !== "verdict") return fail(`expected verdict ${String(exp.verdict)}, observed ${String(o.kind)}`);
    return o.verdict === exp.verdict ? { verdict: "pass" } : fail(`verdict ${String(o.verdict)} is not ${String(exp.verdict)}`);
  }
  return fail("entry expects nothing recognisable");
}

/** Read every `*.json` entry in a folder (not recursive), validate it and check its tolerance pin. */
export function loadOracleEntries(dir: string): { entries: IndexedOracle[]; errors: TypedError[] } {
  const errors: TypedError[] = [];
  const entries: IndexedOracle[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { entries, errors: [err(code === "ENOENT" ? "E_NOT_FOUND" : "E_INTERNAL", "", `cannot list ${dir}: ${code ?? String(e)}`)] };
  }
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(dir, name);
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) continue;
      bytes = readFileSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      errors.push(err(code === "ENOENT" ? "E_NOT_FOUND" : "E_INTERNAL", name, `cannot read oracle file: ${code ?? String(e)}`));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      errors.push(err("E_SCHEMA_INVALID", name, "oracle file is not valid JSON"));
      continue;
    }
    const v = validate("oracle", parsed);
    if (!v.ok) {
      for (const e of v.errors) errors.push({ ...e, field: `${name}${e.field}` });
      continue;
    }
    const pin = checkOracleHash(parsed);
    if (pin.length > 0) {
      for (const e of pin) errors.push({ ...e, field: `${name}${e.field}` });
      continue;
    }
    const entry = parsed as OracleEntry;
    const key = `${entry.oracleId}@${entry.entryVersion}`;
    if (seen.has(key)) {
      errors.push(err("E_SCHEMA_INVALID", name, `duplicate oracle entry ${key}`));
      continue;
    }
    seen.add(key);
    entries.push({ entry, file: name, fileSha256: sha256Hex(bytes) });
  }
  return { entries, errors };
}

/** Each entry's declared inputs must exist under `baseDir` and hash to their pin. */
export function checkOracleInputs(entry: OracleEntry, baseDir: string): TypedError[] {
  const errors: TypedError[] = [];
  entry.inputs.forEach((input, i) => {
    const at = resolveInside(baseDir, input.path);
    if (!at.ok) {
      errors.push(err(at.error.code, `/inputs/${i}/path`, at.error.message));
      return;
    }
    let bytes: Buffer;
    try {
      const realBase = realpathSync(baseDir);
      const realFile = realpathSync(at.value);
      const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
      if (!norm(realFile).startsWith(norm(realBase.endsWith(sep) ? realBase : realBase + sep))) {
        errors.push(err("E_PATH_TRAVERSAL", `/inputs/${i}/path`, `${input.path} resolves outside the oracle folder`));
        return;
      }
      bytes = readFileSync(realFile);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      errors.push(err(code === "ENOENT" ? "E_NOT_FOUND" : "E_INTERNAL", `/inputs/${i}/path`, `cannot read ${input.path}: ${code ?? String(e)}`));
      return;
    }
    if (sha256Hex(bytes) !== input.sha256) errors.push(err("E_STALE_REVISION", `/inputs/${i}/sha256`, `${input.path} does not match its pinned hash`));
  });
  return errors;
}

export type PinSet = { appCommit: string; oracleFiles: { oracleId: string; entryVersion: number; sha256: string }[] };

export type SetResult = {
  adapter: string;
  adapterVersion: string;
  verdict: "pass" | "fail" | "not-run";
  /** False when no `baseDir` was given: entry inputs were not hash-checked, so the set can never clear the gate. */
  inputsVerified: boolean;
  /** True unless every run level 1-4 entry passed, at least one good entry ran and the inputs were verified. */
  blocked: boolean;
  /** Quantities whose known-limit entry failed: recorded, and those quantities are unverified. */
  blockedQuantities: string[];
  results: { oracleId: string; entryVersion: number; tag: string; verdict: EntryVerdict; reason?: string }[];
  pins: PinSet;
};

export type RunOracleSetOptions = {
  entries: IndexedOracle[];
  adapter: { id: string; version: string };
  appCommit: string;
  /** Where entry inputs live; their hashes are checked before each case runs. Without it the set cannot clear the gate. */
  baseDir?: string;
  run: (entry: OracleEntry) => Promise<Observed>;
};

/** The newest entryVersion of each oracleId for one adapter: old versions keep their old verdicts, they are not re-run. */
export function latestEntries(entries: readonly IndexedOracle[], adapterId: string): IndexedOracle[] {
  const best = new Map<string, IndexedOracle>();
  for (const item of entries) {
    if (item.entry.adapter !== adapterId) continue;
    const cur = best.get(item.entry.oracleId);
    if (cur === undefined || item.entry.entryVersion > cur.entry.entryVersion) best.set(item.entry.oracleId, item);
  }
  return [...best.values()].sort((a, b) => (a.entry.oracleId < b.entry.oracleId ? -1 : a.entry.oracleId > b.entry.oracleId ? 1 : 0));
}

export async function runOracleSet(opts: RunOracleSetOptions): Promise<SetResult> {
  const chosen = latestEntries(opts.entries, opts.adapter.id);
  const results: SetResult["results"] = [];
  const blockedQuantities = new Set<string>();
  let anyFail = false;
  let goodPassed = 0;
  for (const item of chosen) {
    // Work on a private copy: the callback gets its own copy, so it cannot change what the result is judged against.
    const e = JSON.parse(JSON.stringify(item.entry)) as OracleEntry;
    const base = { oracleId: e.oracleId, entryVersion: e.entryVersion, tag: e.tag };
    if (!e.adapterVersions.includes("*") && !e.adapterVersions.includes(opts.adapter.version)) {
      results.push({ ...base, verdict: "not-run", reason: `adapter version ${opts.adapter.version} is not covered` });
      continue;
    }
    const pin = checkOracleHash(e);
    const inputs = opts.baseDir === undefined ? [] : checkOracleInputs(e, opts.baseDir);
    const problems = [...pin, ...inputs];
    if (problems.length > 0) {
      anyFail = true;
      results.push({ ...base, verdict: "invalid", reason: problems.map((p) => `${p.field}: ${p.message}`).join("; ") });
      continue;
    }
    let verdict: "pass" | "fail";
    let reason: string | undefined;
    try {
      const out = evaluateOracle(e, await opts.run(JSON.parse(JSON.stringify(e)) as OracleEntry));
      verdict = out.verdict;
      reason = out.reason;
    } catch (caught) {
      verdict = "fail";
      reason = `adapter call failed: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    results.push(reason === undefined ? { ...base, verdict } : { ...base, verdict, reason });
    if (verdict === "fail") {
      if (e.tag === "known-limit") for (const q of e.coverage.quantities) blockedQuantities.add(q);
      else anyFail = true;
    } else if (e.tag === "good") {
      goodPassed++;
    }
  }
  const ran = results.some((r) => r.verdict === "pass" || r.verdict === "fail");
  const verdict: SetResult["verdict"] = anyFail ? "fail" : ran ? "pass" : "not-run";
  return {
    adapter: opts.adapter.id,
    adapterVersion: opts.adapter.version,
    verdict,
    inputsVerified: opts.baseDir !== undefined,
    blocked: verdict !== "pass" || goodPassed === 0 || opts.baseDir === undefined,
    blockedQuantities: [...blockedQuantities].sort(),
    results,
    pins: pinsOf(chosen, opts.appCommit)
  };
}

export function pinsOf(entries: readonly IndexedOracle[], appCommit: string): PinSet {
  return {
    appCommit,
    oracleFiles: entries
      .map((i) => ({ oracleId: i.entry.oracleId, entryVersion: i.entry.entryVersion, sha256: i.fileSha256 }))
      .sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : a.entryVersion - b.entryVersion))
  };
}

/** What changed since a human last accepted the pins. An empty list means nothing changed. */
export function comparePins(accepted: PinSet, current: PinSet): string[] {
  const changes: string[] = [];
  if (accepted.appCommit !== current.appCommit) changes.push(`app commit ${accepted.appCommit} -> ${current.appCommit}`);
  const key = (f: { oracleId: string; entryVersion: number }) => `${f.oracleId}@${f.entryVersion}`;
  const before = new Map(accepted.oracleFiles.map((f) => [key(f), f.sha256]));
  const after = new Map(current.oracleFiles.map((f) => [key(f), f.sha256]));
  for (const [k, sha] of after) {
    if (!before.has(k)) changes.push(`new oracle entry ${k}`);
    else if (before.get(k) !== sha) changes.push(`oracle file ${k} changed`);
  }
  for (const k of before.keys()) if (!after.has(k)) changes.push(`oracle entry ${k} removed`);
  return changes.sort();
}

/** Accepting changed pins is a human action. */
export function acceptPins(approver: Actor, current: PinSet): { ok: true; pins: PinSet } | { ok: false; errors: TypedError[] } {
  if (approver.kind !== "human") return { ok: false, errors: [err("E_NOT_PERMITTED", "/approver", "only a human can accept changed oracle pins")] };
  return { ok: true, pins: JSON.parse(canonicalJson(current)) as PinSet };
}

/** A quantity is verified only when a passed `good` entry of this set covers it and no known-limit entry failed for it. */
export function unverifiedQuantities(requested: readonly string[], set: SetResult, entries: readonly IndexedOracle[]): string[] {
  const covered = new Set<string>();
  for (const r of set.results) {
    if (r.verdict !== "pass" || r.tag !== "good") continue;
    const hit = entries.find((i) => i.entry.oracleId === r.oracleId && i.entry.entryVersion === r.entryVersion);
    if (hit !== undefined) for (const q of hit.entry.coverage.quantities) covered.add(q);
  }
  const bad = new Set(set.blockedQuantities);
  return requested.filter((q) => !covered.has(q) || bad.has(q));
}
