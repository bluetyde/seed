// Mutation run for the reconciliation of the study record (E3): one change at a time, run its tests, restore.
// Usage: node scripts/mutate-study-reconcile.cjs [index]   (commit first; tests/study-reconcile.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const R = "src/core/studyReconcile.ts", H = "src/core/studyRecordHost.ts", A = "src/cli/admin.ts";
const MUT = [
  [R, "if (c.actor.kind !== \"human\") return fail(", "if (false) return fail("],
  [R, "if (header === null) return fail(", "if (false) return fail("],
  [R, "if (existsSync(join(engine, \"lease\"))) return fail(", "if (false) return fail("],
  [R, "if (cfg?.study?.studyId !== c.study.studyId) continue;", ""],
  [R, "if (ev.projectId !== projectId) continue;", ""],
  [R, "if (!decisionRow) {", "if (false) {"],
  [R, "if (allowed && !outcomeRow) {", "if (false) {"],
  [R, "time: decisionRow.time,", "time: new Date().toISOString(),"],
  [R, "...(outcomeRow ? { outcomeTime: outcomeRow.time } : {}),", ""],
  [R, "prefix: BACKFILL_PREFIX,", "prefix: \"\","],
  [R, "const missing = drafts.filter((d) => !existing.rows.some(", "const missing = drafts.filter((d) => existing.rows.some("],
  [R, "!dryRun);", "true);"],
  [R, "if (missing.length === 0) return { ok: true, state: \"nothing-to-do\"", "if (false) return { ok: true, state: \"nothing-to-do\""],
  [R, "const next = requestRows[i + 1]?.seq ?? Infinity;", "const next = Infinity;"],
  [R, " && (r.event as { configHash?: unknown }).configHash === ev.configHash);", ");"],
  [R, "return r.seq > decisionRow.seq && e.phase === \"outcome\"", "return e.phase === \"outcome\""],
  [R, "keys.some((k) => k !== \"dryRun\") ||", ""],
  [R, "actor: gate.actor ?? c.actor,", "actor: c.actor,"],
  [R, "outcomeEvent && outcomeEvent.ok === true ?", "outcomeEvent ?"],
  [H, "const outcomeTime = a.outcomeTime ?? time;", "const outcomeTime = time;"],
  [H, "const pre = a.prefix ?? \"\";", "const pre = \"\";"],
  [A, "\"oracle-status\", \"reconcile-study\"]", "\"oracle-status\"]"]
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
  const r = spawnSync("npx", ["vitest", "run", "tests/study-reconcile.test.ts", "tests/study-record.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 400000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
