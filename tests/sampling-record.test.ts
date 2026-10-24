// @covers R-STUDY-06
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHostJson } from "../src/core/hostFiles";
import { buildReport, samplingSummaryProblem } from "../src/core/report";
import { runSamplingFromHostFile } from "../src/core/samplingHost";
import { readStudyRecord, studyRecordFile } from "../src/core/studyRecord";
import { samplingStepDraft, type SamplingFacts } from "../src/core/studyRecordHost";
import { verifyStudyLog } from "../src/core/semantic";
import { budget, fixture, fixtureDirs, lines } from "./helpers/replayFixture";
import { FIXTURE_HUMAN, buildStudyLog, makeHeader, makeStep } from "./helpers/studyFixtures";

// The sampling summary as a step of the live study record, and the report builder's rule that it keeps the spread over the inputs and the sampling noise apart.
const saved = process.env.SEED_STUDY_HEADER;
beforeEach(() => { delete process.env.SEED_STUDY_HEADER; });
afterEach(() => {
  if (saved === undefined) delete process.env.SEED_STUDY_HEADER; else process.env.SEED_STUDY_HEADER = saved;
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const facts = (over: Partial<SamplingFacts> = {}): SamplingFacts => ({
  samplingId: "uq", requestId: "s1", design: { method: "lhs", n: 20, seed: 7 },
  parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 90 } }],
  planned: 20, completed: 20, runIds: Array.from({ length: 20 }, (_, i) => `r-${i + 1}`),
  outputs: [{ key: "out:last", n: 20, mean: 9.123456789, inputSpread: 2.34567891, noise: { rms: 0.25, reportedRuns: 20 }, quantiles: { p05: 5.4, p50: 9.1, p95: 12.7 } }],
  ...over
});
const draft = (f: SamplingFacts) => samplingStepDraft({ actor: FIXTURE_HUMAN, time: "2026-10-24T12:00:00.000Z", facts: f });

describe("samplingStepDraft", () => {
  it("is a compare step citing the runs read, keyed by the request, with the two figures apart", () => {
    const d = draft(facts());
    expect(d).toMatchObject({ action: "compare", key: "sampling:s1", time: "2026-10-24T12:00:00.000Z" });
    expect(d.runs).toEqual(Array.from({ length: 20 }, (_, i) => `r-${i + 1}`));
    expect(d.reason).toContain("Sampling summary uq (request s1): 20 of 20 points ran to the end; design lhs, n 20, seed 7; delayMs uniform 10 to 90.");
    expect(d.reason).toContain("Output out:last (n 20): mean 9.12346; input spread 2.34568; sampling noise 0.25 rms over 20 runs; p05, p50, p95 5.4, 9.1, 12.7.");
    expect(d.reason).toContain("is never added to or taken from the spread");
    expect(d.reason).toContain("not a scientific conclusion");
    expect(samplingSummaryProblem(d.reason)).toBeNull();
  });
  it("says plainly when the adapter reported no noise, and never invents one", () => {
    const d = draft(facts({ outputs: [{ key: "k:last", n: 5, mean: 1, inputSpread: 0.1, noise: { rms: null, reportedRuns: 0 }, quantiles: null }] }));
    expect(d.reason).toContain("sampling noise not reported by the adapter");
    expect(d.reason).not.toContain("rms");
    expect(samplingSummaryProblem(d.reason)).toBeNull();
  });
  it("an output with no numbers still gives both figures (as none)", () => {
    const d = draft(facts({ outputs: [{ key: "k:last", n: 0, mean: null, inputSpread: null, noise: { rms: null, reportedRuns: 0 }, quantiles: null }] }));
    expect(d.reason).toContain("(n 0): mean none; input spread none; sampling noise not reported by the adapter");
    expect(samplingSummaryProblem(d.reason)).toBeNull();
  });
  it("cites at most 100 runs", () => {
    const d = draft(facts({ runIds: Array.from({ length: 500 }, (_, i) => `r-${i}`), completed: 500, planned: 500 }));
    expect(d.runs).toHaveLength(100);
    expect(d.runs![0]).toBe("r-0");
  });
  it("stays under the 2000 characters a step may have: whole outputs are left out and said, never half of one", () => {
    const outputs = Array.from({ length: 8 }, (_, i) => ({ key: `${"q".repeat(120)}${i}:last`, n: 20, mean: 1.5, inputSpread: 0.5, noise: { rms: 0.1, reportedRuns: 20 }, quantiles: { p05: 1, p50: 1.5, p95: 2 } }));
    const d = draft(facts({ outputs }));
    expect(d.reason.length).toBeLessThanOrEqual(2000);
    expect(d.reason).toMatch(/\d+ more outputs are in the sampling log\./);
    expect(samplingSummaryProblem(d.reason)).toBeNull();
    const shown = d.reason.split(" Output ").length - 1;
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(8);
  });
  it("with eight parameters of long definitions it falls back to their names", () => {
    const parameters = Array.from({ length: 8 }, (_, i) => ({ id: `parameter-number-${i}`, distribution: { kind: "normal", mean: 123456.789, sd: 4567.891, min: 100000, max: 150000 } }));
    const d = draft(facts({ parameters }));
    expect(d.reason).toContain("parameter-number-0, parameter-number-1");
    expect(d.reason).not.toContain("normal mean");
    expect(d.reason.length).toBeLessThanOrEqual(2000);
  });
  it("each distribution kind reads in words", () => {
    const kinds = [
      { kind: "uniform", min: 1, max: 2 }, { kind: "triangular", min: 0, mode: 1, max: 3 },
      { kind: "normal", mean: 5, sd: 1, min: 3, max: 7 }, { kind: "lognormal", mu: 0, sigma: 0.5, min: 0.5, max: 4 }
    ].map((distribution, i) => ({ id: `p${i}`, distribution }));
    const r = draft(facts({ parameters: kinds })).reason;
    expect(r).toContain("p0 uniform 1 to 2; p1 triangular 0, mode 1, 3; p2 normal mean 5 sd 1 cut to 3 to 7; p3 lognormal mu 0 sigma 0.5 cut to 0.5 to 4");
  });
});

describe("the report builder's rule", () => {
  const withStep = (reason: string) => {
    const log = buildStudyLog([makeHeader({ studyId: "study-sampling" }), makeStep(1, { action: "compare", runs: [], reason })]);
    return buildReport({ studyLines: log, runs: {}, generatedBy: "SEED test" });
  };
  const good = draft(facts()).reason;

  it("a step that is not a sampling summary is left alone", () => {
    expect(samplingSummaryProblem("Replay of run r-1 by run r-2: reproduced.")).toBeNull();
    expect(samplingSummaryProblem("")).toBeNull();
    expect(samplingSummaryProblem("A note about Sampling summary things")).toBeNull();
  });
  it("a summary with both figures is accepted by the report", () => {
    const r = withStep(good);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.markdown).toContain("Sampling summary uq");
    expect(r.ok && r.value.markdown).toMatch(/sampling noise 0\\?\.25 rms over 20 runs/);
  });
  it("a summary that leaves out the noise is refused, naming the output", () => {
    const r = withStep("Sampling summary uq (request s1): 20 of 20 points ran to the end. Output out:last (n 20): mean 1; input spread 2.");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/steps/1/reason" });
    expect(!r.ok && r.errors[0]!.message).toContain("no sampling noise for out:last");
  });
  it("a summary that leaves out the spread is refused", () => {
    const r = withStep("Sampling summary uq (request s1): 20 of 20 points ran to the end. Output out:last (n 20): mean 1; sampling noise 0.1 rms over 5 runs.");
    expect(!r.ok && r.errors[0]!.message).toContain("no input spread for out:last");
  });
  it("one output out of several that lacks a figure refuses the whole report", () => {
    const text = good + " Output second:max (n 20): mean 1; input spread 2.";
    expect(samplingSummaryProblem(text)).toContain("second:max");
    expect(withStep(text).ok).toBe(false);
  });
  it("a summary that lists no output is refused", () => {
    expect(samplingSummaryProblem("Sampling summary uq (request s1): nothing.")).toContain("lists no output");
  });
});

describe("the step in a live study record", () => {
  async function withHeader() {
    const f = await fixture({ scenario: "response", maxCases: 20, samplings: { uq: { base: "approved", design: { method: "lhs", n: 6, seed: 3 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" }] } } });
    const projectId = JSON.parse(readFileSync(join(f.project, "seed.project.json"), "utf8")).projectId;
    writeHostJson(join(f.root, "study-header.json"), makeHeader({ studyId: "study", projectId, parameters: f.config.study.parameters, budget: f.config.study.budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN }));
    process.env.SEED_STUDY_HEADER = join(f.root, "study-header.json");
    const record = studyRecordFile(f.project, "studies", "study");
    const rows = () => { const r = readStudyRecord(record); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.rows; };
    return { ...f, record, rows };
  }
  const req = (over: Record<string, unknown> = {}) => ({ requestId: "s1", samplingId: "uq", budget, ...over });

  it("one summary step after the points' own steps, citing the runs that were read, with both figures; the chain verifies", async () => {
    const f = await withHeader();
    const r = await runSamplingFromHostFile(f.file, req());
    expect(r.ok && r.studyRecord).toEqual({ appended: 1 });
    if (!r.ok) return;
    const rows = f.rows();
    const last = rows.at(-1)!;
    expect(last.action).toBe("compare");
    expect(last.runs).toEqual(r.results.map((x) => x.runId));
    expect(last.reason).toMatch(/^Sampling summary uq \(request s1\): 6 of 6 points ran to the end; design lhs, n 6, seed 3; delayMs uniform 10 to 60\./);
    expect(samplingSummaryProblem(last.reason as string)).toBeNull();
    expect(rows.filter((x) => x.action === "run")).toHaveLength(6);
    expect(rows.filter((x) => x.action === "compare")).toHaveLength(1);
    expect(verifyStudyLog(readFileSync(f.record, "utf8").trim().split("\n"))).toEqual([]);
  }, 180000);

  it("the same request again adds no second step", async () => {
    const f = await withHeader();
    await runSamplingFromHostFile(f.file, req());
    const before = f.rows().length;
    const again = await runSamplingFromHostFile(f.file, req());
    expect(again.ok && again.studyRecord).toEqual({ appended: 0 });
    expect(f.rows().length).toBe(before);
  }, 240000);

  it("a host with no human header has no study record: nothing is written, and that is not a failure", async () => {
    const f = await fixture({ scenario: "response", maxCases: 20, samplings: { uq: { base: "approved", design: { method: "lhs", n: 4, seed: 3 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" }] } } });
    const r = await runSamplingFromHostFile(f.file, req());
    expect(r.ok && r.studyRecord).toEqual({ appended: 0 });
  }, 120000);

  it("a header that does not match the host: the sampling still answers, the failure is returned and goes to the diagnostics", async () => {
    const f = await withHeader();
    writeHostJson(join(f.root, "study-header.json"), makeHeader({ studyId: "another-study", projectId: "p-x", parameters: [], budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN }));
    const r = await runSamplingFromHostFile(f.file, req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.outputs[0]!.n).toBe(6);
    expect(r.studyRecord).toMatchObject({ failed: expect.stringMatching(/differs from the host project or study policy/) });
    const diagnostics = lines(join(f.state, "engines", readdirOne(join(f.state, "engines")), "diagnostics.jsonl"));
    expect(diagnostics.some((x) => x.stage === "study-record" && /sampling step/.test(x.message))).toBe(true);
  }, 180000);
});

import { readdirSync } from "node:fs";
function readdirOne(dir: string): string {
  const names = readdirSync(dir);
  expect(names).toHaveLength(1);
  return names[0]!;
}
