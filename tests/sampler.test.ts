// @covers R-STUDY-06
import { describe, expect, it } from "vitest";
import { MAX_SEED, Rng, distributionProblem, normalCdf, normalQuantile, quantile, roundValue, samplePoints, unitDesign, type Distribution } from "../src/core/sampler";

// The in-house sampler (docs/sampling.md). The numbers that stand against it are mathematical facts, not its own output: known values of the
// normal distribution, the stratification property of a Latin hypercube, the moments of a truncated normal, statistical tests of the generator.
const near = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

describe("the generator", () => {
  it("repeats for a seed, differs for another seed, and stays inside (0, 1)", () => {
    const a = new Rng(1), b = new Rng(1), c = new Rng(2);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 1000 }, () => c.next())).not.toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(1); }
  });
  it("regression pin: the first words of seeds 0 and 12345, one real number, and one small design (a change here changes every sample ever drawn)", () => {
    const a = new Rng(0), b = new Rng(12345);
    expect([a.u32(), a.u32(), a.u32()]).toEqual([1789933344, 44971166, 2521387044]);
    expect([b.u32(), b.u32(), b.u32()]).toEqual([1093274547, 203003357, 3741353573]);
    expect(new Rng(12345).next()).toBe(0.2545478123967752);
    expect(samplePoints({ method: "lhs", n: 4, seed: 7 }, [{ kind: "uniform", min: 0, max: 1 }])).toEqual([[0.73803265653], [0.159839545016], [0.276716967406], [0.927939069092]]);
  });
  it("seeds outside 0 to 2^32-1 and non-integers are refused", () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN, Infinity]) expect(() => new Rng(bad)).toThrow();
    expect(() => new Rng(0)).not.toThrow();
    expect(() => new Rng(MAX_SEED)).not.toThrow();
  });
  it("is uniform: mean, variance, a chi-square over 100 bins, and no serial correlation", () => {
    const r = new Rng(20261024);
    const N = 200_000;
    const xs = Array.from({ length: N }, () => r.next());
    const mean = xs.reduce((s, x) => s + x, 0) / N;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (N - 1);
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.003);
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.001);
    const bins = new Array<number>(100).fill(0);
    for (const x of xs) bins[Math.floor(x * 100)]!++;
    const chi = bins.reduce((s, o) => s + (o - N / 100) ** 2 / (N / 100), 0);
    expect(chi).toBeLessThan(148.2); // chi-square, 99 degrees of freedom, p = 0.001
    let cov = 0;
    for (let i = 1; i < N; i++) cov += (xs[i]! - mean) * (xs[i - 1]! - mean);
    expect(Math.abs(cov / (N - 1) / variance)).toBeLessThan(0.01);
  });
  it("int(n) is unbiased and in range; permutation(n) is a permutation and reaches all orders", () => {
    const r = new Rng(7);
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[r.int(6)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(400);
    expect(() => r.int(0)).toThrow();
    expect(() => r.int(1.5)).toThrow();
    const seen = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const p = r.permutation(3);
      expect([...p].sort()).toEqual([0, 1, 2]);
      seen.set(p.join(), (seen.get(p.join()) ?? 0) + 1);
    }
    expect(seen.size).toBe(6);
    for (const c of seen.values()) expect(Math.abs(c - 1000)).toBeLessThan(150);
    expect(r.permutation(0)).toEqual([]);
    expect(r.permutation(1)).toEqual([0]);
  });
});

describe("the normal distribution", () => {
  it.each([
    [0, 0.5], [1, 0.8413447460685429], [-1, 0.15865525393145707], [2, 0.9772498680518208], [3, 0.9986501019683699],
    [-3, 0.0013498980316301], [1.96, 0.9750021048517795], [0.5, 0.6914624612740131]
  ])("cdf(%s) = %s", (x, p) => near(normalCdf(x), p, 1e-13));
  it.each([[-6, 9.865876450376946e-10], [-10, 7.619853024160527e-24], [-8, 6.220960574271786e-16]])("the tail cdf(%s) has a relative error under 1e-9", (x, p) => {
    expect(Math.abs(normalCdf(x) / p - 1)).toBeLessThan(1e-9);
  });
  it("is symmetric and monotone, 0 and 1 at the far ends", () => {
    for (const x of [0.1, 0.7, 1.3, 2.9, 4.4]) near(normalCdf(-x), 1 - normalCdf(x), 1e-14);
    let last = -1;
    for (let x = -9; x <= 9; x += 0.05) { const p = normalCdf(x); expect(p).toBeGreaterThanOrEqual(last); last = p; }
    expect(normalCdf(-50)).toBe(0);
    expect(normalCdf(50)).toBe(1);
    expect(normalCdf(Number.NaN)).toBeNaN();
  });
  it.each([[0.975, 1.959963984540054], [0.5, 0], [0.8413447460685429, 1], [0.0013498980316301, -3], [1e-9, -5.997807015007687], [0.999, 3.090232306167813]])("quantile(%s) = %s", (p, z) => {
    near(normalQuantile(p), z, 1e-10);
  });
  it("is the inverse of the cdf over a grid, deep into the tails", () => {
    for (let x = -8; x <= 8; x += 0.0625) {
      const back = normalQuantile(normalCdf(x));
      if (x < 6) near(back, x, 1e-8); // above that cdf(x) is within rounding of 1
    }
    for (const p of [1e-300, 1e-100, 1e-20, 1e-5, 0.01, 0.3, 0.7, 0.99, 1 - 1e-9]) near(normalCdf(normalQuantile(p)), p, 1e-9 * Math.max(1, 1 / p) * (p < 0.5 ? p : 1));
  });
  it("refuses a probability that is not strictly between 0 and 1", () => {
    for (const p of [0, 1, -0.1, 1.1, Number.NaN]) expect(() => normalQuantile(p)).toThrow();
  });
});

describe("the distributions", () => {
  const uniform: Distribution = { kind: "uniform", min: 10, max: 30 };
  const tri: Distribution = { kind: "triangular", min: 0, mode: 2, max: 10 };
  const norm: Distribution = { kind: "normal", mean: 5, sd: 1, min: 3, max: 8 };
  const logn: Distribution = { kind: "lognormal", mu: 0, sigma: 0.5, min: 0.4, max: 3 };

  it("uniform: linear between its ends", () => {
    near(quantile(uniform, 0.25), 15);
    near(quantile(uniform, 0.5), 20);
    expect(quantile(uniform, 1e-12)).toBeGreaterThanOrEqual(10);
    expect(quantile(uniform, 1 - 1e-12)).toBeLessThanOrEqual(30);
  });
  it("triangular: the mode sits at probability (mode - min) / (max - min), the cdf checks out on both sides", () => {
    near(quantile(tri, 0.2), 2);
    // cdf(x) = x^2 / (10 * 2) for x < 2, and 1 - (10 - x)^2 / (10 * 8) for x >= 2
    near(quantile(tri, 0.05), Math.sqrt(0.05 * 20));
    near(quantile(tri, 0.9), 10 - Math.sqrt(0.1 * 80));
  });
  it("truncated normal: the window is respected, the median of a symmetric window is the mean, and the mean matches the closed form", () => {
    const sym: Distribution = { kind: "normal", mean: 5, sd: 1, min: 3, max: 7 };
    near(quantile(sym, 0.5), 5, 1e-10);
    for (const u of [1e-9, 0.01, 0.5, 0.99, 1 - 1e-9]) { const v = quantile(norm, u); expect(v).toBeGreaterThanOrEqual(3); expect(v).toBeLessThanOrEqual(8); }
    // E[X] = mean + sd * (pdf(a) - pdf(b)) / (cdf(b) - cdf(a)), a = (3-5)/1, b = (8-5)/1
    const a = -2, b = 3, pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    const exact = 5 + (pdf(a) - pdf(b)) / (normalCdf(b) - normalCdf(a));
    const xs = unitDesign({ method: "lhs", n: 20_000, seed: 3 }, 1).map((r) => quantile(norm, r[0]!));
    expect(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length - exact)).toBeLessThan(2e-3);
  });
  it("truncated lognormal: inside the window, and the median is the lognormal median when the window is symmetric in ln x", () => {
    for (const u of [1e-9, 0.2, 0.5, 0.8, 1 - 1e-9]) { const v = quantile(logn, u); expect(v).toBeGreaterThanOrEqual(0.4); expect(v).toBeLessThanOrEqual(3); }
    near(quantile({ kind: "lognormal", mu: 1, sigma: 0.3, min: Math.exp(0.2), max: Math.exp(1.8) }, 0.5), Math.exp(1), 1e-10);
  });
  it("each distribution is increasing in u", () => {
    for (const d of [uniform, tri, norm, logn]) {
      let last = -Infinity;
      for (let u = 0.001; u < 1; u += 0.001) { const v = quantile(d, u); expect(v).toBeGreaterThanOrEqual(last); last = v; }
    }
  });
  it("distributionProblem says what is wrong", () => {
    expect(distributionProblem(uniform)).toBeNull();
    expect(distributionProblem(tri)).toBeNull();
    expect(distributionProblem(norm)).toBeNull();
    expect(distributionProblem(logn)).toBeNull();
    const bad: [unknown, RegExp][] = [
      [null, /object/], [{ kind: "weibull" }, /not one of/], [{ kind: "uniform", min: 3, max: 3 }, /min below max/], [{ kind: "uniform", min: 1, max: Number.NaN }, /finite/],
      [{ kind: "uniform", min: 1, max: 2, shape: 3 }, /not shape/], [{ kind: "triangular", min: 0, mode: 11, max: 10 }, /mode between/], [{ kind: "normal", mean: 5, sd: 0, min: 3, max: 8 }, /sd above 0/],
      [{ kind: "normal", mean: 5, sd: 1, min: 8, max: 3 }, /window/], [{ kind: "normal", mean: 0, sd: 1, min: 20, max: 21 }, /holds only/], [{ kind: "normal", mean: 5, sd: 1 }, /window/],
      [{ kind: "lognormal", mu: 0, sigma: 1, min: 0, max: 3 }, /0 < min < max/], [{ kind: "lognormal", mu: 0, sigma: 1, min: -1, max: 3 }, /0 < min/], [{ kind: "lognormal", mu: 0, sigma: 0.01, min: 50, max: 60 }, /holds only/]
    ];
    for (const [d, re] of bad) expect(distributionProblem(d), JSON.stringify(d)).toMatch(re);
  });
  it("roundValue keeps 12 significant digits", () => {
    expect(roundValue(1 / 3)).toBe(0.333333333333);
    expect(roundValue(123456789.123456789)).toBe(123456789.123);
    expect(roundValue(0)).toBe(0);
  });
});

describe("the designs", () => {
  it("a Latin hypercube has exactly one point in each stratum of every dimension", () => {
    for (const n of [2, 7, 50, 333]) {
      const rows = unitDesign({ method: "lhs", n, seed: n }, 4);
      expect(rows).toHaveLength(n);
      for (let j = 0; j < 4; j++) {
        const strata = rows.map((r) => Math.floor(r[j]! * n)).sort((a, b) => a - b);
        expect(strata).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    }
  });
  it("every point is strictly inside the unit cube, for both methods", () => {
    for (const method of ["lhs", "random"] as const) for (const row of unitDesign({ method, n: 500, seed: 9 }, 3)) for (const u of row) { expect(u).toBeGreaterThan(0); expect(u).toBeLessThan(1); }
  });
  it("the same seed repeats the sample, another seed gives another, a different n or method changes it", () => {
    const base = unitDesign({ method: "lhs", n: 20, seed: 5 }, 3);
    expect(unitDesign({ method: "lhs", n: 20, seed: 5 }, 3)).toEqual(base);
    expect(unitDesign({ method: "lhs", n: 20, seed: 6 }, 3)).not.toEqual(base);
    expect(unitDesign({ method: "random", n: 20, seed: 5 }, 3)).not.toEqual(base);
    expect(unitDesign({ method: "lhs", n: 21, seed: 5 }, 3)).not.toEqual(base);
  });
  it("the dimensions are paired by independent permutations: their correlation is small and not systematic", () => {
    const rows = unitDesign({ method: "lhs", n: 400, seed: 11 }, 3);
    const corr = (a: number, b: number) => {
      const x = rows.map((r) => r[a]!), y = rows.map((r) => r[b]!);
      const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x.length; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; }
      return sxy / Math.sqrt(sxx * syy);
    };
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) expect(Math.abs(corr(a, b))).toBeLessThan(0.15);
  });
  it("a Latin hypercube estimates the mean of a monotone function better than plain random sampling (over 300 seeds)", () => {
    const f = (u: number[]) => u[0]! + 2 * u[1]!; // exact mean 1.5
    const rms = (method: "lhs" | "random") => {
      let s = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const rows = unitDesign({ method, n: 25, seed }, 2);
        s += (rows.reduce((a, r) => a + f(r), 0) / 25 - 1.5) ** 2;
      }
      return Math.sqrt(s / 300);
    };
    expect(rms("lhs")).toBeLessThan(0.5 * rms("random"));
  });
  it("samplePoints applies the distributions column by column and rounds to 12 digits", () => {
    const d: Distribution[] = [{ kind: "uniform", min: 0, max: 1 }, { kind: "uniform", min: 100, max: 200 }];
    const pts = samplePoints({ method: "lhs", n: 10, seed: 4 }, d);
    const unit = unitDesign({ method: "lhs", n: 10, seed: 4 }, 2);
    expect(pts).toHaveLength(10);
    pts.forEach((p, i) => { near(p[0]!, unit[i]![0]!, 1e-11); near(p[1]!, 100 + 100 * unit[i]![1]!, 1e-11); expect(p[0]).toBe(roundValue(p[0]!)); });
  });
  it("n must be at least 1", () => {
    expect(() => unitDesign({ method: "lhs", n: 0, seed: 1 }, 1)).toThrow();
    expect(() => unitDesign({ method: "lhs", n: 2.5, seed: 1 }, 1)).toThrow();
  });
});
