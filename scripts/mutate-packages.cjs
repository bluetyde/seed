// Mutation run for the cross-app packages code (manifest v0.2 checks, registry, resolver): one change at a time, run the tests, restore.
// Usage: node scripts/mutate-packages.cjs [index]   (commit first; tests/packages.test.ts and tests/components.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const P = "src/core/packages.ts", C = "src/core/components.ts";
const MUT = [
  [P, "!(known.get(p.record) ?? []).includes(p.version)", "false"],
  [P, "code: known.has(p.record) ? \"E_RECORD_VERSION\" : \"E_RECORD_UNKNOWN\"", "code: \"E_RECORD_UNKNOWN\""],
  [P, "if (!versions) errors.push({ code: \"E_RECORD_UNKNOWN\"", "if (false) errors.push({ code: \"E_RECORD_UNKNOWN\""],
  [P, "!versions.some((v) => v >= r.minVersion && (r.maxVersion === undefined || v <= r.maxVersion))", "false"],
  [P, "(r.maxVersion === undefined || v <= r.maxVersion)", "true"],
  [P, "if (apps.has(m.app)) errors.push", "if (false) errors.push"],
  [P, "if (ps.length === 1) out.push(", "if (ps.length >= 1) out.push("],
  [P, "const loop = findLoop(edges);\n  if (loop) errors.push", "const loop = null as string[] | null;\n  if (loop) errors.push"],
  [P, "if (invalid.length) return fail(invalid);", ""],
  [P, "else if (c.kind !== \"addon\") errors.push", "else if (false) errors.push"],
  [P, "if (!m || !c) errors.push", "if (false) errors.push"],
  [P, "if (version === undefined) return fail(", "if (false) return fail("],
  [P, "const inst = usable.find(({ app: a, c }) => installedHere(a, c.id));\n          if (inst) {", "const inst = undefined as any;\n          if (inst) {"],
  [P, "const there = usable.find(({ app: a, c }) => inPlan.has(key(a, c.id)));\n          if (there) {", "const there = undefined as any;\n          if (there) {"],
  [P, "if (usable.length === 0) {", "if (false) {"],
  [P, "usable.length === 1 ? usable[0] : undefined", "usable[0]"],
  [P, "chosenKey !== undefined ? usable.find(({ app: a, c }) => key(a, c.id) === chosenKey)", "chosenKey !== undefined ? usable[0]"],
  [P, "eligible(c, req.platform, req.appVersions[a] ?? \"0.0.0\") === null || installedHere(a, c.id)", "true"],
  [P, "addedByChain.has(key(there.app, there.c.id)) ? \"added\" : \"chosen\"", "\"chosen\""],
  [P, "else if (!wanted.has(pick.app)) wanted.set(pick.app, new Set());", ""],
  [P, "if (loop) return fail([{ code: \"E_COMPONENT_CYCLE\", component: loop[0], message: `dependency cycle across apps", "if (false) return fail([{ code: \"E_COMPONENT_CYCLE\", component: loop[0], message: `dependency cycle across apps"],
  [P, "selectedByUser: s.action === \"keep\" ? s.selectedByUser : chosen", "selectedByUser: true"],
  [P, "if (staged.has(from) && staged.has(to) && from !== to) {", "if (false) {"],
  [P, "expanded > req.freeBytes", "expanded >= req.freeBytes"],
  [P, "steps.filter((s) => s.action !== \"keep\")", "steps"],
  [P, "download += p.cost.downloadBytes;", ""],
  [P, "(c.satisfies ?? []).includes(prerequisiteId)", "true"],
  [P, ".sort((a, b) => key(a.app, a.component).localeCompare(key(b.app, b.component)))", ""],
  [C, "if (c.kind !== \"addon\") errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/consumes\")", "if (false) errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/consumes\")"],
  [C, "if (c.kind === \"library\") errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/produces\")", "if (false) errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/produces\")"],
  [C, "if (c.kind !== \"library\") errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/satisfies\")", "if (false) errors.push({ code: \"E_COMPONENT_DEPENDENCY\", ...where(\"/satisfies\")"],
  [C, "r.maxVersion !== undefined && r.maxVersion < r.minVersion", "false"],
  [C, "if (seenC.has(r.record)) errors.push", "if (false) errors.push"],
  [C, "if (seenP.has(key)) errors.push", "if (false) errors.push"],
  [C, "k.status === \"defined\" && (k.wireSchema === undefined || k.schemaSha256 === undefined)", "false"],
  [C, "if (seen.has(key)) errors.push({ code: \"E_SCHEMA_INVALID\", field: \"/kinds\"", "if (false) errors.push({ code: \"E_SCHEMA_INVALID\", field: \"/kinds\""]
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
  const r = spawnSync("npx", ["vitest", "run", "tests/packages.test.ts", "tests/components.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 240000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, file.replace("src/core/", ""), from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
