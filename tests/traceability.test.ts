import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  parseBoxes,
  scanTests,
  buildMatrix,
  sourceHash,
  render,
} = require("../scripts/lib/traceability.cjs");

const cliScript = join(__dirname, "..", "scripts", "trace-matrix.cjs");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("1. parseBoxes", () => {
  it("parses dash, numbered, indented boxes, all 3 states, IDs, malformed tokens, and ignores non-boxes", () => {
    const markdown = [
      "# Heading 1",
      "- bullet without brackets",
      "- [ ] {R-A-01} Dash box open with ID",
      "- [x] Dash box done without ID",
      "- [~] {R-B-02} Dash box partial with ID",
      "1. [ ] Numbered box open",
      "2. [x] {R-C-03} Numbered box done with ID",
      "10. [~] Numbered box partial",
      "  - [x] {R-D-04} Indented box done",
      "    4. [ ] {R-E-05} Deeply indented numbered box",
      "- [x] {R-E2-7} Malformed one digit ID",
      "- [ ] {r-e2-07} Malformed lowercase ID",
      "Plain text line",
    ].join("\n");

    const boxes = parseBoxes(markdown);

    expect(boxes).toEqual([
      {
        line: 3,
        state: " ",
        id: "R-A-01",
        text: "Dash box open with ID",
      },
      {
        line: 4,
        state: "x",
        id: null,
        text: "Dash box done without ID",
      },
      {
        line: 5,
        state: "~",
        id: "R-B-02",
        text: "Dash box partial with ID",
      },
      {
        line: 6,
        state: " ",
        id: null,
        text: "Numbered box open",
      },
      {
        line: 7,
        state: "x",
        id: "R-C-03",
        text: "Numbered box done with ID",
      },
      {
        line: 8,
        state: "~",
        id: null,
        text: "Numbered box partial",
      },
      {
        line: 9,
        state: "x",
        id: "R-D-04",
        text: "Indented box done",
      },
      {
        line: 10,
        state: " ",
        id: "R-E-05",
        text: "Deeply indented numbered box",
      },
      {
        line: 11,
        state: "x",
        id: null,
        text: "{R-E2-7} Malformed one digit ID",
      },
      {
        line: 12,
        state: " ",
        id: null,
        text: "{r-e2-07} Malformed lowercase ID",
      },
    ]);
  });
});

describe("2. Duplicate ID", () => {
  it("throws with exact message including both line numbers when two boxes have {R-A-01}", () => {
    const markdown = [
      "- [ ] {R-A-01} First box",
      "- [ ] Other box",
      "- [x] {R-A-01} Duplicate box",
    ].join("\n");

    expect(() => parseBoxes(markdown)).toThrow("duplicate requirement id R-A-01 (lines 1 and 3)");
  });
});

describe("3. scanTests", () => {
  it("finds it, test, it.skip, it.only, test.todo across quotes, handles describe hierarchy and limits", () => {
    const fileA = {
      path: "tests/suite.test.ts",
      text: [
        'describe("[R-DESC-01] outer suite", () => {',
        '  describe("[R-DESC-02] inner suite", () => {',
        '    it("[R-TEST-01] single quote test", () => {});',
        "    test('double quote test', () => {});",
        "    it.skip(`backtick [R-TEST-02] test`, () => {});",
        '    it.only("[R-TEST-01] duplicate test id", () => {});',
        '    test.todo("todo test");',
        "  });",
        '  describe("[R-SIBLING-01] sibling suite", () => {',
        '    it("test in sibling", () => {});',
        "  });",
        '  it("[R-E2-7] malformed id test", () => {});',
        '  it(`[${id}] template title`, () => {});',
        "});",
      ].join("\n"),
    };

    const { tests, total } = scanTests([fileA]);

    expect(total).toBe(8);
    expect(tests).toHaveLength(8);

    // Test 1: line 3, single quote test inside outer & inner describes
    expect(tests[0]).toEqual({
      file: "tests/suite.test.ts",
      line: 3,
      title: "[R-TEST-01] single quote test",
      ids: ["R-DESC-01", "R-DESC-02", "R-TEST-01"],
    });

    // Test 2: line 4, double quote test inherits outer & inner describes
    expect(tests[1]).toEqual({
      file: "tests/suite.test.ts",
      line: 4,
      title: "double quote test",
      ids: ["R-DESC-01", "R-DESC-02"],
    });

    // Test 3: line 5, it.skip backtick
    expect(tests[2]).toEqual({
      file: "tests/suite.test.ts",
      line: 5,
      title: "backtick [R-TEST-02] test",
      ids: ["R-DESC-01", "R-DESC-02", "R-TEST-02"],
    });

    // Test 4: line 6, it.only with duplicate R-TEST-01 (de-duplicated)
    expect(tests[3]).toEqual({
      file: "tests/suite.test.ts",
      line: 6,
      title: "[R-TEST-01] duplicate test id",
      ids: ["R-DESC-01", "R-DESC-02", "R-TEST-01"],
    });

    // Test 5: line 7, test.todo
    expect(tests[4]).toEqual({
      file: "tests/suite.test.ts",
      line: 7,
      title: "todo test",
      ids: ["R-DESC-01", "R-DESC-02"],
    });

    // Test 6: line 10, sibling suite inherits outer, does NOT inherit inner suite
    expect(tests[5]).toEqual({
      file: "tests/suite.test.ts",
      line: 10,
      title: "test in sibling",
      ids: ["R-DESC-01", "R-SIBLING-01"],
    });

    // Test 7: line 12, malformed [R-E2-7] produces no test ID (only outer describe ID)
    expect(tests[6]).toEqual({
      file: "tests/suite.test.ts",
      line: 12,
      title: "[R-E2-7] malformed id test",
      ids: ["R-DESC-01"],
    });

    // Test 8: line 13, template title with ${ is counted as a test line, but yields no title ID
    expect(tests[7]).toEqual({
      file: "tests/suite.test.ts",
      line: 13,
      title: "[${id}] template title",
      ids: ["R-DESC-01"],
    });
  });

  it("counts tab indentation as 4 spaces for describe ancestry", () => {
    const file = {
      path: "tests/tabs.test.ts",
      text: [
        '  describe("[R-PARENT-01] 2 spaces", () => {',
        '\t  describe("[R-CHILD-02] 1 tab plus 2 spaces (indent 6)", () => {',
        '\t\tit("[R-LEAF-03] 2 tabs (indent 8)", () => {});',
        "\t  });",
        '\tdescribe("[R-SIBLING-04] 1 tab (indent 4)", () => {',
        '\t  it("test in sibling (indent 6)", () => {});',
        "\t});",
        "  });",
      ].join("\n"),
    };
    const { tests } = scanTests([file]);
    expect(tests).toHaveLength(2);
    expect(tests[0]!.ids).toEqual(["R-CHILD-02", "R-LEAF-03", "R-PARENT-01"]);
    expect(tests[1]!.ids).toEqual(["R-PARENT-01", "R-SIBLING-04"]);
  });
});

describe("4. buildMatrix", () => {
  it("assembles matrix rows, tests sorted by file then line, noEvidence, unknownTests, and counts", () => {
    const boxes = [
      { line: 1, state: "x", id: "R-REQ-01", text: "Req 1 done with tests" },
      { line: 2, state: " ", id: "R-REQ-02", text: "Req 2 open without test" },
      { line: 3, state: "~", id: "R-REQ-03", text: "Req 3 partial without test" },
      { line: 4, state: "x", id: "R-REQ-04", text: "Req 4 done without test" },
      { line: 5, state: " ", id: null, text: "Unidentified box" },
    ];

    const tests = [
      { file: "tests/b.test.ts", line: 20, title: "Test B", ids: ["R-REQ-01"] },
      { file: "tests/a.test.ts", line: 10, title: "Test A", ids: ["R-REQ-01"] },
      { file: "tests/c.test.ts", line: 30, title: "Unknown Test", ids: ["R-UNKNOWN-99"] },
      { file: "tests/d.test.ts", line: 40, title: "Untagged Test", ids: [] },
    ];

    const matrix = buildMatrix(boxes, tests);

    expect(matrix.requirements).toBe(4);
    expect(matrix.tagged).toBe(3);
    expect(matrix.untagged).toBe(1);
    expect(matrix.total).toBe(4);

    // Tests for R-REQ-01 are ordered by file then line
    expect(matrix.rows[0]).toEqual({
      id: "R-REQ-01",
      state: "x",
      text: "Req 1 done with tests",
      tests: [
        { file: "tests/a.test.ts", line: 10, title: "Test A" },
        { file: "tests/b.test.ts", line: 20, title: "Test B" },
      ],
    });

    // noEvidence: done or partial with no tests (open boxes are excluded)
    expect(matrix.noEvidence).toEqual([
      { id: "R-REQ-03", state: "~", text: "Req 3 partial without test", tests: [] },
      { id: "R-REQ-04", state: "x", text: "Req 4 done without test", tests: [] },
    ]);

    // unknownTests: tests that name an ID with no box
    expect(matrix.unknownTests).toEqual([
      {
        file: "tests/c.test.ts",
        line: 30,
        title: "Unknown Test",
        ids: ["R-UNKNOWN-99"],
        unknownIds: ["R-UNKNOWN-99"],
      },
    ]);
  });
});

describe("5. render golden test", () => {
  it("renders a small matrix matching the exact golden output", () => {
    const boxes = [
      { line: 1, state: "x", id: "R-REQ-01", text: "Req A text" },
      {
        line: 2,
        state: "~",
        id: "R-REQ-02",
        text: "This requirement text is intentionally very long, definitely longer than one hundred characters in total length.",
      },
      { line: 3, state: "x", id: "R-REQ-03", text: "Req C with no evidence" },
    ];

    const tests = [
      {
        file: "tests/a.test.ts",
        line: 10,
        title: "test with | pipe",
        ids: ["R-REQ-01"],
      },
      {
        file: "tests/b.test.ts",
        line: 20,
        title: "A very long test title that is intentionally written to exceed eighty characters in total length",
        ids: ["R-REQ-02"],
      },
      {
        file: "tests/c.test.ts",
        line: 30,
        title: "unknown test",
        ids: ["R-UNK-99"],
      },
    ];

    const matrix = buildMatrix(boxes, tests);
    const hash = sourceHash(boxes, tests);
    const rendered = render(matrix, hash);

    const expected = [
      "# Requirement to test traceability",
      "",
      "Generated by scripts/trace-matrix.cjs from TODO.md and tests/**/*.test.ts. Do not edit by hand; run `node scripts/trace-matrix.cjs` to regenerate.",
      "",
      "- requirements with an ID: 3",
      "- tests found: 3 (tagged 3, untagged 0)",
      "- requirements with no test evidence: 1",
      "- tests naming an unknown requirement: 1",
      `- source hash: ${hash}`,
      "",
      "## Matrix",
      "",
      "| ID | State | Requirement | Tests |",
      "|---|---|---|---|",
      '| R-REQ-01 | done | Req A text | tests/a.test.ts:10 "test with \\| pipe" |',
      '| R-REQ-02 | partial | This requirement text is intentionally very long, definitely longer than one hundred characters in t... | tests/b.test.ts:20 "A very long test title that is intentionally written to exceed eighty characters..." |',
      "| R-REQ-03 | done | Req C with no evidence | none |",
      "",
      "## Requirements with no test evidence",
      "",
      "- R-REQ-03 (done): Req C with no evidence",
      "",
      "## Tests naming an unknown requirement",
      "",
      '- tests/c.test.ts:30 "unknown test" names R-UNK-99',
      "",
    ].join("\n");

    expect(rendered).toBe(expected);
  });

  it("renders the empty case with table body row and both none sections", () => {
    const matrix = buildMatrix([], []);
    const hash = sourceHash([], []);
    const rendered = render(matrix, hash);

    const expected = [
      "# Requirement to test traceability",
      "",
      "Generated by scripts/trace-matrix.cjs from TODO.md and tests/**/*.test.ts. Do not edit by hand; run `node scripts/trace-matrix.cjs` to regenerate.",
      "",
      "- requirements with an ID: 0",
      "- tests found: 0 (tagged 0, untagged 0)",
      "- requirements with no test evidence: 0",
      "- tests naming an unknown requirement: 0",
      `- source hash: ${hash}`,
      "",
      "## Matrix",
      "",
      "| ID | State | Requirement | Tests |",
      "|---|---|---|---|",
      "| none | | | |",
      "",
      "## Requirements with no test evidence",
      "",
      "none",
      "",
      "## Tests naming an unknown requirement",
      "",
      "none",
      "",
    ].join("\n");

    expect(rendered).toBe(expected);
  });
});

describe("6. sourceHash", () => {
  it("is stable, changes when relevant fields change, and ignores un-IDed boxes and file input order", () => {
    const boxesBase = [
      { line: 1, state: "x", id: "R-A-01", text: "Text A" },
      { line: 2, state: " ", id: null, text: "Ignored" },
    ];
    const testsBase = [
      { file: "tests/a.test.ts", line: 10, title: "Title A", ids: ["R-A-01"] },
    ];

    const hash1 = sourceHash(boxesBase, testsBase);
    const hash2 = sourceHash(boxesBase, testsBase);
    expect(hash1).toBe(hash2);

    // Changes when box text changes
    const hashDiffBoxText = sourceHash(
      [{ line: 1, state: "x", id: "R-A-01", text: "Text A altered" }],
      testsBase
    );
    expect(hashDiffBoxText).not.toBe(hash1);

    // Changes when box state changes
    const hashDiffBoxState = sourceHash(
      [{ line: 1, state: "~", id: "R-A-01", text: "Text A" }],
      testsBase
    );
    expect(hashDiffBoxState).not.toBe(hash1);

    // Changes when test title changes
    const hashDiffTestTitle = sourceHash(boxesBase, [
      { file: "tests/a.test.ts", line: 10, title: "Title A altered", ids: ["R-A-01"] },
    ]);
    expect(hashDiffTestTitle).not.toBe(hash1);

    // Changes when test IDs change
    const hashDiffTestIds = sourceHash(boxesBase, [
      { file: "tests/a.test.ts", line: 10, title: "Title A", ids: ["R-A-02"] },
    ]);
    expect(hashDiffTestIds).not.toBe(hash1);

    // Does NOT change when box without ID changes
    const hashBoxWithoutIdChanged = sourceHash(
      [
        { line: 1, state: "x", id: "R-A-01", text: "Text A" },
        { line: 2, state: "~", id: null, text: "Completely different text" },
      ],
      testsBase
    );
    expect(hashBoxWithoutIdChanged).toBe(hash1);

    // Does NOT change when order of files array changes before scanTests sorts
    const file1 = { path: "tests/a.test.ts", text: 'it("[R-A-01] a", () => {});' };
    const file2 = { path: "tests/b.test.ts", text: 'it("[R-A-01] b", () => {});' };
    const scan1 = scanTests([file1, file2]);
    const scan2 = scanTests([file2, file1]);
    expect(sourceHash(boxesBase, scan1.tests)).toBe(sourceHash(boxesBase, scan2.tests));
  });
});

describe("7. CLI", () => {
  function setupTree() {
    const dir = mkdtempSync(join(tmpdir(), "seed-trace-test-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "tests", "sub"), { recursive: true });
    mkdirSync(join(dir, "tests", "fixtures"), { recursive: true });

    writeFileSync(
      join(dir, "TODO.md"),
      "- [x] {R-A-01} Requirement A\n- [ ] {R-B-02} Requirement B\n"
    );
    writeFileSync(join(dir, "tests", "a.test.ts"), 'it("[R-A-01] test in a", () => {});\n');
    writeFileSync(join(dir, "tests", "sub", "b.test.ts"), 'it("[R-B-02] test in b", () => {});\n');
    writeFileSync(
      join(dir, "tests", "fixtures", "c.test.ts"),
      'it("[R-C-03] fixture test to skip", () => {});\n'
    );

    return dir;
  }

  it("executes CLI workflows, skips fixtures, enforces --check and --results, handles errors", () => {
    const dir = setupTree();

    // 1. Write mode: creates docs/TRACEABILITY.md, skips fixtures
    const runWrite = spawnSync(process.execPath, [cliScript, "--root", dir], { encoding: "utf8" });
    expect(runWrite.status).toBe(0);
    expect(runWrite.stdout.trim()).toBe("wrote docs/TRACEABILITY.md: 2 requirements, 2 tests");
    const matrixFile = join(dir, "docs", "TRACEABILITY.md");
    expect(existsSync(matrixFile)).toBe(true);
    const initialContent = readFileSync(matrixFile, "utf8");

    // 2. --check right after exits 0
    const runCheckClean = spawnSync(process.execPath, [cliScript, "--root", dir, "--check"], {
      encoding: "utf8",
    });
    expect(runCheckClean.status).toBe(0);
    expect(runCheckClean.stdout).toContain("traceability matrix is current");

    // 3. After editing a test title, --check exits 1
    writeFileSync(
      join(dir, "tests", "a.test.ts"),
      'it("[R-A-01] modified test in a", () => {});\n'
    );
    const runCheckModified = spawnSync(process.execPath, [cliScript, "--root", dir, "--check"], {
      encoding: "utf8",
    });
    expect(runCheckModified.status).toBe(1);
    expect(runCheckModified.stdout).toContain(
      "traceability matrix is out of date: run node scripts/trace-matrix.cjs"
    );

    // 4. With matrix file missing, --check exits 1
    rmSync(matrixFile);
    const runCheckMissing = spawnSync(process.execPath, [cliScript, "--root", dir, "--check"], {
      encoding: "utf8",
    });
    expect(runCheckMissing.status).toBe(1);
    expect(runCheckMissing.stdout).toContain(
      "traceability matrix is out of date: run node scripts/trace-matrix.cjs"
    );

    // Re-generate current matrix file for subsequent checks
    writeFileSync(
      join(dir, "tests", "a.test.ts"),
      'it("[R-A-01] test in a", () => {});\n'
    );
    spawnSync(process.execPath, [cliScript, "--root", dir], { encoding: "utf8" });
    const committedBytes = readFileSync(matrixFile);

    // 5. Missing TODO.md exits 2
    const dirNoTodo = mkdtempSync(join(tmpdir(), "seed-trace-notodo-"));
    tmpDirs.push(dirNoTodo);
    mkdirSync(join(dirNoTodo, "docs"));
    mkdirSync(join(dirNoTodo, "tests"));
    const runNoTodo = spawnSync(process.execPath, [cliScript, "--root", dirNoTodo], {
      encoding: "utf8",
    });
    expect(runNoTodo.status).toBe(2);
    expect(runNoTodo.stderr.length).toBeGreaterThan(0);

    // 6. Duplicate ID exits 2
    const dirDup = mkdtempSync(join(tmpdir(), "seed-trace-dup-"));
    tmpDirs.push(dirDup);
    mkdirSync(join(dirDup, "docs"));
    mkdirSync(join(dirDup, "tests"));
    writeFileSync(
      join(dirDup, "TODO.md"),
      "- [ ] {R-DUP-01} Item 1\n- [x] {R-DUP-01} Item 2\n"
    );
    const runDup = spawnSync(process.execPath, [cliScript, "--root", dirDup], {
      encoding: "utf8",
    });
    expect(runDup.status).toBe(2);
    expect(runDup.stderr).toContain("duplicate requirement id R-DUP-01");

    // 7. Unknown option exits 2
    const runUnknown = spawnSync(
      process.execPath,
      [cliScript, "--root", dir, "--unknown-option"],
      { encoding: "utf8" }
    );
    expect(runUnknown.status).toBe(2);
    expect(runUnknown.stderr).toContain("unknown option: --unknown-option");

    // 8. Missing docs/ folder with default output exits 2
    const dirNoDocs = mkdtempSync(join(tmpdir(), "seed-trace-nodocs-"));
    tmpDirs.push(dirNoDocs);
    mkdirSync(join(dirNoDocs, "tests"));
    writeFileSync(join(dirNoDocs, "TODO.md"), "- [x] {R-A-01} Req\n");
    const runNoDocs = spawnSync(process.execPath, [cliScript, "--root", dirNoDocs], {
      encoding: "utf8",
    });
    expect(runNoDocs.status).toBe(2);
    expect(runNoDocs.stderr.length).toBeGreaterThan(0);

    // 9. --results with vitest JSON report prints per-ID summary and does not change committed file
    const reportData = {
      testResults: [
        {
          assertionResults: [
            { fullName: "suite > [R-A-01] test in a", status: "passed" },
            { fullName: "suite > [R-A-01] another test", status: "failed" },
            { fullName: "suite > [R-A-01] skipped test", status: "skipped" },
            { fullName: "suite > [R-B-02] test in b", status: "passed" },
          ],
        },
      ],
    };
    const reportFile = join(dir, "results.json");
    writeFileSync(reportFile, JSON.stringify(reportData));

    const runResults = spawnSync(
      process.execPath,
      [cliScript, "--root", dir, "--results", reportFile],
      { encoding: "utf8" }
    );
    expect(runResults.status).toBe(0);
    expect(runResults.stdout).toContain("R-A-01: 1 passed, 1 failed, 1 other");
    expect(runResults.stdout).toContain("R-B-02: 1 passed, 0 failed, 0 other");

    const afterBytes = readFileSync(matrixFile);
    expect(afterBytes.equals(committedBytes)).toBe(true);

    // 10. Unreadable or invalid JSON FILE exits 2
    const badJsonFile = join(dir, "bad-results.json");
    writeFileSync(badJsonFile, "{ invalid json content");
    const runBadJson = spawnSync(
      process.execPath,
      [cliScript, "--root", dir, "--results", badJsonFile],
      { encoding: "utf8" }
    );
    expect(runBadJson.status).toBe(2);
    expect(runBadJson.stderr.length).toBeGreaterThan(0);

    const runMissingJson = spawnSync(
      process.execPath,
      [cliScript, "--root", dir, "--results", join(dir, "non-existent.json")],
      { encoding: "utf8" }
    );
    expect(runMissingJson.status).toBe(2);
    expect(runMissingJson.stderr.length).toBeGreaterThan(0);
  });
});

describe("8. Bad-input rule (rule 10)", () => {
  it("rejects invalid arguments and invalid box tokens with explicit errors", () => {
    // Missing argument for flags
    const runMissingRoot = spawnSync(process.execPath, [cliScript, "--root"], { encoding: "utf8" });
    expect(runMissingRoot.status).toBe(2);
    expect(runMissingRoot.stderr).toContain("missing argument for --root");

    const runMissingOut = spawnSync(process.execPath, [cliScript, "--out"], { encoding: "utf8" });
    expect(runMissingOut.status).toBe(2);
    expect(runMissingOut.stderr).toContain("missing argument for --out");

    const runMissingResults = spawnSync(process.execPath, [cliScript, "--results"], { encoding: "utf8" });
    expect(runMissingResults.status).toBe(2);
    expect(runMissingResults.stderr).toContain("missing argument for --results");

    // Invalid JSON report without testResults array
    const dir = mkdtempSync(join(tmpdir(), "seed-trace-badreport-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "TODO.md"), "- [x] {R-A-01} Req\n");
    const badReport = join(dir, "no-test-results.json");
    writeFileSync(badReport, JSON.stringify({ other: 123 }));
    const runBadReport = spawnSync(
      process.execPath,
      [cliScript, "--root", dir, "--results", badReport],
      { encoding: "utf8" }
    );
    expect(runBadReport.status).toBe(2);
    expect(runBadReport.stderr).toContain("missing testResults array");
  });
});

describe("added by the dispatcher: order does not depend on the locale", () => {
  const lib = require("../scripts/lib/traceability.cjs");
  const boxes = [{ line: 1, state: "x", id: "R-X-01", text: "a requirement" }];
  const tA = { file: "tests/a.test.ts", line: 3, title: "[R-X-01] lower case file", ids: ["R-X-01"] };
  const tB = { file: "tests/B.test.ts", line: 3, title: "[R-X-01] upper case file", ids: ["R-X-01"] };
  const tDash = { file: "tests/a-b.test.ts", line: 1, title: "[R-X-01] dash", ids: ["R-X-01"] };
  const tDot = { file: "tests/a.test.ts", line: 1, title: "[R-X-01] dot", ids: ["R-X-01"] };

  it("lists tests in plain code-unit order of the file path (uppercase before lowercase, dash before dot)", () => {
    const m = lib.buildMatrix(boxes, [tA, tB, tDot, tDash]);
    expect(m.rows[0].tests.map((t: { file: string; line: number }) => `${t.file}:${t.line}`)).toEqual([
      "tests/B.test.ts:3",
      "tests/a-b.test.ts:1",
      "tests/a.test.ts:1",
      "tests/a.test.ts:3",
    ]);
  });

  it("the source hash does not depend on the order the tests are given in", () => {
    const h1 = lib.sourceHash(boxes, [tA, tB, tDot, tDash]);
    const h2 = lib.sourceHash(boxes, [tDash, tDot, tB, tA]);
    expect(h1).toBe(h2);
  });
});

describe("added by the dispatcher: two edges the brief's test list missed", () => {
  const lib = require("../scripts/lib/traceability.cjs");

  it("writes a pipe in the requirement text as an escaped pipe", () => {
    const boxes = [{ line: 1, state: "x", id: "R-X-01", text: "a | b" }];
    const out = lib.render(lib.buildMatrix(boxes, []), "h");
    expect(out).toContain("| R-X-01 | done | a \\| b | none |");
  });

  it("lists an ID once when the test title and its describe both name it", () => {
    const text = ['describe("[R-X-01] group", () => {', '  it("[R-X-01] again", () => {});', "});", ""].join("\n");
    const { tests } = lib.scanTests([{ path: "tests/x.test.ts", text }]);
    expect(tests).toHaveLength(1);
    expect(tests[0].ids).toEqual(["R-X-01"]);
  });
});

describe("file-level tags and manual boxes (added for SEED's own use of the generator)", () => {
  const { scanFileTags } = require("../scripts/lib/traceability.cjs");

  const file = (path: string, text: string) => ({ path, text });

  it("a `// @covers` line tags every test of its file; several lines and ids merge; a plain mention of the word is not a tag", () => {
    const files = [
      file("tests/a.test.ts", ["// @covers R-A-01, R-B-02", "// @covers R-A-01", 'it("one", () => {});', 'it("two", () => {});', ""].join("\n")),
      file("tests/b.test.ts", ['it("x", () => {}); // @covers R-A-01', "const s = '// @covers R-C-03';", ""].join("\n")),
    ];
    const { tests } = scanTests(files);
    expect(scanFileTags(files, tests)).toEqual([{ file: "tests/a.test.ts", ids: ["R-A-01", "R-B-02"], tests: 2 }]);
  });

  it("a requirement covered by a file lists the file with its test count and has evidence; counts as tagged tests", () => {
    const boxes = parseBoxes("- [x] {R-A-01} covered by a file\n- [x] {R-A-02} nothing\n");
    const files = [file("tests/a.test.ts", "// @covers R-A-01\nit(\"one\", () => {});\nit(\"two\", () => {});\n"), file("tests/c.test.ts", 'it("loose", () => {});\n')];
    const { tests } = scanTests(files);
    const fileTags = scanFileTags(files, tests);
    const m = buildMatrix(boxes, tests, fileTags);
    expect(m.rows[0].files).toEqual([{ file: "tests/a.test.ts", tests: 2 }]);
    expect(m.noEvidence.map((r: { id: string }) => r.id)).toEqual(["R-A-02"]);
    expect([m.tagged, m.untagged]).toEqual([2, 1]);
    const text = render(m, sourceHash(boxes, tests, fileTags));
    expect(text).toContain("tests/a.test.ts (all 2 tests of the file)");
  });

  it("a file tag naming a requirement that has no box is reported, like a title tag", () => {
    const boxes = parseBoxes("- [x] {R-A-01} one\n");
    const files = [file("tests/a.test.ts", "// @covers R-Z-09\nit(\"one\", () => {});\n")];
    const { tests } = scanTests(files);
    const fileTags = scanFileTags(files, tests);
    const m = buildMatrix(boxes, tests, fileTags);
    expect(m.unknownFiles).toEqual([{ file: "tests/a.test.ts", ids: ["R-Z-09"] }]);
    expect(render(m, "h")).toContain("- tests/a.test.ts (file tag) names R-Z-09");
  });

  it("a `manual` box is not a missing test: it is shown as manual, and stays out of the no-evidence list", () => {
    const boxes = parseBoxes("- [x] {R-D-01 manual} the plan is written\n- [~] {R-D-02} partly done\n");
    expect(boxes[0]).toEqual({ line: 1, state: "x", id: "R-D-01", text: "the plan is written", manual: true });
    expect(boxes[1]).toEqual({ line: 2, state: "~", id: "R-D-02", text: "partly done" });
    const m = buildMatrix(boxes, []);
    expect(m.noEvidence.map((r: { id: string }) => r.id)).toEqual(["R-D-02"]);
    expect(render(m, "h")).toContain("manual: documentation or a hand check, not a test");
  });

  it("the hash changes with a file tag and with the manual marker, and does not when neither is used", () => {
    const boxes = parseBoxes("- [x] {R-A-01} one\n");
    const plain = sourceHash(boxes, [], []);
    expect(sourceHash(boxes, [])).toBe(plain);
    expect(sourceHash(boxes, [], [{ file: "tests/a.test.ts", ids: ["R-A-01"], tests: 1 }])).not.toBe(plain);
    expect(sourceHash(parseBoxes("- [x] {R-A-01 manual} one\n"), [])).not.toBe(plain);
  });

  it("--results counts a file-tagged requirement from the assertions of that file", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-file-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "TODO.md"), "- [x] {R-A-01} one\n");
    writeFileSync(join(root, "tests", "a.test.ts"), '// @covers R-A-01\nit("one", () => {});\nit("two", () => {});\n');
    mkdirSync(join(root, "docs"));
    const run = (extra: string[]) => spawnSync(process.execPath, [cliScript, "--root", root, ...extra], { encoding: "utf8" });
    expect(run([]).status).toBe(0);
    const results = join(root, "results.json");
    writeFileSync(
      results,
      JSON.stringify({
        testResults: [
          { name: join(root, "tests", "a.test.ts"), assertionResults: [{ fullName: "one", status: "passed" }, { fullName: "two", status: "failed" }] },
          { name: join(root, "tests", "other.test.ts"), assertionResults: [{ fullName: "three", status: "passed" }] },
        ],
      }),
    );
    const r = run(["--check", "--results", results]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("R-A-01: 1 passed, 1 failed, 0 other");
  });
});

// SEED's own matrix: the committed docs/TRACEABILITY.md must be what the generator makes from TODO.md and the tests as they are now.
describe("SEED's own traceability matrix", () => {
  const repo = join(__dirname, "..");

  it("every done or partial box in TODO.md has a requirement ID", () => {
    const text = readFileSync(join(repo, "TODO.md"), "utf8");
    const bare = text.split("\n").filter((l) => /^\s*(?:[-*]|\d+\.)\s+\[[x~]\]\s+(?!\{R-)/.test(l));
    expect(bare.map((l) => l.slice(0, 80))).toEqual([]);
    expect(parseBoxes(text).filter((b: { id: string | null }) => b.id !== null).length).toBeGreaterThan(60);
  });

  it("the committed matrix is current, has no requirement without evidence, and names no unknown requirement", () => {
    const r = spawnSync(process.execPath, [cliScript, "--check"], { cwd: repo, encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("traceability matrix is current");
    expect(r.status).toBe(0);
    const doc = readFileSync(join(repo, "docs", "TRACEABILITY.md"), "utf8");
    expect(doc).toContain("- requirements with no test evidence: 0");
    expect(doc).toContain("- tests naming an unknown requirement: 0");
  });
});
