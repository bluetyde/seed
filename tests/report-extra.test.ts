import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/report";
import { buildStudyLog, makeConclusion, makeHeader, makeQuantity, makeResultsIndex, makeRunRecord, makeStep, SAMPLE_SHA256 } from "./helpers/studyFixtures";

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
