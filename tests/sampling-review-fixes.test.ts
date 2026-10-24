// @covers R-STUDY-06
import { describe, expect, it } from "vitest";
import { distributionProblem, samplePoints } from "../src/core/sampler";
import { reduceQuantity, summarizeSampling, type SampleRun } from "../src/core/sampling";
import { factsOf, type SamplingSummary } from "../src/core/samplingHost";
import { samplingStepDraft, type SamplingFacts } from "../src/core/studyRecordHost";
import type { QuantityData } from "../src/core/quantityData";
import { FIXTURE_HUMAN } from "./helpers/studyFixtures";

// Findings of the Codex review of the sampling study (2026-10-24), each with the case that showed it.
const series = (values: number[], std?: number[]): QuantityData => ({ kind: "series", quantity: "p", unit: "W", axis: { name: "t", unit: "s" }, x: values.map((_, i) => i), values, ...(std ? { std } : {}) });

describe("reducing a long series", () => {
  it("min and max of a series of 400000 numbers do not fail on the engine's limit for arguments", () => {
    const v = Array.from({ length: 400_000 }, (_, i) => Math.sin(i));
    v[123_456] = -5; v[300_000] = 9;
    expect(reduceQuantity(series(v), "min")).toMatchObject({ ok: true, value: -5 });
    expect(reduceQuantity(series(v), "max")).toMatchObject({ ok: true, value: 9 });
  });
  it("the first of several equal minima is the one taken (its noise goes with it)", () => {
    expect(reduceQuantity(series([3, 1, 1, 2], [0.1, 0.2, 0.3, 0.4]), "min")).toMatchObject({ value: 1, std: 0.2 });
  });
  it("a mean that overflows is refused with its reason, never a number", () => {
    expect(reduceQuantity(series([1.7e308, 1.7e308]), "mean")).toMatchObject({ ok: false });
  });
});

describe("finite numbers that overflow when they are combined", () => {
  const runs = (vals: number[], std: (number | null)[] = []): SampleRun[] => vals.map((v, i) => ({ caseId: `c${i}`, values: [i], outputs: { "out:last": { value: v, std: std[i] ?? null } } }));
  const out = [{ quantity: "out", reduce: "last" as const }];
  it("a spread that is infinite is an error, not a missing spread", () => {
    expect(() => summarizeSampling(["x"], out, runs([-1e155, 1e155, 0]))).toThrow(/too large to take a spread/);
  });
  it("a sum that overflows is an error", () => {
    expect(() => summarizeSampling(["x"], out, runs([1.7e308, 1.7e308]))).toThrow(/too large to average/);
  });
  it("noise that overflows when squared is an error", () => {
    expect(() => summarizeSampling(["x"], out, runs([1, 2, 3], [1e200, 1e200, 1e200]))).toThrow(/too large to combine/);
  });
  it("ordinary numbers still give a summary", () => {
    const s = summarizeSampling(["x"], out, runs([1, 2, 3, 4]));
    expect(s[0]).toMatchObject({ n: 4, mean: 2.5 });
  });
});

describe("the windows the sampler accepts", () => {
  it("a window whose width overflows is refused", () => {
    expect(distributionProblem({ kind: "uniform", min: -1e308, max: 1e308 })).toMatch(/not a finite number/);
    expect(distributionProblem({ kind: "uniform", min: 0, max: 1 })).toBeNull();
  });
  it("a window narrower than the twelve digits that are written still holds every point", () => {
    const d = { kind: "uniform" as const, min: 1.0000000000001, max: 1.0000000000002 };
    expect(distributionProblem(d)).toBeNull();
    const pts = samplePoints({ method: "lhs", n: 50, seed: 3 }, [d]);
    for (const [v] of pts) { expect(v).toBeGreaterThanOrEqual(d.min); expect(v).toBeLessThanOrEqual(d.max); }
  });
});

describe("the study step", () => {
  const facts = (over: Partial<SamplingFacts> = {}): SamplingFacts => ({
    samplingId: "uq", requestId: "s1", design: { method: "lhs", n: 4, seed: 1 }, parameters: [{ id: "x", distribution: { kind: "uniform", min: 0, max: 1 } }],
    planned: 4, completed: 4, runIds: ["r1", "r2", "r3", "r4"],
    outputs: [{ key: "out:last", n: 4, mean: 1, inputSpread: 0.5, noise: { rms: 0.1, reportedRuns: 4 }, quantiles: null }], ...over
  });
  it("two samplings that share a request id are two steps", () => {
    const a = samplingStepDraft({ actor: FIXTURE_HUMAN, time: "2026-10-24T12:00:00.000Z", facts: facts() });
    const b = samplingStepDraft({ actor: FIXTURE_HUMAN, time: "2026-10-24T12:00:00.000Z", facts: facts({ samplingId: "other" }) });
    expect(a.key).not.toBe(b.key);
  });
  it("cites only the runs that gave a number", () => {
    const results = ["1", "2", "3", "4"].map((n) => ({ caseId: `uq-${n}`, requestId: `s1.uq-${n}`, values: [], state: "completed", runId: `r${n}` }));
    const summary: SamplingSummary = { planned: 4, completed: 4, outputs: [], unread: [], used: ["uq-1", "uq-3"], caveats: "" };
    const f = factsOf("uq", "s1", { base: "approved", design: { method: "lhs", n: 4, seed: 1 }, parameters: [], outputs: [] }, summary, results as never);
    expect(f.runIds).toEqual(["r1", "r3"]);
  });
});
