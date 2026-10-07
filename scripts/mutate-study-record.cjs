// Mutation run for the live study record (E3): one change at a time, run the record tests, restore.
// Usage: node scripts/mutate-study-record.cjs [index]   (commit first; tests/study-record.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const R = "src/core/studyRecord.ts", H = "src/core/studyRecordHost.ts", N = "src/core/studyNoteHost.ts", F = "src/core/fileRunHost.ts", S = "src/core/sweepHost.ts", C = "src/cli/seed.ts", M = "src/mcp/seed.ts";
const MUT = [
  [R, "if (!text.endsWith(\"\\n\")) return err(", "if (false) return err("],
  [R, "if (problems.length) return { ok: false, errors: problems };\n  return { ok: true, lines", "return { ok: true, lines"],
  [R, "if (problems.length) return { ok: false as const, errors: problems };", ""],
  [R, "if (canonicalJson(bare) !== canonicalJson(header)) return err(", "if (false) return err("],
  [R, "rows.some((r) => typeof r.reason === \"string\" && r.reason.endsWith(marker))", "false"],
  [R, "d.reason.slice(0, 2000 - marker.length - 1)", "d.reason"],
  [R, "let seq = rows.length;", "let seq = rows.length + 1;"],
  [R, "Buffer.byteLength(text) > MAX_HOST_FILE", "false"],
  [R, "{ waitMs: 15000 }", "{ waitMs: 0 }"],
  [R, "createHash(\"sha256\").update(key).digest(\"hex\").slice(0, 16)", "createHash(\"sha256\").update(\"k\").digest(\"hex\").slice(0, 16)"],
  [H, "if (a.decision && !a.decision.allow) {", "if (false) {"],
  [H, "key: `oracle:${a.c.oracles.evidenceSha256}`,", "key: `oracle:${a.requestId}`,"],
  [H, "a.outcome.state === \"cancelled\" ? \"cancel\" : \"note\"", "\"note\""],
  [H, "if (header === null) return { ok: true, appended: 0 };", ""],
  [H, "if (!isAbsolute(headerFile)) throw", "if (false) throw"],
  [H, "if (inside(projectRoot, realpathSync(headerFile))) throw", "if (false) throw"],
  [H, "header.hash !== undefined || header.prev !== undefined", "false"],
  [H, "header.studyId !== c.study.studyId ||", ""],
  [H, "header.projectId !== projectId ||", ""],
  [H, "header.tier !== c.study.tier ||", ""],
  [H, "canonicalJson(header.parameters) !== canonicalJson(c.study.parameters)", "false"],
  [H, "} else if (a.decision && a.decision.allow && a.outcome.ok) {", "} else if (a.decision && a.outcome.ok) {"],
  [H, "(grant ${a.decision.grantId})", "${a.decision.grantId}"],
  [N, "const decision = evaluateGate(", "const decision = { allow: true } as any; void evaluateGate("],
  [N, "if (!existsSync(safeChild(runsRoot, id, true)) ||", "if (false &&"],
  [N, "r.text.length > 1500", "r.text.length > 15000"],
  [N, "new Set(runs).size !== runs.length", "false"],
  [N, "!ID.test(r.noteId)", "false"],
  [N, "${sha256Hex(JSON.stringify([r.text, runs]))}", ""],
  [F, "lastDecision = event.decision;", ""],
  [F, "...(context ? { context } : {}),", ""],
  [S, "{ sweep: { sweepId, index: results.indexOf(row) + 1, count: results.length, values: row.values } }", "undefined"],
  [C, "argv[0] === \"note\"\n              ? addStudyNote(hostConfig!, request)\n              : await runFromHostFile(hostConfig!, request);", "argv[0] === \"note\"\n              ? await runFromHostFile(hostConfig!, request)\n              : await runFromHostFile(hostConfig!, request);"]
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
  const r = spawnSync("npx", ["vitest", "run", "tests/study-record.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 240000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, file.replace("src/", ""), from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
