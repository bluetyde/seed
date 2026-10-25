// @covers R-STUDY-06
import { describe, expect, it } from "vitest";
import type { PolicyStudy } from "../src/core/policy";
import type { RegisteredCase } from "../src/core/runDispatcher";
import type { QuantityData } from "../src/core/quantityData";
import { MAX_SAMPLING_OUTPUTS, MAX_SAMPLING_PARAMETERS, expandSampling, pearson, quantile7, ranks, reduceQuantity, spearman, summarizeSampling, type SampleRun, type SamplingDefinition, type SamplingOutput } from "../src/core/sampling";

// The definition and the statistics of a sampling study (docs/sampling.md): what is refused, what a point becomes, and the numbers, against
// known answers (a linear response, pure noise, ties, an exact quantile).
const budget = { maxWallSeconds: 600, maxCores: 4, maxMemoryMB: 4096, maxDiskMB: 1000 };
const study = (extra: Partial<PolicyStudy["budget"]> = {}): PolicyStudy => ({
  studyId: "s", tier: "A1", budget: { ...budget, maxCases: 100, ...extra },
  parameters: [{ id: "temp", min: 300, max: 900, unit: "K" }, { id: "flow", min: 1, max: 50 }, { id: "gap", min: 0.1, max: 2 }]
});
const base: RegisteredCase = {
  artifact: { path: "m.json", revision: { hash: "a".repeat(64), counter: 1 } },
  inputs: [{ path: "m.json", sha256: "a".repeat(64) }],
  params: [{ id: "temp", value: 500 }, { id: "flow", value: 10 }],
  settings: { scenario: "success" },
  seed: 7
};
const cases = { base };
const def = (over: Partial<SamplingDefinition> = {}): SamplingDefinition => ({
  base: "base",
  design: { method: "lhs", n: 12, seed: 42 },
  parameters: [{ id: "temp", distribution: { kind: "uniform", min: 400, max: 800 } }, { id: "flow", distribution: { kind: "triangular", min: 5, mode: 10, max: 20 } }],
  outputs: [{ quantity: "peak", reduce: "max" }],
  ...over
});
const expand = (d: unknown, s = study()) => expandSampling("uq", d as SamplingDefinition, cases, s);
const codes = (r: { ok: boolean; errors?: { code: string; field?: string; message: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const msg = (r: { ok: boolean; errors?: { message: string }[] }) => (r.ok ? "" : r.errors!.map((e) => e.message).join("; "));

describe("expanding a sampling", () => {
  it("makes one full registered case per point, ids uq-001 on, the values in the case's params and settings", () => {
    const r = expand(def());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(12);
    expect(r.cases.map((c) => c.caseId).slice(0, 3)).toEqual(["uq-001", "uq-002", "uq-003"]);
    expect(r.cases[11]!.caseId).toBe("uq-012");
    r.cases.forEach((c, i) => {
      expect(c.values.map((v) => v.id)).toEqual(["temp", "flow"]);
      expect(c.registered.params.find((p) => p.id === "temp")!.value).toBe(r.points[i]![0]);
      expect(c.registered.params.find((p) => p.id === "flow")!.value).toBe(r.points[i]![1]);
      expect((c.registered.settings as Record<string, unknown>).temp).toBe(r.points[i]![0]);
      expect((c.registered.settings as Record<string, unknown>).scenario).toBe("success");
      expect(c.registered.artifact).toEqual(base.artifact);
      expect(c.registered.seed).toBe(7);
    });
    expect(base.params).toEqual([{ id: "temp", value: 500 }, { id: "flow", value: 10 }]); // the base case is not changed
  });
  it("a parameter the base case does not list is added", () => {
    const r = expand(def({ parameters: [{ id: "gap", distribution: { kind: "uniform", min: 0.5, max: 1 } }] }));
    expect(r.ok && r.cases[0]!.registered.params.map((p) => p.id)).toEqual(["temp", "flow", "gap"]);
  });
  it("is the same every time for a seed, different for another, and every value lies inside the declared window and the study bounds", () => {
    const a = expand(def()), b = expand(def()), c = expand(def({ design: { method: "lhs", n: 12, seed: 43 } }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup");
    expect(b.points).toEqual(a.points);
    expect(c.points).not.toEqual(a.points);
    for (const p of a.points) { expect(p[0]).toBeGreaterThanOrEqual(400); expect(p[0]).toBeLessThanOrEqual(800); expect(p[1]).toBeGreaterThanOrEqual(5); expect(p[1]).toBeLessThanOrEqual(20); }
  });
  it("a Latin hypercube puts one point in each of the n equal-probability strata of a uniform parameter", () => {
    const r = expand(def({ design: { method: "lhs", n: 20, seed: 1 }, parameters: [{ id: "temp", distribution: { kind: "uniform", min: 300, max: 900 } }] }));
    if (!r.ok) throw new Error("setup");
    expect(r.points.map((p) => Math.min(19, Math.floor(((p[0]! - 300) / 600) * 20))).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it("does not change the definition it is given", () => {
    const d = def();
    const before = JSON.stringify(d);
    expand(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("what is refused", () => {
  const cases2: [string, unknown, RegExp][] = [
    ["a base case that is not registered", def({ base: "nope" }), /base case nope/],
    ["an extra key", { ...def(), seedless: 1 }, /not seedless/],
    ["a missing design", { ...def(), design: undefined }, /method, n and a seed/],
    ["an unknown method", def({ design: { method: "halton" as never, n: 8, seed: 1 } }), /lhs .* sobol or morris/],
    ["a Sobol base size below 8", def({ design: { method: "sobol", n: 7, seed: 1 } }), /at least 8/],
    ["one Morris trajectory", def({ design: { method: "morris", n: 1, seed: 1 } }), /at least 2/],
    ["fewer than two points", def({ design: { method: "lhs", n: 1, seed: 1 } }), /at least 2/],
    ["a fractional n", def({ design: { method: "lhs", n: 8.5, seed: 1 } }), /whole number/],
    ["a negative seed", def({ design: { method: "lhs", n: 8, seed: -1 } }), /seed/],
    ["a seed that is too large", def({ design: { method: "lhs", n: 8, seed: 2 ** 32 } }), /seed/],
    ["an extra design key", def({ design: { method: "lhs", n: 8, seed: 1, antithetic: true } as never }), /not antithetic/],
    ["no parameters", def({ parameters: [] }), /1 to 8 parameters/],
    ["a parameter the study does not declare", def({ parameters: [{ id: "pressure", distribution: { kind: "uniform", min: 1, max: 2 } }] }), /not a parameter of the study/],
    ["a parameter named twice", def({ parameters: [{ id: "temp", distribution: { kind: "uniform", min: 400, max: 500 } }, { id: "temp", distribution: { kind: "uniform", min: 500, max: 600 } }] }), /sampled twice/],
    ["a forbidden key", def({ parameters: [{ id: "__proto__", distribution: { kind: "uniform", min: 400, max: 500 } }] }), /cannot be sampled/],
    ["a window that leaves the study bounds", def({ parameters: [{ id: "temp", distribution: { kind: "uniform", min: 250, max: 500 } }] }), /leaves the study bounds 300 to 900/],
    ["a window above the study bounds", def({ parameters: [{ id: "flow", distribution: { kind: "triangular", min: 5, mode: 10, max: 60 } }] }), /leaves the study bounds/],
    ["a bad distribution", def({ parameters: [{ id: "temp", distribution: { kind: "uniform", min: 500, max: 400 } }] }), /min below max/],
    ["a normal with no window", def({ parameters: [{ id: "temp", distribution: { kind: "normal", mean: 600, sd: 50 } as never }] }), /window/],
    ["an extra parameter key", def({ parameters: [{ id: "temp", distribution: { kind: "uniform", min: 400, max: 500 }, unit: "K" } as never] }), /not unit/],
    ["no outputs", def({ outputs: [] }), /1 to 8 outputs/],
    ["an output with no reduction", def({ outputs: [{ quantity: "peak", reduce: "median" as never }] }), /reduce is one of/],
    ["an output named twice", def({ outputs: [{ quantity: "peak", reduce: "max" }, { quantity: "peak", reduce: "max" }] }), /listed twice/],
    ["a bad quantity name", def({ outputs: [{ quantity: "../x", reduce: "max" }] }), /names a quantity/]
  ];
  it.each(cases2)("%s", (_n, d, re) => {
    const r = expand(d);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(msg(r)).toMatch(re);
    expect(codes(r)[0]).toBe("E_SCHEMA_INVALID");
  });
  it("more points than the study allows is a budget error that says who can change it", () => {
    const r = expand(def({ design: { method: "lhs", n: 101, seed: 1 } }));
    expect(codes(r)).toEqual(["E_BUDGET_EXCEEDED"]);
    expect(msg(r)).toContain("raises maxCases");
    expect(expand(def({ design: { method: "lhs", n: 100, seed: 1 } })).ok).toBe(true);
  });
  it("the study's default limit of 10 applies when nothing else is said, and 10000 is a fixed ceiling", () => {
    const noMax: PolicyStudy = { ...study(), budget: { ...budget } };
    expect(codes(expand(def({ design: { method: "lhs", n: 11, seed: 1 } }), noMax))).toEqual(["E_BUDGET_EXCEEDED"]);
    expect(expand(def({ design: { method: "lhs", n: 10, seed: 1 } }), noMax).ok).toBe(true);
    expect(codes(expand(def({ design: { method: "random", n: 10001, seed: 1 } }), study({ maxCases: 1e9 })))).toEqual(["E_BUDGET_EXCEEDED"]);
  });
  it("a bad sampling id is refused", () => {
    expect(expandSampling("bad id", def(), cases, study()).ok).toBe(false);
    expect(expandSampling("", def(), cases, study()).ok).toBe(false);
  });
  it("limits on parameters and outputs", () => {
    const many = Array.from({ length: MAX_SAMPLING_PARAMETERS + 1 }, (_, i) => ({ id: `p${i}`, distribution: { kind: "uniform" as const, min: 1, max: 2 } }));
    expect(msg(expand(def({ parameters: many })))).toMatch(/1 to 8 parameters/);
    const outs: SamplingOutput[] = Array.from({ length: MAX_SAMPLING_OUTPUTS + 1 }, (_, i) => ({ quantity: `q${i}`, reduce: "last" as const }));
    expect(msg(expand(def({ outputs: outs })))).toMatch(/1 to 8 outputs/);
  });
});

describe("reducing a quantity", () => {
  const series: QuantityData = { kind: "series", quantity: "peak", unit: "K", axis: { name: "t", unit: "s" }, x: [0, 1, 2, 3], values: [10, 40, 25, 30], std: [1, 4, 2.5, 3] };
  it("last, first, min, max take the number and the deviation at that place; mean has none", () => {
    expect(reduceQuantity(series, "last")).toEqual({ ok: true, value: 30, std: 3 });
    expect(reduceQuantity(series, "first")).toEqual({ ok: true, value: 10, std: 1 });
    expect(reduceQuantity(series, "max")).toEqual({ ok: true, value: 40, std: 4 });
    expect(reduceQuantity(series, "min")).toEqual({ ok: true, value: 10, std: 1 });
    expect(reduceQuantity(series, "mean")).toEqual({ ok: true, value: 26.25, std: null });
  });
  it("a series without deviations gives none, and one is never invented", () => {
    const plain: QuantityData = { ...series, std: undefined } as QuantityData;
    expect(reduceQuantity(plain, "last")).toEqual({ ok: true, value: 30, std: null });
  });
  it("a scalar is itself, with its deviation when it has one", () => {
    expect(reduceQuantity({ kind: "scalar", quantity: "k", unit: "1", value: 1.0012, std: 0.0003 }, "last")).toEqual({ ok: true, value: 1.0012, std: 0.0003 });
    expect(reduceQuantity({ kind: "scalar", quantity: "k", unit: "1", value: 1.0012 }, "max")).toEqual({ ok: true, value: 1.0012, std: null });
  });
  it("a table, an empty series and a value that is not finite are refused with a reason", () => {
    expect(reduceQuantity({ kind: "table", quantity: "t", unit: "1", columns: [], rows: [] }, "last")).toMatchObject({ ok: false });
    expect(reduceQuantity({ ...series, x: [], values: [] } as QuantityData, "last")).toMatchObject({ ok: false });
    expect(reduceQuantity({ ...series, values: [1, Number.NaN] } as QuantityData, "last")).toMatchObject({ ok: false });
    expect(reduceQuantity({ kind: "scalar", quantity: "k", unit: "1", value: Infinity }, "last")).toMatchObject({ ok: false });
  });
});

describe("statistics", () => {
  it("quantile7 is the linear one: exact on known values", () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantile7(s, 0.5)).toBe(3);
    expect(quantile7(s, 0.25)).toBe(2);
    expect(quantile7(s, 0.05)).toBeCloseTo(1.2, 12);
    expect(quantile7(s, 0.95)).toBeCloseTo(4.8, 12);
    expect(quantile7([7], 0.3)).toBe(7);
    expect(quantile7([1, 2], 0.5)).toBe(1.5);
  });
  it("ranks share the mean rank among ties; pearson and spearman on known data", () => {
    expect(ranks([30, 10, 20, 20])).toEqual([4, 1, 2.5, 2.5]);
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 12); // monotone, not linear
    expect(pearson([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])!).toBeLessThan(1);
  });

  const out: SamplingOutput[] = [{ quantity: "y", reduce: "last" }];
  const mk = (xs: number[], f: (x: number) => number, std: number | null = null): SampleRun[] =>
    xs.map((x, i) => ({ caseId: `c-${i + 1}`, values: [x], outputs: { "y:last": { value: f(x), std } } }));

  it("a linear response y = 3x + 2 over x = 0..9: mean, spread, extremes, quantiles and a correlation of exactly 1", () => {
    const [s] = summarizeSampling(["x"], out, mk([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], (x) => 3 * x + 2));
    expect(s!.n).toBe(10);
    expect(s!.planned).toBe(10);
    expect(s!.mean).toBeCloseTo(15.5, 12);
    expect(s!.inputSpread).toBeCloseTo(3 * Math.sqrt(82.5 / 9), 12); // sd of 0..9 with n-1: sqrt(9.1667)
    expect(s!.standardError).toBeCloseTo(s!.inputSpread! / Math.sqrt(10), 12);
    expect([s!.min, s!.max]).toEqual([2, 29]);
    expect(s!.quantiles!.p50).toBeCloseTo(15.5, 12);
    expect(s!.quantiles!.p05).toBeCloseTo(2 + 3 * 0.45, 12);
    expect(s!.correlations).toEqual([{ parameter: "x", pearson: expect.closeTo(1, 12), spearman: expect.closeTo(1, 12) }]);
    expect(s!.note).toBeNull();
  });
  it("pure Monte Carlo noise: the noise line is reported as noise, with its own kind, and the spread is not the noise", () => {
    // outputs constant in x (no input effect) with a reported deviation of 0.5 on each
    const runs = mk([1, 2, 3, 4, 5, 6, 7, 8], () => 10, 0.5);
    const [s] = summarizeSampling(["x"], out, runs);
    expect(s!.noise).toEqual({ kind: "statistical", rms: 0.5, reportedRuns: 8 });
    expect(s!.inputSpread).toBe(0);
    expect(s!.correlations[0]).toEqual({ parameter: "x", pearson: null, spearman: null });
  });
  it("noise and spread are separate numbers, and a warning appears when the noise is more than half of the spread", () => {
    const [low] = summarizeSampling(["x"], out, mk([1, 2, 3, 4, 5, 6, 7, 8], (x) => 100 * x, 1));
    expect(low!.note).toBeNull();
    expect(low!.noise.rms).toBe(1);
    const noisy = mk([1, 2, 3, 4, 5, 6, 7, 8], (x) => x, 3);
    const [high] = summarizeSampling(["x"], out, noisy);
    expect(high!.note).toMatch(/more than half of the observed spread/);
    expect(high!.noise.rms).toBe(3);
    expect(high!.inputSpread).toBeCloseTo(Math.sqrt(6), 12); // not changed by the noise
  });
  it("no reported deviation means no noise figure and zero reporting runs, never a made-up one", () => {
    const [s] = summarizeSampling(["x"], out, mk([1, 2, 3, 4], (x) => x));
    expect(s!.noise).toEqual({ kind: "statistical", rms: null, reportedRuns: 0 });
  });
  it("the noise is the root mean square of the deviations that were reported, over those runs only", () => {
    const runs: SampleRun[] = [
      { caseId: "a", values: [1], outputs: { "y:last": { value: 1, std: 3 } } },
      { caseId: "b", values: [2], outputs: { "y:last": { value: 2, std: 4 } } },
      { caseId: "c", values: [3], outputs: { "y:last": { value: 3, std: null } } }
    ];
    const [s] = summarizeSampling(["x"], out, runs);
    expect(s!.noise.reportedRuns).toBe(2);
    expect(s!.noise.rms).toBeCloseTo(Math.sqrt((9 + 16) / 2), 12);
  });
  it("runs that gave no number are left out and said so; fewer than two numbers give no spread", () => {
    const runs: SampleRun[] = [
      { caseId: "a", values: [1], outputs: { "y:last": { value: 5, std: null } } },
      { caseId: "b", values: [2], outputs: { "y:last": null } },
      { caseId: "c", values: [3], outputs: { "y:last": null } }
    ];
    const [s] = summarizeSampling(["x"], out, runs);
    expect([s!.n, s!.planned]).toEqual([1, 3]);
    expect(s!.mean).toBe(5);
    expect(s!.inputSpread).toBeNull();
    expect(s!.quantiles).toBeNull();
    expect(s!.note).toMatch(/2 of 3 planned points gave no number/);
    expect(s!.note).toMatch(/fewer than two/);
    const [none] = summarizeSampling(["x"], out, runs.map((r) => ({ ...r, outputs: { "y:last": null } })));
    expect([none!.n, none!.mean, none!.min, none!.max]).toEqual([0, null, null, null]);
  });
  it("the convergence table has checkpoints at a quarter, half, three quarters and all, once there are 8 numbers", () => {
    const [s] = summarizeSampling(["x"], out, mk(Array.from({ length: 40 }, (_, i) => i), (x) => x));
    expect(s!.convergence.map((c) => c.n)).toEqual([10, 20, 30, 40]);
    expect(s!.convergence[0]!.mean).toBeCloseTo(4.5, 12);
    expect(s!.convergence[3]!.mean).toBeCloseTo(19.5, 12);
    expect(summarizeSampling(["x"], out, mk([1, 2, 3, 4, 5, 6, 7], (x) => x))[0]!.convergence).toEqual([]);
  });
  it("several outputs and parameters are kept apart", () => {
    const outs: SamplingOutput[] = [{ quantity: "a", reduce: "max" }, { quantity: "b", reduce: "last" }];
    const runs: SampleRun[] = [1, 2, 3, 4, 5].map((x) => ({ caseId: `c${x}`, values: [x, 10 - x], outputs: { "a:max": { value: 2 * x, std: null }, "b:last": { value: 100 - x, std: 0.1 } } }));
    const [a, b] = summarizeSampling(["p", "q"], outs, runs);
    expect(a!.key).toBe("a:max");
    expect(a!.correlations.map((c) => [c.parameter, Math.round(c.pearson! * 1e9) / 1e9])).toEqual([["p", 1], ["q", -1]]);
    expect(b!.correlations.map((c) => Math.round(c.spearman! * 1e9) / 1e9)).toEqual([-1, 1]);
    expect(a!.noise.reportedRuns).toBe(0);
    expect(b!.noise.reportedRuns).toBe(5);
  });
});
