// Mutation run for the record-source transfer (E4): one change at a time, run its tests, restore.
// Usage: node scripts/mutate-transfer-record.cjs [index]   (commit first; tests/transfer-record.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const D = "src/core/depletionRecord.ts", T = "src/core/transfer.ts", H = "src/core/transferHost.ts";
const MUT = [
  [D, "typeof doc.id !== \"string\" || !/^[0-9a-f]{64}$/.test(doc.id)", "false"],
  [D, "createHash(\"sha256\").update(canonical, \"utf8\").digest(\"hex\") !== doc.id", "false"],
  [D, "if (!(top && JSON.parse(k) === \"id\")) members.push([k, v]);", "members.push([k, v]);"],
  [D, "members.sort((a, b) => {", "[].sort((a, b) => {"],
  [D, "doc.schema !== DEPLETION_SCHEMA", "false"],
  [D, "Number.isFinite(x) && x > 0)", "Number.isFinite(x) && x >= 0)"],
  [D, "b.length !== steps.length ||", ""],
  [D, "Number.isFinite(x) && x >= 0))", "Number.isFinite(x)))"],
  [D, "if (new Set(regions.map((r) => r.name)).size !== regions.length) return", "if (false) return"],
  [D, "tDays > last)", "tDays > last + 1)"],
  [D, "tDays < 0 ||", "tDays < -1 ||"],
  [D, "return { ok: true, value: b0 + ((tDays - t0) / (ends[i]! - t0)) * (b1 - b0), interpolated: true };", "return { ok: true, value: b1, interpolated: true };"],
  [D, "const b0 = i === 0 ? 0 : r.burnupMwdPerTu[i - 1]!;", "const b0 = i === 0 ? 0 : r.burnupMwdPerTu[i]!;"],
  [D, "if (!r) return { ok: false, errors: [err(\"E_REGION_UNKNOWN\"", "if (false) return { ok: false, errors: [err(\"E_REGION_UNKNOWN\""],
  [T, "if (pin.artifact !== r.source.artifact || pin.revision !== r.source.recordSha256) invalid.push(", "if (false) invalid.push("],
  [T, "conv.factor !== r.units.factor ||", ""],
  [T, "else if (sha256Hex(text) !== r.source.recordSha256) stale.push(", "else if (false) stale.push("],
  [T, "else if (parsed.record.recordId !== r.source.recordId) stale.push(", "else if (false) stale.push("],
  [T, "        if (!b.ok) invalid.push(...b.errors);\n      }\n    }\n  }\n  if (view.targetTransfers) {\n    const t = view.targetTransfers.find((x) => x.field === r.target.field);\n    if (!t) invalid.push(err(\"E_UNSUPPORTED\", \"/target/field\", `the target app declares no transfer ${JSON.stringify(r.target.field)}`));\n    else if (!t.accepts.some((a) => a.dimension === \"burnup\"", "        if (false) invalid.push(...b.errors);\n      }\n    }\n  }\n  if (view.targetTransfers) {\n    const t = view.targetTransfers.find((x) => x.field === r.target.field);\n    if (!t) invalid.push(err(\"E_UNSUPPORTED\", \"/target/field\", `the target app declares no transfer ${JSON.stringify(r.target.field)}`));\n    else if (!t.accepts.some((a) => a.dimension === \"burnup\""],
  [T, "else if (!t.accepts.some((a) => a.dimension === \"burnup\" && (a.normalization", "else if (!t.accepts.some((a) => true && (a.normalization"],
  [T, "if (isRecordRecipe(recipeIn)) return evaluateRecordTransfer(recipeIn, view);", ""],
  [T, "value: b.value * recipe.units.factor }", "value: b.value }"],
  [T, "interpolated: b.interpolated,\n    },\n    target:", "interpolated: false,\n    },\n    target:"],
  [T, "sourceRecordId: parsed.record.recordId, ", ""],
  [T, "if (reply.output.content === opts.targetContent) return", "if (false) return"],
  [H, "if (!isRecordRecipe(recipe)) { try {", "if (true) { try {"]
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
  const r = spawnSync("npx", ["vitest", "run", "tests/transfer-record.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 400000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
