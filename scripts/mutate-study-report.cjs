// Mutation run for the report export that reads the live study record (E3): one change at a time, run the live-report tests, restore.
// Usage: node scripts/mutate-study-report.cjs [index]   (commit first; tests/study-report-live.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const P = "src/core/studyReportHost.ts";
const MUT = [
  [P, "if (!live.ok) throw Error(", "if (false) throw Error("],
  [P, "if (canonicalJson(bare) !== canonicalJson(header)) throw Error(", "if (false) throw Error("],
  [P, "if (!cited.includes(runId)) throw Error(", "if (false) throw Error("],
  [P, "if (id === runId) continue;", ""],
  [P, "if (!/^r-[A-Za-z0-9_-]+$/.test(id)) throw Error(\"the live study record cites an invalid run id\");", ""],
  [P, "if (typeof otherRequest !== \"string\") throw Error(", "if (false) throw Error("],
  [P, "if (expectRunId !== undefined && runId !== expectRunId) throw Error(", "if (false) throw Error("],
  [P, "studyLines = live.lines;", "studyLines = [JSON.stringify(header)];"],
  [P, "if (live.lines.length > 0) {\n        const { prev", "if (false) {\n        const { prev"],
  [P, "const prefix = r === main ? \"\" : `runs/${r.runId}/`;", "const prefix = \"\";"],
  [P, "staleRunIds: allRuns.filter(r => r.stale).map(r => r.runId),", "staleRunIds: [],"],
  [P, "runs: Object.fromEntries(allRuns.map(r => [r.runId, r.reportRun])),", "runs: { [runId]: reportRun },"],
  [P, "(live.lines.length > 0 && readFileSync(liveFile, \"utf8\") !== studyLines.join(\"\n\") + \"\n\")", "false"],
  [P, "allRuns.some(r => canonicalJson(readHostJson(safeChild(r.runRoot, \"run-record.json\"))) !== canonicalJson(r.record)) ||", ""],
  [P, "for (const r of allRuns) for (const output of r.record.outputs ?? []) checked(r.runRoot, output.path, output.sha256);", ""],
  [P, "others.push(verifyRun(otherRequest, id));", ""],
  [P, "oracle.verdict !== \"pass\" ||", ""],
  [P, "canonicalJson(oracle.pins) !== canonicalJson(gate.pins)", "false"],
  [P, "if (!exportDecision.allow) return", "if (false) return"],
  [P, "generatedBy: others.length > 0 || live.lines.length > 0 ?", "generatedBy: false ?"]
];
const only = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
const rows = [];
for (let i = 0; i < MUT.length; i++) {
  if (only !== null && i !== only) continue;
  const [file, from, to] = MUT[i];
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { rows.push([i, "NOT FOUND", from]); console.log(i, "NOT FOUND", from.slice(0, 60)); continue; }
  writeFileSync(file, original.replace(from, to));
  if (!execSync("git diff --stat", { encoding: "utf8" }).trim()) { rows.push([i, "NOT APPLIED", from]); continue; }
  const r = spawnSync("npx", ["vitest", "run", "tests/study-report-live.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 240000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
