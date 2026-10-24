/**
 * Sensitivity analysis for a sampling study (docs/sensitivity.md): Sobol variance-based indices and Morris elementary effects. Pure: no file, no
 * clock, no `Math.random`; every random draw comes from the seeded `Rng` of the sampler. Nothing here is wired into the host yet.
 *
 * Everything works in the unit hypercube. A caller maps a unit point to real parameter values with the distributions' `quantile`. Because
 * `quantile` needs probabilities strictly inside (0, 1), a Morris point (which can be exactly 0 or 1) goes through `openUnit` first.
 *
 * Sobol (Saltelli design): two independent n-by-d matrices A and B, and for each parameter i the matrix AB_i, which is A with column i taken
 * from B. The model runs n*(d+2) times. First-order index (Saltelli et al. 2010): S_i = (1/n) sum_j fB[j] (fAB_i[j] - fA[j]) / Var. Total-order
 * index (Jansen 1999): ST_i = (1/(2n)) sum_j (fA[j] - fAB_i[j])^2 / Var. Var is the sample variance (denominator 2n - 1) of the pooled values
 * of fA and fB: they are 2n draws from the same output distribution, so pooling gives the best estimate of the one variance both formulas
 * divide by. The pooled mean is subtracted from every value first; the Jansen formula uses differences, so only the first-order formula
 * changes, and there the centring removes a large part of the sampling noise.
 *
 * An index estimate is an estimate. It can come out slightly below 0 or above 1 because of sampling error. It is NOT clamped here: clamping hides
 * the size of the noise and biases the mean of repeated estimates. A caller who reads an estimate of -0.02 reads "zero, within noise".
 *
 * Morris (Campolongo, Cariboni and Saltelli 2007): r trajectories of d+1 points on a grid of `levels` values; one parameter moves per step by
 * +delta or -delta. The elementary effect of a step is (f(next) - f(prev)) / (signed delta). mu is its mean, muStar the mean of its absolute
 * value, sigma its sample standard deviation. Morris ranks parameters (screening); it does not give a share of the variance.
 */
import { Rng, unitDesign, type DesignMethod } from "./sampler";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- Sobol design ------------------------------------------------------------------------------------------------------------------------

export type SobolDesign = {
  n: number;
  d: number;
  /** n rows of d unit values. */
  A: number[][];
  /** n rows of d unit values, independent of A. */
  B: number[][];
  /** AB[i] is A with column i replaced by column i of B: d matrices of n rows. */
  AB: number[][][];
};

export type SobolDesignOptions = { n: number; d: number; seed: number; method: DesignMethod };

/** One design of n rows by 2d columns; the first d columns are A, the last d columns are B. n*(d+2) model runs in total. */
export function sobolUnitDesign(options: SobolDesignOptions): SobolDesign {
  const { n, d, seed, method } = options;
  if (!Number.isInteger(n) || n < 8) throw new Error("a Sobol design needs n, a whole number of 8 or more");
  if (!Number.isInteger(d) || d < 1) throw new Error("a Sobol design needs d, a whole number of 1 or more");
  const full = unitDesign({ method, n, seed }, 2 * d);
  const A = full.map((row) => row.slice(0, d));
  const B = full.map((row) => row.slice(d, 2 * d));
  const AB = Array.from({ length: d }, (_, i) => A.map((row, j) => row.map((v, k) => (k === i ? B[j]![k]! : v))));
  return { n, d, A, B, AB };
}

/**
 * The points to run, in this order: the n rows of A, then the n rows of B, then the n rows of AB[0], AB[1], ... AB[d-1]. n*(d+2) points.
 * The caller runs them in this order and gives the outputs back in the same order to `sobolSplit`.
 */
export function sobolRows(design: SobolDesign): number[][] {
  return [...design.A, ...design.B, ...design.AB.flat()].map((row) => row.slice());
}

/** Cuts a flat list of n*(d+2) outputs (in the order of `sobolRows`) into fA, fB and fAB (fAB[i] holds the n outputs of AB[i]). */
export function sobolSplit(values: readonly number[], n: number, d: number): { fA: number[]; fB: number[]; fAB: number[][] } {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(d) || d < 1) throw new Error("n and d are whole numbers of 1 or more");
  if (values.length !== n * (d + 2)) throw new Error(`expected ${n * (d + 2)} outputs (n*(d+2) with n=${n}, d=${d}), got ${values.length}`);
  const fA = values.slice(0, n);
  const fB = values.slice(n, 2 * n);
  const fAB = Array.from({ length: d }, (_, i) => values.slice((2 + i) * n, (3 + i) * n));
  return { fA, fB, fAB };
}

// ---- Sobol indices -----------------------------------------------------------------------------------------------------------------------

export type SobolBootstrap = { resamples?: number; level?: number; seed: number };
export type SobolOptions = { bootstrap?: SobolBootstrap };
export type SobolParameter = {
  first: number;
  total: number;
  /** Percentile interval of the bootstrap, only when `bootstrap` was asked for. */
  firstInterval?: [number, number];
  totalInterval?: [number, number];
};
export type SobolResult = {
  n: number;
  d: number;
  /** Mean of the pooled fA and fB. */
  mean: number;
  /** Sample variance (denominator 2n - 1) of the pooled fA and fB. */
  variance: number;
  parameters: SobolParameter[];
  bootstrap?: { resamples: number; level: number; skipped: number };
};

type Estimate = { mean: number; variance: number; first: number[]; total: number[] };

/** The estimates on the rows listed in `rows` (repeats allowed). Null when the variance of those rows is 0. */
function estimate(fA: readonly number[], fB: readonly number[], fAB: readonly (readonly number[])[], rows: readonly number[]): Estimate | null {
  const m = rows.length;
  let sum = 0;
  for (const j of rows) sum += fA[j]! + fB[j]!;
  const mean = sum / (2 * m);
  let ss = 0;
  for (const j of rows) ss += (fA[j]! - mean) ** 2 + (fB[j]! - mean) ** 2;
  const variance = ss / (2 * m - 1);
  if (!Number.isFinite(mean) || !Number.isFinite(variance)) throw new Error("the model outputs are too large: their mean or variance overflows, so no index can be given");
  if (!(variance > 0)) return null;
  const first: number[] = [];
  const total: number[] = [];
  for (const f of fAB) {
    let s1 = 0, s2 = 0;
    for (const j of rows) {
      s1 += (fB[j]! - mean) * (f[j]! - fA[j]!);
      s2 += (fA[j]! - f[j]!) ** 2;
    }
    const fi = s1 / m / variance, ti = s2 / (2 * m) / variance;
    if (!Number.isFinite(fi) || !Number.isFinite(ti)) throw new Error("the model outputs are too large: an index overflows");
    first.push(fi);
    total.push(ti);
  }
  return { mean, variance, first, total };
}

/** Linear interpolation between order statistics (the "type 7" percentile) of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * First-order and total-order Sobol indices from the outputs of a Saltelli design. `fAB[i][j]` is the output of row j of AB[i].
 * Refuses (throws) rather than return NaN: n below 8, no parameter, a value that is not finite, lengths that do not match, or a variance of 0
 * (a constant output has no variance to share out, so the indices do not exist).
 */
export function sobolIndices(fA: readonly number[], fB: readonly number[], fAB: readonly (readonly number[])[], options: SobolOptions = {}): SobolResult {
  const n = fA.length;
  const d = fAB.length;
  if (d < 1) throw new Error("fAB holds no parameter: d must be 1 or more");
  if (n < 8) throw new Error(`n is ${n}; the indices need n of 8 or more`);
  if (fB.length !== n) throw new Error(`fA has ${n} values but fB has ${fB.length}`);
  fAB.forEach((f, i) => {
    if (f.length !== n) throw new Error(`fA has ${n} values but fAB[${i}] has ${f.length}`);
  });
  const all = [fA, fB, ...fAB];
  all.forEach((list, k) => {
    const bad = list.findIndex((v) => !finite(v));
    if (bad >= 0) throw new Error(`a model output is not a finite number (${k === 0 ? "fA" : k === 1 ? "fB" : `fAB[${k - 2}]`}[${bad}])`);
  });
  const identity = Array.from({ length: n }, (_, j) => j);
  let lo = Infinity, hi = -Infinity;
  for (const v of fA) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const v of fB) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const point = lo === hi ? null : estimate(fA, fB, fAB, identity);
  if (!point) throw new Error("the variance of the output is 0 (fA and fB are constant), so Sobol indices are undefined");
  const parameters: SobolParameter[] = point.first.map((first, i) => ({ first, total: point.total[i]! }));
  const result: SobolResult = { n, d, mean: point.mean, variance: point.variance, parameters };

  const bs = options.bootstrap;
  if (bs) {
    const resamples = bs.resamples ?? 200;
    const level = bs.level ?? 0.95;
    if (!Number.isInteger(resamples) || resamples < 10) throw new Error("bootstrap.resamples is a whole number of 10 or more");
    if (!(level > 0 && level < 1)) throw new Error("bootstrap.level is a number strictly between 0 and 1");
    const rng = new Rng(bs.seed);
    const firsts: number[][] = Array.from({ length: d }, () => []);
    const totals: number[][] = Array.from({ length: d }, () => []);
    let skipped = 0;
    for (let b = 0; b < resamples; b++) {
      const rows = Array.from({ length: n }, () => rng.int(n));
      const e = estimate(fA, fB, fAB, rows);
      if (!e) { skipped++; continue; }
      for (let i = 0; i < d; i++) { firsts[i]!.push(e.first[i]!); totals[i]!.push(e.total[i]!); }
    }
    if (firsts[0]!.length < 2) throw new Error("almost every bootstrap resample had a variance of 0; no interval can be given");
    const a = (1 - level) / 2;
    for (let i = 0; i < d; i++) {
      const f = firsts[i]!.sort((x, y) => x - y), t = totals[i]!.sort((x, y) => x - y);
      parameters[i]!.firstInterval = [percentile(f, a), percentile(f, 1 - a)];
      parameters[i]!.totalInterval = [percentile(t, a), percentile(t, 1 - a)];
    }
    result.bootstrap = { resamples, level, skipped };
  }
  return result;
}

// ---- Morris design -----------------------------------------------------------------------------------------------------------------------

export type MorrisStep = { parameter: number; delta: number };
export type MorrisDesign = {
  r: number;
  d: number;
  levels: number;
  /** r*(d+1) rows, trajectory by trajectory; each trajectory is d+1 consecutive rows. Values lie in [0, 1] and can be exactly 0 or 1. */
  points: number[][];
  /** steps[t][s] is the s-th move of trajectory t: which parameter moved, and by the signed delta. */
  steps: MorrisStep[][];
};
export type MorrisDesignOptions = { r: number; d: number; levels?: number; seed: number };

/** Maps exactly 0 and exactly 1 to 1e-9 and 1 - 1e-9 and leaves any other value unchanged. Callers use it before `quantile`. */
export function openUnit(u: number): number {
  if (!Number.isFinite(u) || u < 0 || u > 1) throw new Error(`a unit value is a number from 0 to 1, not ${u}`);
  return u <= 0 ? 1e-9 : u >= 1 ? 1 - 1e-9 : u;
}

/** r trajectories of d+1 points (Campolongo, Cariboni, Saltelli 2007): r*(d+1) model runs. */
export function morrisUnitDesign(options: MorrisDesignOptions): MorrisDesign {
  const { r, d, seed } = options;
  const levels = options.levels ?? 4;
  if (!Number.isInteger(r) || r < 2) throw new Error("a Morris design needs r, a whole number of 2 or more trajectories");
  if (!Number.isInteger(d) || d < 1) throw new Error("a Morris design needs d, a whole number of 1 or more");
  if (!Number.isInteger(levels) || levels < 2 || levels % 2 !== 0) throw new Error("levels is an even whole number of 2 or more");
  const rng = new Rng(seed);
  // Work in whole grid steps so that the points sit exactly on the grid: the grid has p+1 nodes 0..p, a move is h = levels/2 nodes.
  const p = levels - 1;
  const h = levels / 2;
  const delta = h / p; // = levels / (2 (levels - 1))
  const points: number[][] = [];
  const steps: MorrisStep[][] = [];
  for (let t = 0; t < r; t++) {
    // Each parameter moves once, between two grid nodes s and s + h. s is drawn among the nodes that allow a +delta step (0..p-h); a random
    // sign says whether the parameter starts at s and moves up, or starts at s + h and moves down (the D* matrix of Campolongo et al. 2007).
    // Without the sign draw every step would be +delta: a start restricted to 0..p-h can never move down.
    const low = Array.from({ length: d }, () => rng.int(p - h + 1));
    const up = Array.from({ length: d }, () => rng.int(2) === 0);
    const order = rng.permutation(d);
    const idx = low.map((s, k) => (up[k]! ? s : s + h));
    points.push(idx.map((k) => k / p));
    const trajectory: MorrisStep[] = [];
    for (const parameter of order) {
      idx[parameter] = up[parameter]! ? low[parameter]! + h : low[parameter]!;
      trajectory.push({ parameter, delta: up[parameter]! ? delta : -delta });
      points.push(idx.map((k) => k / p));
    }
    steps.push(trajectory);
  }
  return { r, d, levels, points, steps };
}

// ---- Morris effects ----------------------------------------------------------------------------------------------------------------------

export type MorrisParameter = { mu: number; muStar: number; sigma: number; n: number; effects: number[] };

/** Elementary effects per parameter from the outputs of the r*(d+1) points of the design (in the order of `design.points`). */
export function morrisEffects(outputs: readonly number[], design: MorrisDesign): MorrisParameter[] {
  const { r, d } = design;
  if (design.steps.length !== r || design.steps.some((s) => s.length !== d)) throw new Error("the design is malformed: every trajectory needs d steps");
  if (outputs.length !== r * (d + 1)) throw new Error(`expected ${r * (d + 1)} outputs (r*(d+1) with r=${r}, d=${d}), got ${outputs.length}`);
  const bad = outputs.findIndex((v) => !finite(v));
  if (bad >= 0) throw new Error(`a model output is not a finite number (outputs[${bad}])`);
  const effects: number[][] = Array.from({ length: d }, () => []);
  for (let t = 0; t < r; t++) {
    for (let s = 0; s < d; s++) {
      const base = t * (d + 1) + s;
      const step = design.steps[t]![s]!;
      const effect = (outputs[base + 1]! - outputs[base]!) / step.delta;
      if (!Number.isFinite(effect)) throw new Error(`the elementary effect of parameter ${step.parameter} in trajectory ${t} is not a finite number (the outputs differ by more than can be divided by the step)`);
      effects[step.parameter]!.push(effect);
    }
  }
  return effects.map((ee) => {
    const n = ee.length;
    const mu = ee.reduce((a, b) => a + b, 0) / n;
    const muStar = ee.reduce((a, b) => a + Math.abs(b), 0) / n;
    const sigma = n > 1 ? Math.sqrt(ee.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1)) : 0;
    return { mu, muStar, sigma, n, effects: ee };
  });
}
