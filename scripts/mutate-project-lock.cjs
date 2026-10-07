// Mutation run for the project writer lock changes (src/core/projectStore.ts): one change at a time, run the lock tests, restore.
// Usage: node scripts/mutate-project-lock.cjs [index]   (commit first; the lock tests must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const F = "src/core/projectStore.ts";
const M = [
  ["if (!TRANSIENT_CODES.has(code)) throw err;", "throw err;"],
  ["if (attempt >= 5) return { state: \"held\" };", "if (attempt >= 5) return { state: \"stale\" };"],
  ["if (TRANSIENT_CODES.has(code)) refused = true;", "if (false) refused = true;"],
  ["if (refused) {", "if (false) {"],
  ["{ flag: \"wx\", encoding: \"utf8\" }", "{ flag: \"w\", encoding: \"utf8\" }"],
  ["if (code === \"EEXIST\" || code === \"ENOENT\" || TRANSIENT_CODES.has(code)) {\n          // not our folder", "if (false) {\n          // not our folder"],
  ["return !judging.isAlive(holder.pid);", "return true;"],
  ["if (holder !== null && holder.host === judging.host) {", "if (false) {"],
  ["return judging.now().getTime() - statSync(guardDir).mtimeMs > judging.graceMs;", "return judging.now().getTime() - statSync(guardDir).mtimeMs > -1;"],
  ["attempt < 20 && guardAbandoned()", "attempt < 20"],
  ["attempt < 20 && readGuardOwner()?.token === guardToken", "attempt < 20"],
  ["} else if (!TRANSIENT_CODES.has(code)) {", "} else if (true) {"],
  ["if (c !== \"EEXIST\" && c !== \"ENOENT\" && !TRANSIENT_CODES.has(c)) return", "if (true) return"],
  ["if (c === \"ENOENT\") break;", ""],
  ["if (!TRANSIENT_CODES.has(c)) return { ok: false, errors: [toInternalError(guardErr)] };", "return { ok: false, errors: [toInternalError(guardErr)] };"],
  ["if (Date.now() >= deadline) return lockedError();\n      sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));\n      continue;\n    }\n", "sleepSync(10);\n      continue;\n    }\n"]
];
const only = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
const rows = [];
for (let i = 0; i < M.length; i++) {
  if (only !== null && i !== only) continue;
  const [from, to] = M[i];
  const original = readFileSync(F, "utf8");
  if (!original.includes(from)) { rows.push([i, "NOT FOUND", from]); console.log(i, "NOT FOUND", from.slice(0, 60)); continue; }
  writeFileSync(F, original.replace(from, to));
  if (!execSync("git diff --stat", { encoding: "utf8" }).trim()) { rows.push([i, "NOT APPLIED", from]); continue; }
  const r = spawnSync("npx", ["vitest", "run", "tests/project-lock-transient.test.ts", "tests/project-store.test.ts", "tests/lock-review.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 240000, shell: true });
  writeFileSync(F, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 70).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
