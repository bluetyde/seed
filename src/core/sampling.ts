import { DISTRIBUTION_KINDS, MAX_SEED, distributionProblem, pointsFromUnit, unitDesign, type Design, type DesignMethod, type Distribution } from "./sampler";
import { morrisEffects, morrisUnitDesign, openUnit, sobolIndices, sobolRows, sobolSplit, sobolUnitDesign, type MorrisDesign, type SobolDesign } from "./sensitivity";
import { DEFAULT_MAX_CASES, type PolicyStudy } from "./policy";
import type { QuantityData } from "./quantityData";
import type { RegisteredCase } from "./runDispatcher";
import { HARD_MAX_CASES, sweepCaseId, type ExpandedCase } from "./sweep";
import type { TypedError } from "./validate";

/**
 * A sampling study (docs/sampling.md, plan 09). Registered by the host like a sweep: the client names it and a budget, never a value. A person
 * writes, in the host configuration, the base case, the design (method, number of points, seed), the distribution of each study parameter, and
 * the outputs to summarise. Every point becomes a registered case of its own (`<samplingId>-001` and on), run through the same guarded path
 * as a sweep case. Only parameters the study declares with bounds can be sampled, and the whole window of a distribution must lie inside those
 * bounds, so no sample is refused at the gate half way through.
 */
export type OutputReduction = "last" | "first" | "min" | "max" | "mean";
export const REDUCTIONS: readonly OutputReduction[] = ["last", "first", "min", "max", "mean"];
export type SamplingOutput = { quantity: string; reduce: OutputReduction };
/**
 * `lhs` and `random` draw n points from the declared distributions. `sobol` (n is the base size: n*(d+2) runs, n at least 8) and `morris` (n is the
 * number of trajectories: n*(d+1) runs, n at least 2) are the sensitivity designs of docs/sensitivity.md: they also give which parameter causes the spread.
 */
export type SamplingMethod = DesignMethod | "sobol" | "morris";
export const SAMPLING_METHODS: readonly SamplingMethod[] = ["lhs", "random", "sobol", "morris"];
export type SamplingDesign = { method: SamplingMethod; n: number; seed: number };
export type SamplingDefinition = {
  base: string;
  design: SamplingDesign;
  parameters: { id: string; distribution: Distribution }[];
  outputs: SamplingOutput[];
};
export const MAX_SAMPLING_PARAMETERS = 8;
export const MAX_SAMPLING_OUTPUTS = 8;
export const MIN_POINTS = 2;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
const QUANTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const bad = (field: string, message: string): { ok: false; errors: TypedError[] } => ({ ok: false, errors: [{ code: "E_SCHEMA_INVALID", field, message, source: "seed" }] });
const outputKey = (o: SamplingOutput) => `${o.quantity}:${o.reduce}`;
export { outputKey };

export const SOBOL_MIN_N = 8;
export const MORRIS_MIN_R = 2;

/** How many runs a design makes for `dims` parameters. */
export function designRuns(design: SamplingDesign, dims: number): number {
  if (design.method === "sobol") return design.n * (dims + 2);
  if (design.method === "morris") return design.n * (dims + 1);
  return design.n;
}

/** The design in the unit hypercube: its rows in run order, and for the two sensitivity methods the design object the estimators need. Pure. */
export function unitPoints(design: SamplingDesign, dims: number): { rows: number[][]; sobol?: SobolDesign; morris?: MorrisDesign } {
  if (design.method === "sobol") {
    const sobol = sobolUnitDesign({ n: design.n, d: dims, seed: design.seed, method: "lhs" });
    return { rows: sobolRows(sobol), sobol };
  }
  if (design.method === "morris") {
    const morris = morrisUnitDesign({ r: design.n, d: dims, seed: design.seed });
    return { rows: morris.points.map((row) => row.map(openUnit)), morris };
  }
  return { rows: unitDesign(design as Design, dims) };
}

/** The lowest and highest value a distribution can give. */
export function support(d: Distribution): [number, number] {
  return [d.min, d.max];
}

/**
 * The cases of a sampling, in sample order. Pure: the same definition gives the same cases and values. A definition that cannot be expanded is
 * an error naming what is wrong, never a shorter sample.
 */
export function expandSampling(
  samplingId: string,
  def: SamplingDefinition,
  cases: Readonly<Record<string, RegisteredCase>>,
  study: PolicyStudy
): { ok: true; cases: ExpandedCase[]; points: number[][] } | { ok: false; errors: TypedError[] } {
  if (typeof samplingId !== "string" || !ID.test(samplingId)) return bad("/samplingId", "a sampling id is 1 to 56 letters, digits, dots, dashes or underscores");
  const at = `/samplings/${samplingId}`;
  if (def === null || typeof def !== "object" || Array.isArray(def)) return bad(at, "a sampling names a base case, a design, parameters and outputs");
  const extra = Object.keys(def).find((k) => !["base", "design", "parameters", "outputs"].includes(k));
  if (extra !== undefined) return bad(`${at}/${extra}`, `a sampling has base, design, parameters and outputs; not ${extra}`);
  if (typeof def.base !== "string" || !Object.hasOwn(cases, def.base)) return bad(`${at}/base`, `base case ${String(def.base)} is not registered`);
  const base = cases[def.base] as RegisteredCase;

  const d = def.design as Partial<SamplingDesign> | null;
  if (d === null || typeof d !== "object") return bad(`${at}/design`, "the design has a method, n and a seed");
  const dExtra = Object.keys(d).find((k) => !["method", "n", "seed"].includes(k));
  if (dExtra !== undefined) return bad(`${at}/design/${dExtra}`, `the design has method, n and seed; not ${dExtra}`);
  if (!SAMPLING_METHODS.includes(d.method as SamplingMethod)) return bad(`${at}/design/method`, "the design method is lhs (Latin hypercube), random, sobol or morris");
  const least = d.method === "sobol" ? SOBOL_MIN_N : d.method === "morris" ? MORRIS_MIN_R : MIN_POINTS;
  if (!Number.isSafeInteger(d.n) || (d.n as number) < least) return bad(`${at}/design/n`, `n is a whole number of at least ${least}${d.method === "sobol" ? " (the base size of a Sobol design)" : d.method === "morris" ? " (the number of Morris trajectories)" : ""}`);
  if (!Number.isInteger(d.seed) || (d.seed as number) < 0 || (d.seed as number) > MAX_SEED) return bad(`${at}/design/seed`, "the seed is a whole number from 0 to 4294967295");
  const design = d as SamplingDesign;
  const dims = Array.isArray(def.parameters) ? def.parameters.length : 0;
  const runs = designRuns(design, dims);
  const limit = Math.min(study.budget.maxCases ?? DEFAULT_MAX_CASES, HARD_MAX_CASES);
  if (runs > limit) {
    return { ok: false, errors: [{ code: "E_BUDGET_EXCEEDED", field: `${at}/design/n`, message: `the sampling has ${runs} points (${design.method} with n ${design.n} and ${dims} parameters), over the study limit of ${limit} cases (a person raises maxCases in the study budget)`, source: "seed", range: { max: limit } }] };
  }

  if (!Array.isArray(def.parameters) || def.parameters.length < 1 || def.parameters.length > MAX_SAMPLING_PARAMETERS) return bad(`${at}/parameters`, `a sampling has 1 to ${MAX_SAMPLING_PARAMETERS} parameters`);
  const seen = new Set<string>();
  for (let i = 0; i < def.parameters.length; i++) {
    const p = def.parameters[i] as SamplingDefinition["parameters"][number];
    const pAt = `${at}/parameters/${i}`;
    if (p === null || typeof p !== "object" || typeof p.id !== "string") return bad(pAt, "a parameter names a study parameter and its distribution");
    const pExtra = Object.keys(p).find((k) => k !== "id" && k !== "distribution");
    if (pExtra !== undefined) return bad(`${pAt}/${pExtra}`, `a parameter has id and distribution; not ${pExtra}`);
    if (FORBIDDEN_KEYS.has(p.id)) return bad(`${pAt}/id`, `${p.id} cannot be sampled`);
    const bound = study.parameters.find((b) => b.id === p.id);
    if (!bound) return bad(`${pAt}/id`, `${p.id} is not a parameter of the study; only parameters with human-declared bounds can be sampled`);
    if (seen.has(p.id)) return bad(`${pAt}/id`, `${p.id} is sampled twice`);
    seen.add(p.id);
    const problem = distributionProblem(p.distribution);
    if (problem) return bad(`${pAt}/distribution`, problem);
    const [lo, hi] = support(p.distribution);
    if (lo < bound.min || hi > bound.max) {
      return bad(`${pAt}/distribution`, `the window ${lo} to ${hi} of ${p.id} leaves the study bounds ${bound.min} to ${bound.max}; a sample outside them would be refused at the gate and stop the run`);
    }
  }

  if (!Array.isArray(def.outputs) || def.outputs.length < 1 || def.outputs.length > MAX_SAMPLING_OUTPUTS) return bad(`${at}/outputs`, `a sampling summarises 1 to ${MAX_SAMPLING_OUTPUTS} outputs`);
  const outs = new Set<string>();
  for (let i = 0; i < def.outputs.length; i++) {
    const o = def.outputs[i] as SamplingOutput;
    const oAt = `${at}/outputs/${i}`;
    if (o === null || typeof o !== "object" || typeof o.quantity !== "string" || !QUANTITY.test(o.quantity)) return bad(oAt, "an output names a quantity and how a series is reduced to one number");
    const oExtra = Object.keys(o).find((k) => k !== "quantity" && k !== "reduce");
    if (oExtra !== undefined) return bad(`${oAt}/${oExtra}`, `an output has quantity and reduce; not ${oExtra}`);
    if (!REDUCTIONS.includes(o.reduce)) return bad(`${oAt}/reduce`, `reduce is one of ${REDUCTIONS.join(", ")}`);
    if (outs.has(outputKey(o))) return bad(oAt, `the output ${outputKey(o)} is listed twice`);
    outs.add(outputKey(o));
  }

  const points = pointsFromUnit(unitPoints(design, def.parameters.length).rows, def.parameters.map((p) => p.distribution));
  const out: ExpandedCase[] = points.map((row, i) => {
    const registered = structuredClone(base);
    const settings: Record<string, unknown> = { ...(registered.settings ?? {}) };
    const values: { id: string; value: number }[] = [];
    def.parameters.forEach((p, j) => {
      const value = row[j] as number;
      values.push({ id: p.id, value });
      settings[p.id] = value;
      const param = registered.params.find((q) => q.id === p.id);
      if (param !== undefined) param.value = value;
      else registered.params.push({ id: p.id, value });
    });
    registered.settings = settings;
    return { caseId: sweepCaseId(samplingId, i + 1), registered, values };
  });
  return { ok: true, cases: out, points };
}

// ---- reducing a quantity to one number ----------------------------------------------------------------------------------------------------

export type Reduced = { ok: true; value: number; std: number | null } | { ok: false; reason: string };

/**
 * One number from a quantity of one run. A scalar is itself; a series is reduced as the output says. The standard deviation the adapter reported
 * for that number (Monte Carlo noise) is carried when the data has one at that place, and is `null` when it has none or when a reduction
 * (a mean of a series) has no defined deviation: it is never estimated here.
 */
export function reduceQuantity(data: QuantityData, reduce: OutputReduction): Reduced {
  if (data.kind === "scalar") return Number.isFinite(data.value) ? { ok: true, value: data.value, std: data.std !== undefined && Number.isFinite(data.std) ? data.std : null } : { ok: false, reason: "the value is not a finite number" };
  if (data.kind === "table") return { ok: false, reason: "a table quantity cannot be sampled; name a scalar or a series" };
  const v = data.values;
  if (v.length < 1 || v.some((x) => !Number.isFinite(x))) return { ok: false, reason: "the series is empty or holds a value that is not a finite number" };
  const at = (i: number): Reduced => ({ ok: true, value: v[i] as number, std: data.std !== undefined && Number.isFinite(data.std[i]) ? (data.std[i] as number) : null });
  switch (reduce) {
    case "last": return at(v.length - 1);
    case "first": return at(0);
    // loops, not Math.min(...v): a long series must not fail on the engine's limit for arguments
    case "min": { let k = 0; for (let i = 1; i < v.length; i++) if ((v[i] as number) < (v[k] as number)) k = i; return at(k); }
    case "max": { let k = 0; for (let i = 1; i < v.length; i++) if ((v[i] as number) > (v[k] as number)) k = i; return at(k); }
    case "mean": { const m = v.reduce((s, x) => s + x, 0) / v.length; return Number.isFinite(m) ? { ok: true, value: m, std: null } : { ok: false, reason: "the mean of the series is too large to be a finite number" }; }
  }
}

// ---- statistics ---------------------------------------------------------------------------------------------------------------------------

export type SampleRun = {
  caseId: string;
  /** The value of each sampled parameter at this point, in the order of `parameters`. */
  values: number[];
  /** Per output key, the reduced number, or null when the run did not give one. */
  outputs: Record<string, { value: number; std: number | null } | null>;
};
export type OutputSummary = {
  key: string;
  quantity: string;
  reduce: OutputReduction;
  /** Runs that gave a number, out of the planned points. */
  n: number;
  planned: number;
  mean: number | null;
  /** Sample standard deviation (n - 1) of the outputs: **the spread of the output over the sampled inputs** (it contains the noise of each run). */
  inputSpread: number | null;
  /** Standard error of the mean: spread over the square root of n. */
  standardError: number | null;
  min: number | null;
  max: number | null;
  quantiles: { p05: number; p25: number; p50: number; p75: number; p95: number } | null;
  /** The mean and its standard error after the first k runs in case order, at four checkpoints: a sign of whether n is enough. */
  convergence: { n: number; mean: number; standardError: number | null }[];
  /**
   * **The sampling noise the adapter reported**: the root mean square of the per-run standard deviations, over the runs that reported one. It is a
   * different kind of uncertainty from `inputSpread` and is never added to it or taken from it. `null` with `reportedRuns: 0` when the adapter
   * reports none.
   */
  noise: { kind: "statistical"; rms: number | null; reportedRuns: number };
  /** Per sampled parameter: Pearson and Spearman correlation with this output over the runs; null where undefined (a constant). Correlation is not causation and sees only monotone or linear trends. */
  correlations: { parameter: string; pearson: number | null; spearman: number | null }[];
  note: string | null;
};

const finiteOrNull = (x: number) => (Number.isFinite(x) ? x : null);

/** Type 7 quantile (the default of R and numpy): linear between order statistics. */
export function quantile7(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}
function meanOf(x: readonly number[]) { return x.reduce((s, v) => s + v, 0) / x.length; }
function sdOf(x: readonly number[]) {
  if (x.length < 2) return null;
  const m = meanOf(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = meanOf(x), my = meanOf(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += ((x[i] as number) - mx) * ((y[i] as number) - my); sxx += ((x[i] as number) - mx) ** 2; syy += ((y[i] as number) - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
/** Ranks 1..n, equal values sharing the mean of their ranks. */
export function ranks(x: readonly number[]): number[] {
  const order = x.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(x.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1] as readonly [number, number])[0] === (order[i] as readonly [number, number])[0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[(order[k] as readonly [number, number])[1]] = rank;
    i = j + 1;
  }
  return r;
}
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  return pearson(ranks(x), ranks(y));
}

/** The summaries of a sampling, one per output. Pure. */
export function summarizeSampling(parameters: readonly string[], outputs: readonly SamplingOutput[], runs: readonly SampleRun[]): OutputSummary[] {
  return outputs.map((o) => {
    const key = outputKey(o);
    const rows = runs.filter((r) => r.outputs[key] != null);
    const values = rows.map((r) => (r.outputs[key] as { value: number }).value);
    const n = values.length;
    const sd = sdOf(values);
    const sorted = [...values].sort((a, b) => a - b);
    const stds = rows.map((r) => (r.outputs[key] as { std: number | null }).std).filter((s): s is number => s !== null);
    const checkpoints = n >= 8 ? [...new Set([Math.ceil(n / 4), Math.ceil(n / 2), Math.ceil((3 * n) / 4), n])] : [];
    const convergence = checkpoints.map((k) => {
      const head = values.slice(0, k);
      const s = sdOf(head);
      return { n: k, mean: meanOf(head), standardError: s === null ? null : s / Math.sqrt(k) };
    });
    const rms = stds.length > 0 ? Math.sqrt(stds.reduce((s, v) => s + v * v, 0) / stds.length) : null;
    // finite numbers can still overflow when squared or summed: that is said, never reported as an unknown spread
    if (n > 0 && !Number.isFinite(meanOf(values))) throw new Error(`the numbers of ${key} are too large to average without overflow`);
    if (n >= 2 && (sd === null || !Number.isFinite(sd))) throw new Error(`the numbers of ${key} are too large to take a spread of without overflow`);
    if (rms !== null && !Number.isFinite(rms)) throw new Error(`the reported noise of ${key} is too large to combine without overflow`);
    let note: string | null = null;
    if (o.reduce === "mean") note = "the noise of a mean of a series is not given: the covariance of its points is unknown, so no deviation is combined";
    if (n < runs.length) note = (note ? note + "; " : "") + `${runs.length - n} of ${runs.length} planned points gave no number for this output and are left out`;
    if (n < 2) note = (note ? note + "; " : "") + "fewer than two numbers: no spread can be given";
    else if (rms !== null && sd !== null && sd > 0 && rms > 0.5 * sd) note = (note ? note + "; " : "") + `the reported sampling noise (${rms.toPrecision(3)}) is more than half of the observed spread (${sd.toPrecision(3)}): the spread says little about the inputs until the noise is lower (more histories, or a rerun with another seed)`;
    return {
      key, quantity: o.quantity, reduce: o.reduce, n, planned: runs.length,
      mean: n > 0 ? meanOf(values) : null,
      inputSpread: sd === null ? null : finiteOrNull(sd),
      standardError: sd === null ? null : sd / Math.sqrt(n),
      min: n > 0 ? (sorted[0] as number) : null,
      max: n > 0 ? (sorted[n - 1] as number) : null,
      quantiles: n >= 2 ? { p05: quantile7(sorted, 0.05), p25: quantile7(sorted, 0.25), p50: quantile7(sorted, 0.5), p75: quantile7(sorted, 0.75), p95: quantile7(sorted, 0.95) } : null,
      convergence,
      noise: { kind: "statistical" as const, rms, reportedRuns: stds.length },
      correlations: parameters.map((p, j) => {
        const xs = rows.map((r) => r.values[j] as number);
        return { parameter: p, pearson: pearson(xs, values), spearman: spearman(xs, values) };
      }),
      note
    };
  });
}

// ---- sensitivity ----------------------------------------------------------------------------------------------------------------------------

export type SensitivityResult =
  | {
      method: "sobol"; n: number; d: number; mean: number; variance: number;
      parameters: { id: string; first: number; total: number; firstInterval?: [number, number]; totalInterval?: [number, number] }[];
      bootstrap?: { resamples: number; level: number; skipped: number };
    }
  | { method: "morris"; r: number; d: number; parameters: { id: string; mu: number; muStar: number; sigma: number }[] }
  | { method: "sobol" | "morris"; unavailable: string };

/**
 * The runs the ordinary summary (mean, spread, noise, quantiles) stands on. A Sobol design's A and B matrices are each a plain sample of the declared
 * distributions, so the summary uses those 2n runs; the AB runs are hybrids and are left to the indices. A Morris design is a walk on a grid, not a sample:
 * all its runs are summarised, and the summary says what that spread is.
 */
export function summaryRunsOf(design: SamplingDesign, runs: readonly SampleRun[]): SampleRun[] {
  return design.method === "sobol" ? runs.slice(0, 2 * design.n) : runs.slice();
}

/**
 * Sobol indices or Morris effects of every output, from all the runs of the design in run order. An output with a run that gave no number has no
 * indices (the estimators need every row): it says so, and names how many are missing. Never invents a number. Pure, seeded: the bootstrap of the
 * Sobol intervals uses the design's seed.
 */
export function sensitivityOf(def: SamplingDefinition, runs: readonly SampleRun[]): Record<string, SensitivityResult> | undefined {
  const method = def.design.method;
  if (method !== "sobol" && method !== "morris") return undefined;
  const ids = def.parameters.map((p) => p.id);
  const design = unitPoints(def.design, ids.length);
  const out: Record<string, SensitivityResult> = {};
  for (const o of def.outputs) {
    const key = outputKey(o);
    const values = runs.map((r) => r.outputs[key]?.value);
    const missing = values.filter((v) => v === undefined).length;
    if (values.length !== design.rows.length || missing > 0) {
      out[key] = { method, unavailable: `${missing > 0 ? missing : "some"} of the ${design.rows.length} runs gave no number for this output, and the ${method === "sobol" ? "Sobol" : "Morris"} estimators need every run of the design` };
      continue;
    }
    try {
      if (method === "sobol") {
        const { fA, fB, fAB } = sobolSplit(values as number[], def.design.n, ids.length);
        const r = sobolIndices(fA, fB, fAB, { bootstrap: { seed: def.design.seed } });
        out[key] = {
          method, n: r.n, d: r.d, mean: r.mean, variance: r.variance,
          parameters: r.parameters.map((p, j) => ({ id: ids[j] as string, first: p.first, total: p.total, ...(p.firstInterval ? { firstInterval: p.firstInterval } : {}), ...(p.totalInterval ? { totalInterval: p.totalInterval } : {}) })),
          ...(r.bootstrap ? { bootstrap: r.bootstrap } : {})
        };
      } else {
        const eff = morrisEffects(values as number[], design.morris as MorrisDesign);
        out[key] = { method, r: def.design.n, d: ids.length, parameters: eff.map((e, j) => ({ id: ids[j] as string, mu: e.mu, muStar: e.muStar, sigma: e.sigma })) };
      }
    } catch (e) {
      out[key] = { method, unavailable: e instanceof Error ? e.message : "the estimators refused these numbers" };
    }
  }
  return out;
}

export const SAMPLING_CAVEATS =
  "A sample is a set of runs at points drawn from distributions a person declared. The summary describes those runs: the spread of an output over the declared input ranges, and, apart from it, the sampling noise the adapter reported. The two are different kinds of uncertainty and are never added. Correlations show linear or monotone trends only. The summary says nothing about distributions that were not declared, about model error, or about points outside the declared ranges.";

export { DISTRIBUTION_KINDS };
