// Mutation run for src/core/components.ts (W2): one change at a time, run tests/components.test.ts, restore.
// Usage: node scripts/mutate-components.cjs [index]   (commit first; the suite must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const F = "src/core/components.ts";
const M = [
  ["if (have && compareVersions(have.version, c.version) >= 0) {", "if (have && compareVersions(have.version, c.version) > 0) {"],
  ["if (have && have.origin === \"adopted\") {", "if (false) {"],
  ["if (need !== undefined && compareVersions(have.version, need) < 0) {", "if (false) {"],
  ["if (req.cache?.has(a.sha256)) continue;", ""],
  ["if (req.offline) missing.push(", "if (false) missing.push("],
  ["if (req.freeBytes !== undefined && expanded > req.freeBytes)", "if (req.freeBytes !== undefined && expanded >= req.freeBytes)"],
  ["else if (c.kind === \"library\") errors.push({ code: \"E_COMPONENT_NOT_SELECTABLE\"", "else if (false) errors.push({ code: \"E_COMPONENT_NOT_SELECTABLE\""],
  ["if (staying.has(x)) errors.push", "if (false) errors.push"],
  ["(p.via === undefined || platform.via === undefined || p.via === platform.via)", "true"],
  ["compareVersions(appVersion, v.min) < 0 ||", "false ||"],
  ["(v.max !== undefined && compareVersions(appVersion, v.max) > 0)", "false"],
  ["for (const d of [...(c.dependsOn ?? [])].sort((a, b) => a.component.localeCompare(b.component))) place(d.component);", ""],
  ["for (const id of [...asked].sort()) place(id);", "for (const id of [...asked]) place(id);"],
  ["if (def.kind === \"core\") return fail", "if (false) return fail"],
  ["if (def.kind === \"library\") return fail", "if (false) return fail"],
  ["if (needers.length) return fail", "if (false) return fail"],
  ["if (go" + "ing.has(i.component) || i.selectedByUser || i.origin === \"adopted\") continue;", "if (going.has(i.component) || i.origin === \"adopted\") continue;"],
  ["if (go" + "ing.has(i.component) || i.selectedByUser || i.origin === \"adopted\") continue;", "if (going.has(i.component) || i.selectedByUser) continue;"],
  ["if (busy.length) return fail", "if (false) return fail"],
  ["=== \"adopted\" ? \"unregister\" : \"remove\"", "=== \"adopted\" ? \"remove\" : \"remove\""],
  ["activating: [\"ready\", \"failed\", \"interrupted\"]", "activating: [\"ready\", \"failed\", \"interrupted\", \"cancelled\"]"],
  ["removing: [\"removed\", \"failed\", \"interrupted\"]", "removing: [\"removed\", \"failed\"]"],
  ["staging: [\"verifying\", \"failed\", \"cancelled\", \"interrupted\"]", "staging: [\"verifying\", \"failed\", \"cancelled\"]"],
  ["if (found.ownerAlive) return", "if (false) return"],
  ["found.activeVersion === tx.to) {", "true) {"],
  ["if (found.present === false) return", "if (true) return"],
  ["return recorded.pid === current.pid && recorded.startIdentity === current.startIdentity;", "return recorded.pid === current.pid;"],
  ["if (current === null || !recorded.startIdentity || !current.startIdentity) return false;", "if (current === null) return false;"],
  ["const cycle = findCycle(byId);", "const cycle = null as string[] | null;"],
  ["if (d.min !== undefined && compareVersions(dep.version, d.min) < 0) {", "if (false) {"],
  ["if (c.kind === \"core\" && dep.kind !== \"core\" && dep.kind !== \"library\") {", "if (false) {"],
  ["if (t.operation !== \"remove\" && t.to === undefined)", "if (false)"],
  ["if (!m.components.some((c) => c.kind === \"core\")) {", "if (false) {"]
];
const only = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
const rows = [];
for (let i = 0; i < M.length; i++) {
  if (only !== null && i !== only) continue;
  const [from, to] = M[i];
  const original = readFileSync(F, "utf8");
  if (!original.includes(from)) { rows.push([i, "NOT FOUND", from]); console.log(i, "NOT FOUND", from); continue; }
  writeFileSync(F, original.replace(from, to));
  if (!execSync("git diff --stat", { encoding: "utf8" }).trim()) { rows.push([i, "NOT APPLIED", from]); continue; }
  const r = spawnSync("npx", ["vitest", "run", "tests/components.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 120000, shell: true });
  writeFileSync(F, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 70));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
