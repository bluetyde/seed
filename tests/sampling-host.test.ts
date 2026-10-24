// @covers R-STUDY-06
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCases, validateHostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { runSamplingFromHostFile } from "../src/core/samplingHost";
import { readStudyRecord, studyRecordFile } from "../src/core/studyRecord";
import { budget, fixture, fixtureDirs, lines } from "./helpers/replayFixture";
import { FIXTURE_HUMAN, makeHeader } from "./helpers/studyFixtures";

// A sampling through the real host, with the fake adapter whose last value is 5 + 0.1 * delayMs (so the answer is known): the cases run through the
// guarded path, and the summary is built from the saved files (docs/sampling.md).
const saved = process.env.SEED_STUDY_HEADER;
beforeEach(() => { delete process.env.SEED_STUDY_HEADER; });
afterEach(() => {
  if (saved === undefined) delete process.env.SEED_STUDY_HEADER; else process.env.SEED_STUDY_HEADER = saved;
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Def = NonNullable<Parameters<typeof fixture>[0]["samplings"]>[string];
const def = (over: Partial<Def> = {}): Def => ({
  base: "approved",
  design: { method: "lhs", n: 8, seed: 20261024 },
  parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 90 } }],
  outputs: [{ quantity: "out", reduce: "last" }],
  ...over
});
const host = (over: { scenario?: string; maxCases?: number; sampling?: Def } = {}) =>
  fixture({ scenario: over.scenario ?? "response", maxCases: over.maxCases ?? 20, samplings: { uq: over.sampling ?? def() } });
const request = (over: Record<string, unknown> = {}) => ({ requestId: "s1", samplingId: "uq", budget, ...over });
const run = (f: { file: string }, over: Record<string, unknown> = {}) => runSamplingFromHostFile(f.file, request(over));
const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
const sd = (x: number[]) => Math.sqrt(x.reduce((s, v) => s + (v - mean(x)) ** 2, 0) / (x.length - 1));

describe("a sampling with a known linear response", () => {
  it("runs every point, and the summary is the known answer: mean, spread, quantiles, a correlation of 1", async () => {
    const f = await host();
    const r = await run(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.complete).toBe(true);
    expect(r.results).toHaveLength(8);
    expect(r.results.every((x) => x.state === "completed" && typeof x.runId === "string")).toBe(true);
    expect(r.results.map((x) => x.caseId)).toEqual(Array.from({ length: 8 }, (_, i) => `uq-00${i + 1}`));
    const delays = r.results.map((x) => x.values[0]!.value);
    for (const d of delays) { expect(d).toBeGreaterThanOrEqual(10); expect(d).toBeLessThanOrEqual(90); }
    const expected = delays.map((d) => 5 + 0.1 * d);
    expect(r.summary.planned).toBe(8);
    expect(r.summary.completed).toBe(8);
    expect(r.summary.unread).toEqual([]);
    const o = r.summary.outputs[0]!;
    expect(o.key).toBe("out:last");
    expect(o.n).toBe(8);
    expect(o.mean).toBeCloseTo(mean(expected), 9);
    expect(o.inputSpread).toBeCloseTo(sd(expected), 9);
    expect(o.min).toBeCloseTo(Math.min(...expected), 9);
    expect(o.max).toBeCloseTo(Math.max(...expected), 9);
    expect(o.correlations[0]!.pearson).toBeCloseTo(1, 9);
    expect(o.correlations[0]!.spearman).toBeCloseTo(1, 9);
    expect(o.noise).toEqual({ kind: "statistical", rms: null, reportedRuns: 0 });
    expect(r.summary.caveats).toContain("never added");
    expect(r.design).toEqual({ method: "lhs", n: 8, seed: 20261024 });
    expect(r.parameters).toEqual([{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 90 } }]);
  }, 120000);

  it("a Latin hypercube puts one point in each of the 8 strata of the declared window", async () => {
    const f = await host();
    const r = await run(f);
    if (!r.ok) throw new Error("setup");
    const strata = r.results.map((x) => Math.min(7, Math.floor(((x.values[0]!.value - 10) / 80) * 8))).sort((a, b) => a - b);
    expect(strata).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }, 120000);

  it("the noise the adapter reports is its own line: the spread of the outputs is not changed by it and the noise is not added to it", async () => {
    const f = await host({ scenario: "response-noise" });
    const r = await run(f);
    if (!r.ok) throw new Error("setup");
    const o = r.summary.outputs[0]!;
    expect(o.noise).toEqual({ kind: "statistical", rms: 0.25, reportedRuns: 8 });
    const expected = r.results.map((x) => 5 + 0.1 * x.values[0]!.value);
    expect(o.inputSpread).toBeCloseTo(sd(expected), 9);
    expect(o.mean).toBeCloseTo(mean(expected), 9);
  }, 120000);

  it("several outputs of one run are summarised apart: a mean over time and the last value", async () => {
    const f = await host({ sampling: def({ outputs: [{ quantity: "out", reduce: "last" }, { quantity: "out", reduce: "mean" }, { quantity: "out", reduce: "first" }] }) });
    const r = await run(f);
    if (!r.ok) throw new Error("setup");
    expect(r.summary.outputs.map((o) => o.key)).toEqual(["out:last", "out:mean", "out:first"]);
    const delays = r.results.map((x) => x.values[0]!.value);
    expect(r.summary.outputs[1]!.mean).toBeCloseTo(mean(delays.map((d) => (1 + 2 + 5 + 0.1 * d) / 3)), 9);
    expect(r.summary.outputs[2]!.inputSpread).toBe(0); // the first value does not depend on the input
  }, 120000);
});

describe("records and repeatability", () => {
  it("the sampling log says what was admitted (design, parameters, outputs), what finished and the summary; the sweep log is not touched", async () => {
    const f = await host();
    const r = await run(f);
    if (!r.ok) throw new Error("setup");
    const log = lines(join(f.state, "samplings.jsonl")).map((x) => x.event);
    expect(log.map((e) => e.phase)).toEqual(["admitted", "finished", "summary"]);
    expect(log[0]).toMatchObject({ samplingId: "uq", requestId: "s1", cases: 8, design: { method: "lhs", n: 8, seed: 20261024 }, parameters: ["delayMs"], outputs: ["out:last"], via: "tier" });
    expect(log[1]).toMatchObject({ complete: true });
    expect(log[2]).toMatchObject({ planned: 8, completed: 8 });
    expect(existsSync(join(f.state, "sweeps.jsonl"))).toBe(false);
  }, 120000);

  it("asking again with the same request id replays the finished cases and gives the same summary; a new request id runs the same points again", async () => {
    const f = await host();
    const a = await run(f);
    const b = await run(f);
    const c = await run(f, { requestId: "s2" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup");
    expect(b.summary.outputs).toEqual(a.summary.outputs);
    expect(b.results.map((x) => x.runId)).toEqual(a.results.map((x) => x.runId));
    expect(c.results.map((x) => x.values)).toEqual(a.results.map((x) => x.values));
    expect(c.summary.outputs[0]!.mean).toBe(a.summary.outputs[0]!.mean);
  }, 240000);

  it("another seed gives other points and another mean", async () => {
    const f1 = await host();
    const f2 = await host({ sampling: def({ design: { method: "lhs", n: 8, seed: 99 } }) });
    const a = await run(f1), b = await run(f2);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(b.results.map((x) => x.values)).not.toEqual(a.results.map((x) => x.values));
    expect(b.summary.outputs[0]!.mean).not.toBe(a.summary.outputs[0]!.mean);
  }, 240000);

  it("a sampling step in the live study record says which sample point it is", async () => {
    const f = await host();
    const projectId = JSON.parse(readFileSync(join(f.project, "seed.project.json"), "utf8")).projectId;
    writeHostJson(join(f.root, "study-header.json"), makeHeader({ studyId: "study", projectId, parameters: f.config.study.parameters, budget: f.config.study.budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN }));
    process.env.SEED_STUDY_HEADER = join(f.root, "study-header.json");
    const r = await run(f);
    if (!r.ok) throw new Error("setup");
    const rec = readStudyRecord(studyRecordFile(f.project, "studies", "study"));
    if (!rec.ok) throw new Error("no record");
    const texts = rec.rows.filter((x) => x.action === "run").map((x) => x.reason as string);
    expect(texts).toHaveLength(8);
    texts.forEach((t, i) => expect(t).toMatch(new RegExp(`Sampling uq, point ${i + 1} of 8 \\(delayMs=[0-9.]+\\)`)));
    expect(texts.join(" ")).not.toContain("Sweep");
  }, 240000);
});

describe("what is refused", () => {
  it("a sampling that is not registered, and a request with a field it may not have", async () => {
    const f = await host();
    const none = await run(f, { samplingId: "other" });
    expect(none).toMatchObject({ ok: false, errors: [{ code: "E_NOT_PERMITTED", field: "/samplingId" }] });
    expect(lines(join(f.state, "samplings.jsonl")).at(-1)!.event).toMatchObject({ phase: "refused", reason: "sampling is not registered" });
    for (const extra of [{ seed: 5 }, { values: [1] }, { distribution: {} }, { sweepId: "t" }]) {
      const r = await run(f, extra);
      expect(r).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
    }
  });
  it("a sweep id is not a sampling id and the other way round", async () => {
    const f = await host();
    expect((await run(f, { samplingId: "t" })).ok).toBe(false);
    const { runSweepFromHostFile } = await import("../src/core/sweepHost");
    expect((await runSweepFromHostFile(f.file, { requestId: "x", sweepId: "uq", budget })).ok).toBe(false);
  });
  it("more points than the study's maxCases is refused as a configuration, so no host can be saved with it", async () => {
    await expect(host({ maxCases: 5 })).rejects.toThrow(/invalid sampling uq: .*over the study limit of 5/);
  });
  it("the gate: a study at tier A0 may not sample, and nothing runs", async () => {
    const f = await fixture({ scenario: "response", tier: "A0", maxCases: 20, samplings: { uq: def() } });
    const r = await runSamplingFromHostFile(f.file, request());
    expect(r.ok).toBe(false);
    expect(lines(join(f.state, "samplings.jsonl")).at(-1)!.event).toMatchObject({ phase: "refused" });
    expect(existsSync(join(f.project, "runs", "requests.json"))).toBe(false);
  });
  it("a window outside the study bounds can not be saved in a host configuration", async () => {
    await expect(host({ sampling: def({ parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 5000 } }] }) })).rejects.toThrow(/leaves the study bounds 0 to 1000/);
  });
  it("a sampling that would reuse a registered case id, or a sweep's, can not be saved", async () => {
    await expect(fixture({ scenario: "response", maxCases: 20, samplings: { t: def() } })).rejects.toThrow(/would reuse the case id t-001/);
  });
});

describe("the host configuration with samplings", () => {
  it("all points are cases a client may name, with the sampled value in params and settings; the base case is untouched", async () => {
    const f = await host();
    const c = validateHostConfiguration(JSON.parse(readFileSync(f.file, "utf8")));
    const all = allCases(c);
    expect(Object.keys(all).filter((k) => k.startsWith("uq-"))).toHaveLength(8);
    expect(all["uq-001"]!.params).toEqual([{ id: "delayMs", value: expect.any(Number) }]);
    expect(all["uq-001"]!.params[0]!.value).not.toBe(10);
    expect(c.cases.approved!.params).toEqual([{ id: "delayMs", value: 10 }]);
  });
  it("an unknown key in a sampling is refused by the schema", async () => {
    await expect(host({ sampling: { ...def(), antithetic: true } as never })).rejects.toThrow(/invalid seed.host/);
  });
});
