// @covers R-STUDY-06, R-STUDY-08
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudy } from "../src/core/policy";
import type { RegisteredCase } from "../src/core/runDispatcher";
import { pointsFromUnit } from "../src/core/sampler";
import { expandSampling, outputKey, sensitivityOf, summaryRunsOf, unitPoints, designRuns, type SampleRun, type SamplingDefinition } from "../src/core/sampling";
import { runSamplingFromHostFile } from "../src/core/samplingHost";
import { samplingSummaryProblem } from "../src/core/report";
import { samplingStepDraft, type SamplingFacts } from "../src/core/studyRecordHost";
import { budget, fixture, fixtureDirs } from "./helpers/replayFixture";
import { FIXTURE_HUMAN } from "./helpers/studyFixtures";

// The sensitivity designs inside a sampling (docs/sampling.md, docs/sensitivity.md): the runs a design makes, the indices computed from them, and the
// step they leave in the study record. The analytic oracles are the linear model's (S_i = ST_i = a_i^2 / sum a_k^2; Morris mu* = |a_i| times the window).
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const wall = { maxWallSeconds: 600, maxCores: 4, maxMemoryMB: 4096, maxDiskMB: 1000 };
const study = (maxCases = 100): PolicyStudy => ({ studyId: "s", tier: "A1", budget: { ...wall, maxCases }, parameters: [{ id: "a", min: 0, max: 10 }, { id: "b", min: 0, max: 10 }, { id: "c", min: 0, max: 10 }] });
const base: RegisteredCase = { artifact: { path: "m.json", revision: { hash: "a".repeat(64), counter: 1 } }, inputs: [{ path: "m.json", sha256: "a".repeat(64) }], params: [], settings: {}, seed: 7 };
const uni = (id: string) => ({ id, distribution: { kind: "uniform" as const, min: 0, max: 10 } });
const def = (method: "sobol" | "morris" | "lhs", n: number, d = 3, seed = 5): SamplingDefinition => ({
  base: "base", design: { method, n, seed }, parameters: ["a", "b", "c"].slice(0, d).map(uni), outputs: [{ quantity: "y", reduce: "last" }]
});
const expand = (x: SamplingDefinition, maxCases = 100) => expandSampling("uq", x, { base }, study(maxCases));

/** The runs of a definition against a model, computed here from the design without the host. */
function runsOf(x: SamplingDefinition, model: (v: number[]) => number): SampleRun[] {
  const rows = pointsFromUnit(unitPoints(x.design, x.parameters.length).rows, x.parameters.map((p) => p.distribution));
  return rows.map((v, i) => ({ caseId: `uq-${i + 1}`, values: v, outputs: { [outputKey(x.outputs[0]!)]: { value: model(v), std: null } } }));
}

describe("the runs of a design", () => {
  it("sobol makes n*(d+2) points in the order A, B, AB1..ABd; morris makes r*(d+1)", () => {
    expect(designRuns({ method: "sobol", n: 8, seed: 1 }, 3)).toBe(40);
    expect(designRuns({ method: "morris", n: 5, seed: 1 }, 3)).toBe(20);
    expect(designRuns({ method: "lhs", n: 12, seed: 1 }, 3)).toBe(12);
    const r = expand(def("sobol", 8));
    expect(r.ok && r.cases.length).toBe(40);
    const m = expand(def("morris", 5));
    expect(m.ok && m.cases.length).toBe(20);
    if (!r.ok) return;
    // AB1 differs from A in the first parameter only
    const a = r.cases.slice(0, 8).map((c) => c.values), ab1 = r.cases.slice(16, 24).map((c) => c.values);
    for (let j = 0; j < 8; j++) { expect(ab1[j]![1]).toEqual(a[j]![1]); expect(ab1[j]![2]).toEqual(a[j]![2]); }
    expect(ab1.some((v, j) => v[0]!.value !== a[j]![0]!.value)).toBe(true);
  });
  it("is the same for the same seed and differs for another", () => {
    const x = expand(def("sobol", 8, 3, 5)), y = expand(def("sobol", 8, 3, 5)), z = expand(def("sobol", 8, 3, 6));
    expect(x.ok && y.ok && z.ok).toBe(true);
    if (!(x.ok && y.ok && z.ok)) return;
    expect(x.cases.map((c) => c.values)).toEqual(y.cases.map((c) => c.values));
    expect(x.cases.map((c) => c.values)).not.toEqual(z.cases.map((c) => c.values));
  });
  it("every value stays inside its window, a Morris point at the edge of the grid included", () => {
    const m = expand(def("morris", 20));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    for (const c of m.cases) for (const v of c.values) { expect(v.value).toBeGreaterThanOrEqual(0); expect(v.value).toBeLessThanOrEqual(10); }
  });
  it("the whole design counts against the study's case limit, not n alone", () => {
    const r = expand(def("sobol", 8), 39);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]!.code).toBe("E_BUDGET_EXCEEDED");
    expect(!r.ok && r.errors[0]!.message).toMatch(/40 points/);
    expect(expand(def("sobol", 8), 40).ok).toBe(true);
  });
});

describe("the indices of a linear model (S_i = ST_i = a_i^2 / sum a^2)", () => {
  const a = [1, 2, 3];
  const model = (v: number[]) => a.reduce((s, c, i) => s + c * (v[i] as number), 0);
  it("sobol finds them within the sampling error, with bootstrap intervals that hold the estimate", () => {
    const x = def("sobol", 2048);
    const out = sensitivityOf(x, runsOf(x, model))!["y:last"]!;
    expect(out.method).toBe("sobol");
    if (!("parameters" in out) || out.method !== "sobol") throw new Error("expected indices");
    const total = a.reduce((s, c) => s + c * c, 0);
    out.parameters.forEach((p, i) => {
      const want = (a[i]! ** 2) / total;
      expect(p.id).toBe(["a", "b", "c"][i]);
      expect(Math.abs(p.first - want)).toBeLessThan(0.06);
      expect(Math.abs(p.total - want)).toBeLessThan(0.06);
      expect(p.firstInterval![0]).toBeLessThanOrEqual(p.first);
      expect(p.firstInterval![1]).toBeGreaterThanOrEqual(p.first);
    });
  });
  it("morris gives mu* = |a_i| times the window (10), sigma 0", () => {
    const x = def("morris", 10);
    const out = sensitivityOf(x, runsOf(x, model))!["y:last"]!;
    if (!("parameters" in out) || out.method !== "morris") throw new Error("expected effects");
    out.parameters.forEach((p, i) => { expect(p.muStar).toBeCloseTo(a[i]! * 10, 6); expect(p.sigma).toBeCloseTo(0, 6); });
  });
  it("lhs and random designs have no sensitivity", () => {
    const x = def("lhs", 12);
    expect(sensitivityOf(x, runsOf(x, model))).toBeUndefined();
  });
  it("an output with a missing run has no indices, and says how many runs are missing", () => {
    const x = def("sobol", 8);
    const runs = runsOf(x, model);
    runs[3]!.outputs["y:last"] = null;
    runs[9]!.outputs["y:last"] = null;
    const out = sensitivityOf(x, runs)!["y:last"]!;
    expect("unavailable" in out && out.unavailable).toMatch(/2 of the 40 runs gave no number/);
  });
  it("a constant output has no indices: the estimator's refusal is said, never NaN", () => {
    const x = def("sobol", 8);
    const out = sensitivityOf(x, runsOf(x, () => 3))!["y:last"]!;
    expect("unavailable" in out && out.unavailable).toMatch(/variance/);
  });
  it("the plain summary of a sobol design stands on the A and B runs only (2n), a morris design on all", () => {
    const s = def("sobol", 8), m = def("morris", 5);
    expect(summaryRunsOf(s.design, runsOf(s, model))).toHaveLength(16);
    expect(summaryRunsOf(m.design, runsOf(m, model))).toHaveLength(20);
  });
});

describe("the step in the study record", () => {
  const facts = (sensitivity: unknown): SamplingFacts => ({
    samplingId: "uq", requestId: "s1", design: { method: "sobol", n: 8, seed: 5 }, parameters: [{ id: "a", distribution: { kind: "uniform", min: 0, max: 10 } }],
    planned: 24, completed: 24, runIds: ["r1"],
    outputs: [{ key: "y:last", n: 16, mean: 1, inputSpread: 0.5, noise: { rms: null, reportedRuns: 0 }, quantiles: null, sensitivity: sensitivity as never }]
  });
  const draft = (f: SamplingFacts) => samplingStepDraft({ actor: FIXTURE_HUMAN, time: "2026-10-24T12:00:00.000Z", facts: f });
  it("says the Sobol indices with their intervals, and still passes the report rule (spread and noise apart)", () => {
    const d = draft(facts({ method: "sobol", n: 8, d: 1, parameters: [{ id: "a", first: 0.91, total: 0.95, firstInterval: [0.8, 1], totalInterval: [0.9, 1] }], bootstrap: { resamples: 200, level: 0.95, skipped: 0 } }));
    expect(d.reason).toMatch(/Sobol first-order: a 0\.91 \[0\.8, 1\]/);
    expect(d.reason).toMatch(/Sobol total-order: a 0\.95 \[0\.9, 1\] \(bootstrap 95% intervals over 200 resamples\)/);
    expect(d.reason).toMatch(/Estimates, not exact shares/);
    expect(samplingSummaryProblem(d.reason)).toBeNull();
  });
  it("says Morris effects as a ranking, and an unavailable output as unavailable with the reason", () => {
    expect(draft(facts({ method: "morris", r: 5, d: 1, parameters: [{ id: "a", mu: 1, muStar: 2, sigma: 0.1 }] })).reason).toMatch(/Morris effects over 5 trajectories: a mu\* 2 \(mu 1, sigma 0\.1\)\. A ranking of the inputs, not a share/);
    const u = draft(facts({ method: "sobol", unavailable: "2 of the 24 runs gave no number" })).reason;
    expect(u).toMatch(/Sobol indices are not available: 2 of the 24 runs gave no number/);
    expect(samplingSummaryProblem(u)).toBeNull();
  });
});

describe("through the host, against the fake adapter whose output is 5 + 0.1 * delayMs", () => {
  const sampling = (method: "sobol" | "morris", n: number) => ({ uq: { base: "approved", design: { method, n, seed: 3 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform" as const, min: 100, max: 300 } }], outputs: [{ quantity: "out", reduce: "last" as const }] } });
  it("a sobol design: the host gives exactly the indices the estimator gives for the same design and the known response", async () => {
    const f = await fixture({ scenario: "response", maxCases: 40, samplings: sampling("sobol", 8) });
    const r = await runSamplingFromHostFile(f.file, { requestId: "s1", samplingId: "uq", budget });
    expect(r.ok && r.complete).toBe(true);
    if (!r.ok) return;
    expect(r.results).toHaveLength(24);
    const s = r.summary.sensitivity!["out:last"]!;
    if (!("parameters" in s) || s.method !== "sobol") throw new Error("expected indices: " + JSON.stringify(s));
    // eight base rows are few: the indices are noisy estimates around 1, so they are compared with the pure computation, not with 1
    const x: SamplingDefinition = { base: "approved", design: { method: "sobol", n: 8, seed: 3 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 100, max: 300 } }], outputs: [{ quantity: "out", reduce: "last" }] };
    const want = sensitivityOf(x, runsOf(x, (v) => 5 + 0.1 * (v[0] as number)))!["out:last"]!;
    if (!("parameters" in want) || want.method !== "sobol") throw new Error("expected indices");
    expect(s.parameters[0]!.first).toBeCloseTo(want.parameters[0]!.first, 9);
    expect(s.parameters[0]!.total).toBeCloseTo(want.parameters[0]!.total, 9);
    expect(s.parameters[0]!.firstInterval).toBeDefined();
    expect(r.summary.outputs[0]!.n).toBe(16);
  }, 240000);
  it("a morris design of one parameter: mu* is the slope (0.1) times the window (200) = 20", async () => {
    const f = await fixture({ scenario: "response", maxCases: 40, samplings: sampling("morris", 4) });
    const r = await runSamplingFromHostFile(f.file, { requestId: "s1", samplingId: "uq", budget });
    expect(r.ok && r.complete).toBe(true);
    if (!r.ok) return;
    const s = r.summary.sensitivity!["out:last"]!;
    if (!("parameters" in s) || s.method !== "morris") throw new Error("expected effects: " + JSON.stringify(s));
    expect(s.parameters[0]!.muStar).toBeCloseTo(20, 6);
    expect(r.summary.outputs[0]!.note).toMatch(/walk on a grid/);
  }, 240000);
});
