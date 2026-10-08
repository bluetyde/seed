// Mutation run for query_model (E3): one change at a time, run its tests, restore.
// Usage: node scripts/mutate-query-model.cjs [index]   (commit first; tests/query-model.test.ts must be green; SEED_NODAL_REPO set to a NODAL checkout with --query)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const Q = "src/core/queryHost.ts", N = "adapters/nodal/cli.cjs", P = "src/core/policy.ts", M = "src/mcp/seed.ts", C = "src/cli/seed.ts";
const MUT = [
  [Q, "Object.keys(r).sort().join() !== \"caseId,query,requestId\"", "false"],
  [Q, "!ID.test(r.requestId)", "false"],
  [Q, "!ID.test(r.caseId)", "false"],
  [Q, "Array.isArray(r.query)", "false"],
  [Q, "> MAX_QUERY_BYTES) return", "> MAX_QUERY_BYTES * 100) return"],
  [Q, "if (!registered) return fail(", "if (false) return fail("],
  [Q, "if (before !== artifact.revision.hash) return fail(", "if (false) return fail("],
  [Q, "if (!decision.allow) return", "if (false) return"],
  [Q, "if (!dReply.result?.capabilities?.includes(\"query-model\")) return", "if (false) return"],
  [Q, "else if (reply.result.modelSha256 !== before)", "else if (false)"],
  [Q, "> MAX_ANSWER_BYTES) result", "> MAX_ANSWER_BYTES * 100) result"],
  [Q, "if (result.ok && readModel() !== before) result =", "if (false) result ="],
  [Q, "if (!logged.ok) return fail(", "if (false) return fail("],
  [Q, "if (!result.ok) return result;\n    return { ok: true, caseId", "return { ok: true, caseId"],
  [Q, "withProjectLock(logDir, () =>", "withProjectLock(project, () =>"],
  [Q, "queryHash: sha256Hex(queryText),", "queryHash: \"x\","],
  [Q, "...(result.ok ? { answerHash: sha256Hex(canonicalJson(result.answer)) } : { codes: result.errors.map((e) => e.code) }),", "...(result.ok ? { answerHash: \"x\" } : { codes: [] }),"],
  [Q, "if (!described.ok) return { ok: false, errors: described.errors };", ""],
  [N, "if (modelSha256 !== request.artifact.revision.hash) return fail(", "if (false) return fail("],
  [N, "if (art.escaped) return fail(typed(\"E_PATH_TRAVERSAL\", \"/artifact/path\", \"the model path leaves the project\"));\n  if (art.missing) return fail(typed(\"E_NOT_FOUND\", \"/artifact/path\", \"the model file does not exist\"));\n  const bytes = fs.readFileSync(art.abs);\n  const modelSha256", "const art2 = art;\n  const bytes = fs.readFileSync(art.abs);\n  const modelSha256"],
  [N, "E_QUERY_MODEL: \"E_SCHEMA_INVALID\"", "E_QUERY_MODEL: \"E_QUERY_INVALID\""],
  [N, "code.startsWith(\"E_QUERY_\") ? \"E_QUERY_INVALID\" : \"E_APP_FAILED\"", "\"E_APP_FAILED\""],
  [N, "const { ok: _ok, ...answer } = out;", "const answer = out;"],
  [N, "\"collect\", \"query-model\"],", "\"collect\"],"],
  [P, "  query_model: \"A0\",\n", ""],
  [M, "readOnlyHint: true,", "readOnlyHint: false,"],
  [M, "          query: z.record(z.unknown()),\n", "          query: z.record(z.unknown()),\n          path: z.string().optional(),\n"],
  [C, "\"note\", \"query\", \"cancel\"", "\"note\", \"cancel\""]
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
  if (/^(src\/mcp|src\/cli)/.test(file)) execSync("npm run build", { stdio: "ignore" });
  const r = spawnSync("npx", ["vitest", "run", "tests/query-model.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 400000, shell: true });
  writeFileSync(file, original);
  if (/^(src\/mcp|src\/cli)/.test(file)) execSync("npm run build", { stdio: "ignore" });
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
