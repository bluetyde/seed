// @covers R-STUDY-08
import { describe, expect, it } from "vitest";
import { Rng } from "../src/core/sampler";
import { morrisEffects, morrisUnitDesign, openUnit, sobolIndices, sobolRows, sobolSplit, sobolUnitDesign, type SobolResult } from "../src/core/sensitivity";

// Sensitivity indices (docs/sensitivity.md). The numbers that stand against them are analytic: the variance decomposition of a linear model, of the
// Ishigami function and of the Sobol g-function, computed here from the formulas; plus a by-hand check of the estimators on 8 rows.
const PI = Math.PI;
type Model = (u: readonly number[]) => number;

/** Draws the Saltelli design, runs the model on every row in the documented order, and gives back the indices. */
function sobolRun(model: Model, n: number, d: number, seed: number, method: "lhs" | "random", bootstrapSeed?: number): SobolResult {
  const design = sobolUnitDesign({ n, d, seed, method });
  const { fA, fB, fAB } = sobolSplit(sobolRows(design).map(model), n, d);
  return sobolIndices(fA, fB, fAB, bootstrapSeed === undefined ? {} : { bootstrap: { seed: bootstrapSeed } });
}
const maxError = (r: SobolResult, first: number[], total: number[]) =>
  Math.max(...r.parameters.flatMap((p, i) => [Math.abs(p.first - first[i]!), Math.abs(p.total - total[i]!)]));

// ---- analytic oracles -------------------------------------------------------------------------------------------------------------------

const linearA = [1, 2, 3];
const linearModel: Model = (u) => linearA.reduce((s, a, i) => s + a * u[i]!, 0);
const linearShare = linearA.map((a) => a ** 2 / linearA.reduce((s, b) => s + b ** 2, 0));

const ishA = 7, ishB = 0.1;
const ishigami: Model = (u) => {
  const x = u.map((v) => -PI + 2 * PI * v);
  return Math.sin(x[0]!) + ishA * Math.sin(x[1]!) ** 2 + ishB * x[2]! ** 4 * Math.sin(x[0]!);
};
const ishV = ishA ** 2 / 8 + (ishB * PI ** 4) / 5 + (ishB ** 2 * PI ** 8) / 18 + 1 / 2;
const ishV1 = (1 + (ishB * PI ** 4) / 5) ** 2 / 2;
const ishV2 = ishA ** 2 / 8;
const ishV13 = (8 * ishB ** 2 * PI ** 8) / 225;
const ishFirst = [ishV1 / ishV, ishV2 / ishV, 0];
const ishTotal = [(ishV1 + ishV13) / ishV, ishV2 / ishV, ishV13 / ishV];

const gC = [0, 1, 9];
const gModel: Model = (u) => gC.reduce((p, c, i) => (p * (Math.abs(4 * u[i]! - 2) + c)) / (1 + c), 1);
const gVi = gC.map((c) => 1 / (3 * (1 + c) ** 2));
const gV = gVi.reduce((p, v) => p * (1 + v), 1) - 1;
const gFirst = gVi.map((v) => v / gV);
const gTotal = gVi.map((v, i) => (v * gVi.reduce((p, w, j) => (j === i ? p : p * (1 + w)), 1)) / gV);

const SEEDS = [11, 202, 3003, 40004, 505005, 6060606];
// Tolerance on the largest absolute error over all first and total indices of one run (see docs/sensitivity.md for the errors seen).
const TOL_ISHIGAMI = 0.04;
const TOL_G = 0.04;

describe("the oracle values themselves", () => {
  it("the formulas give the textbook numbers", () => {
    expect(ishFirst[0]!).toBeCloseTo(0.3139, 3);
    expect(ishFirst[1]!).toBeCloseTo(0.4424, 3);
    expect(ishTotal[0]!).toBeCloseTo(0.5576, 3);
    expect(ishTotal[2]!).toBeCloseTo(0.2437, 3);
    expect(linearShare.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    expect(gFirst.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(1);
    for (let i = 0; i < 3; i++) expect(gTotal[i]!).toBeGreaterThanOrEqual(gFirst[i]!);
  });
});

describe("Sobol indices against analytic answers", () => {
  it("linear additive model: S_i = ST_i = a_i^2 / sum a_k^2", () => {
    for (const method of ["lhs", "random"] as const) {
      const r = sobolRun(linearModel, 8192, 3, 5, method);
      expect(maxError(r, linearShare, linearShare)).toBeLessThan(0.03);
      expect(r.mean).toBeCloseTo(3, 1); // E[y] = (1+2+3)/2
      expect(r.variance).toBeCloseTo(14 / 12, 1); // Var[y] = sum a^2 / 12
    }
  });
  for (const method of ["lhs", "random"] as const) {
    it(`Ishigami, ${method}: every first and total index within ${TOL_ISHIGAMI} for ${SEEDS.length} seeds (n = 16384)`, () => {
      for (const seed of SEEDS) {
        const r = sobolRun(ishigami, 16384, 3, seed, method);
        const err = maxError(r, ishFirst, ishTotal);
        expect(err, `seed ${seed}`).toBeLessThan(TOL_ISHIGAMI);
        expect(r.variance / ishV).toBeGreaterThan(0.95);
        expect(r.variance / ishV).toBeLessThan(1.05);
      }
    });
  }
  it("Sobol g-function (c = 0, 1, 9): within tolerance for every seed, and the ranking of the parameters is right", () => {
    for (const seed of SEEDS) {
      const r = sobolRun(gModel, 16384, 3, seed, "lhs");
      expect(maxError(r, gFirst, gTotal), `seed ${seed}`).toBeLessThan(TOL_G);
      expect(r.parameters[0]!.total).toBeGreaterThan(r.parameters[1]!.total);
      expect(r.parameters[1]!.total).toBeGreaterThan(r.parameters[2]!.total);
    }
  });
  it("interaction only, y = (x1 - 1/2)(x2 - 1/2): S = 0 and ST = 1 within 0.05 (n = 8192)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const method of ["lhs", "random"] as const) {
        const r = sobolRun((u) => (u[0]! - 0.5) * (u[1]! - 0.5), 8192, 2, seed, method);
        for (const p of r.parameters) {
          expect(Math.abs(p.first), `seed ${seed} ${method}`).toBeLessThan(0.05);
          expect(Math.abs(p.total - 1), `seed ${seed} ${method}`).toBeLessThan(0.05);
        }
      }
    }
  });
  it("noise independent of the inputs: S is near 0 and its interval holds 0; ST is near 1 because the estimator cannot tell noise from interaction", () => {
    // A fresh noise draw for every run: the model is not a function of the input, so Jansen's difference (fA - fAB) is the difference of two
    // independent draws and ST estimates 1. That is the honest behaviour, documented; it is not a sign of an interaction.
    const noise = new Rng(99);
    const r = sobolRun(() => noise.next(), 4096, 3, 8, "random", 17);
    for (const p of r.parameters) {
      expect(Math.abs(p.first)).toBeLessThan(0.05);
      expect(p.firstInterval![0]).toBeLessThanOrEqual(0);
      expect(p.firstInterval![1]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(p.total - 1)).toBeLessThan(0.05);
    }
  });
  it("noise that is a property of the row (the same on every run of that row): S = ST = 0 exactly and the interval is [0, 0]", () => {
    const n = 64, d = 2;
    const rng = new Rng(3);
    const rowNoise = Array.from({ length: n }, () => rng.next());
    const fA = rowNoise, fB = Array.from({ length: n }, () => rng.next());
    const r = sobolIndices(fA, fB, [fA.slice(), fA.slice()].slice(0, d), { bootstrap: { seed: 4 } });
    for (const p of r.parameters) {
      expect(p.first).toBeCloseTo(0, 12);
      expect(p.total).toBe(0);
      expect(p.totalInterval).toEqual([0, 0]);
    }
  });
  it("finite outputs whose variance overflows are refused with a reason, never NaN indices", () => {
    const n = 8;
    const fA = Array.from({ length: n }, (_, i) => (i % 2 ? 1e155 : 0));
    const zero = new Array<number>(n).fill(0);
    expect(() => sobolIndices(fA, fA.slice(), [zero])).toThrow(/mean or variance overflows/);
  });
  it("a constant output has no variance: refused, not NaN", () => {
    const n = 16;
    const c = new Array<number>(n).fill(0.1);
    expect(() => sobolIndices(c, c, [c])).toThrow(/variance of the output is 0/);
    const r = () => sobolRun(() => 3.7, 64, 2, 1, "lhs");
    expect(r).toThrow(/variance of the output is 0/);
  });
});

describe("Sobol design structure", () => {
  const d = 4, n = 32;
  it("AB[i] equals A except column i, which equals column i of B (exactly)", () => {
    const s = sobolUnitDesign({ n, d, seed: 9, method: "lhs" });
    expect(s.A.length).toBe(n);
    expect(s.B.length).toBe(n);
    expect(s.AB.length).toBe(d);
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < d; k++) expect(s.AB[i]![j]![k]).toBe(k === i ? s.B[j]![k] : s.A[j]![k]);
      }
    }
    expect(s.A).not.toEqual(s.B);
  });
  it("is deterministic per seed, differs per seed, and every value is inside (0, 1)", () => {
    for (const method of ["lhs", "random"] as const) {
      const a = sobolUnitDesign({ n, d, seed: 1, method });
      expect(sobolUnitDesign({ n, d, seed: 1, method })).toEqual(a);
      expect(sobolUnitDesign({ n, d, seed: 2, method })).not.toEqual(a);
      for (const v of sobolRows(a).flat()) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
    }
  });
  it("LHS: columns of A and of B are each stratified (one point per stratum)", () => {
    const s = sobolUnitDesign({ n, d, seed: 4, method: "lhs" });
    for (const M of [s.A, s.B]) {
      for (let k = 0; k < d; k++) expect(M.map((row) => Math.floor(row[k]! * n)).sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });
  it("sobolRows lists A, B, AB[0], AB[1], ... and sobolSplit gives them back", () => {
    const s = sobolUnitDesign({ n, d, seed: 6, method: "random" });
    const rows = sobolRows(s);
    expect(rows.length).toBe(n * (d + 2));
    expect(rows.slice(0, n)).toEqual(s.A);
    expect(rows.slice(n, 2 * n)).toEqual(s.B);
    expect(rows.slice(2 * n, 3 * n)).toEqual(s.AB[0]);
    expect(rows.slice((1 + d) * n)).toEqual(s.AB[d - 1]);
    const marked = rows.map((_, i) => i);
    const { fA, fB, fAB } = sobolSplit(marked, n, d);
    expect(fA).toEqual(marked.slice(0, n));
    expect(fB).toEqual(marked.slice(n, 2 * n));
    expect(fAB.length).toBe(d);
    expect(fAB[2]).toEqual(marked.slice(4 * n, 5 * n));
  });
  it("refuses bad input with a message that names the problem", () => {
    expect(() => sobolUnitDesign({ n: 7, d: 2, seed: 1, method: "lhs" })).toThrow(/n.*8 or more/);
    expect(() => sobolUnitDesign({ n: 16, d: 0, seed: 1, method: "lhs" })).toThrow(/d.*1 or more/);
    expect(() => sobolSplit([1, 2, 3], 8, 1)).toThrow(/expected 24 outputs/);
  });
});

describe("Sobol estimator checks", () => {
  it("n = 8, d = 1, by hand", () => {
    const fA = [1, 3, 2, 5, 4, 6, 8, 7];
    const fB = [2, 1, 4, 3, 6, 5, 7, 8];
    const fAB = [2, 2, 3, 6, 5, 4, 9, 10];
    // pooled mean: (36 + 36) / 16 = 4.5. Sum of squares of all 16 values: 204 + 204 = 408; about the mean 408 - 16 * 4.5^2 = 408 - 324 = 84.
    // variance with denominator 16 - 1: 84 / 15 = 5.6.
    // fAB - fA = 1, -1, 1, 1, 1, -2, 1, 3. fB - 4.5 = -2.5, -3.5, -0.5, -1.5, 1.5, 0.5, 2.5, 3.5.
    // products: -2.5, 3.5, -0.5, -1.5, 1.5, -1, 2.5, 10.5; their sum is 12.5.
    // first = (12.5 / 8) / 5.6; squares of fA - fAB: 1, 1, 1, 1, 1, 4, 1, 9; their sum is 19; total = (19 / 16) / 5.6.
    const r = sobolIndices(fA, fB, [fAB]);
    expect(r.n).toBe(8);
    expect(r.mean).toBe(4.5);
    expect(r.variance).toBeCloseTo(84 / 15, 12);
    expect(r.parameters[0]!.first).toBeCloseTo(12.5 / 8 / (84 / 15), 12); // 0.27901785714...
    expect(r.parameters[0]!.total).toBeCloseTo(19 / 16 / (84 / 15), 12); // 0.21205357142...
  });
  it("an index may fall outside 0..1 and is not clamped", () => {
    // fAB moves against fB at every row: the first-order sum is negative.
    const fA = [0, 0, 0, 0, 0, 0, 0, 0];
    const fB = [1, 2, 3, 4, 5, 6, 7, 8];
    const fAB = fB.map((v) => -v);
    const r = sobolIndices(fA, fB, [fAB]);
    expect(r.parameters[0]!.first).toBeLessThan(0);
    expect(r.parameters[0]!.total).toBeGreaterThan(1);
  });
  it("refuses small n, no parameter, non-finite values, mismatched lengths", () => {
    const ok = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(() => sobolIndices([1, 2, 3], [1, 2, 3], [[1, 2, 3]])).toThrow(/n is 3.*8 or more/);
    expect(() => sobolIndices(ok, ok, [])).toThrow(/d must be 1 or more/);
    expect(() => sobolIndices(ok, ok.slice(1), [ok])).toThrow(/fB has 7/);
    expect(() => sobolIndices(ok, ok, [ok.slice(1)])).toThrow(/fAB\[0\] has 7/);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => sobolIndices([...ok.slice(0, 7), bad], ok, [ok])).toThrow(/not a finite number.*fA\[7\]/);
      expect(() => sobolIndices(ok, ok, [ok, [bad, ...ok.slice(1)]])).toThrow(/not a finite number.*fAB\[1\]\[0\]/);
    }
    expect(() => sobolIndices(ok, ok, [ok], { bootstrap: { seed: 1, resamples: 3 } })).toThrow(/resamples/);
    expect(() => sobolIndices(ok, ok, [ok], { bootstrap: { seed: 1, level: 1 } })).toThrow(/level/);
  });
});

describe("Sobol bootstrap", () => {
  const model = ishigami;
  it("is deterministic per seed and differs for another seed", () => {
    const design = sobolUnitDesign({ n: 512, d: 3, seed: 21, method: "lhs" });
    const { fA, fB, fAB } = sobolSplit(sobolRows(design).map(model), 512, 3);
    const a = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 5 } });
    expect(sobolIndices(fA, fB, fAB, { bootstrap: { seed: 5 } })).toEqual(a);
    const b = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 6 } });
    expect(b.parameters[0]!.firstInterval).not.toEqual(a.parameters[0]!.firstInterval);
    expect(b.parameters[0]!.first).toBe(a.parameters[0]!.first); // the point estimate does not depend on the bootstrap seed
    expect(a.bootstrap).toEqual({ resamples: 200, level: 0.95, skipped: 0 });
  });
  it("the interval has lo < hi and brackets the point estimate in at least 90% of 6 seeds x 3 parameters x 2 indices (n = 1024)", () => {
    let inside = 0, total = 0;
    for (const seed of SEEDS) {
      const design = sobolUnitDesign({ n: 1024, d: 3, seed, method: "lhs" });
      const { fA, fB, fAB } = sobolSplit(sobolRows(design).map(model), 1024, 3);
      const r = sobolIndices(fA, fB, fAB, { bootstrap: { seed: seed + 1 } });
      for (const p of r.parameters) {
        for (const [est, iv] of [[p.first, p.firstInterval!], [p.total, p.totalInterval!]] as const) {
          expect(iv[0]).toBeLessThan(iv[1]);
          total++;
          if (iv[0] <= est && est <= iv[1]) inside++;
        }
      }
    }
    expect(inside / total).toBeGreaterThanOrEqual(0.9);
  });
  it("a wider level gives a wider interval, and the interval covers the true value for the strong parameters (n = 4096)", () => {
    const design = sobolUnitDesign({ n: 4096, d: 3, seed: 77, method: "lhs" });
    const { fA, fB, fAB } = sobolSplit(sobolRows(design).map(model), 4096, 3);
    const narrow = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 1, level: 0.5, resamples: 300 } });
    const wide = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 1, level: 0.99, resamples: 300 } });
    for (let i = 0; i < 3; i++) {
      const wn = narrow.parameters[i]!.totalInterval!, ww = wide.parameters[i]!.totalInterval!;
      expect(ww[1] - ww[0]).toBeGreaterThan(wn[1] - wn[0]);
    }
    // 99% interval of the total index of x1 and x2 holds the analytic value (a statistical check on one fixed seed, not a guarantee)
    for (const i of [0, 1]) {
      const iv = wide.parameters[i]!.totalInterval!;
      expect(iv[0]).toBeLessThanOrEqual(ishTotal[i]!);
      expect(iv[1]).toBeGreaterThanOrEqual(ishTotal[i]!);
    }
  });
});

// ---- Morris -----------------------------------------------------------------------------------------------------------------------------

describe("Morris design structure", () => {
  for (const levels of [4, 6, 8]) {
    it(`levels ${levels}: d+1 points per trajectory, one coordinate moves by exactly delta, each parameter once, on the grid, in [0, 1]`, () => {
      const r = 25, d = 5;
      const design = morrisUnitDesign({ r, d, levels, seed: 3 });
      const delta = levels / (2 * (levels - 1));
      expect(design.points.length).toBe(r * (d + 1));
      expect(design.steps.length).toBe(r);
      for (let t = 0; t < r; t++) {
        const moved: number[] = [];
        for (let s = 0; s < d; s++) {
          const prev = design.points[t * (d + 1) + s]!, next = design.points[t * (d + 1) + s + 1]!;
          const step = design.steps[t]![s]!;
          const changed = next.map((v, k) => (v !== prev[k] ? k : -1)).filter((k) => k >= 0);
          expect(changed).toEqual([step.parameter]);
          expect(Math.abs(step.delta)).toBe(delta);
          expect(next[step.parameter]! - prev[step.parameter]!).toBeCloseTo(step.delta, 12);
          moved.push(step.parameter);
        }
        expect([...moved].sort()).toEqual([0, 1, 2, 3, 4]);
      }
      for (const row of design.points) {
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
          expect(Math.abs(v * (levels - 1) - Math.round(v * (levels - 1)))).toBeLessThan(1e-12); // on the grid
        }
      }
    });
  }
  it("both signs occur, a point at 0 or 1 occurs, and every parameter swings between a node s and s + delta with s <= 1 - delta", () => {
    const design = morrisUnitDesign({ r: 200, d: 3, seed: 8 });
    const signs = new Set(design.steps.flat().map((s) => Math.sign(s.delta)));
    expect(signs).toEqual(new Set([1, -1]));
    const delta = 2 / 3;
    for (const trajectory of design.steps) for (const step of trajectory) expect(step.delta === delta || step.delta === -delta).toBe(true);
    for (let t = 0; t < 200; t++) {
      const first = design.points[t * 4]!, last = design.points[t * 4 + 3]!;
      for (let k = 0; k < 3; k++) expect(Math.min(first[k]!, last[k]!)).toBeLessThanOrEqual(1 - delta + 1e-12);
    }
    expect(design.points.flat().some((v) => v === 0 || v === 1)).toBe(true);
  });
  it("is deterministic per seed and differs for another seed", () => {
    const a = morrisUnitDesign({ r: 10, d: 4, seed: 1 });
    expect(morrisUnitDesign({ r: 10, d: 4, seed: 1 })).toEqual(a);
    expect(morrisUnitDesign({ r: 10, d: 4, seed: 2 })).not.toEqual(a);
  });
  it("openUnit moves only exactly 0 and exactly 1", () => {
    expect(openUnit(0)).toBe(1e-9);
    expect(openUnit(1)).toBe(1 - 1e-9);
    expect(openUnit(0.25)).toBe(0.25);
    expect(openUnit(1e-12)).toBe(1e-12);
    expect(openUnit(2 / 3)).toBe(2 / 3);
  });
  it("openUnit refuses what is not a unit value instead of moving it to the edge", () => {
    for (const bad of [-0.2, 1.2, NaN, Infinity]) expect(() => openUnit(bad)).toThrow(/0 to 1/);
  });
  it("refuses bad input", () => {
    expect(() => morrisUnitDesign({ r: 1, d: 3, seed: 1 })).toThrow(/r.*2 or more/);
    expect(() => morrisUnitDesign({ r: 5, d: 0, seed: 1 })).toThrow(/d.*1 or more/);
    expect(() => morrisUnitDesign({ r: 5, d: 3, levels: 5, seed: 1 })).toThrow(/even/);
    expect(() => morrisUnitDesign({ r: 5, d: 3, seed: -1 })).toThrow();
  });
});

describe("Morris effects that overflow", () => {
  it("outputs 0 and 1.5e308 give an effect that is not a finite number: an error naming the trajectory", () => {
    const design = morrisUnitDesign({ r: 2, d: 1, seed: 1 });
    const outputs = design.points.map((_, i) => (i % 2 ? 1.5e308 : 0));
    expect(() => morrisEffects(outputs, design)).toThrow(/trajectory \d is not a finite number/);
  });
});

describe("Morris effects against analytic answers", () => {
  const run = (f: Model, r: number, d: number, seed: number) => {
    const design = morrisUnitDesign({ r, d, seed });
    return morrisEffects(design.points.map(f), design);
  };
  it("linear model: EE_i = a_i exactly, so mu = a_i, muStar = |a_i|, sigma = 0", () => {
    for (const seed of [1, 2, 3]) {
      const out = run(linearModel, 20, 3, seed);
      out.forEach((p, i) => {
        expect(p.n).toBe(20);
        expect(p.mu).toBeCloseTo(linearA[i]!, 12);
        expect(p.muStar).toBeCloseTo(linearA[i]!, 12);
        expect(p.sigma).toBeCloseTo(0, 12);
        for (const e of p.effects) expect(e).toBeCloseTo(linearA[i]!, 12);
      });
    }
  });
  it("a negative coefficient: mu negative, muStar positive", () => {
    const a = [2, -3, 0.5];
    const out = run((u) => a.reduce((s, c, i) => s + c * u[i]!, 0), 15, 3, 4);
    expect(out[1]!.mu).toBeCloseTo(-3, 12);
    expect(out[1]!.muStar).toBeCloseTo(3, 12);
    expect(out[0]!.mu).toBeCloseTo(2, 12);
    expect(out[2]!.sigma).toBeCloseTo(0, 12);
  });
  it("a nonlinear model: sigma is positive for the parameter in an interaction and 0 for the one that is not; a dead input has muStar 0", () => {
    const out = run((u) => u[0]! * u[1]! + 5 * u[2]!, 40, 4, 6);
    expect(out[0]!.sigma).toBeGreaterThan(0.05);
    expect(out[1]!.sigma).toBeGreaterThan(0.05);
    expect(out[2]!.sigma).toBeCloseTo(0, 12);
    expect(out[2]!.muStar).toBeCloseTo(5, 12);
    expect(out[3]!.muStar).toBe(0);
    expect(out[3]!.sigma).toBe(0);
  });
  it("ranks the Ishigami inputs: x3 and x2 act (muStar above 0), by muStar from 40 trajectories", () => {
    const out = run((u) => ishigami(u.map(openUnit)), 40, 3, 12);
    for (const p of out) expect(p.muStar).toBeGreaterThan(0.5);
    expect(out[1]!.muStar).toBeGreaterThan(out[0]!.muStar * 0.5);
  });
  it("by hand: d = 1, two trajectories", () => {
    const design = { r: 2, d: 1, levels: 4, points: [[0], [2 / 3], [1], [1 / 3]], steps: [[{ parameter: 0, delta: 2 / 3 }], [{ parameter: 0, delta: -2 / 3 }]] };
    // outputs 1, 3 | 5, 2: EE1 = (3 - 1) / (2/3) = 3; EE2 = (2 - 5) / (-2/3) = 4.5. mu = 3.75, muStar = 3.75, sigma = sqrt(((3 - 3.75)^2 + (4.5 - 3.75)^2) / 1) = 0.75 * sqrt(2).
    const [p] = morrisEffects([1, 3, 5, 2], design);
    expect(p!.mu).toBeCloseTo(3.75, 12);
    expect(p!.muStar).toBeCloseTo(3.75, 12);
    expect(p!.sigma).toBeCloseTo(0.75 * Math.SQRT2, 12);
  });
  it("refuses non-finite outputs and wrong lengths", () => {
    const design = morrisUnitDesign({ r: 3, d: 2, seed: 1 });
    const ok = design.points.map((_, i) => i);
    expect(() => morrisEffects(ok.slice(1), design)).toThrow(/expected 9 outputs/);
    for (const bad of [Number.NaN, Infinity]) expect(() => morrisEffects([bad, ...ok.slice(1)], design)).toThrow(/not a finite number/);
  });
});

// ---- found by the dispatcher's breakage checks (4 changes the first 33 tests did not catch) ----------------------------------------------------

describe("the bootstrap resamples every row, with the right tails, and survives resamples of no variance", () => {
  const n = 64, d = 2;
  const data = () => {
    const design = sobolUnitDesign({ n, d, seed: 5, method: "lhs" });
    return sobolSplit(sobolRows(design).map((u) => u[0]! + 0.5 * u[1]!), n, d);
  };

  it("every row can be drawn: changing only the last row changes the interval (a draw that never reached the last row would not)", () => {
    const a = data();
    const b = data();
    b.fA[n - 1] = b.fA[n - 1]! + 25;
    b.fB[n - 1] = b.fB[n - 1]! - 25;
    b.fAB.forEach((f) => { f[n - 1] = f[n - 1]! + 40; });
    const ra = sobolIndices(a.fA, a.fB, a.fAB, { bootstrap: { seed: 9, resamples: 200 } });
    const rb = sobolIndices(b.fA, b.fB, b.fAB, { bootstrap: { seed: 9, resamples: 200 } });
    const lastRowOnlyMatters = ra.parameters.some((p, i) => p.firstInterval![0] !== rb.parameters[i]!.firstInterval![0] || p.totalInterval![1] !== rb.parameters[i]!.totalInterval![1]);
    expect(lastRowOnlyMatters).toBe(true);
  });

  it("the 95% interval is wider than the 50% interval by about the ratio of a normal curve (1.96 / 0.674 = 2.9), and both are centred on the estimate", () => {
    const m = 4096;
    const design = sobolUnitDesign({ n: m, d: 3, seed: 21, method: "lhs" });
    const { fA, fB, fAB } = sobolSplit(sobolRows(design).map(ishigamiUnit), m, 3);
    const wide = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 4, resamples: 400, level: 0.95 } });
    const narrow = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 4, resamples: 400, level: 0.5 } });
    wide.parameters.forEach((p, i) => {
      const w = p.totalInterval![1] - p.totalInterval![0];
      const q = narrow.parameters[i]!.totalInterval![1] - narrow.parameters[i]!.totalInterval![0];
      expect(q).toBeGreaterThan(0);
      expect(w / q).toBeGreaterThan(2.2);
      expect(w / q).toBeLessThan(3.8);
      expect(p.totalInterval![0]).toBeLessThan(p.total);
      expect(p.totalInterval![1]).toBeGreaterThan(p.total);
    });
  });

  it("resamples with no variance are skipped and counted, and never turn an interval into NaN", () => {
    // 8 rows where one row differs: a resample that misses it is constant, so it has no variance (probability (7/8)^8, about one in three)
    const fA = [1, 1, 1, 1, 1, 1, 1, 9], fB = [1, 1, 1, 1, 1, 1, 1, 1], fAB = [[1, 1, 1, 1, 1, 1, 1, 5]];
    const r = sobolIndices(fA, fB, fAB, { bootstrap: { seed: 3, resamples: 300 } });
    expect(r.bootstrap!.skipped).toBeGreaterThan(30);
    expect(r.bootstrap!.skipped).toBeLessThan(250);
    const p = r.parameters[0]!;
    for (const v of [...p.firstInterval!, ...p.totalInterval!]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("a Morris trajectory moves the parameters in a random order", () => {
  it("over 40 trajectories of 3 parameters all 6 orders occur", () => {
    const design = morrisUnitDesign({ r: 40, d: 3, seed: 17 });
    const orders = new Set(design.steps.map((t) => t.map((s) => s.parameter).join(",")));
    expect(orders.size).toBe(6);
  });
});

function ishigamiUnit(u: readonly number[]): number {
  const x = u.map((v) => -Math.PI + 2 * Math.PI * v);
  return Math.sin(x[0]!) + 7 * Math.sin(x[1]!) ** 2 + 0.1 * x[2]! ** 4 * Math.sin(x[0]!);
}
