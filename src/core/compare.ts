import type { QuantityData } from "./quantityData";
import { parseUnit } from "./units";
import type { TypedError } from "./validate";

/**
 * Comparison of one named quantity across runs (plan 07, "Comparison"). Rules:
 *  - only compatible quantities are compared: the same dimension after unit conversion, the same normalization, the same kind of data, the
 *    same coordinate system, and for series the same axis and the same grid; anything else is refused with the reason, in the table;
 *  - failed, cancelled, interrupted, trip-terminated, stale and unfinished runs stay in the table, marked, and stay out of the comparison
 *    itself (a stale run's values are shown, labelled, never used);
 *  - normalization and uncertainty appear on every row; uncertainty is shown only where a run declares it, never invented, and the three
 *    kinds (statistical sampling noise, input uncertainty, model uncertainty) are never added together;
 *  - nothing here reads a file: the caller passes the data it has already checked against the hash in the results index.
 */

export type UncertaintyKind = "statistical" | "input" | "model";

export type CompareQuantityEntry = {
  name: string;
  unit: string;
  normalization: string;
  verification?: string;
  dimension?: string;
  coordinates?: { system: string; axes: { name: string; unit: string }[] };
  uncertainty?: { kind: UncertaintyKind; value: number; unit?: string };
};

export type CompareRun = {
  runId: string;
  /** The coordinator lifecycle state of the run record. */
  state: string;
  native?: { status: string; detail?: string };
  /** True when a later input revision made the run stale. */
  stale?: boolean;
  /** The quantities of the run's results index (a completed run has them). */
  quantities?: CompareQuantityEntry[];
  /** The data of the compared quantity of this run, already read and hash-checked by the caller. */
  data?: QuantityData;
};

export type CompareRequest = {
  quantity: string;
  runs: CompareRun[];
  /** The run the others are compared with; by default the first run in the list that can be compared at all. */
  reference?: string;
  /** Relative tolerance for "the same grid" (default 1e-9). */
  gridTolerance?: number;
};

export type Mark = "ok" | "failed" | "cancelled" | "interrupted" | "trip" | "stale" | "queued" | "running" | "no-quantity" | "refused";

export type RefusalCode =
  | "kind-mismatch"
  | "table-unsupported"
  | "normalization-mismatch"
  | "dimension-mismatch"
  | "unit-mismatch"
  | "domain-mismatch"
  | "axis-mismatch"
  | "grid-mismatch"
  | "data-mismatch";

export type RowUncertainty = { kind: UncertaintyKind; value: number; unit: string };

export type CompareRow = {
  runId: string;
  state: string;
  native?: { status: string; detail?: string };
  mark: Mark;
  /** Is this row part of the comparison (and of its spread)? */
  used: boolean;
  /** Why the row is marked, refused or left out. */
  reason?: string;
  refusal?: { code: RefusalCode; message: string };
  verification?: string;
  unit?: string;
  normalization?: string;
  uncertainty: RowUncertainty[];
  /** A scalar value, in the reference unit for rows that are used (in the run's own unit for a stale run, whose unit is then given). */
  value?: number;
  /** A series, in the reference units for rows that are used. */
  series?: { x: number[]; y: number[] };
  /** Difference from the reference run, in the reference unit. */
  difference?: { absolute: number; relative: number | null; sigmas?: number } | { maxAbsolute: number; maxRelative: number | null; rms: number };
};

export type CompareOk = {
  ok: true;
  quantity: string;
  kind: "scalar" | "series";
  reference: { runId: string; unit: string; normalization: string };
  rows: CompareRow[];
  /** How far the compared runs lie apart, in the reference unit, and the uncertainties of the compared runs, kept apart by kind. */
  variation: {
    compared: number;
    spread: { min: number; max: number; range: number } | null;
    uncertainty: Record<UncertaintyKind, number | null>;
  };
  notes: string[];
};

export type CompareResult = CompareOk | { ok: false; errors: TypedError[] };

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const MARKS: Record<string, Mark> = { failed: "failed", cancelled: "cancelled", interrupted: "interrupted", "terminated-by-trip": "trip", queued: "queued", running: "running" };

type Vec = Record<string, number>;
const sameVector = (a: Vec, b: Vec): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** A converter from one unit to another of the same dimension, or the reason there is none. `difference` converts a spread or an uncertainty (no offset). */
function converter(from: string, to: string): { ok: true; convert: (v: number, difference?: boolean) => number } | { ok: false; reason: string } {
  const a = parseUnit(from);
  if (!a.ok) return { ok: false, reason: `cannot read the unit ${JSON.stringify(from)}: ${a.reason}` };
  const b = parseUnit(to);
  if (!b.ok) return { ok: false, reason: `cannot read the unit ${JSON.stringify(to)}: ${b.reason}` };
  if (!sameVector(a.vector, b.vector)) return { ok: false, reason: `${JSON.stringify(from)} and ${JSON.stringify(to)} are not the same kind of quantity` };
  return {
    ok: true,
    convert: (v, difference = false) => {
      const si = difference ? v * a.factor : a.celsius ? v + 273.15 : v * a.factor;
      return difference ? si / b.factor : b.celsius ? si - 273.15 : si / b.factor;
    },
  };
}

const quantityOf = (run: CompareRun, name: string): CompareQuantityEntry | undefined => run.quantities?.find((q) => q.name === name);

function uncertaintiesOf(entry: CompareQuantityEntry, data: QuantityData, toUnit: string, fromUnit: string): RowUncertainty[] {
  const out: RowUncertainty[] = [];
  const scale = converter(fromUnit, toUnit);
  const conv = (v: number): number => (scale.ok ? scale.convert(v, true) : v);
  const unit = scale.ok ? toUnit : fromUnit;
  if (data.kind === "scalar" && data.std !== undefined) out.push({ kind: "statistical", value: conv(data.std), unit });
  if (data.kind === "series" && data.std !== undefined && data.std.length > 0) out.push({ kind: "statistical", value: conv(Math.max(...data.std)), unit });
  if (entry.uncertainty !== undefined) {
    const u = entry.uncertainty;
    const own = u.unit ?? entry.unit;
    const c = converter(own, toUnit);
    out.push(c.ok ? { kind: u.kind, value: c.convert(u.value, true), unit: toUnit } : { kind: u.kind, value: u.value, unit: own });
  }
  return out;
}

export function compareQuantity(req: CompareRequest): CompareResult {
  if (typeof req.quantity !== "string" || req.quantity.length === 0) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/quantity", "name the quantity to compare")] };
  if (!Array.isArray(req.runs) || req.runs.length === 0) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/runs", "give at least one run")] };
  const seen = new Set<string>();
  for (let i = 0; i < req.runs.length; i++) {
    const id = req.runs[i]!.runId;
    if (seen.has(id)) return { ok: false, errors: [err("E_SCHEMA_INVALID", `/runs/${i}/runId`, `run ${id} is listed twice`)] };
    seen.add(id);
  }
  const tol = req.gridTolerance ?? 1e-9;

  // 1. every run gets a row; the ones that can be compared are the candidates
  const rows = new Map<string, CompareRow>();
  const candidates: { run: CompareRun; entry: CompareQuantityEntry; data: QuantityData }[] = [];
  for (const run of req.runs) {
    const entry = quantityOf(run, req.quantity);
    const base: CompareRow = {
      runId: run.runId,
      state: run.state,
      ...(run.native !== undefined ? { native: run.native } : {}),
      mark: "ok",
      used: false,
      uncertainty: [],
      ...(entry?.verification !== undefined ? { verification: entry.verification } : {}),
      ...(entry !== undefined ? { unit: entry.unit, normalization: entry.normalization } : {}),
    };
    const flagged = MARKS[run.state];
    if (flagged !== undefined) {
      rows.set(run.runId, { ...base, mark: flagged, reason: run.state === "terminated-by-trip" ? "ended by a trip: not a completed run of the intended experiment" : `the run is ${run.state}: it has no result to compare` });
    } else if (run.state !== "completed") {
      rows.set(run.runId, { ...base, mark: "failed", reason: `unknown run state ${JSON.stringify(run.state)}` });
    } else if (run.stale === true) {
      const row: CompareRow = { ...base, mark: "stale", reason: "a later input revision made this run stale: shown, labelled, not used" };
      if (run.data?.kind === "scalar") row.value = run.data.value;
      if (run.data?.kind === "series") row.series = { x: run.data.x, y: run.data.values };
      if (entry !== undefined && run.data !== undefined) row.uncertainty = uncertaintiesOf(entry, run.data, entry.unit, entry.unit);
      rows.set(run.runId, row);
    } else if (entry === undefined) {
      rows.set(run.runId, { ...base, mark: "no-quantity", reason: `the run has no quantity ${JSON.stringify(req.quantity)}` });
    } else if (run.data === undefined) {
      rows.set(run.runId, { ...base, mark: "no-quantity", reason: "the data of this quantity was not provided" });
    } else {
      rows.set(run.runId, base);
      candidates.push({ run, entry, data: run.data });
    }
  }

  // 2. the reference
  const refCand = req.reference === undefined ? candidates[0] : candidates.find((c) => c.run.runId === req.reference);
  if (refCand === undefined) {
    const why = req.reference === undefined ? "no run in the list is completed, current and has this quantity with its data" : `the reference run ${JSON.stringify(req.reference)} is not a completed, current run with this quantity and its data`;
    return { ok: false, errors: [err("E_PROP_MISSING", req.reference === undefined ? "/runs" : "/reference", why)] };
  }
  const ref = refCand;
  if (ref.data.kind === "table") return { ok: false, errors: [err("E_SCHEMA_INVALID", "/quantity", "tables are not compared here: compare their scalar or series quantities")] };
  const refUnit = ref.data.unit;
  const refNorm = ref.entry.normalization;
  const kind = ref.data.kind;

  const refuse = (row: CompareRow, code: RefusalCode, message: string): void => {
    row.mark = "refused";
    row.reason = message;
    row.refusal = { code, message };
  };

  // 3. the candidates, one by one
  const used: { row: CompareRow; data: QuantityData }[] = [];
  for (const c of candidates) {
    const row = rows.get(c.run.runId)!;
    const d = c.data;
    row.unit = d.unit;
    if (d.kind === "table") {
      refuse(row, "table-unsupported", "tables are not compared here: compare their scalar or series quantities");
      continue;
    }
    if (d.kind !== kind) {
      refuse(row, "kind-mismatch", `this run holds a ${d.kind}, the reference holds a ${kind}`);
      continue;
    }
    if (c.entry.normalization !== refNorm) {
      refuse(row, "normalization-mismatch", `normalization ${JSON.stringify(c.entry.normalization)} differs from the reference's ${JSON.stringify(refNorm)}`);
      continue;
    }
    if (c.entry.dimension !== undefined && ref.entry.dimension !== undefined && c.entry.dimension !== ref.entry.dimension) {
      refuse(row, "dimension-mismatch", `dimension ${c.entry.dimension} differs from the reference's ${ref.entry.dimension}`);
      continue;
    }
    if (d.unit !== c.entry.unit) {
      refuse(row, "data-mismatch", `the data is in ${JSON.stringify(d.unit)} but the results index says ${JSON.stringify(c.entry.unit)}`);
      continue;
    }
    const conv = converter(d.unit, refUnit);
    if (!conv.ok) {
      refuse(row, "unit-mismatch", conv.reason);
      continue;
    }
    const ca = c.entry.coordinates;
    const ra = ref.entry.coordinates;
    if ((ca !== undefined || ra !== undefined) && (ca === undefined || ra === undefined || ca.system !== ra.system)) {
      refuse(row, "domain-mismatch", `coordinate system ${JSON.stringify(ca?.system ?? "none declared")} differs from the reference's ${JSON.stringify(ra?.system ?? "none declared")}`);
      continue;
    }
    if (d.kind === "scalar" && ref.data.kind === "scalar") {
      row.value = conv.convert(d.value);
      row.unit = refUnit;
      row.uncertainty = uncertaintiesOf(c.entry, d, refUnit, d.unit);
      row.used = true;
      used.push({ row, data: d });
      continue;
    }
    if (d.kind === "series" && ref.data.kind === "series") {
      const ax = converter(d.axis.unit, ref.data.axis.unit);
      if (d.axis.name !== ref.data.axis.name || !ax.ok) {
        refuse(row, "axis-mismatch", `axis ${JSON.stringify(d.axis.name)} (${d.axis.unit}) does not match the reference's ${JSON.stringify(ref.data.axis.name)} (${ref.data.axis.unit})`);
        continue;
      }
      if (d.x.length !== ref.data.x.length) {
        refuse(row, "grid-mismatch", `${d.x.length} points on the axis against the reference's ${ref.data.x.length}`);
        continue;
      }
      const xs = d.x.map((x) => ax.convert(x));
      const refX = ref.data.x;
      const bad = xs.findIndex((x, i) => Math.abs(x - refX[i]!) > tol * Math.max(1, Math.abs(refX[i]!)));
      if (bad >= 0) {
        refuse(row, "grid-mismatch", `the grids differ at point ${bad}: ${xs[bad]} against the reference's ${refX[bad]} ${ref.data.axis.unit}`);
        continue;
      }
      row.series = { x: xs, y: d.values.map((v) => conv.convert(v)) };
      row.unit = refUnit;
      row.uncertainty = uncertaintiesOf(c.entry, d, refUnit, d.unit);
      row.used = true;
      used.push({ row, data: d });
    }
  }

  // 4. differences from the reference, and the variation of the compared runs
  const refRow = rows.get(ref.run.runId)!;
  if (ref.data.kind === "scalar") {
    refRow.value = ref.data.value;
    refRow.unit = refUnit;
  } else if (ref.data.kind === "series") {
    refRow.series = { x: ref.data.x, y: ref.data.values };
    refRow.unit = refUnit;
  }
  refRow.uncertainty = uncertaintiesOf(ref.entry, ref.data, refUnit, refUnit);
  refRow.used = true;
  const stat = (row: CompareRow): number | undefined => row.uncertainty.find((u) => u.kind === "statistical")?.value;
  for (const { row } of used) {
    if (row === refRow) continue;
    if (row.value !== undefined && refRow.value !== undefined) {
      const absolute = row.value - refRow.value;
      const s1 = stat(row);
      const s2 = stat(refRow);
      const combined = s1 !== undefined && s2 !== undefined ? Math.sqrt(s1 * s1 + s2 * s2) : 0;
      row.difference = { absolute, relative: refRow.value !== 0 ? absolute / Math.abs(refRow.value) : null, ...(combined > 0 ? { sigmas: Math.abs(absolute) / combined } : {}) };
    } else if (row.series !== undefined && refRow.series !== undefined) {
      const diffs = row.series.y.map((y, i) => y - refRow.series!.y[i]!);
      const rel = diffs.map((d, i) => (refRow.series!.y[i] !== 0 ? Math.abs(d) / Math.abs(refRow.series!.y[i]!) : null)).filter((v): v is number => v !== null);
      row.difference = {
        maxAbsolute: Math.max(...diffs.map(Math.abs)),
        maxRelative: rel.length > 0 ? Math.max(...rel) : null,
        rms: Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length),
      };
    }
  }

  const comparedRows = [...rows.values()].filter((r) => r.used);
  let spread: CompareOk["variation"]["spread"] = null;
  if (kind === "scalar") {
    const vs = comparedRows.map((r) => r.value!);
    spread = { min: Math.min(...vs), max: Math.max(...vs), range: Math.max(...vs) - Math.min(...vs) };
  } else {
    const n = refRow.series!.y.length;
    let lo = Infinity;
    let hi = -Infinity;
    let range = 0;
    for (let i = 0; i < n; i++) {
      const col = comparedRows.map((r) => r.series!.y[i]!);
      const a = Math.min(...col);
      const b = Math.max(...col);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
      range = Math.max(range, b - a);
    }
    spread = { min: lo, max: hi, range };
  }
  const biggest = (k: UncertaintyKind): number | null => {
    const vs = comparedRows.flatMap((r) => r.uncertainty.filter((u) => u.kind === k).map((u) => u.value));
    return vs.length === 0 ? null : Math.max(...vs);
  };
  const uncertainty = { statistical: biggest("statistical"), input: biggest("input"), model: biggest("model") };

  const notes: string[] = [];
  if (comparedRows.length === 1) notes.push("only one run could be compared: there is no spread to show");
  if (uncertainty.statistical !== null) notes.push("the spread between runs includes Monte Carlo sampling noise of up to " + uncertainty.statistical + " " + refUnit + "; the uncertainties of different kinds are shown apart and never added");
  if (uncertainty.statistical === null && uncertainty.input === null && uncertainty.model === null) notes.push("none of the compared runs declares an uncertainty; none is assumed");
  const kept = [...rows.values()].filter((r) => !r.used);
  if (kept.length > 0) notes.push(`${kept.length} run${kept.length === 1 ? "" : "s"} listed but not compared (see the marks)`);

  return {
    ok: true,
    quantity: req.quantity,
    kind,
    reference: { runId: ref.run.runId, unit: refUnit, normalization: refNorm },
    rows: req.runs.map((r) => rows.get(r.runId)!),
    variation: { compared: comparedRows.length, spread, uncertainty },
    notes,
  };
}

const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~&]/g;
const mdText = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(MD_SPECIAL, "\\$&");
const fmt = (n: number): string => (Number.isFinite(n) ? String(Number(n.toPrecision(6))) : "n/a");

/** The comparison as a Markdown table: every row, with its mark, normalization, uncertainty and the reason it was left out. Text from runs is escaped. */
export function comparisonMarkdown(result: CompareOk): string {
  const lines: string[] = [];
  lines.push(`Comparison of ${mdText(result.quantity)} (${result.kind}); reference: run ${mdText(result.reference.runId)}, ${mdText(result.reference.unit)}, normalization ${mdText(result.reference.normalization)}`);
  lines.push("");
  lines.push("| Run | State | Mark | Value | Unit | Normalization | Uncertainty | Verification | Difference | Note |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of result.rows) {
    const value = r.value !== undefined ? fmt(r.value) : r.series !== undefined ? `${r.series.y.length} points` : "none";
    const unc = r.uncertainty.length === 0 ? "none declared" : r.uncertainty.map((u) => `${mdText(u.kind)} ${fmt(u.value)} ${mdText(u.unit)}`).join("; ");
    let diff = "";
    if (r.difference !== undefined) {
      diff = "absolute" in r.difference ? `${fmt(r.difference.absolute)}${r.difference.relative === null ? "" : ` (${fmt(r.difference.relative * 100)} %)`}${r.difference.sigmas !== undefined ? `, ${fmt(r.difference.sigmas)} sigma` : ""}` : `max ${fmt(r.difference.maxAbsolute)}, rms ${fmt(r.difference.rms)}`;
    }
    const mark = r.mark === "ok" ? "compared" : r.mark.toUpperCase();
    lines.push(`| ${mdText(r.runId)} | ${mdText(r.state)} | ${mark} | ${value} | ${r.unit !== undefined ? mdText(r.unit) : ""} | ${r.normalization !== undefined ? mdText(r.normalization) : ""} | ${unc} | ${r.verification !== undefined ? mdText(r.verification) : ""} | ${diff} |${r.reason !== undefined ? mdText(r.reason) : ""} |`);
  }
  for (const n of result.notes) lines.push("", mdText(n));
  return lines.join("\n") + "\n";
}
