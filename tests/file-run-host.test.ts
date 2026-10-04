import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { appendAdmission, readHostJson, withEngineLease, writeHostJson } from "../src/core/hostFiles";
import { runFromHostFile, saveHostConfiguration, validateHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { readRequest, runCli } from "../src/cli/seed";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function fixture(delayMs = 10) {
  const root = mkdtempSync(join(tmpdir(), "seed file host spaces ")); dirs.push(root);
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "CLI fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const model = JSON.stringify({ name: "case", counter: 1, fake: { validate: "ok" } });
  mkdirSync(join(repo, "models")); writeFileSync(join(repo, "models/case.json"), model); writeFileSync(join(project, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "p_top", value: 0.02, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = { schema: "seed.oracle/0.1", oracleId: "test-one", entryVersion: 1, adapter: "fake", adapterVersions: ["*"], tag: "good", inputs,
    expected, tolerance, source: { kind: "hand", text: "test", check: "independent fixture" }, coverage: { quantities: ["p_top"], domain: "fixture" }, toleranceHash: sha256Hex(canonicalJson({ expected, tolerance })) };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries); expect(indexed.errors).toEqual([]);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: "fake", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json"); writeHostJson(evidence, result);
  const runtime = resolve(__dirname, "fixtures/fake-adapter/cli.cjs");
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const config: HostConfiguration = { schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "fake", version: "0.1.0", command: process.execPath, args: [runtime] }, actor: { kind: "agent", name: "test-agent", model: "fixture" },
    study: { studyId: "study", tier: "A1", budget, parameters: [] }, cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: [], settings: { scenario: "success", delayMs } } },
    runtime: { path: runtime, sha256: sha256Hex(readFileSync(runtime)) }, oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: result.pins };
  const file = join(root, "host.json"); saveHostConfiguration(file, config);
  const engineRoot = join(state, "engines", sha256Hex(runtime));
  return { root, project, state, repo, config, file, budget, engineRoot, request: { requestId: "cli1", caseId: "approved", budget } };
}
function rows(root: string) { return readFileSync(join(root, "admissions.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s)); }
function cli(file: string, input: unknown, args = ["run"]) {
  const r = spawnSync(process.execPath, [resolve(__dirname, "../dist/cli/seed.js"), ...args], { input: JSON.stringify(input), encoding: "utf8", timeout: 30000, env: { ...process.env, SEED_HOST_CONFIG: file } });
  expect(r.error).toBeUndefined(); expect(r.stderr).toBe("");
  expect(r.stdout.trim().split("\n")).toHaveLength(1); return { ...r, reply: JSON.parse(r.stdout) };
}
it("uses the validated project's configured runs folder", async () => {
  const f = await fixture(); const p = openProject(f.project);
  if (!p.ok) throw Error("fixture project failed");
  (p.value.manifest.folders as { runs: string }).runs = "calculations";
  mkdirSync(join(f.project, "calculations"));
  expect(saveProject(f.project, p.value.manifest, p.value.revision).ok).toBe(true);
  const r = cli(f.file, f.request); expect(r.status).toBe(0);
  expect(existsSync(join(f.project, "calculations", r.reply.runId))).toBe(true);
  expect(readdirSync(join(f.project, "runs"))).toEqual([]);
});
it("persists configuration and admits a real subprocess through the CLI with durable evidence", async () => {
  const f = await fixture(); const r = cli(f.file, f.request);
  expect(r.status).toBe(0); expect(r.reply.state).toBe("completed");
  expect(readHostJson(f.file)).toEqual(f.config);
  const log = rows(f.engineRoot); expect(log.map(x => x.event.phase)).toEqual(["request", "decision", "outcome"]);
  expect(log[1].event.event.decision.allow).toBe(true); expect(log[2].event.event.runId).toBe(r.reply.runId);
  expect(log[0].event.event.configuration).toEqual(f.config);
  expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
});
it("fresh CLI processes reload revoked grants and policy", async () => {
  const f = await fixture(); f.config.study.tier = "A0";
  f.config.grants = [{ grantId: "g1", studyId: "study", actor: { kind: "agent", name: "test-agent" }, operation: "run_case", inputRevisions: [{ artifact: "models/case.json", revision: f.config.cases.approved!.inputs[0]!.sha256 }], issuedAt: "2000-01-01T00:00:00Z", expires: "2099-01-01T00:00:00Z", approvedBy: { kind: "human", name: "owner" } }];
  saveHostConfiguration(f.file, f.config); expect(cli(f.file, f.request).status).toBe(0);
  f.config.grants[0]!.revoked = true; saveHostConfiguration(f.file, f.config);
  const r = cli(f.file, { ...f.request, requestId: "revoked" }); expect(r.status).toBe(2); expect(r.reply.errors[0].code).toBe("E_NOT_PERMITTED");
  expect(rows(f.engineRoot).filter(x => x.event.phase === "decision").map(x => x.event.event.decision.allow)).toEqual([true, false]);
});
it("rejects client authority overrides, unknown cases, and unknown CLI approval/config verbs", async () => {
  const f = await fixture();
  for (const request of [{ ...f.request, actor: { kind: "human" } }, { ...f.request, caseId: "unknown" }, { ...f.request, context: { tier: "A3" } }]) expect(cli(f.file, request).status).toBe(2);
  expect(cli(f.file, f.request, ["approve"]).reply.errors[0].code).toBe("E_VERB_UNKNOWN");
  expect(readdirSync(join(f.project, "runs"))).toEqual([]);
});
for (const kind of ["evidence", "entry", "input", "commit", "runtime"] as const) it(`blocks changed ${kind} before run creation`, async () => {
  const f = await fixture();
  if (kind === "evidence") writeFileSync(f.config.oracles.evidenceFile, "{}");
  if (kind === "entry") writeFileSync(join(f.config.oracles.entriesDir, "one.json"), "{}");
  if (kind === "input") writeFileSync(join(f.repo, "models/case.json"), "changed");
  if (kind === "commit") expect(spawnSync("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "new commit"]).status).toBe(0);
  if (kind === "runtime") { f.config.runtime.sha256 = "0".repeat(64); saveHostConfiguration(f.file, f.config); }
  expect(cli(f.file, f.request).status).toBe(2); expect(readdirSync(join(f.project, "runs"))).toEqual([]);
});
it("does not reset a corrupt or partial admission log", async () => {
  const f = await fixture(); expect(cli(f.file, f.request).status).toBe(0);
  const log = join(f.engineRoot, "admissions.jsonl"); const text = readFileSync(log, "utf8"); writeFileSync(log, text + "partial");
  expect(cli(f.file, { ...f.request, requestId: "next" }).status).toBe(2); expect(readFileSync(log, "utf8")).toBe(text + "partial");
});
it("host files cannot be inside the project and config versions fail closed", async () => {
  const f = await fixture(); expect(() => saveHostConfiguration(join(f.project, "host.json"), f.config)).toThrow(/outside/);
  expect(() => validateHostConfiguration({ ...f.config, schema: "seed.host/999" })).toThrow();
  expect(() => validateHostConfiguration({ ...f.config, actor: { kind: "agent", name: "bad" } })).toThrow();
  expect(() => validateHostConfiguration({ ...f.config, approve: true })).toThrow();
});
it("linked engine directories cannot redirect writes outside host state", async () => {
  const root = mkdtempSync(join(tmpdir(), "seed-journal-link-")); dirs.push(root);
  const target = join(root, "target"); mkdirSync(target); writeFileSync(join(target, "sentinel"), "untouched"); mkdirSync(join(root, "state"));
  symlinkSync(target, join(root, "state/engines"), process.platform === "win32" ? "junction" : "dir");
  await expect(withEngineLease(join(root, "state"), "runtime", async engine => appendAdmission(engine, { data: "bad" }))).rejects.toThrow();
  expect(readdirSync(target)).toEqual(["sentinel"]); expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched");
});

it("separate command-line processes share the engine lease", async () => {
  const f = await fixture(2000);
  const child = spawn(process.execPath, [resolve(__dirname, "../dist/cli/seed.js"), "run"], { env: { ...process.env, SEED_HOST_CONFIG: f.file }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => { output += b; }); const done = new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  child.stdin.end(JSON.stringify(f.request));
  try {
    const limit = Date.now() + 10000; while (!existsSync(join(f.engineRoot, "lease")) && Date.now() < limit) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
    expect(cli(f.file, { ...f.request, requestId: "parallel" }).reply.errors[0].code).toBe("E_BUDGET_EXCEEDED");
    expect(await done).toBe(0); expect(JSON.parse(output).state).toBe("completed");
  } finally { if (child.exitCode === null) { child.kill(); await done; } }
});
it("bounded input rejects oversized, malformed and unfinished streams", async () => {
  await expect(readRequest(Readable.from(["{" ]))).rejects.toThrow(/one JSON/);
  await expect(readRequest(Readable.from([Buffer.alloc(1048577)]))).rejects.toThrow(/1 MiB/);
  const stream = new PassThrough(); await expect(readRequest(stream, 10)).rejects.toThrow(/timed out/); stream.destroy();
  expect((await runCli(["run"], Readable.from(["{}"]), undefined)).code).toBe(2);
});

it("persisted cases must describe all declared study parameters", async () => {
  const f = await fixture(); f.config.study.parameters = [{ id: "power", min: 0, max: 10 }];
  expect(() => validateHostConfiguration(f.config)).toThrow(/every study parameter/);
});
it("crashed engine leases stay blocked until human recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "seed-abandoned-lease-")); dirs.push(root);
  mkdirSync(join(root, "engines", sha256Hex("engine"), "lease"), { recursive: true });
  writeHostJson(join(root, "engines", sha256Hex("engine"), "lease", "owner.json"), { pid: 99999999, token: "old" });
  await expect(withEngineLease(root, "engine", async () => true)).rejects.toThrow(/E_ENGINE_BUSY/);
  expect(readHostJson(join(root, "engines", sha256Hex("engine"), "lease/owner.json")).token).toBe("old");
});
it("journal tampering is detected rather than replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "seed-tampered-journal-")); dirs.push(root);
  appendAdmission(root, { value: "before" }); const path = join(root, "admissions.jsonl");
  const tampered = readFileSync(path, "utf8").replace("before", "after"); writeFileSync(path, tampered);
  expect(() => appendAdmission(root, { value: "new" })).toThrow(/hash chain/); expect(readFileSync(path, "utf8")).toBe(tampered);
});
