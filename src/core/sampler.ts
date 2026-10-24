/**
 * The in-house sampler of the sampling study (docs/sampling.md, plan 09): a seeded generator, Latin hypercube and plain random designs, and
 * the inverse distribution functions that turn a point of the unit hypercube into a value of a declared distribution. Pure: no file, no clock,
 * no `Math.random`. The same design and seed give the same points on every machine, because the generator uses only 32-bit integer operations
 * and the values are rounded to 12 significant digits (the inverse normal uses `Math.exp` and `Math.log`, whose last bit can differ between
 * JavaScript engines; the rounding hides that except exactly at a rounding boundary).
 *
 * Generator: xoshiro128** (Blackman and Vigna) with its four words filled from the seed by a 32-bit mixer. A real number is made from two
 * 32-bit draws with 53 bits and an offset of one half, so it is never exactly 0 or 1 and an inverse distribution function never sees an end.
 *
 * Latin hypercube: each dimension is cut into n strata of equal probability, one point falls in each stratum (random place inside it), and the
 * strata of the dimensions are paired by independent random permutations. Pairing is random, so two dimensions can be correlated by chance,
 * about 1/sqrt(n) in size; the design does not control that.
 */

export const MAX_SEED = 0xffffffff;

function mix32(state: { a: number }): number {
  state.a = (state.a + 0x9e3779b9) >>> 0;
  let t = state.a ^ (state.a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}
const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Rng {
  private readonly s = new Uint32Array(4);
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new Error("a seed is a whole number from 0 to 4294967295");
    const m = { a: seed >>> 0 };
    for (let i = 0; i < 4; i++) this.s[i] = mix32(m);
    if ((this.s[0]! | this.s[1]! | this.s[2]! | this.s[3]!) === 0) this.s[0] = 1;
  }
  /** The next 32-bit word. */
  u32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2] = (s[2]! ^ s[0]!) >>> 0;
    s[3] = (s[3]! ^ s[1]!) >>> 0;
    s[1] = (s[1]! ^ s[2]!) >>> 0;
    s[0] = (s[0]! ^ s[3]!) >>> 0;
    s[2] = (s[2]! ^ t) >>> 0;
    s[3] = rotl(s[3]!, 11);
    return result;
  }
  /** A real number in the open interval (0, 1), 53 bits. */
  next(): number {
    const a = this.u32() >>> 5;
    const b = this.u32() >>> 6;
    return (a * 67108864 + b + 0.5) / 9007199254740992;
  }
  /** A whole number from 0 to n-1, without the bias of a remainder. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new Error("n is a whole number from 1 to 2^32");
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const x = this.u32();
      if (x < limit) return x % n;
    }
  }
  /** A random permutation of 0..n-1 (Fisher-Yates). */
  permutation(n: number): number[] {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    return p;
  }
}

// ---- the normal distribution -------------------------------------------------------------------------------------------------------------

const SQRT2 = Math.SQRT2;
const SQRT_PI = Math.sqrt(Math.PI);

/** erfc for z >= 0, to about 1e-15 relative: a positive series for small z, a continued fraction for large z. */
function erfcPositive(z: number): number {
  if (z === 0) return 1;
  if (z < 2) {
    // erf(z) = 2/sqrt(pi) exp(-z^2) sum 2^n z^(2n+1) / (1 3 5 ... (2n+1)); all terms positive
    let term = z;
    let sum = z;
    for (let n = 1; n < 200; n++) {
      term *= (2 * z * z) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-z * z) * sum;
  }
  if (z > 27) return 0;
  // erfc(z) = exp(-z^2)/sqrt(pi) / (z + (1/2)/(z + (2/2)/(z + (3/2)/(z + ...))))
  let f = z;
  for (let k = 120; k >= 1; k--) f = z + k / 2 / f;
  return Math.exp(-z * z) / SQRT_PI / f;
}

/** The standard normal distribution function. */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x) / SQRT2;
  const tail = 0.5 * erfcPositive(z);
  return x < 0 ? tail : 1 - tail;
}
const normalPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** The standard normal quantile (inverse distribution function) for 0 < p < 1: a rational first guess, then Newton steps held inside a bracket. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("p is a number strictly between 0 and 1");
  if (p === 0.5) return 0;
  if (p > 0.5) return -normalQuantileLow(1 - p);
  return normalQuantileLow(p);
}
/** For 0 < p < 0.5: the negative root of cdf(x) = p. */
function normalQuantileLow(p: number): number {
  const t = Math.sqrt(-2 * Math.log(p));
  let x = -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
  let lo = -40, hi = 0;
  for (let i = 0; i < 100; i++) {
    const f = normalCdf(x) - p;
    if (f > 0) hi = x; else lo = x;
    const step = f / normalPdf(x);
    let next = x - step;
    if (!(next > lo && next < hi) || !Number.isFinite(next)) next = (lo + hi) / 2;
    if (Math.abs(next - x) <= 1e-15 * (1 + Math.abs(x))) return next;
    x = next;
  }
  return x;
}

// ---- distributions -----------------------------------------------------------------------------------------------------------------------

/**
 * A distribution a person declares for a parameter. Every one is **bounded**, because the study's bounds are a gate: a sample outside them would
 * be refused when its case starts and stop the sampling. A normal or a lognormal therefore carries the window `min` to `max` it is cut to.
 */
export type Distribution =
  | { kind: "uniform"; min: number; max: number }
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "normal"; mean: number; sd: number; min: number; max: number }
  | { kind: "lognormal"; mu: number; sigma: number; min: number; max: number };

export const DISTRIBUTION_KINDS = ["uniform", "triangular", "normal", "lognormal"] as const;
/** The least probability a truncation window may hold: a window further out than this in the tail is refused rather than sampled with no precision. */
export const MIN_WINDOW_MASS = 1e-9;

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Null when the distribution is usable, otherwise what is wrong with it. */
export function distributionProblem(d: unknown): string | null {
  if (d === null || typeof d !== "object") return "a distribution is an object with a kind";
  const x = d as Record<string, unknown>;
  const only = (keys: string[]) => Object.keys(x).find((k) => k !== "kind" && !keys.includes(k));
  switch (x.kind) {
    case "uniform": {
      const extra = only(["min", "max"]);
      if (extra) return `a uniform distribution has min and max, not ${extra}`;
      if (!fin(x.min) || !fin(x.max) || !(x.min < x.max)) return "uniform needs finite numbers with min below max";
      return null;
    }
    case "triangular": {
      const extra = only(["min", "mode", "max"]);
      if (extra) return `a triangular distribution has min, mode and max, not ${extra}`;
      if (!fin(x.min) || !fin(x.mode) || !fin(x.max) || !(x.min < x.max) || x.mode < x.min || x.mode > x.max) return "triangular needs finite numbers with min below max and the mode between them";
      return null;
    }
    case "normal": {
      const extra = only(["mean", "sd", "min", "max"]);
      if (extra) return `a normal distribution has mean, sd, min and max, not ${extra}`;
      if (!fin(x.mean) || !fin(x.sd) || !(x.sd > 0) || !fin(x.min) || !fin(x.max) || !(x.min < x.max)) return "normal needs finite mean, sd above 0, and a window min below max";
      const mass = normalCdf((x.max - x.mean) / x.sd) - normalCdf((x.min - x.mean) / x.sd);
      if (!(mass >= MIN_WINDOW_MASS)) return `the window min to max holds only ${mass.toExponential(2)} of the normal distribution; widen it or move the mean`;
      return null;
    }
    case "lognormal": {
      const extra = only(["mu", "sigma", "min", "max"]);
      if (extra) return `a lognormal distribution has mu, sigma, min and max, not ${extra}`;
      if (!fin(x.mu) || !fin(x.sigma) || !(x.sigma > 0) || !fin(x.min) || !fin(x.max) || !(x.min > 0) || !(x.min < x.max)) return "lognormal needs finite mu (the mean of ln x), sigma above 0, and a window 0 < min < max";
      const mass = normalCdf((Math.log(x.max) - x.mu) / x.sigma) - normalCdf((Math.log(x.min) - x.mu) / x.sigma);
      if (!(mass >= MIN_WINDOW_MASS)) return `the window min to max holds only ${mass.toExponential(2)} of the lognormal distribution; widen it or move mu`;
      return null;
    }
    default:
      return `the distribution kind ${JSON.stringify(x.kind)} is not one of ${DISTRIBUTION_KINDS.join(", ")}`;
  }
}

/** The value of the distribution at probability u (0 < u < 1), always inside its own bounds. */
export function quantile(d: Distribution, u: number): number {
  switch (d.kind) {
    case "uniform":
      return clamp(d.min + u * (d.max - d.min), d.min, d.max);
    case "triangular": {
      const f = (d.mode - d.min) / (d.max - d.min);
      const v = u < f ? d.min + Math.sqrt(u * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - u) * (d.max - d.min) * (d.max - d.mode));
      return clamp(v, d.min, d.max);
    }
    case "normal": {
      const a = normalCdf((d.min - d.mean) / d.sd), b = normalCdf((d.max - d.mean) / d.sd);
      return clamp(d.mean + d.sd * normalQuantile(clampOpen(a + u * (b - a))), d.min, d.max);
    }
    case "lognormal": {
      const a = normalCdf((Math.log(d.min) - d.mu) / d.sigma), b = normalCdf((Math.log(d.max) - d.mu) / d.sigma);
      return clamp(Math.exp(d.mu + d.sigma * normalQuantile(clampOpen(a + u * (b - a)))), d.min, d.max);
    }
  }
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clampOpen = (p: number) => (p <= 1e-300 ? 1e-300 : p >= 1 - 1e-16 ? 1 - 1e-16 : p);

/** Twelve significant digits: what is written into a case, so that a value does not depend on the last bit of `Math.exp` on another engine. */
export const roundValue = (v: number): number => Number(v.toPrecision(12));

// ---- designs ----------------------------------------------------------------------------------------------------------------------------

export type DesignMethod = "lhs" | "random";
export type Design = { method: DesignMethod; n: number; seed: number };

/**
 * n points in the unit hypercube of `dims` dimensions, as rows. `lhs`: dimension by dimension a permutation of the strata, then one place inside
 * each stratum. `random`: row by row, dimension by dimension. The order of draws is part of the contract: it is what makes a seed repeat.
 */
export function unitDesign(design: Design, dims: number): number[][] {
  if (!Number.isInteger(design.n) || design.n < 1) throw new Error("n is a whole number of 1 or more");
  const rng = new Rng(design.seed);
  const rows = Array.from({ length: design.n }, () => new Array<number>(dims));
  if (design.method === "random") {
    for (let i = 0; i < design.n; i++) for (let j = 0; j < dims; j++) rows[i]![j] = rng.next();
    return rows;
  }
  for (let j = 0; j < dims; j++) {
    const strata = rng.permutation(design.n);
    for (let i = 0; i < design.n; i++) rows[i]![j] = (strata[i]! + rng.next()) / design.n;
  }
  return rows;
}

/** The sample: row i holds the value of each distribution for point i. */
export function samplePoints(design: Design, distributions: readonly Distribution[]): number[][] {
  return unitDesign(design, distributions.length).map((row) => row.map((u, j) => roundValue(quantile(distributions[j]!, u))));
}
