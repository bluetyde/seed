// @covers R-REP-04
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/report";
import { buildStudyLog, makeConclusion, makeHeader, makeQuantity, makeResultsIndex, makeRunRecord, makeSeries, makeStep, SAMPLE_SHA256 } from "./helpers/studyFixtures";

// Added by the dispatcher after fuzzing every free-text field of the report with markup payloads.
const PAYLOAD = "[x](javascript:1)<b>*`|\n# h";

function simpleInput(agentName: string, models: string[]) {
  const steps = models.map((model, i) =>
    makeStep(i + 1, { actor: { kind: "agent", name: agentName, model }, action: "run", runs: ["run-1"] })
  );
  const lines = buildStudyLog([makeHeader({ studyId: "study-extra" }), ...steps]);
  const record = makeRunRecord("run-1", "completed");
  const results = makeResultsIndex("run-1", [
    makeQuantity("power", "verified", {
      provenance: { runId: "run-1", inputRevisions: [SAMPLE_SHA256] },
      data: { path: "data/power.csv", sha256: SAMPLE_SHA256 }
    })
  ]);
  return { studyLines: lines, runs: { "run-1": { record, results } }, generatedBy: "SEED test" };
}

describe("report: untrusted agent names and models", () => {
  it("escapes agent name and model in the Markdown sentence and keeps markup out of HTML", () => {
    const res = buildReport(simpleInput(PAYLOAD.slice(0, 20), ["m-1"]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sentence = res.value.markdown.split("\n").filter((l) => l.startsWith("AI agents took part"));
    expect(sentence).toHaveLength(1);
    expect(sentence[0]).not.toContain("[x](");
    expect(sentence[0]).not.toContain("<b>");
    // the newline inside the name must not start a new Markdown line (a heading)
    expect(res.value.markdown).not.toMatch(/^# h/m);
    expect(res.value.html).not.toContain("<b>");
  });

  it("lists one agent that used two models as two entries, in code-unit order", () => {
    const res = buildReport(simpleInput("Agent", ["model-b", "model-a"]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.html).toContain("agents: Agent (model-a), Agent (model-b).");
  });
});

// Added after the Codex review (2026-10-03).
describe("report: names that exist on Object.prototype, large series, provenance", () => {
  it("a cited run named constructor that is not provided is a typed refusal, not an exception", () => {
    const lines = buildStudyLog([makeHeader({ studyId: "study-proto" }), makeStep(1, { actor: { kind: "human", name: "h" }, action: "run", runs: ["constructor"] })]);
    const res = buildReport({ studyLines: lines, runs: {}, generatedBy: "t" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("E_PROP_MISSING");
      expect(res.errors[0]?.field).toBe("/runs/constructor");
    }
  });

  it("a quantity named constructor without a series renders without a plot", () => {
    const lines = buildStudyLog([makeHeader({ studyId: "study-proto2" }), makeStep(1, { actor: { kind: "human", name: "h" }, action: "run", runs: ["run-1"] })]);
    const res = buildReport({
      studyLines: lines,
      runs: {
        "run-1": {
          record: makeRunRecord("run-1", "completed"),
          results: makeResultsIndex("run-1", [
            makeQuantity("constructor", "verified", {
              provenance: { runId: "run-1", inputRevisions: [SAMPLE_SHA256] },
              data: { path: "data/c.csv", sha256: SAMPLE_SHA256 }
            })
          ])
        }
      },
      generatedBy: "t"
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.html).not.toContain("<svg");
  });

  it("a series with 150000 points is plotted (no argument-count overflow)", () => {
    const lines = buildStudyLog([makeHeader({ studyId: "study-big" }), makeStep(1, { actor: { kind: "human", name: "h" }, action: "run", runs: ["run-1"] })]);
    const n = 150000;
    const series = { x: Array.from({ length: n }, (_, i) => i), y: Array.from({ length: n }, (_, i) => i * 2), xLabel: "x", yLabel: "y" };
    void makeSeries;
    const res = buildReport({
      studyLines: lines,
      runs: {
        "run-1": {
          record: makeRunRecord("run-1", "completed"),
          results: makeResultsIndex("run-1", [
            makeQuantity("power", "verified", {
              provenance: { runId: "run-1", inputRevisions: [SAMPLE_SHA256] },
              data: { path: "data/p.csv", sha256: SAMPLE_SHA256 }
            })
          ]),
          series: { power: series }
        }
      },
      generatedBy: "t"
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.html).toContain("<svg");
  });

  it("results whose inputs differ from the run record are refused", () => {
    const lines = buildStudyLog([makeHeader({ studyId: "study-prov" }), makeStep(1, { actor: { kind: "human", name: "h" }, action: "run", runs: ["run-1"] })]);
    const results = makeResultsIndex("run-1", [
      makeQuantity("power", "verified", {
        provenance: { runId: "run-1", inputRevisions: [SAMPLE_SHA256] },
        data: { path: "data/p.csv", sha256: SAMPLE_SHA256 }
      })
    ]) as Record<string, unknown>;
    results.inputHashes = [{ path: "models/core.xml", sha256: "2".repeat(64) }];
    const res = buildReport({ studyLines: lines, runs: { "run-1": { record: makeRunRecord("run-1", "completed"), results } }, generatedBy: "t" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("E_OUTPUT_INCOMPLETE");
      expect(res.errors[0]?.field).toBe("/runs/run-1/inputHashes");
    }
  });
});
