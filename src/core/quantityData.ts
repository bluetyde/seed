/**
 * Reader for a quantity's data file (contracts v0.2, docs/contracts-v0.2-data-shapes.md).
 *
 * Reads `seed.quantity-data/0.2` files, and converts the five v0.1 shapes the adapters write today (RAFT, NODAL, FEED,
 * OpenMC, PRA) so the oracle observers, reports and transfers read one typed object. The index entry is the authority for
 * the name, the unit and the dimension; a file that disagrees is refused, never repaired.
 */
import fs from "node:fs";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import type { TypedError } from "./validate";
import { DIMENSIONS, parseUnit, unitMismatch, type Dimension } from "./units";

export type Scalar = { kind: "scalar"; quantity: string; unit: string; value: number; std?: number; meta?: Record<string, unknown> };
export type Series = {
  kind: "series"; quantity: string; unit: string; axis: { name: string; unit: string }; x: number[]; values: number[];
  std?: number[]; min?: number[]; max?: number[]; labels?: string[]; meta?: Record<string, unknown>;
};
export type Column = { name: string; unit: string; role: "label" | "coordinate" | "value" | "std"; of?: string };
export type Table = { kind: "table"; quantity: string; unit: string; columns: Column[]; rows: (number | string | string[])[][]; meta?: Record<string, unknown> };
export type QuantityData = Scalar | Series | Table;

/** What the reader needs from the results-index entry. */
export type IndexEntryView = {
  name: string;
  unit: string;
  dimension?: string;
  coordinates?: { system: string; axes: { name: string; unit: string }[] };
};

export type ReadResult = { ok: true; data: QuantityData; converted: boolean } | { ok: false; errors: TypedError[] };

const schemaPath = path.join(__dirname, "..", "..", "schema");
let validator: ValidateFunction | null = null;
function getValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaPath, "common.schema.json"), "utf8")) as object);
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaPath, "quantity-data.schema.json"), "utf8")) as object);
    const v = ajv.getSchema("https://seed.invalid/schema/quantity-data.schema.json");
    if (!v) throw new Error("quantity-data schema not found");
    validator = v;
  }
  return validator;
}

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numArray = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every(isNum);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Checks the schema cannot express: lengths, order, cell types, units. */
function checkShape(d: QuantityData, strictUnits: boolean): TypedError[] {
  const e: TypedError[] = [];
  const unit = (u: string, field: string): void => {
    if (!strictUnits) return; // v0.1 files carry free-text units (RAFT: dk/k); only a declared dimension makes the unit checkable
    const p = parseUnit(u);
    if (!p.ok) e.push(err("E_UNITS", field, p.reason));
  };
  unit(d.unit, "/unit");
  if (d.kind === "series") {
    unit(d.axis.unit, "/axis/unit");
    const n = d.x.length;
    if (d.values.length !== n) e.push(err("E_SCHEMA_INVALID", "/values", `values has ${d.values.length} entries, x has ${n}`));
    for (const k of ["std", "min", "max", "labels"] as const) {
      const a = d[k];
      if (a !== undefined && a.length !== n) e.push(err("E_SCHEMA_INVALID", "/" + k, `${k} has ${a.length} entries, x has ${n}`));
    }
    for (let i = 1; i < n; i++) if (!(d.x[i]! > d.x[i - 1]!)) { e.push(err("E_SCHEMA_INVALID", "/x", `x is not strictly increasing at index ${i}`)); break; }
    if (d.min && d.max) for (let i = 0; i < Math.min(d.min.length, d.max.length); i++) if (d.min[i]! > d.max[i]!) { e.push(err("E_SCHEMA_INVALID", "/min", `min exceeds max at index ${i}`)); break; }
  }
  if (d.kind === "table") {
    const names = new Set<string>();
    d.columns.forEach((c, i) => {
      if (names.has(c.name)) e.push(err("E_SCHEMA_INVALID", `/columns/${i}/name`, `column name ${JSON.stringify(c.name)} is used twice`));
      names.add(c.name);
      if (c.role !== "label") unit(c.unit, `/columns/${i}/unit`);
      if (c.role === "std") {
        const of = d.columns.find((o) => o.name === c.of);
        if (!of || of.role !== "value") e.push(err("E_SCHEMA_INVALID", `/columns/${i}/of`, "a std column names the value column it belongs to"));
      } else if (c.of !== undefined) e.push(err("E_SCHEMA_INVALID", `/columns/${i}/of`, "only a std column has `of`"));
    });
    d.rows.forEach((row, ri) => {
      if (row.length !== d.columns.length) { e.push(err("E_SCHEMA_INVALID", `/rows/${ri}`, `row has ${row.length} cells, there are ${d.columns.length} columns`)); return; }
      row.forEach((cell, ci) => {
        const c = d.columns[ci]!;
        const ok = c.role === "label" ? typeof cell === "string" || (Array.isArray(cell) && cell.every((s) => typeof s === "string")) : isNum(cell) && (c.role !== "std" || cell >= 0);
        if (!ok) e.push(err("E_SCHEMA_INVALID", `/rows/${ri}/${ci}`, `cell does not fit its ${c.role} column ${JSON.stringify(c.name)}`));
      });
    });
  }
  return e.slice(0, 20);
}

/** The five v0.1 file shapes, by what they contain. Null when the shape is not one of them. */
function convertV01(raw: Record<string, unknown>, entry: IndexEntryView): QuantityData | string | null {
  const base = { quantity: entry.name, unit: entry.unit };
  const axisOf = (name: string, fallbackUnit: string): { name: string; unit: string } => {
    const a = entry.coordinates?.axes.find((x) => x.name === name);
    return { name, unit: a ? a.unit : fallbackUnit };
  };
  const extra = (keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  if (Array.isArray(raw.t) || Array.isArray(raw.r)) {
    const isT = Array.isArray(raw.t);
    const x = isT ? raw.t : raw.r;
    if (!numArray(x) || !numArray(raw.values)) return "the series has missing or non-finite numbers";
    const s: Series = { kind: "series", ...base, axis: axisOf(isT ? "t" : "r", isT ? "s" : "m"), x, values: raw.values };
    for (const k of ["min", "max"] as const) if (raw[k] !== undefined) { if (!numArray(raw[k])) return `${k} has missing or non-finite numbers`; s[k] = raw[k] as number[]; }
    if (Array.isArray(raw.region)) s.labels = raw.region.map(String);
    const meta = extra(["kind", "location", "note"]);
    if (Object.keys(meta).length) s.meta = meta;
    return s;
  }
  if (Array.isArray(raw.bins)) {
    const bins = raw.bins as unknown[];
    const rows: Table["rows"] = [];
    for (const b of bins) {
      if (!isObj(b) || !Array.isArray(b.labels) || !isNum(b.mean) || !isNum(b.std) || b.std < 0) return "a tally bin has no labels, mean or std";
      rows.push([b.labels.map(String), b.mean, b.std]);
    }
    return {
      kind: "table", ...base,
      columns: [{ name: "bin", unit: "1", role: "label" }, { name: "mean", unit: entry.unit, role: "value" }, { name: "std", unit: entry.unit, role: "std", of: "mean" }],
      rows, meta: extra(["tally", "score", "normalization", "filters"])
    };
  }
  if (Array.isArray(raw.cutSets)) {
    const rows: Table["rows"] = [];
    for (const c of raw.cutSets as unknown[]) {
      if (!isObj(c) || !Array.isArray(c.events) || !isNum(c.probability)) return "a cut set has no events or probability";
      rows.push([c.events.map(String), c.probability]);
    }
    return { kind: "table", ...base, columns: [{ name: "events", unit: "1", role: "label" }, { name: "probability", unit: entry.unit, role: "value" }], rows };
  }
  if (isNum(raw.value)) {
    const meta = extra(["method", "note"]);
    return { kind: "scalar", ...base, value: raw.value, ...(Object.keys(meta).length ? { meta } : {}) };
  }
  if (Array.isArray(raw.values) && raw.values.length === 1 && isNum(raw.values[0])) return { kind: "scalar", ...base, value: raw.values[0] };
  return null;
}

export function readQuantityData(source: string | unknown, entry: IndexEntryView): ReadResult {
  let raw: unknown = source;
  if (typeof source === "string") {
    try { raw = JSON.parse(source); } catch { return { ok: false, errors: [err("E_SCHEMA_INVALID", "", "the data file is not JSON")] }; }
  }
  if (!isObj(raw)) return { ok: false, errors: [err("E_SCHEMA_INVALID", "", "the data file is not an object")] };

  if (entry.dimension !== undefined) {
    if (!(DIMENSIONS as readonly string[]).includes(entry.dimension)) return { ok: false, errors: [err("E_UNITS", "/dimension", `unknown dimension ${JSON.stringify(entry.dimension)}`)] };
    const bad = unitMismatch(entry.unit, entry.dimension as Dimension);
    if (bad) return { ok: false, errors: [err("E_UNITS", "/unit", bad)] };
  }

  let data: QuantityData;
  let converted = false;
  if (raw.schema === undefined) {
    if (raw.quantity !== undefined && raw.quantity !== entry.name) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/quantity", `the file is for ${JSON.stringify(raw.quantity)}, the index entry is ${JSON.stringify(entry.name)}`)] };
    if (raw.unit !== undefined && raw.unit !== entry.unit) return { ok: false, errors: [err("E_UNITS", "/unit", `the file says ${JSON.stringify(raw.unit)}, the index entry says ${JSON.stringify(entry.unit)}`)] };
    const c = convertV01(raw, entry);
    if (c === null) return { ok: false, errors: [err("E_SCHEMA_INVALID", "", "the data file is in none of the known shapes")] };
    if (typeof c === "string") return { ok: false, errors: [err("E_SCHEMA_INVALID", "", c)] };
    data = c;
    converted = true;
  } else {
    const v = getValidator();
    if (!v(raw)) {
      const first = (v.errors ?? []).find((x) => x.keyword !== "oneOf") ?? v.errors?.[0];
      return { ok: false, errors: [err("E_SCHEMA_INVALID", first?.instancePath ?? "", `quantity data schema validation failed: ${first?.message ?? "invalid"}`)] };
    }
    data = raw as unknown as QuantityData;
    if (data.quantity !== entry.name) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/quantity", `the file is for ${JSON.stringify(data.quantity)}, the index entry is ${JSON.stringify(entry.name)}`)] };
    if (data.unit !== entry.unit) return { ok: false, errors: [err("E_UNITS", "/unit", `the file says ${JSON.stringify(data.unit)}, the index entry says ${JSON.stringify(entry.unit)}`)] };
  }
  const problems = checkShape(data, !converted);
  return problems.length ? { ok: false, errors: problems } : { ok: true, data, converted };
}
