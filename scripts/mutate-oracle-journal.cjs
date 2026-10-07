// Mutation run for the oracle evaluation journal (L1): one change at a time, run the journal tests, restore.
// Usage: node scripts/mutate-oracle-journal.cjs [index]   (commit first; tests/oracle-journal.test.ts must be green)
const { spawnSync, execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const J = "src/core/oracleJournal.ts", A = "src/core/oracleAuthority.ts", H = "src/core/oracleJournalHost.ts", F = "src/core/fileRunHost.ts", T = "src/core/transferHost.ts", C = "src/cli/admin.ts";
const M = [
  [J, "if (e.verdict === \"fail\") open = {", "if (e.verdict === \"fail\" || e.verdict === \"pass\") open = {"],
  [J, "if (e.adapterVersion !== adapterVersion || e.pins === undefined || comparePins(e.pins, currentPins).length > 0) continue;", "if (e.adapterVersion !== adapterVersion) continue;"],
  [J, "if (e.adapterVersion !== adapterVersion || e.pins === undefined || comparePins(e.pins, currentPins).length > 0) continue;", "if (e.pins === undefined || comparePins(e.pins, currentPins).length > 0) continue;"],
  [J, "if (open !== null && e.clears === open.hash) open = null;", "if (open !== null) open = null;"],
  [J, "return { blocked: true, reason: \"the oracle journal is unreadable or its hash chain is broken\" };", "return { blocked: false };"],
  [J, "return { blocked: true, reason: \"the oracle journal location is not usable\" };", "return { blocked: false };"],
  [J, "return { blocked: true, reason: \"the oracle journal has a malformed row\" };", "continue;"],
  [J, "return { blocked: true, reason: \"the oracle journal has a row of an unknown kind\" };", "continue;"],
  [J, "r.verdict !== \"pass\" || r.blocked !== false || r.inputsVerified !== true;", "r.verdict !== \"pass\";"],
  [J, "r.verdict !== \"pass\" || r.blocked !== false || r.inputsVerified !== true;", "r.verdict !== \"pass\" || r.blocked !== false;"],
  [J, "if (result.verdict === \"not-run\") throw", "if (false) throw"],
  [J, "if (result.adapter !== adapter.id) throw", "if (false) throw"],
  [J, "if (result.adapterVersion !== adapter.version) throw", "if (false) throw"],
  [J, ".slice(0, 50)", ".slice(0, 500)"],
  [J, "String(r.reason).slice(0, 200)", "String(r.reason)"],
  [J, "if (now.rowHash !== rowHash) throw", "if (false) throw"],
  [J, "if (!now.blocked || now.rowHash === undefined) throw", "if (false) throw"],
  [J, "reason.trim().length < 3", "reason.trim().length < 0"],
  [J, "if (inside(project, realpathSync(path))) throw", "if (false) throw"],
  [J, "if (typeof path !== \"string\" || !isAbsolute(path)) throw", "if (false) throw"],
  [J, "if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(adapterId)) throw", "if (false) throw"],
  [A, "a.journalBlocked === true ||", ""],
  [A, "const journalBlocked = stateRoot !== undefined && typeof adapter !== \"string\" ? journalBlock(stateRoot, adapter.id, adapter.version, currentPins).blocked : false;", "const journalBlocked = false;"],
  [F, "{ id: c.adapter.id, version: c.adapter.version }, state);", "{ id: c.adapter.id, version: c.adapter.version });"],
  [F, "journalBlocked: authority.journalBlocked,", ""],
  [T, "{ id: app.adapter.id, version: app.adapter.version }, x.state);", "{ id: app.adapter.id, version: app.adapter.version });"],
  [H, "if (c.actor.kind !== \"human\") throw", "if (false) throw"],
  [H, "if (inside(project, realpathSync(file)) || inside(project, state)) throw", "if (false) throw"],
  [H, "Object.keys(request).sort().join() !== [...keys].sort().join()", "false"],
  [C, "argv[0] === \"oracle-clear\"\n            ? clearOracleFailure(hostConfig!, request)", "argv[0] === \"oracle-clear\"\n            ? oracleJournalStatus(hostConfig!, request)"]
];
const only = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
const rows = [];
for (let i = 0; i < M.length; i++) {
  if (only !== null && i !== only) continue;
  const [file, from, to] = M[i];
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { rows.push([i, "NOT FOUND", from]); console.log(i, "NOT FOUND", from.slice(0, 60)); continue; }
  writeFileSync(file, original.replace(from, to));
  if (!execSync("git diff --stat", { encoding: "utf8" }).trim()) { rows.push([i, "NOT APPLIED", from]); continue; }
  const r = spawnSync("npx", ["vitest", "run", "tests/oracle-journal.test.ts", "tests/transfer-host.test.ts", "--reporter=dot"], { encoding: "utf8", timeout: 180000, shell: true });
  writeFileSync(file, original);
  const out = (r.stdout || "") + (r.stderr || "");
  const verdict = r.error ? "HUNG" : /(\d+) failed/.test(out) ? "caught" : /passed/.test(out) ? "SURVIVED" : "NO SUMMARY";
  rows.push([i, verdict, from.slice(0, 70)]);
  console.log(i, verdict, file.replace("src/", ""), from.slice(0, 64).replace(/\n/g, " "));
}
console.log("tree clean after run:", execSync("git diff --stat", { encoding: "utf8" }).trim() === "");
console.log(rows.filter((x) => x[1] !== "caught").map((x) => x.join(" | ")).join("\n") || "all caught");
