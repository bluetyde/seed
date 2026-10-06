import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareReport, receiptFilesOk, reportReceiptFolder } from "../src/core/reportReceipt";

// E2 limit L7: the Markdown copy of a report is bound by the receipt like the HTML (receipt schema 0.2); 0.1 receipts stay readable.
const h = (c: string) => c.repeat(64);
const f = (p: string, c = "a") => ({ path: p, sha256: h(c) });
const base = [f("studies/s/report.html"), f("studies/s/study.jsonl", "b"), f("studies/s/evidence.json", "c")];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("which file lists a receipt may have", () => {
  it.each([
    ["0.1, a first report with its three files", { schema: "seed.report-receipt/0.1", version: 1, files: base }, true],
    ["0.1, a first report with a fourth file", { schema: "seed.report-receipt/0.1", version: 1, files: [...base, f("studies/s/report.md", "d")] }, false],
    ["0.1, a revised report with extra files", { schema: "seed.report-receipt/0.1", version: 2, files: [...base, f("studies/s/x.txt", "d")] }, true],
    ["0.2, a first report with report.md as the fourth file", { schema: "seed.report-receipt/0.2", version: 1, files: [...base, f("studies/s/report.md", "d")] }, true],
    ["0.2, a first report without report.md", { schema: "seed.report-receipt/0.2", version: 1, files: base }, false],
    ["0.2, a first report whose fourth file is something else", { schema: "seed.report-receipt/0.2", version: 1, files: [...base, f("studies/s/notes.md", "d")] }, false],
    ["0.2, a first report with a fifth file", { schema: "seed.report-receipt/0.2", version: 1, files: [...base, f("studies/s/report.md", "d"), f("studies/s/x", "e")] }, false],
    ["0.2, a revised report with report.md among its extra files", { schema: "seed.report-receipt/0.2", version: 2, files: [...base, f("studies/s/outputs/o.csv", "d"), f("studies/s/report.md", "e")] }, true],
    ["0.2, a revised report without report.md", { schema: "seed.report-receipt/0.2", version: 2, files: [...base, f("studies/s/outputs/o.csv", "d")] }, false],
    ["an unknown schema", { schema: "seed.report-receipt/0.3", version: 1, files: base }, false],
    ["fewer than three files", { schema: "seed.report-receipt/0.2", version: 2, files: base.slice(0, 2) }, false],
    ["no list", { schema: "seed.report-receipt/0.2", version: 1 }, false],
  ])("%s: %s", (_name, receipt, ok) => {
    expect(receiptFilesOk(receipt as never)).toBe(ok);
  });

  it("a path that only ends in report.md is not enough (it must be the file itself)", () => {
    expect(receiptFilesOk({ schema: "seed.report-receipt/0.2", version: 1, files: [...base, f("studies/s/myreport.md", "d")] })).toBe(false);
  });
});

describe("prepareReport writes receipts that bind report.md", () => {
  const setup = () => {
    const state = mkdtempSync(join(tmpdir(), "seed-receipt-state-"));
    const root = mkdtempSync(join(tmpdir(), "seed-receipt-root-"));
    dirs.push(state, root);
    return { state, root };
  };
  const pendingOf = (state: string, root: string) => {
    const folder = reportReceiptFolder(state, root, "p-1");
    const names = readdirSync(folder);
    expect(names).toHaveLength(1);
    return JSON.parse(readFileSync(join(folder, names[0]!), "utf8"));
  };

  it("a first report: schema 0.2 and four files in the order html, study, evidence, markdown", () => {
    const { state, root } = setup();
    prepareReport(state, root, "p-1", "s-1", "req-1", "r-1", "studies/s", [h("a"), h("b"), h("c"), h("d")]);
    const r = pendingOf(state, root);
    expect(r.schema).toBe("seed.report-receipt/0.2");
    expect(r.files.map((x: { path: string; sha256: string }) => [x.path, x.sha256])).toEqual([
      ["studies/s/report.html", h("a")],
      ["studies/s/study.jsonl", h("b")],
      ["studies/s/evidence.json", h("c")],
      ["studies/s/report.md", h("d")],
    ]);
    expect(receiptFilesOk(r)).toBe(true);
  });

  it("a first report given only three hashes is refused: a receipt must bind report.md", () => {
    const { state, root } = setup();
    expect(() => prepareReport(state, root, "p-1", "s-1", "req-1", "r-1", "studies/s", [h("a"), h("b"), h("c")])).toThrow(/must bind report.md/);
    expect(readdirSync(reportReceiptFolder(state, root, "p-1"))).toEqual([]);
  });

  it("a revised report carries report.md among its extra files and is accepted", () => {
    const { state, root } = setup();
    prepareReport(state, root, "p-1", "s-1", "req-2", "r-1", "studies/s2", [h("a"), h("b"), h("c")], {
      version: 2,
      sourceReportId: "0".repeat(32),
      extraFiles: [{ path: "outputs/o.csv", sha256: h("d") }, { path: "report.md", sha256: h("e") }],
    });
    const r = pendingOf(state, root);
    expect(r.version).toBe(2);
    expect(r.files.at(-1)).toEqual({ path: "studies/s2/report.md", sha256: h("e") });
    expect(receiptFilesOk(r)).toBe(true);
  });

  it("a revised report without report.md is refused", () => {
    const { state, root } = setup();
    expect(() =>
      prepareReport(state, root, "p-1", "s-1", "req-3", "r-1", "studies/s3", [h("a"), h("b"), h("c")], {
        version: 2,
        sourceReportId: "0".repeat(32),
        extraFiles: [{ path: "outputs/o.csv", sha256: h("d") }],
      }),
    ).toThrow(/must bind report.md/);
  });
});
