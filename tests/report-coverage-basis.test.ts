// @covers R-ORA-06
import { describe, expect, it } from "vitest";
import { COVERAGE_BASIS_NOTE, buildReport } from "../src/core/report";
import { buildStudyLog, makeHeader, makeQuantity, makeResultsIndex, makeRunRecord, makeStep, SAMPLE_SHA256 } from "./helpers/studyFixtures";

// F8 (option a): oracle coverage is matched by quantity name only, and a report says so wherever it says "verified" (docs/oracle-coverage.md).
function input(verifications: ("verified" | "unverified")[]) {
  const lines = buildStudyLog([makeHeader({ studyId: "study-coverage" }), makeStep(1, { action: "run", runs: ["run-1"] })]);
  const quantities = verifications.map((v, i) =>
    makeQuantity(i === 0 ? "power" : `quantity-${i}`, v, { provenance: { runId: "run-1", inputRevisions: [SAMPLE_SHA256] }, data: { path: `data/q${i}.csv`, sha256: SAMPLE_SHA256 } })
  );
  return { studyLines: lines, runs: { "run-1": { record: makeRunRecord("run-1", "completed"), results: makeResultsIndex("run-1", quantities) } }, generatedBy: "SEED test" };
}
const count = (text: string, part: string) => text.split(part).length - 1;
const build = (v: ("verified" | "unverified")[]) => {
  const r = buildReport(input(v));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};

describe("the note", () => {
  it("says what verified means and what it does not", () => {
    expect(COVERAGE_BASIS_NOTE).toContain("matches by name only");
    expect(COVERAGE_BASIS_NOTE).toContain("does not check that this model resembles the case the oracle ran");
    expect(COVERAGE_BASIS_NOTE).toContain("not that this model is inside the verified range");
  });
});

describe("a report with a verified quantity", () => {
  it("HTML: the badge says by name, and the note stands in the verification section and in the limits", () => {
    const { html } = build(["verified"]);
    expect(html).toContain('<span class="badge badge-verified">verified (by name)</span>');
    expect(html).not.toContain('<span class="badge badge-verified">verified</span>');
    expect(count(html, "SEED matches by name only")).toBe(2);
    const verification = html.slice(html.indexOf("Quantities verified:"), html.indexOf("</section>", html.indexOf("Quantities verified:")));
    expect(verification).toContain("SEED matches by name only");
    const limits = html.slice(html.indexOf('<section id="limits">'));
    expect(limits).toContain("SEED matches by name only");
  });
  it("Markdown: the label says by name, and the note stands in the verification section and in the limits", () => {
    const { markdown } = build(["verified"]);
    expect(markdown).toContain("verified (by name)");
    expect(count(markdown, "SEED matches by name only")).toBe(2);
    const verification = markdown.slice(markdown.indexOf("## Verification"), markdown.indexOf("## ", markdown.indexOf("## Verification") + 5));
    expect(verification).toContain("SEED matches by name only");
    expect(markdown.slice(markdown.indexOf("## Limits"))).toContain("SEED matches by name only");
  });
});

describe("what did not change", () => {
  it("an unverified quantity is still UNVERIFIED, and is not given the by-name label", () => {
    const { html, markdown } = build(["unverified"]);
    expect(html).toContain('<span class="badge badge-unverified">UNVERIFIED</span>');
    expect(html).not.toContain("verified (by name)");
    expect(markdown).toContain("UNVERIFIED");
    expect(markdown).not.toContain("verified (by name)");
  });
  it("the counts and the warning are as before, and the note is there whatever the mix", () => {
    const { html, markdown } = build(["verified", "unverified"]);
    expect(html).toContain("Quantities verified: 1, unverified: 1");
    expect(html).toContain("1 quantities are unverified and outside verified coverage.");
    expect(markdown).toContain("Quantities verified: 1, unverified: 1");
    expect(count(markdown, "SEED matches by name only")).toBe(2);
    expect(html).toContain('<span class="badge badge-unverified">UNVERIFIED</span>');
    expect(html).toContain("verified (by name)");
  });
  it("the report is the same twice (the note adds nothing that varies)", () => {
    expect(build(["verified"]).markdown).toBe(build(["verified"]).markdown);
  });
});
