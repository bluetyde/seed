import { canonicalJson } from "./canonical";
import type { QuantityData } from "./quantityData";
import type { TypedError } from "./validate";

/**
 * Replay: compare a run with a second run of the same case and say whether the second reproduces the first (acceptance A7). Pure: nothing here
 * reads a file or starts a run; the caller passes the two run records' facts and the data it has already read and hash-checked.
 *
 * Rules (docs/replay.md):
 *  - a replay is a test of reproduction, so the two runs must have been made the same way: the same adapter and version, the same engine and
 *    version, the same data library, the same seed, the same inputs (by hash) and the same settings. Any difference is listed, field by field, and the
 *    verdict is `not-comparable`: a different engine version never "differs" or "reproduces", it is a different experiment;
 *  - the original must be a completed, current run; a replay that did not complete `differs` (it did not reproduce);
 *  - each quantity is judged under the adapter's policy: `exact` (identical numbers), `tolerance` (within an absolute and a relative bound) or
 *    `statistical` (within k combined standard deviations; uncertainty must be declared by both runs and is never invented);
 *  - the verdicts are `reproduced` (every number identical), `reproduced-within-tolerance`, `differs` and `not-comparable`; the whole replay takes
 *    the worst one in that order: differs, then not-comparable, then within-tolerance, then reproduced.
 */

export type ReplayPolicy =
  | { mode: "exact" }
  | { mode: "tolerance"; abs: number; rel: number }
  | { mode: "statistical"; sigmas: number };

export type ReplayRun = {
  runId: string;
  /** The coordinator lifecycle state of the run record. */
  state: string;
  stale?: boolean;
  adapter: { id: string; version: string };
  engine?: { name: string; version: string };
  dataLibrary?: { id: string; hash?: string };
  seed?: number;
  inputs: { path: string; sha256: string }[];
  settings?: unknown;
  /** The quantities of the run, each with its data already read and checked against the hash in the results index. */
  quantities: { name: string; unit: string; normalization: string; data: QuantityData }[];
};

export type ReplayVerdict = "reproduced" | "reproduced-within-tolerance" | "differs" | "not-comparable";

export type ReplayDifference = {
  /** `identity`: how the runs were made; `state`: a run did not complete; `quantity`: a quantity is in one run only; `value`: the numbers. */
  kind: "identity" | "state" | "quantity" | "value";
  field: string;
  original?: unknown;
  replay?: unknown;
  detail?: string;
};

export type ReplayQuantityResult = {
  name: string;
  verdict: ReplayVerdict;
  unit: string;
  /** Why the quantity is not comparable, or how it differs. */
  reason?: string;
  code?: "kind-mismatch" | "unit-mismatch" | "normalization-mismatch" | "grid-mismatch" | "table-unsupported" | "no-uncertainty" | "shape-mismatch";
  /** The largest absolute and relative difference over the compared numbers. */
  maxAbsDiff?: number;
  maxRelDiff?: number;
  /** Statistical policy: the largest difference in combined standard deviations, and where it is (series index). */
  worstSigmas?: number;
  worstIndex?: number;
  points: number;
};

export type ReplayResult =
  | {
      ok: true;
      verdict: ReplayVerdict;
      original: string;
      replay: string;
      policy: ReplayPolicy;
      differences: ReplayDifference[];
      quantities: ReplayQuantityResult[];
      notes: string[];
    }
  | { ok: false; errors: TypedError[] };

const bad = (field: string, message: string): ReplayResult => ({ ok: false, errors: [{ code: "E_SCHEMA_INVALID", field, message, source: "seed" }] });
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** What is wrong with a policy, or null when it is usable. Fields it does not know are refused, so a typo cannot loosen a policy silently. */
export function validReplayPolicy(p: ReplayPolicy): string | null {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return "the policy must be an object";
  const only = (...keys: string[]) => Object.keys(p).every((k) => k === "mode" || keys.includes(k));
  if (p.mode === "exact") return only() ? null : "an exact policy has no other field";
  if (p.mode === "tolerance" && !only("abs", "rel")) return "a tolerance policy has only abs and rel";
  if (p.mode === "statistical" && !only("sigmas")) return "a statistical policy has only sigmas";
  if (p.mode === "tolerance") return finite(p.abs) && p.abs >= 0 && finite(p.rel) && p.rel >= 0 && (p.abs > 0 || p.rel > 0) ? null : "a tolerance policy needs abs and rel, finite and not negative, and not both zero (use exact for that)";
  if (p.mode === "statistical") return finite(p.sigmas) && p.sigmas > 0 && p.sigmas <= 10 ? null : "a statistical policy needs sigmas above 0 and at most 10";
  return "the policy mode must be exact, tolerance or statistical";
}

function validRun(r: ReplayRun, field: string): string | null {
  if (r === null || typeof r !== "object") return `${field} must be a run`;
  if (typeof r.runId !== "string" || r.runId.length < 1) return `${field}.runId must be a run id`;
  if (typeof r.state !== "string") return `${field}.state must be the lifecycle state`;
  if (!r.adapter || typeof r.adapter.id !== "string" || typeof r.adapter.version !== "string") return `${field}.adapter needs an id and a version`;
  if (!Array.isArray(r.inputs) || r.inputs.some((i) => typeof i?.path !== "string" || typeof i?.sha256 !== "string")) return `${field}.inputs must list path and sha256`;
  if (!Array.isArray(r.quantities)) return `${field}.quantities must be a list`;
  if (r.seed !== undefined && !(Number.isInteger(r.seed) && r.seed >= 0)) return `${field}.seed must be a whole number, 0 or more`;
  return null;
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a === undefined ? null : a) === canonicalJson(b === undefined ? null : b);

/** Every way the two runs were made differently, one entry per field. */
export function identityDifferences(o: ReplayRun, r: ReplayRun): ReplayDifference[] {
  const out: ReplayDifference[] = [];
  const diff = (field: string, a: unknown, b: unknown) => { if (!sameJson(a, b)) out.push({ kind: "identity", field, original: a ?? null, replay: b ?? null }); };
  diff("adapter.id", o.adapter.id, r.adapter.id);
  diff("adapter.version", o.adapter.version, r.adapter.version);
  diff("engine.name", o.engine?.name, r.engine?.name);
  diff("engine.version", o.engine?.version, r.engine?.version);
  diff("dataLibrary.id", o.dataLibrary?.id, r.dataLibrary?.id);
  diff("dataLibrary.hash", o.dataLibrary?.hash, r.dataLibrary?.hash);
  diff("seed", o.seed, r.seed);
  const byPath = (x: ReplayRun) => new Map(x.inputs.map((i) => [i.path, i.sha256]));
  const a = byPath(o), b = byPath(r);
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(p)) out.push({ kind: "identity", field: `inputs[${p}]`, original: null, replay: b.get(p), detail: "an input only the replay has" });
    else if (!b.has(p)) out.push({ kind: "identity", field: `inputs[${p}]`, original: a.get(p), replay: null, detail: "an input only the original has" });
    else if (a.get(p) !== b.get(p)) out.push({ kind: "identity", field: `inputs[${p}].sha256`, original: a.get(p), replay: b.get(p), detail: "the input file changed" });
  }
  diff("settings", o.settings, r.settings);
  return out;
}

type Acc = { maxAbs: number; maxRel: number; allIdentical: boolean; within: boolean; worstSigmas: number; worstIndex: number; points: number };
const newAcc = (): Acc => ({ maxAbs: 0, maxRel: 0, allIdentical: true, within: true, worstSigmas: 0, worstIndex: -1, points: 0 });

function numeric(acc: Acc, a: number, b: number, sa: number | undefined, sb: number | undefined, policy: ReplayPolicy, index: number): void {
  acc.points += 1;
  const d = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  const rel = scale === 0 ? 0 : d / scale;
  if (d > acc.maxAbs) acc.maxAbs = d;
  if (rel > acc.maxRel) acc.maxRel = rel;
  const stdSame = (sa ?? null) === (sb ?? null);
  if (!(Object.is(a, b) || a === b) || !stdSame) acc.allIdentical = false;
  if (d === 0 && stdSame) return;
  if (policy.mode === "exact") { acc.within = false; return; }
  if (policy.mode === "tolerance") { if (d > policy.abs + policy.rel * scale) acc.within = false; return; }
  // statistical: both runs declare an uncertainty (checked by the caller)
  const combined = Math.sqrt((sa ?? 0) ** 2 + (sb ?? 0) ** 2);
  const z = combined === 0 ? (d === 0 ? 0 : Infinity) : d / combined;
  if (z > acc.worstSigmas) { acc.worstSigmas = z; acc.worstIndex = index; }
  if (z > policy.sigmas) acc.within = false;
}

function judge(name: string, unit: string, acc: Acc, policy: ReplayPolicy): ReplayQuantityResult {
  const verdict: ReplayVerdict = acc.allIdentical ? "reproduced" : acc.within ? "reproduced-within-tolerance" : "differs";
  return {
    name, unit, verdict, points: acc.points, maxAbsDiff: acc.maxAbs, maxRelDiff: acc.maxRel,
    ...(policy.mode === "statistical" ? { worstSigmas: acc.worstSigmas, ...(acc.worstIndex >= 0 ? { worstIndex: acc.worstIndex } : {}) } : {}),
    ...(verdict === "differs" ? { reason: policy.mode === "exact" ? "the numbers are not identical" : policy.mode === "tolerance" ? "a number is outside the tolerance" : `a number is more than ${policy.sigmas} combined standard deviations away` } : {}),
  };
}

function notComparable(name: string, unit: string, code: NonNullable<ReplayQuantityResult["code"]>, reason: string): ReplayQuantityResult {
  return { name, unit, verdict: "not-comparable", code, reason, points: 0 };
}

function compareData(name: string, unit: string, a: QuantityData, b: QuantityData, policy: ReplayPolicy, gridTol = 1e-9): ReplayQuantityResult {
  if (a.kind !== b.kind) return notComparable(name, unit, "kind-mismatch", `the original is a ${a.kind} and the replay a ${b.kind}`);
  const acc = newAcc();
  if (a.kind === "scalar" && b.kind === "scalar") {
    if (policy.mode === "statistical" && (a.std === undefined || b.std === undefined)) return notComparable(name, unit, "no-uncertainty", "a statistical policy needs an uncertainty from both runs, and one of them declares none");
    numeric(acc, a.value, b.value, a.std, b.std, policy, 0);
    return judge(name, unit, acc, policy);
  }
  if (a.kind === "series" && b.kind === "series") {
    if (a.x.length !== b.x.length || a.values.length !== b.values.length) return notComparable(name, unit, "grid-mismatch", `the original has ${a.x.length} points and the replay ${b.x.length}`);
    for (let i = 0; i < a.x.length; i += 1) {
      const scale = Math.max(Math.abs(a.x[i]!), Math.abs(b.x[i]!), 1e-300);
      if (Math.abs(a.x[i]! - b.x[i]!) > gridTol * scale) return notComparable(name, unit, "grid-mismatch", `the grids differ at point ${i}`);
    }
    if (a.axis.name !== b.axis.name || a.axis.unit !== b.axis.unit) return notComparable(name, unit, "grid-mismatch", "the axes differ");
    if (policy.mode === "statistical" && (a.std === undefined || b.std === undefined || a.std.length !== a.values.length || b.std.length !== b.values.length)) {
      return notComparable(name, unit, "no-uncertainty", "a statistical policy needs an uncertainty at every point from both runs");
    }
    for (let i = 0; i < a.values.length; i += 1) numeric(acc, a.values[i]!, b.values[i]!, a.std?.[i], b.std?.[i], policy, i);
    return judge(name, unit, acc, policy);
  }
  if (a.kind === "table" && b.kind === "table") {
    if (policy.mode === "statistical") return notComparable(name, unit, "table-unsupported", "a table is not compared statistically");
    if (a.rows.length !== b.rows.length || a.columns.length !== b.columns.length || canonicalJson(a.columns) !== canonicalJson(b.columns)) return notComparable(name, unit, "shape-mismatch", "the columns or the number of rows differ");
    let index = 0;
    for (let i = 0; i < a.rows.length; i += 1) {
      const ra = a.rows[i]!, rb = b.rows[i]!;
      if (ra.length !== rb.length) return notComparable(name, unit, "shape-mismatch", `row ${i} has a different length`);
      for (let j = 0; j < ra.length; j += 1) {
        const x = ra[j], y = rb[j];
        if (typeof x === "number" && typeof y === "number") numeric(acc, x, y, undefined, undefined, policy, index);
        else { acc.points += 1; if (canonicalJson(x) !== canonicalJson(y)) { acc.allIdentical = false; acc.within = false; } }
        index += 1;
      }
    }
    return judge(name, unit, acc, policy);
  }
  return notComparable(name, unit, "kind-mismatch", "the data kinds differ");
}

const RANK: Record<ReplayVerdict, number> = { reproduced: 0, "reproduced-within-tolerance": 1, "not-comparable": 2, differs: 3 };

/** Compares a replay with the run it repeats. */
export function compareReplay(req: { original: ReplayRun; replay: ReplayRun; policy: ReplayPolicy; gridTolerance?: number }): ReplayResult {
  const p = validReplayPolicy(req?.policy);
  if (p) return bad("/policy", p);
  const e1 = validRun(req.original, "original"), e2 = validRun(req.replay, "replay");
  if (e1) return bad("/original", e1);
  if (e2) return bad("/replay", e2);
  if (req.original.runId === req.replay.runId) return bad("/replay", "a run cannot be replayed against itself: the replay is a second run");
  const { original, replay, policy } = req;
  const base = { original: original.runId, replay: replay.runId, policy };
  const notes: string[] = [];

  // 1. the original must be something to reproduce
  if (original.state !== "completed" || original.stale === true) {
    return { ok: true, verdict: "not-comparable", ...base, quantities: [], notes, differences: [{ kind: "state", field: "original.state", original: original.stale ? `${original.state} (stale)` : original.state, replay: replay.state, detail: "only a completed, current run can be reproduced" }] };
  }
  // 2. made the same way?
  const identity = identityDifferences(original, replay);
  if (identity.length > 0) {
    notes.push("the runs were not made the same way, so their values were not compared: a replay is only a test of reproduction when nothing but the run differs");
    return { ok: true, verdict: "not-comparable", ...base, quantities: [], notes, differences: identity };
  }
  // 3. did the replay complete?
  if (replay.state !== "completed") {
    return { ok: true, verdict: "differs", ...base, quantities: [], notes, differences: [{ kind: "state", field: "replay.state", original: original.state, replay: replay.state, detail: "the replay did not complete, so it did not reproduce the original" }] };
  }
  // 4. the quantities
  const differences: ReplayDifference[] = [];
  const quantities: ReplayQuantityResult[] = [];
  const byName = (r: ReplayRun) => new Map(r.quantities.map((q) => [q.name, q]));
  const a = byName(original), b = byName(replay);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const qa = a.get(name), qb = b.get(name);
    if (!qa || !qb) {
      differences.push({ kind: "quantity", field: name, original: qa ? "present" : "absent", replay: qb ? "present" : "absent", detail: qa ? "the replay does not have this quantity" : "only the replay has this quantity" });
      quantities.push({ name, unit: (qa ?? qb)!.unit, verdict: "differs", reason: qa ? "missing from the replay" : "not in the original", points: 0 });
      continue;
    }
    if (qa.unit !== qb.unit) { quantities.push(notComparable(name, qa.unit, "unit-mismatch", `the unit is ${qa.unit} in the original and ${qb.unit} in the replay`)); continue; }
    if (qa.normalization !== qb.normalization) { quantities.push(notComparable(name, qa.unit, "normalization-mismatch", `the normalization is ${qa.normalization} in the original and ${qb.normalization} in the replay`)); continue; }
    const res = compareData(name, qa.unit, qa.data, qb.data, policy, req.gridTolerance);
    quantities.push(res);
    if (res.verdict === "differs") differences.push({ kind: "value", field: name, detail: res.reason, original: undefined, replay: undefined });
  }
  if (quantities.length === 0) notes.push("the runs have no quantities to compare");
  const verdict = quantities.reduce<ReplayVerdict>((worst, q) => (RANK[q.verdict] > RANK[worst] ? q.verdict : worst), "reproduced");
  return { ok: true, verdict, ...base, quantities, differences, notes };
}

const esc = (s: unknown) => String(s).replace(/[\\|`*_<>\r\n]/g, (c) => (c === "\r" || c === "\n" ? " " : "\\" + c));
const num = (n: number | undefined) => (n === undefined ? "" : Number.isFinite(n) ? n.toPrecision(6) : String(n));

/** A table of the result. Text that comes from runs is escaped; numbers are formatted here. */
export function replayMarkdown(res: Extract<ReplayResult, { ok: true }>): string {
  const lines = [
    `Replay of run ${esc(res.original)} by run ${esc(res.replay)}: **${res.verdict}** (policy: ${esc(JSON.stringify(res.policy))})`,
    "",
  ];
  if (res.differences.some((d) => d.kind === "identity" || d.kind === "state")) {
    lines.push("| What differs | Original | Replay | Note |", "|---|---|---|---|");
    for (const d of res.differences.filter((x) => x.kind === "identity" || x.kind === "state")) lines.push(`| ${esc(d.field)} | ${esc(d.original ?? "")} | ${esc(d.replay ?? "")} | ${esc(d.detail ?? "")} |`);
    lines.push("");
  }
  if (res.quantities.length) {
    lines.push("| Quantity | Unit | Verdict | Largest difference | Relative | Sigmas | Note |", "|---|---|---|---|---|---|---|");
    for (const q of res.quantities) lines.push(`| ${esc(q.name)} | ${esc(q.unit)} | ${q.verdict} | ${num(q.maxAbsDiff)} | ${num(q.maxRelDiff)} | ${num(q.worstSigmas)} | ${esc(q.reason ?? "")} |`);
    lines.push("");
  }
  for (const n of res.notes) lines.push(`- ${esc(n)}`);
  return lines.join("\n") + "\n";
}
