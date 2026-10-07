// Mutation run for the sweep code (E3): apply one change at a time, run the sweep and policy tests, restore.
// Usage: node scripts/mutate-sweep.cjs   (the working tree must be committed and the suite green first)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const M = [
  ["src/core/sweep.ts", "if (total > limit) {", "if (total > limit + 1) {"],
  ["src/core/sweep.ts", "if (axis.values.length > limit) {", "if (axis.values.length > limit + 1) {"],
  ["src/core/sweep.ts", "if (FORBIDDEN_KEYS.has(axis.id))", "if (false)"],
  ["src/core/sweep.ts", "if (seen.has(axis.id))", "if (false)"],
  ["src/core/sweep.ts", "if (values.has(key))", "if (false)"],
  ["src/core/sweep.ts", "if (!Object.hasOwn(cases, def.base))", "if (!(def.base in cases))"],
  ["src/core/sweep.ts", "for (let a = def.axes.length - 1; a >= 0; a--)", "for (let a = 0; a < def.axes.length; a++)"],
  ["src/core/sweep.ts", "settings[axis.id] = value;", ""],
  ["src/core/sweep.ts", "if (param !== undefined) param.value = value;", "if (param !== undefined) param.value = param.value;"],
  ["src/core/sweep.ts", "def.axes.length > MAX_AXES", "def.axes.length > MAX_AXES + 1"],
  ["src/core/sweep.ts", "const registered = structuredClone(base);", "const registered = base;"],
  ["src/core/sweep.ts", "!study.parameters.some((b) => b.id === axis.id)", "false"],
  ["src/core/sweep.ts", "if (axis.values.length < 1)", "if (false)"],
  ["src/core/sweep.ts", "String(index).padStart(3, \"0\")", "String(index).padStart(2, \"0\")"],
  ["src/core/policy.ts", "(req.cases as number) > limit", "(req.cases as number) >= limit"],
  ["src/core/policy.ts", "(req.cases as number) < 1", "(req.cases as number) < 0"],
  ["src/core/policy.ts", "?? DEFAULT_MAX_CASES", "?? 100"],
  ["src/core/policy.ts", "if (req.operation === \"run_sweep\") {", "if (req.operation === \"run_case\") {"],
  ["src/core/policy.ts", "!Number.isSafeInteger(req.cases) ||", ""],
  ["src/core/sweepHost.ts", "new Set([\"completed\", \"terminated-by-trip\"])", "new Set([\"completed\", \"terminated-by-trip\", \"failed\"])"],
  ["src/core/sweepHost.ts", "if (changed) {", "if (false) {"],
  ["src/core/sweepHost.ts", "if (!decision.allow) {", "if (false) {"],
  ["src/core/sweepHost.ts", "Object.keys(r.budget).sort().join() !== KEYS.join() ||", ""],
  ["src/core/sweepHost.ts", "Object.hasOwn(c.sweeps, sweepId)", "(sweepId in c.sweeps)"],
  ["src/core/sweepHost.ts", "if (tooLong !== undefined) {", "if (false) {"],
  ["src/core/sweepHost.ts", "row.state = \"refused\";", "row.state = \"failed\";"],
  ["src/core/sweepHost.ts", "phase: \"finished\"", "phase: \"done\""],
  ["src/core/sweepHost.ts", "if (!expanded.ok) return { ok: false, errors: expanded.errors };", ""],
  ["src/core/sweepHost.ts", "r.requestId.length > 64 ||", ""],
  ["src/core/sweepHost.ts", "Object.keys(r).some((k) => ![\"requestId\", \"sweepId\", \"budget\"].includes(k)) ||", ""],
  ["src/core/fileRunHost.ts", "if (Object.hasOwn(c.cases, x.caseId))", "if (false)"],
  ["src/core/fileRunHost.ts", "if (!expanded.ok) throw Error(\"invalid sweep \" + sweepId + \": \"", "if (false) throw Error(\"invalid sweep \" + sweepId + \": \""]
];

const only = process.argv[2] ? Number(process.argv[2]) : null;
const results = [];
for (let i = 0; i < M.length; i++) {
  if (only !== null && i !== only) continue;
  const [file, from, to] = M[i];
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) {
    results.push([i, file, "NOT FOUND", from]);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const diff = execSync("git diff --stat", { encoding: "utf8" }).trim();
  if (!diff) {
    results.push([i, file, "NOT APPLIED", from]);
    continue;
  }
  const r = spawnSync("npx", ["vitest", "run", "tests/sweep.test.ts", "tests/sweep-host.test.ts", "tests/policy.test.ts", "--reporter=dot"], {
    encoding: "utf8",
    timeout: 240000,
    shell: true
  });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const failed = /(\d+) failed/.exec(out);
  const verdict = r.error ? "HUNG/ERROR (counts as caught only if tests did not finish)" : failed ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  results.push([i, file, verdict, from.slice(0, 70)]);
  console.log(i, verdict, file, from.slice(0, 70));
}
const left = execSync("git diff --stat", { encoding: "utf8" }).trim();
console.log("tree clean after run:", left === "");
console.log(results.filter((x) => x[2] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
