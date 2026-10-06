/**
 * Unit grammar and dimensions of contracts v0.2 (docs/contracts-v0.2-data-shapes.md section 3).
 *
 * A unit is a product or quotient of tokens: `W/m^3`, `eV`, `reaction/particle`, `1`. Every token has a factor to its SI
 * base and an exponent vector; a counted thing (`particle`, `reaction`, ...) is its own axis, so `reaction/particle` is
 * not dimensionless. The only conversion the host performs goes through these tables. An unknown token is a refusal,
 * never a pass-through.
 */

export type Dimension =
  | "length"
  | "time"
  | "temperature"
  | "pressure"
  | "energy"
  | "power"
  | "power-per-length"
  | "power-per-volume"
  | "heat-flux"
  | "mass-flow"
  | "probability"
  | "count"
  | "rate"
  | "dimensionless"
  | "other";

export const DIMENSIONS: readonly Dimension[] = [
  "length", "time", "temperature", "pressure", "energy", "power", "power-per-length", "power-per-volume",
  "heat-flux", "mass-flow", "probability", "count", "rate", "dimensionless", "other"
];

const BASE_AXES = ["m", "kg", "s", "K", "A", "mol"] as const;
const COUNTED = ["particle", "reaction", "event", "fission", "demand"] as const;
type Vec = Record<string, number>;

const vec = (o: Vec): Vec => o;
// token -> [factor to SI, exponent vector, whether an SI prefix may be put in front]
const TOKENS: Record<string, { f: number; v: Vec; prefix: boolean }> = {
  m: { f: 1, v: vec({ m: 1 }), prefix: true },
  g: { f: 1e-3, v: vec({ kg: 1 }), prefix: true },
  s: { f: 1, v: vec({ s: 1 }), prefix: true },
  K: { f: 1, v: vec({ K: 1 }), prefix: true },
  A: { f: 1, v: vec({ A: 1 }), prefix: true },
  mol: { f: 1, v: vec({ mol: 1 }), prefix: true },
  Pa: { f: 1, v: vec({ kg: 1, m: -1, s: -2 }), prefix: true },
  N: { f: 1, v: vec({ kg: 1, m: 1, s: -2 }), prefix: true },
  J: { f: 1, v: vec({ kg: 1, m: 2, s: -2 }), prefix: true },
  W: { f: 1, v: vec({ kg: 1, m: 2, s: -3 }), prefix: true },
  Hz: { f: 1, v: vec({ s: -1 }), prefix: true },
  eV: { f: 1.602176634e-19, v: vec({ kg: 1, m: 2, s: -2 }), prefix: true },
  b: { f: 1e-28, v: vec({ m: 2 }), prefix: true },
  hour: { f: 3600, v: vec({ s: 1 }), prefix: false },
  "1": { f: 1, v: vec({}), prefix: false }
};
for (const c of COUNTED) TOKENS[c] = { f: 1, v: vec({ [c]: 1 }), prefix: false };

const PREFIXES: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, c: 1e-2 };

export type ParsedUnit = { ok: true; factor: number; vector: Vec; celsius: boolean } | { ok: false; reason: string };

function parseToken(tok: string): { f: number; v: Vec } | null {
  const exact = TOKENS[tok];
  if (exact) return { f: exact.f, v: exact.v };
  const p = PREFIXES[tok[0] ?? ""];
  const base = TOKENS[tok.slice(1)];
  if (p !== undefined && base && base.prefix) return { f: p * base.f, v: base.v };
  return null;
}

function parseTerms(text: string, sign: 1 | -1, vector: Vec): { factor: number } | string {
  let factor = 1;
  for (const term of text.split("*")) {
    const m = /^([A-Za-z]+|1)(?:\^(-?[1-9][0-9]?))?$/.exec(term);
    if (!m) return `cannot read ${JSON.stringify(term)}`;
    const t = parseToken(m[1]!);
    if (!t) return `unknown unit ${JSON.stringify(m[1])}`;
    const n = m[2] === undefined ? 1 : Number(m[2]);
    factor *= Math.pow(t.f, sign * n);
    for (const [axis, e] of Object.entries(t.v)) vector[axis] = (vector[axis] ?? 0) + sign * n * e;
  }
  return { factor };
}

export function parseUnit(unit: string): ParsedUnit {
  if (typeof unit !== "string" || unit.length === 0 || unit.length > 40) return { ok: false, reason: "a unit is 1 to 40 characters" };
  if (unit === "degC") return { ok: true, factor: 1, vector: { K: 1 }, celsius: true };
  const parts = unit.split("/");
  if (parts.length > 2) return { ok: false, reason: "at most one '/' in a unit" };
  const vector: Vec = {};
  const num = parseTerms(parts[0]!, 1, vector);
  if (typeof num === "string") return { ok: false, reason: num };
  let factor = num.factor;
  if (parts[1] !== undefined) {
    const den = parseTerms(parts[1], -1, vector);
    if (typeof den === "string") return { ok: false, reason: den };
    factor *= den.factor;
  }
  for (const k of Object.keys(vector)) if (vector[k] === 0) delete vector[k];
  return { ok: true, factor, vector, celsius: false };
}

const sameVec = (a: Vec, b: Vec): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

const SI: Partial<Record<Dimension, Vec>> = {
  length: { m: 1 },
  time: { s: 1 },
  temperature: { K: 1 },
  pressure: { kg: 1, m: -1, s: -2 },
  energy: { kg: 1, m: 2, s: -2 },
  power: { kg: 1, m: 2, s: -3 },
  "power-per-length": { kg: 1, m: 1, s: -3 },
  "power-per-volume": { kg: 1, m: -1, s: -3 },
  "heat-flux": { kg: 1, s: -3 },
  "mass-flow": { kg: 1, s: -1 }
};

const isCountedAxis = (k: string): boolean => (COUNTED as readonly string[]).includes(k);

/** Does this unit belong to this dimension? Returns a refusal text, or null when it does. */
export function unitMismatch(unit: string, dimension: Dimension): string | null {
  const p = parseUnit(unit);
  if (!p.ok) return p.reason;
  const keys = Object.keys(p.vector);
  const counts = keys.filter(isCountedAxis);
  const physical = keys.filter((k) => !isCountedAxis(k));
  switch (dimension) {
    case "probability":
    case "dimensionless":
      return keys.length === 0 && !p.celsius ? null : `${JSON.stringify(unit)} is not dimensionless`;
    case "count":
      return counts.length === 1 && p.vector[counts[0]!] === 1 && physical.length === 0 ? null : `${JSON.stringify(unit)} is not a single counted thing`;
    case "rate":
      return physical.length === 1 && p.vector.s === -1 && counts.every((c) => p.vector[c] === 1) && counts.length <= 1 ? null : `${JSON.stringify(unit)} is not a rate (per time, optionally of one counted thing)`;
    case "other":
      return null;
    default: {
      const want = SI[dimension]!;
      if (counts.length > 0) return `${JSON.stringify(unit)} carries a counted thing; ${dimension} does not`;
      if (p.celsius) return dimension === "temperature" ? null : `degC is a temperature`;
      return sameVec(p.vector, want) ? null : `${JSON.stringify(unit)} is not a ${dimension} unit`;
    }
  }
}

/** Convert a value to the SI unit of its dimension (K for temperature, 1 for the dimensionless ones). Throws on a mismatch. */
export function toSI(value: number, unit: string, dimension: Dimension): number {
  const bad = unitMismatch(unit, dimension);
  if (bad) throw new Error(bad);
  const p = parseUnit(unit);
  if (!p.ok) throw new Error(p.reason);
  if (p.celsius) return value + 273.15;
  return value * p.factor;
}
