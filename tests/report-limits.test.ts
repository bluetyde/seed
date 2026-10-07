import { describe, expect, it } from "vitest";
import { buildReport, type ReportInput } from "../src/core/report";
import { buildStudyLog, makeConclusion, makeHeader, makeQuantity, makeResultsIndex, makeRunRecord, makeSeries, makeStep, SAMPLE_SHA256, SAMPLE_SHA256_2 } from "./helpers/studyFixtures";

// E2 limits L8 and L9 of the exit review: the report builder refuses runs the study record does not cite, a study record cut short or
// stripped of its hash chain (when the caller names the head it verified), and plotted points that are not tied to the data hash.
const human = { kind: "human" as const, name: "h" };
const lines = buildStudyLog([
  makeHeader({ studyId: "study-limits" }),
  makeStep(1, { actor: human, action: "run", runs: ["run-1"] }),
  makeStep(2, { actor: human, action: "note", runs: ["run-1"] }),
]);
const results = (runId: string) => makeResultsIndex(runId, [makeQuantity("power", "verified", { provenance: { runId, inputRevisions: [SAMPLE_SHA256] } })]);
const run = (runId: string) => ({ record: makeRunRecord(runId, "completed"), results: results(runId) });
const base = (extra: Partial<ReportInput> = {}): ReportInput => ({ studyLines: lines, runs: { "run-1": run("run-1") }, generatedBy: "SEED test", ...extra });
const head = JSON.parse(lines.at(-1)!) as { seq: number; hash: string };
const errorOf = (r: ReturnType<typeof buildReport>) => (r.ok ? null : r.errors[0]);

describe("L9: a run the study record does not cite is refused, not appended", () => {
  it("the cited run alone builds", () => {
    expect(buildReport(base()).ok).toBe(true);
  });

  it("an extra run that no step or claim cites is a typed refusal naming it", () => {
    const e = errorOf(buildReport(base({ runs: { "run-1": run("run-1"), "run-9": run("run-9") } })));
    expect(e).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/runs/run-9" });
    expect(e?.message).toContain("not cited");
  });

  it("a run cited only by a conclusion claim is accepted and shown", () => {
    const withClaim = buildStudyLog([
      makeHeader({ studyId: "study-claim" }),
      makeStep(1, { actor: human, action: "run", runs: ["run-1"] }),
      makeConclusion(2, { claims: [{ text: "c", runs: ["run-2"], oracles: ["orc-1"] }] }),
    ]);
    const r = buildReport({ studyLines: withClaim, runs: { "run-1": run("run-1"), "run-2": run("run-2") }, generatedBy: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.html).toContain('id="run-run-2"');
  });
});

describe("L8: the study record may not be cut short or stripped when the caller names the head it verified", () => {
  it("without an anchor the library still accepts a self-consistent prefix (the old behaviour, now opt-in to refuse)", () => {
    expect(buildReport(base({ studyLines: lines.slice(0, 2) })).ok).toBe(true);
  });

  it("the right head, last or not, builds", () => {
    expect(buildReport(base({ studyAnchor: { seq: head.seq, hash: head.hash } })).ok).toBe(true);
    expect(buildReport(base({ studyAnchor: { seq: head.seq, hash: head.hash, last: true } })).ok).toBe(true);
  });

  it("a record cut short of the head is refused", () => {
    const e = errorOf(buildReport(base({ studyLines: lines.slice(0, 2), studyAnchor: { seq: head.seq, hash: head.hash } })));
    expect(e).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/studyLines" });
    expect(e?.message).toContain("shorter than its verified head");
  });

  it("a record with a different hash at the head is refused", () => {
    const e = errorOf(buildReport(base({ studyAnchor: { seq: head.seq, hash: "0".repeat(64) } })));
    expect(e?.message).toContain("does not end in its verified head");
  });

  it("a record with lines after the head is refused when the head must be last", () => {
    const e = errorOf(buildReport(base({ studyAnchor: { seq: head.seq - 1, hash: (JSON.parse(lines[1]!) as { hash: string }).hash, last: true } })));
    expect(e?.message).toContain("lines after its verified head");
  });

  it("a record whose hashes were all stripped (self-consistent, but unchained) is refused", () => {
    const stripped = lines.map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      delete o.hash;
      delete o.prev;
      return JSON.stringify(o);
    });
    expect(buildReport(base({ studyLines: stripped })).ok).toBe(true); // an unchained record is a valid record on its own
    const e = errorOf(buildReport(base({ studyLines: stripped, studyAnchor: { seq: head.seq, hash: head.hash } })));
    expect(e?.message).toContain("no complete hash chain");
  });
});

describe("L8: plotted points must be tied to the data hash of the results index", () => {
  const withSeries = (dataSha256?: string, extra: Partial<ReportInput> = {}) =>
    base({ runs: { "run-1": { ...run("run-1"), series: { power: { ...makeSeries(3), ...(dataSha256 ? { dataSha256 } : {}) } } } }, ...extra });

  it("a series that names the index's data hash builds", () => {
    expect(buildReport(withSeries(SAMPLE_SHA256, { requireBoundSeries: true })).ok).toBe(true);
  });

  it("a series that names another hash is refused, with or without the requirement", () => {
    for (const extra of [{}, { requireBoundSeries: true }]) {
      const e = errorOf(buildReport(withSeries(SAMPLE_SHA256_2, extra)));
      expect(e).toMatchObject({ code: "E_OUTPUT_INCOMPLETE", field: "/runs/run-1/series/power/dataSha256" });
    }
  });

  it("a series with no hash builds unless binding is required", () => {
    expect(buildReport(withSeries()).ok).toBe(true);
    expect(errorOf(buildReport(withSeries(undefined, { requireBoundSeries: true })))).toMatchObject({ code: "E_OUTPUT_INCOMPLETE" });
  });
});
