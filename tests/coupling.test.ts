import { describe, expect, it } from "vitest";
import { HARD_MAX_PASSES, runCoupling, validateLoop, type CouplingOutcome, type LoopDefinition, type PassFunction } from "../src/core/coupling";

// The loop controller of a feedback coupling (docs/coupling-controller.md), tested only with scripted fake passes whose fixed point is known.
// The expected number of passes comes from an independent recurrence written here in plain arithmetic, never from the controller.

const loop = (over: Partial<LoopDefinition> = {}, tol = 1e-3): LoopDefinition => ({
  exchanged: [{ id: "x", tolerance: tol }],
  maxPasses: 25,
  relaxation: 1,
  consecutive: 2,
  ...over
});
const linear = (a: number, b: number): PassFunction => async (it) => ({ ok: true, calc: { x: a * (it.x as number) + b } });
/** A pass that ignores the iterate and returns scripted values, one per pass. */
const script = (rows: Record<string, number>[]): PassFunction => async (_it, k) => ({ ok: true, calc: { ...(rows[k - 1] ?? rows[rows.length - 1]!) } });
const lastIndex = (o: CouplingOutcome) => o.passes[o.passes.length - 1]!.index;

/** Independent recurrence for one or more quantities with a linear map: the first pass at which every change has been inside its tolerance `consecutive` times in a row. */
function expectedPasses(map: (v: number[]) => number[], start: number[], tols: number[], relax: number, consecutive: number, max: number): number | null {
  let x = start;
  let run = 0;
  for (let k = 1; k <= max; k++) {
    const c = map(x);
    let inside = true;
    for (let i = 0; i < x.length; i++) {
      const ch = Math.abs(c[i]! - x[i]!) / Math.max(Math.abs(c[i]!), 1e-12);
      if (ch > tols[i]!) inside = false;
    }
    run = inside ? run + 1 : 0;
    if (run >= consecutive) return k;
    x = x.map((xi, i) => xi + relax * (c[i]! - xi));
  }
  return null;
}

/** Independent recurrence for divergence by growth: scale_i = max(|calc_i of pass 1|, 1e-12), R_k = max_i |calc_i - x_i| / (tol_i scale_i); the first pass with three strict increases in a row, or null. */
function growthPass(map: (v: number[]) => number[], start: number[], tols: number[], relax: number): number | null {
  let x = start;
  let scale: number[] = [];
  const R: number[] = [];
  for (let k = 1; k <= 25; k++) {
    const c = map(x);
    if (k === 1) scale = c.map((ci) => Math.max(Math.abs(ci), 1e-12));
    let r = 0;
    for (let i = 0; i < x.length; i++) r = Math.max(r, Math.abs(c[i]! - x[i]!) / (tols[i]! * scale[i]!));
    R.push(R.length === k - 1 ? r : 0);
    if (k >= 4 && R[k - 1]! > R[k - 2]! && R[k - 2]! > R[k - 3]! && R[k - 3]! > R[k - 4]!) return k;
    x = x.map((xi, i) => xi + relax * (c[i]! - xi));
  }
  return null;
}

describe("convergence on a linear map with a known fixed point", () => {
  it("a = 0.5, b = 1, from 0: converges in the number of passes the recurrence gives, to the fixed point 2", async () => {
    // By hand: x_k = 2(1 - 0.5^k), change_k = 0.5^(k-1) / (2(1 - 0.5^k)); the first change under 1e-3 is pass 10, so the second in a row is pass 11.
    const expected = expectedPasses((v) => [0.5 * v[0]! + 1], [0], [1e-3], 1, 2, 25);
    expect(expected).toBe(11);
    const o = await runCoupling(loop(), { x: 0 }, linear(0.5, 1));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(11);
    expect(o.result).toEqual({ iterate: o.passes[10]!.calc, passes: 11 });
    expect(o.result!.iterate.x).toBeCloseTo(2, 2);
    expect(Math.abs(o.result!.iterate.x! - 2) / 2).toBeLessThan(1e-3);
  });
  it("the residual (calc - iterate) shrinks by |a| on every pass", async () => {
    const o = await runCoupling(loop(), { x: 0 }, linear(0.5, 1));
    for (let i = 1; i < o.passes.length; i++) {
      const r0 = o.passes[i - 1]!.calc.x! - o.passes[i - 1]!.iterate.x!;
      const r1 = o.passes[i]!.calc.x! - o.passes[i]!.iterate.x!;
      expect(r1 / r0).toBeCloseTo(0.5, 9);
    }
  });
  it("with relaxation 0.5 the contraction is 1 - 0.5(1 - a) = 0.75 and the pass count follows the recurrence", async () => {
    const expected = expectedPasses((v) => [0.5 * v[0]! + 1], [0], [1e-3], 0.5, 2, 25);
    expect(expected).not.toBeNull();
    const plain = expectedPasses((v) => [0.5 * v[0]! + 1], [0], [1e-3], 1, 2, 25)!;
    expect(expected!).toBeGreaterThan(plain);
    const o = await runCoupling(loop({ relaxation: 0.5 }), { x: 0 }, linear(0.5, 1));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(expected!);
    // the iterates themselves approach 2 by the factor 0.75 each pass
    for (let i = 1; i < o.passes.length; i++) {
      expect((o.passes[i]!.iterate.x! - 2) / (o.passes[i - 1]!.iterate.x! - 2)).toBeCloseTo(0.75, 9);
    }
    expect(Math.abs(o.result!.iterate.x! - 2) / 2).toBeLessThan(2e-3);
  });
  it("a = -0.5 (a damped alternation) converges and is not called oscillating", async () => {
    const expected = expectedPasses((v) => [-0.5 * v[0]! + 1], [0], [1e-3], 1, 2, 25);
    expect(expected).not.toBeNull();
    const o = await runCoupling(loop(), { x: 0 }, linear(-0.5, 1));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(expected!);
    expect(o.result!.iterate.x).toBeCloseTo(2 / 3, 2);
  });
  it("a = 0.99 is too slow for 25 passes: not-converged, no result, all 25 passes recorded", async () => {
    expect(expectedPasses((v) => [0.99 * v[0]! + 1], [0], [1e-3], 1, 2, 25)).toBeNull();
    const o = await runCoupling(loop(), { x: 0 }, linear(0.99, 1));
    expect(o.state).toBe("not-converged");
    expect(o.result).toBeUndefined();
    expect("result" in o).toBe(false);
    expect(o.passes).toHaveLength(25);
    expect(o.passes.map((p) => p.index)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
  it("a smaller maxPasses ends the loop at that count", async () => {
    const o = await runCoupling(loop({ maxPasses: 5 }), { x: 0 }, linear(0.5, 1));
    expect(o.state).toBe("not-converged");
    expect(o.passes).toHaveLength(5);
    expect(o.result).toBeUndefined();
  });
  it("already at the fixed point: two passes of zero change converge", async () => {
    const o = await runCoupling(loop(), { x: 2 }, linear(0.5, 1));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(2);
    expect(o.result).toEqual({ iterate: { x: 2 }, passes: 2 });
  });
});

describe("divergence, oscillation and the order of the checks", () => {
  it("a = -1.2 started near the fixed point: the residual grows on three passes in a row, diverged before maxPasses", async () => {
    // fixed point 1/2.2 = 0.4545; the changes from 0.45 are about 0.0217, 0.0268, 0.0311, 0.0388 (growing)
    expect(growthPass((v) => [-1.2 * v[0]! + 1], [0.45], [1e-3], 1)).toBe(4);
    const o = await runCoupling(loop(), { x: 0.45 }, linear(-1.2, 1));
    expect(o.state).toBe("diverged");
    expect(o.result).toBeUndefined();
    expect(o.passes).toHaveLength(4);
    const ch = o.passes.map((p) => p.change.x!);
    expect(ch[1]!).toBeGreaterThan(ch[0]!);
    expect(ch[2]!).toBeGreaterThan(ch[1]!);
    expect(ch[3]!).toBeGreaterThan(ch[2]!);
  });
  it("growth must be strict on three passes in a row: a change that grows twice and then falls is not diverged", async () => {
    // changes of x with calc scripted: 1, 2, 3, 2 (x starts at 0, iterate = previous calc)
    const o = await runCoupling(loop({ maxPasses: 4 }), { x: 0 }, script([{ x: 1 }, { x: 2 }, { x: 2.5 }, { x: 2.9 }]));
    expect(o.state).toBe("not-converged");
  });
  it("a = -1.2 started far from the fixed point alternates AND grows: diverged at pass 4 (the growth check comes before oscillation)", async () => {
    // residuals 1, -1.2, 1.44, -1.728; scale 1 (|calc of pass 1|); R = |r| / 1e-3 grows on every pass
    expect(growthPass((v) => [-1.2 * v[0]! + 1], [0], [1e-3], 1)).toBe(4);
    const o = await runCoupling(loop(), { x: 0 }, linear(-1.2, 1));
    expect(o.state).toBe("diverged");
    expect(o.passes).toHaveLength(4);
    expect(o.result).toBeUndefined();
  });
  it("a monotone growth (a = 1.2, b = 1) is diverged at the pass the recurrence gives", async () => {
    const at = growthPass((v) => [1.2 * v[0]! + 1], [0], [1e-3], 1);
    expect(at).toBe(4);
    const o = await runCoupling(loop(), { x: 0 }, linear(1.2, 1));
    expect(o.state).toBe("diverged");
    expect(o.passes).toHaveLength(at!);
    // residuals are 1, 1.2, 1.44, 1.728 (r_k = 1.2^(k-1))
    o.passes.forEach((p, i) => expect(p.calc.x! - p.iterate.x!).toBeCloseTo(Math.pow(1.2, i), 9));
  });
  it("the relative change does NOT grow here (about 1000, 6000, 1161, 3540 tolerances) but the absolute residual does: diverged, not hidden", async () => {
    const o = await runCoupling(loop(), { x: 0 }, linear(-1.2, 1));
    const rel = o.passes.map((p) => p.change.x! / 1e-3);
    expect(rel[2]!).toBeLessThan(rel[1]!); // the relative change fell on pass 3
    const abs = o.passes.map((p) => Math.abs(p.calc.x! - p.iterate.x!));
    expect(abs[1]!).toBeGreaterThan(abs[0]!);
    expect(abs[2]!).toBeGreaterThan(abs[1]!);
    expect(abs[3]!).toBeGreaterThan(abs[2]!);
    expect(o.state).toBe("diverged");
  });
  it("two quantities, only the second grows: diverged (the largest R is looked at, and the first quantity's tolerance does not hide it)", async () => {
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 1e-3 }, { id: "b", tolerance: 1e-3 }] };
    const pass: PassFunction = async (it) => ({ ok: true, calc: { a: 0.5 * (it.a as number) + 1, b: 1.2 * (it.b as number) + 1 } });
    // a alone converges; b alone is diverged at pass 4
    expect(growthPass((v) => [0.5 * v[0]! + 1, 1.2 * v[1]! + 1], [0, 0], [1e-3, 1e-3], 1)).toBe(4);
    const o = await runCoupling(def, { a: 0, b: 0 }, pass);
    expect(o.state).toBe("diverged");
    expect(o.passes).toHaveLength(4);
    expect(o.reason).toMatch(/residual/);
  });
  it("the scale is fixed at pass 1: a residual that grows only against a moving calc is judged against the first calc", async () => {
    // residual 1, 2, 3, 4 with calc 1, 3, 6, 10 (x = previous calc): R grows on 3 passes in a row; the relative change 1, .67, .5, .4 falls
    const o = await runCoupling(loop({ maxPasses: 6 }), { x: 0 }, script([{ x: 1 }, { x: 3 }, { x: 6 }, { x: 10 }, { x: 15 }, { x: 21 }]));
    expect(o.passes.map((p) => p.change.x!).every((c, i, a) => i === 0 || c < a[i - 1]!)).toBe(true);
    expect(o.state).toBe("diverged");
    expect(o.passes).toHaveLength(4);
  });
  it("a = -1 exactly: pure alternation without decay is oscillating after four passes", async () => {
    const o = await runCoupling(loop(), { x: 0 }, linear(-1, 1));
    expect(o.state).toBe("oscillating");
    expect(o.passes).toHaveLength(4);
    expect(o.passes.map((p) => Math.sign(p.calc.x! - p.iterate.x!))).toEqual([1, -1, 1, -1]);
    expect(o.result).toBeUndefined();
  });
  it("an alternation that decays faster than 0.9 per two passes is not oscillating (a = -0.8 decays 0.64 per two passes)", async () => {
    const o = await runCoupling(loop(), { x: 0 }, linear(-0.8, 1));
    expect(o.state).not.toBe("oscillating");
    // the recurrence says 25 passes are not enough at this rate, so the honest end is not-converged
    expect(expectedPasses((v) => [-0.8 * v[0]! + 1], [0], [1e-3], 1, 2, 25)).toBeNull();
    expect(o.state).toBe("not-converged");
    expect(o.passes).toHaveLength(25);
  });
  it("a = -0.95 decays 0.9025 per two passes (above 0.9): it counts as not decaying and is oscillating", async () => {
    const o = await runCoupling(loop(), { x: 0 }, linear(-0.95, 1));
    expect(o.state).toBe("oscillating");
  });
  it("a range violation is diverged, with the failing pass recorded and no result", async () => {
    const q = { id: "x", tolerance: 1e-3, min: 0, max: 5 };
    const hi = await runCoupling({ ...loop(), exchanged: [q] }, { x: 1 }, script([{ x: 2 }, { x: 5.5 }]));
    expect(hi.state).toBe("diverged");
    expect(hi.passes).toHaveLength(2);
    expect(hi.reason).toMatch(/x/);
    expect(hi.reason).toMatch(/maximum/);
    expect(hi.result).toBeUndefined();
    const lo = await runCoupling({ ...loop(), exchanged: [q] }, { x: 1 }, script([{ x: 2 }, { x: -0.1 }]));
    expect(lo.state).toBe("diverged");
    expect(lo.reason).toMatch(/minimum/);
    // the range edge itself is allowed
    const edge = await runCoupling({ ...loop({ maxPasses: 2 }), exchanged: [q] }, { x: 1 }, script([{ x: 5 }, { x: 0 }]));
    expect(edge.state).not.toBe("diverged");
  });
  it("a value that is not finite is diverged (NaN and Infinity)", async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const o = await runCoupling(loop(), { x: 1 }, script([{ x: 2 }, { x: bad }]));
      expect(o.state).toBe("diverged");
      expect(o.passes).toHaveLength(2);
      expect(o.reason).toMatch(/not a finite/);
      expect(o.result).toBeUndefined();
    }
  });
  it("converged wins over a range violation of nothing, but a range violation wins over convergence of the same pass", async () => {
    // calc equals the iterate (zero change) but is outside its range: the range check comes first
    const q = { id: "x", tolerance: 1e-3, max: 5 };
    const o = await runCoupling({ ...loop(), exchanged: [q] }, { x: 6 }, script([{ x: 6 }]));
    expect(o.state).toBe("diverged");
  });
});

describe("stalled: the tolerance is below the noise floor", () => {
  const jitter: PassFunction = async (_it, k) => ({ ok: true, calc: { x: 10 + (k % 2 === 1 ? 0.5 : -0.5) }, noise: { x: 1 } });
  it("changes of about 0.5 to 1 with a noise of 1 and a tolerance of 1e-6: stalled after two passes, never converged", async () => {
    const o = await runCoupling(loop({}, 1e-6), { x: 10 }, jitter);
    expect(o.state).toBe("stalled");
    expect(o.passes).toHaveLength(2);
    expect(o.result).toBeUndefined();
    expect(o.passes[0]!.noise).toEqual({ x: 1 });
  });
  it("the same jitter without a reported noise is not stalled (it ends oscillating)", async () => {
    const o = await runCoupling(loop({}, 1e-6), { x: 10 }, async (_it, k) => ({ ok: true, calc: { x: 10 + (k % 2 === 1 ? 0.5 : -0.5) } }));
    expect(o.state).toBe("oscillating");
  });
  it("a noise far below the changes does not stall the loop", async () => {
    const o = await runCoupling(loop({}, 1e-6), { x: 10 }, async (_it, k) => ({ ok: true, calc: { x: 10 + (k % 2 === 1 ? 0.5 : -0.5) }, noise: { x: 1e-9 } }));
    expect(o.state).toBe("oscillating");
  });
  it("changes inside the tolerance converge even when a noise is reported (the noise only excuses a failure, it never replaces the test)", async () => {
    const o = await runCoupling(loop(), { x: 5 }, async () => ({ ok: true, calc: { x: 5 }, noise: { x: 1 } }));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(2);
  });
  it("one quantity inside its tolerance and one inside the noise only: stalled", async () => {
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 1e-3 }, { id: "b", tolerance: 1e-6 }] };
    const pass: PassFunction = async (it) => ({ ok: true, calc: { a: it.a as number, b: (it.b as number) + 0.01 }, noise: { a: 0, b: 0.01 } });
    const o = await runCoupling(def, { a: 3, b: 20 }, pass);
    expect(o.state).toBe("stalled");
  });
  it("the stall needs `consecutive` passes in a row: a single noisy pass between good ones does not stall", async () => {
    // pass 1 has a change of 0.5 (inside 2 sigma = 2), pass 2 is exactly the iterate (inside the tolerance), pass 3 noisy again
    const rows = [{ x: 10.5 }, { x: 10.5 }, { x: 11 }];
    const o = await runCoupling(loop({ maxPasses: 3 }, 1e-6), { x: 10 }, async (_it, k) => ({ ok: true, calc: { ...rows[k - 1]! }, noise: { x: 1 } }));
    expect(o.state).toBe("not-converged");
  });
});

describe("consecutive passes and several quantities", () => {
  it("a change that dips under the tolerance for one pass and then rises does not converge on the dip", async () => {
    // calc: 1, 2, 2.0000001 (dip), 3 (rises again), 3.00000001 (dip), 3.00000001 (second in a row)
    const rows = [{ x: 1 }, { x: 2 }, { x: 2.0000001 }, { x: 3 }, { x: 3.00000001 }, { x: 3.00000001 }];
    const o = await runCoupling(loop({}, 1e-6), { x: 0 }, script(rows));
    expect(o.passes[2]!.change.x!).toBeLessThanOrEqual(1e-6); // the dip is real
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(6);
    expect(o.result).toEqual({ iterate: { x: 3.00000001 }, passes: 6 });
  });
  it("consecutive 3 needs three inside passes", async () => {
    const o = await runCoupling(loop({ consecutive: 3 }), { x: 5 }, script([{ x: 5 }]));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(3);
  });
  it("two quantities with a 2x2 linear map of spectral radius 0.5: converges in the recurrence's number of passes", async () => {
    const M = [[0.3, 0.2], [0.1, 0.4]]; // eigenvalues 0.5 and 0.2
    const c = [1, 2];
    const map = (v: number[]) => [M[0]![0]! * v[0]! + M[0]![1]! * v[1]! + c[0]!, M[1]![0]! * v[0]! + M[1]![1]! * v[1]! + c[1]!];
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 1e-4 }, { id: "b", tolerance: 1e-4 }] };
    const pass: PassFunction = async (it) => { const m = map([it.a as number, it.b as number]); return { ok: true, calc: { a: m[0]!, b: m[1]! } }; };
    const expected = expectedPasses(map, [0, 0], [1e-4, 1e-4], 1, 2, 25);
    expect(expected).not.toBeNull();
    const o = await runCoupling(def, { a: 0, b: 0 }, pass);
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(expected!);
    // fixed point: (I - M) x = c, solved by hand: det = 0.7*0.6 - 0.2*0.1 = 0.40; a = (0.6*1 + 0.2*2)/0.4 = 2.5, b = (0.1*1 + 0.7*2)/0.4 = 3.75
    expect(o.result!.iterate.a).toBeCloseTo(2.5, 3);
    expect(o.result!.iterate.b).toBeCloseTo(3.75, 3);
  });
  it("one quantity inside its tolerance and the other not: not converged yet; the stop is the first of two passes with both inside", async () => {
    const M = [[0.3, 0.2], [0.1, 0.4]];
    const c = [1, 2];
    const map = (v: number[]) => [M[0]![0]! * v[0]! + M[0]![1]! * v[1]! + c[0]!, M[1]![0]! * v[0]! + M[1]![1]! * v[1]! + c[1]!];
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 0.5 }, { id: "b", tolerance: 1e-6 }] };
    const pass: PassFunction = async (it) => { const m = map([it.a as number, it.b as number]); return { ok: true, calc: { a: m[0]!, b: m[1]! } }; };
    const expected = expectedPasses(map, [0, 0], [0.5, 1e-6], 1, 2, 25);
    const o = await runCoupling(def, { a: 0, b: 0 }, pass);
    // some pass has a inside its loose tolerance while b is still outside its tight one: that pass alone cannot end the loop
    const mixed = o.passes.findIndex((p) => p.change.a! <= 0.5 && p.change.b! > 1e-6);
    expect(mixed).toBeGreaterThanOrEqual(0);
    expect(mixed).toBeLessThan(o.passes.length - 1);
    if (expected === null) {
      expect(o.state).toBe("not-converged");
      expect(o.result).toBeUndefined();
    } else {
      expect(o.state).toBe("converged");
      expect(o.passes).toHaveLength(expected);
      expect(expected).toBeGreaterThan(2);
      // the pass before the stop is the first of the two with both inside, and the one before that is not
      const k = o.passes.length;
      const inside = (i: number) => o.passes[i]!.change.a! <= 0.5 && o.passes[i]!.change.b! <= 1e-6;
      expect(inside(k - 1)).toBe(true);
      expect(inside(k - 2)).toBe(true);
      expect(inside(k - 3)).toBe(false);
    }
  });
  it("scripted: a stays inside on every pass, b dips on pass 3, leaves on pass 4 and is inside on 5 and 6: stop at pass 6", async () => {
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 1e-6 }, { id: "b", tolerance: 1e-6 }] };
    const bs = [1, 2, 2.0000001, 3, 3.00000001, 3.00000001];
    const o = await runCoupling(def, { a: 1, b: 0 }, async (_it, k) => ({ ok: true, calc: { a: 1, b: bs[k - 1]! } }));
    expect(o.state).toBe("converged");
    expect(o.passes).toHaveLength(6);
    expect(o.passes[2]!.change.b!).toBeLessThanOrEqual(1e-6);
    expect(o.passes[3]!.change.b!).toBeGreaterThan(1e-6);
  });
});

describe("failures of the apps", () => {
  it("a pass that returns { ok: false } at pass 3 is an engine-failure; passes 1 and 2 are kept; no result", async () => {
    const f: PassFunction = async (it, k) => (k === 3 ? { ok: false, reason: "the solver ran out of memory" } : { ok: true, calc: { x: 0.5 * (it.x as number) + 1 } });
    const o = await runCoupling(loop(), { x: 0 }, f);
    expect(o.state).toBe("engine-failure");
    expect(o.reason).toMatch(/the solver ran out of memory/);
    expect(o.passes.map((p) => p.index)).toEqual([1, 2]);
    expect(o.result).toBeUndefined();
  });
  it("a pass that throws at pass 3 is an engine-failure with the message; earlier passes kept", async () => {
    const f: PassFunction = async (it, k) => { if (k === 3) throw new Error("socket closed"); return { ok: true, calc: { x: 0.5 * (it.x as number) + 1 } }; };
    const o = await runCoupling(loop(), { x: 0 }, f);
    expect(o.state).toBe("engine-failure");
    expect(o.reason).toMatch(/socket closed/);
    expect(o.passes).toHaveLength(2);
    expect(o.result).toBeUndefined();
  });
  it("a thrown non-error value is reported too", async () => {
    const o = await runCoupling(loop(), { x: 0 }, async () => { throw "plain string"; });
    expect(o.state).toBe("engine-failure");
    expect(o.reason).toMatch(/plain string/);
    expect(o.passes).toEqual([]);
  });
  it("a pass that leaves out an exchanged value is an engine-failure", async () => {
    const def: LoopDefinition = { ...loop(), exchanged: [{ id: "a", tolerance: 1e-3 }, { id: "b", tolerance: 1e-3 }] };
    const o = await runCoupling(def, { a: 0, b: 0 }, async () => ({ ok: true, calc: { a: 1 } }));
    expect(o.state).toBe("engine-failure");
    expect(o.reason).toMatch(/b/);
  });
  it("a negative or non-finite noise is an engine-failure", async () => {
    const o = await runCoupling(loop(), { x: 0 }, async () => ({ ok: true, calc: { x: 1 }, noise: { x: -1 } }));
    expect(o.state).toBe("engine-failure");
  });
  it("a conservation failure at pass 2 stops at once with state conservation; the failing pass is recorded", async () => {
    let calls = 0;
    const f: PassFunction = async (it, k) => {
      calls++;
      return { ok: true, calc: { x: 0.5 * (it.x as number) + 1 }, conservation: k === 2 ? { ok: false, message: "pin power 1.2 MW is not the 1.0 MW the neutronics app reports" } : { ok: true } };
    };
    const o = await runCoupling(loop(), { x: 0 }, f);
    expect(o.state).toBe("conservation");
    expect(o.reason).toBe("pin power 1.2 MW is not the 1.0 MW the neutronics app reports");
    expect(calls).toBe(2);
    expect(o.passes).toHaveLength(2);
    expect(o.passes[1]!.conservation).toEqual({ ok: false, message: "pin power 1.2 MW is not the 1.0 MW the neutronics app reports" });
    expect(o.passes[0]!.conservation).toEqual({ ok: true });
    expect(o.result).toBeUndefined();
  });
  it("a conservation failure without a message still gets a reason, and wins over convergence of the same pass", async () => {
    const o = await runCoupling(loop(), { x: 5 }, async () => ({ ok: true, calc: { x: 5 }, conservation: { ok: false } }));
    expect(o.state).toBe("conservation");
    expect(o.reason).toMatch(/pass 1/);
    expect(o.passes).toHaveLength(1);
  });
  it("an engine failure wins over everything: no record for a pass that returned nothing", async () => {
    const o = await runCoupling(loop(), { x: 5 }, async () => ({ ok: false, reason: "interrupted" }));
    expect(o.state).toBe("engine-failure");
    expect(o.passes).toEqual([]);
  });
});

describe("what is refused before any pass", () => {
  const base = { exchanged: [{ id: "x", tolerance: 1e-3 }], maxPasses: 10, relaxation: 1, consecutive: 2 };
  const cases: [string, unknown, RegExp][] = [
    ["maxPasses 26", { ...base, maxPasses: 26 }, /maxPasses.*26.*ceiling of 25/],
    ["maxPasses 0", { ...base, maxPasses: 0 }, /maxPasses.*at least 1/],
    ["maxPasses 2.5", { ...base, maxPasses: 2.5 }, /maxPasses is a whole number/],
    ["maxPasses missing", { exchanged: base.exchanged }, /maxPasses is a whole number/],
    ["relaxation 0", { ...base, relaxation: 0 }, /relaxation/],
    ["relaxation 1.5", { ...base, relaxation: 1.5 }, /relaxation/],
    ["relaxation -0.5", { ...base, relaxation: -0.5 }, /relaxation/],
    ["relaxation NaN", { ...base, relaxation: NaN }, /relaxation/],
    ["consecutive 1", { ...base, consecutive: 1 }, /consecutive/],
    ["consecutive 2.5", { ...base, consecutive: 2.5 }, /consecutive/],
    ["tolerance 0", { ...base, exchanged: [{ id: "x", tolerance: 0 }] }, /tolerance/],
    ["tolerance 1", { ...base, exchanged: [{ id: "x", tolerance: 1 }] }, /tolerance/],
    ["tolerance -0.1", { ...base, exchanged: [{ id: "x", tolerance: -0.1 }] }, /tolerance/],
    ["tolerance missing", { ...base, exchanged: [{ id: "x" }] }, /tolerance/],
    ["empty exchanged", { ...base, exchanged: [] }, /at least one quantity/],
    ["exchanged not a list", { ...base, exchanged: "x" }, /at least one quantity/],
    ["duplicate ids", { ...base, exchanged: [{ id: "x", tolerance: 1e-3 }, { id: "x", tolerance: 1e-2 }] }, /x is listed twice/],
    ["a bad id", { ...base, exchanged: [{ id: "", tolerance: 1e-3 }] }, /\.id/],
    ["a forbidden id", { ...base, exchanged: [{ id: "constructor", tolerance: 1e-3 }] }, /\.id/],
    ["floor 0", { ...base, exchanged: [{ id: "x", tolerance: 1e-3, floor: 0 }] }, /floor/],
    ["min above max", { ...base, exchanged: [{ id: "x", tolerance: 1e-3, min: 5, max: 1 }] }, /above max/],
    ["an unknown key", { ...base, speed: 3 }, /not speed/],
    ["an unknown key on a quantity", { ...base, exchanged: [{ id: "x", tolerance: 1e-3, unit: "K" }] }, /not unit/],
    ["not an object", 7, /object/],
    ["null", null, /object/],
    ["an array", [], /object/]
  ];
  for (const [name, def, re] of cases) {
    it(`${name}: validateLoop names the problem, runCoupling runs no pass`, async () => {
      const v = validateLoop(def);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.errors.join("; ")).toMatch(re);
      let calls = 0;
      const o = await runCoupling(def as LoopDefinition, { x: 1 }, async () => { calls++; return { ok: true, calc: { x: 1 } }; });
      expect(o.state).toBe("refused");
      expect(o.passes).toEqual([]);
      expect(o.result).toBeUndefined();
      expect(o.reason).toMatch(re);
      expect(calls).toBe(0);
    });
  }
  it("all the problems of a definition are listed, not only the first", () => {
    const v = validateLoop({ exchanged: [], maxPasses: 99, relaxation: 2, consecutive: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.length).toBe(4);
  });
  it("the hard ceiling is 25 and 25 itself is accepted, as is maxPasses 1", () => {
    expect(HARD_MAX_PASSES).toBe(25);
    expect(validateLoop({ ...base, maxPasses: 25 }).ok).toBe(true);
    expect(validateLoop({ ...base, maxPasses: 1 }).ok).toBe(true);
  });
  it("relaxation and consecutive default to 1 and 2 when omitted; the normalised copy leaves the input alone", () => {
    const input = { exchanged: [{ id: "x", tolerance: 1e-3, floor: 1e-9, min: 0, max: 10 }], maxPasses: 5 };
    const before = JSON.stringify(input);
    const v = validateLoop(input);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.def).toEqual({ exchanged: [{ id: "x", tolerance: 1e-3, floor: 1e-9, min: 0, max: 10 }], maxPasses: 5, relaxation: 1, consecutive: 2 });
    expect(JSON.stringify(input)).toBe(before);
    expect(v.def.exchanged[0]).not.toBe(input.exchanged[0]);
  });
  const initialCases: [string, unknown, RegExp][] = [
    ["an initial iterate that misses a quantity", { x: 1 }, /no value for y/],
    ["a non-finite initial value (NaN)", { x: NaN, y: 1 }, /initial value of x is not a finite/],
    ["a non-finite initial value (Infinity)", { x: 1, y: Infinity }, /initial value of y is not a finite/],
    ["a string as the initial value", { x: "1", y: 1 }, /initial value of x/],
    ["a null initial iterate", null, /initial iterate/]
  ];
  for (const [name, initial, re] of initialCases) {
    it(`${name} is refused with no pass`, async () => {
      let calls = 0;
      const def: LoopDefinition = { ...loop(), exchanged: [{ id: "x", tolerance: 1e-3 }, { id: "y", tolerance: 1e-3 }] };
      const o = await runCoupling(def, initial as Record<string, number>, async () => { calls++; return { ok: true, calc: { x: 1, y: 1 } }; });
      expect(o.state).toBe("refused");
      expect(o.passes).toEqual([]);
      expect(o.reason).toMatch(re);
      expect(o.result).toBeUndefined();
      expect(calls).toBe(0);
    });
  }
  it("an extra key in the initial iterate is ignored, not carried into the records", async () => {
    const o = await runCoupling(loop({ maxPasses: 2 }), { x: 0, other: 9 }, linear(0.5, 1));
    expect(Object.keys(o.passes[0]!.iterate)).toEqual(["x"]);
  });
});

describe("the records", () => {
  it("next = iterate + relaxation * (calc - iterate), the next pass starts from it, index starts at 1, change follows the formula", async () => {
    const def: LoopDefinition = { ...loop({ relaxation: 0.3 }), exchanged: [{ id: "a", tolerance: 1e-3 }, { id: "b", tolerance: 1e-3, floor: 0.5 }] };
    const seen: Record<string, number>[] = [];
    const pass: PassFunction = async (it) => { seen.push({ ...it }); return { ok: true, calc: { a: 0.6 * (it.a as number) + 2, b: 0.1 * (it.b as number) - 0.01 } }; };
    const o = await runCoupling(def, { a: 1, b: 0.2 }, pass);
    expect(o.passes.length).toBeGreaterThan(3);
    o.passes.forEach((p, i) => {
      expect(p.index).toBe(i + 1);
      expect(p.relaxation).toBe(0.3);
      expect(p.iterate).toEqual(seen[i]);
      for (const id of ["a", "b"]) {
        expect(p.next[id]).toBe(p.iterate[id]! + 0.3 * (p.calc[id]! - p.iterate[id]!));
      }
      expect(p.change.a).toBe(Math.abs(p.calc.a! - p.iterate.a!) / Math.max(Math.abs(p.calc.a!), 1e-12));
      // b has the absolute scale 0.5, and |calc_b| is far below it
      expect(p.change.b).toBe(Math.abs(p.calc.b! - p.iterate.b!) / Math.max(Math.abs(p.calc.b!), 0.5));
      if (i > 0) expect(p.iterate).toEqual(o.passes[i - 1]!.next);
    });
    expect(o.passes[0]!.iterate).toEqual({ a: 1, b: 0.2 });
  });
  it("the floor keeps a tiny value from making an enormous relative change; the default floor is 1e-12", async () => {
    const o = await runCoupling(loop({ maxPasses: 1 }), { x: 0 }, script([{ x: 1e-15 }]));
    expect(o.passes[0]!.change.x).toBeCloseTo(1e-3, 12);
    const o2 = await runCoupling({ ...loop({ maxPasses: 1 }), exchanged: [{ id: "x", tolerance: 1e-3, floor: 1e-6 }] }, { x: 0 }, script([{ x: 1e-9 }]));
    expect(o2.passes[0]!.change.x).toBeCloseTo(1e-3, 12);
    // a change from 0 to exactly 0 is 0, not NaN
    const o3 = await runCoupling(loop({ maxPasses: 1 }), { x: 0 }, script([{ x: 0 }]));
    expect(o3.passes[0]!.change.x).toBe(0);
  });
  it("a converged result is the calc of the last pass, not its next iterate (relaxation 0.5)", async () => {
    const o = await runCoupling(loop({ relaxation: 0.5 }), { x: 0 }, linear(0.5, 1));
    expect(o.state).toBe("converged");
    const last = o.passes[o.passes.length - 1]!;
    expect(o.result!.iterate).toEqual(last.calc);
    expect(o.result!.iterate.x).not.toBe(last.next.x);
    expect(o.result!.passes).toBe(o.passes.length);
    expect(lastIndex(o)).toBe(o.result!.passes);
  });
  it("noise and conservation of a pass are kept in its record, copied", async () => {
    const noise = { x: 0.25 };
    const cons = { ok: true, message: "within 0.1 %" };
    const o = await runCoupling(loop({ maxPasses: 1 }), { x: 0 }, async () => ({ ok: true, calc: { x: 1 }, noise, conservation: cons }));
    expect(o.passes[0]!.noise).toEqual({ x: 0.25 });
    expect(o.passes[0]!.conservation).toEqual(cons);
    expect(o.passes[0]!.noise).not.toBe(noise);
    expect(o.passes[0]!.conservation).not.toBe(cons);
    const bare = await runCoupling(loop({ maxPasses: 1 }), { x: 0 }, linear(0.5, 1));
    expect("noise" in bare.passes[0]!).toBe(false);
    expect("conservation" in bare.passes[0]!).toBe(false);
  });
  it("the outcome shares no object with the inputs or with what the pass function receives or returns", async () => {
    const initial = { x: 0 };
    const returned = { x: 1 };
    let received: Record<string, number> | undefined;
    const pass: PassFunction = async (it) => { received = it; return { ok: true, calc: returned }; };
    const o = await runCoupling(loop({ maxPasses: 2 }), initial, pass);
    expect(o.passes[0]!.iterate).not.toBe(initial);
    expect(o.passes[0]!.calc).not.toBe(returned);
    // changing the outcome changes nothing outside it
    o.passes[0]!.iterate.x = 99;
    o.passes[0]!.calc.x = 99;
    expect(initial).toEqual({ x: 0 });
    expect(returned).toEqual({ x: 1 });
    // a pass function that scribbles on its argument changes no record
    const scribble: PassFunction = async (it) => { it.x = 12345; return { ok: true, calc: { x: 1 } }; };
    const o2 = await runCoupling(loop({ maxPasses: 2 }), initial, scribble);
    expect(o2.passes[0]!.iterate).toEqual({ x: 0 });
    expect(o2.passes[1]!.iterate).toEqual({ x: 1 });
    expect(received).toBeDefined();
  });
  it("does not change a frozen definition or a frozen initial iterate, and the result does not alias the last record", async () => {
    const def = loop();
    Object.freeze(def); Object.freeze(def.exchanged); Object.freeze(def.exchanged[0]);
    const initial = Object.freeze({ x: 0 });
    const o = await runCoupling(def, initial, linear(0.5, 1));
    expect(o.state).toBe("converged");
    expect(o.result!.iterate).not.toBe(o.passes[o.passes.length - 1]!.calc);
    expect(def).toEqual(loop());
  });
});

describe("determinism", () => {
  it("the same definition, start and pass function give the same outcome and records, every time", async () => {
    for (const [a, start] of [[0.5, 0], [-0.5, 3], [0.99, 0], [-1, 0], [-1.2, 0.45]] as const) {
      const first = await runCoupling(loop(), { x: start }, linear(a, 1));
      const second = await runCoupling(loop(), { x: start }, linear(a, 1));
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
  it("the pass function is called once per pass, with the pass index, in order", async () => {
    const calls: number[] = [];
    const o = await runCoupling(loop(), { x: 0 }, async (it, k) => { calls.push(k); return { ok: true, calc: { x: 0.5 * (it.x as number) + 1 } }; });
    expect(calls).toEqual(o.passes.map((p) => p.index));
    expect(calls[0]).toBe(1);
  });
});
