// @covers R-DISP-02, R-DISP-03, R-MCP-01
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { connectSeedMcp } from "./helpers/mcp-client";
import { recoverHostCalculation, requestHostCancellation } from "../src/core/hostControl";
import { Lesson } from "../src/main/lesson";
import { lessonHistory, saveLessonIntent, releaseLessonReservation } from "../src/core/lessonHistory";
const dirs: string[] = [];
it("unrelated flat report receipts cannot exhaust this project's history", async () => {
  const f = await fixture(), folder = join(f.state, "reports"); mkdirSync(folder);
  for (let n = 0; n < 1001; n++) writeHostJson(join(folder, n.toString(16).padStart(32, "0") + ".json"), {});
  expect(lessonHistory(f.file, 0)).toMatchObject({ items: [], blocked: false });
});
it("surfaces interrupted intent reservation and only a human can release a dead owner", async () => {
  const f = await fixture(), p = openProject(f.project); if (!p.ok) throw Error("fixture missing");
  const folder = join(f.state, "desktop-intents", sha256Hex(p.value.manifest.projectId + "\n" + realpathSync(f.project))), reservation = join(folder, "reservation");
  mkdirSync(reservation, { recursive: true }); writeHostJson(join(reservation, "owner.json"), { pid: 99999999, token: "dead-fixture" });
  expect(lessonHistory(f.file, 0)).toMatchObject({ blocked: true });
  expect(releaseLessonReservation(f.file, {}).ok).toBe(false);
  f.config.actor = { kind: "human", name: "maintainer" }; saveHostConfiguration(f.file, f.config);
  writeHostJson(join(reservation, "owner.json"), { pid: process.pid, token: "alive-fixture" });
  expect(releaseLessonReservation(f.file, {}).ok).toBe(false);
  writeHostJson(join(reservation, "owner.json"), { pid: 99999999, token: "dead-fixture" });
  expect(releaseLessonReservation(f.file, {})).toMatchObject({ ok: true, state: "intent-reservation-released" });
  expect(lessonHistory(f.file, 0).blocked).toBe(false); expect(existsSync(f.engineRoot)).toBe(false);
});
it("reserves intent capacity before launch and preserves existing entries", async () => {
  const f = await fixture(), id = "desktop-11111111-1111-4111-8111-111111111111";
  saveLessonIntent(f.file, id, "approved");
  const projectId = openProject(f.project); if (!projectId.ok) throw Error("fixture missing");
  const folder = join(f.state, "desktop-intents", sha256Hex(projectId.value.manifest.projectId + "\n" + realpathSync(f.project)));
  for (let n = 1; n < 1000; n++) writeHostJson(join(folder, `desktop-${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.json`), {});
  expect(() => saveLessonIntent(f.file, "desktop-22222222-2222-4222-8222-222222222222", "approved")).toThrow(/capacity/);
  expect(readdirSync(folder)).toHaveLength(1000);
  expect(existsSync(f.engineRoot)).toBe(false);
  expect(readHostJson(join(folder, id + ".json")).requestId).toBe(id);
});
it("reconnect observes original guarded job, requires a new heartbeat and never dispatches", async () => {
  const f = await fixture(6000); f.config.actor = { kind: "human", name: "owner" }; saveHostConfiguration(f.file, f.config);
  const requestId = "desktop-11111111-1111-4111-8111-111111111111";
  saveLessonIntent(f.file, requestId, "approved");
  expect(lessonHistory(f.file, Date.now()).items[0].status).toBe("pending admission");
  expect(existsSync(f.engineRoot)).toBe(false);
  const pending = runFromHostFile(f.file, { ...f.request, requestId });
  const reconnected = new Lesson(f.file, undefined, () => {});
  const deadline = Date.now() + 10000;
  while (!reconnected.snapshot().cancellable && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  expect(reconnected.snapshot()).toMatchObject({ busy: true, cancellable: true });
  expect(rows(f.engineRoot).filter(r => r.event.phase === "request")).toHaveLength(1);
  const beatPath = join(f.engineRoot, "lease", "heartbeat.json"), beat = readHostJson(beatPath);
  writeHostJson(beatPath, { ...beat, time: 0 });
  expect(lessonHistory(f.file, 0).items[0].status).toBe("recovery or inspection required");
  writeHostJson(beatPath, beat);
  expect(lessonHistory(f.file, Date.now()).items[0].status).toBe("recovery or inspection required");
  reconnected.cancel(); await pending;
  const restored = new Lesson(f.file, undefined, () => {});
  expect(restored.snapshot().history?.[0]).toMatchObject({ requestId, status: "cancelled" });
  const runId = readHostJson(join(f.project, "runs", "requests.json"))[requestId].runId;
  const recordPath = join(f.project, "runs", runId, "run-record.json"), record = readHostJson(recordPath);
  writeHostJson(recordPath, { ...record, state: "completed" });
  expect(lessonHistory(f.file, 0).items[0]).toMatchObject({ status: "evidence unavailable or changed" });
  writeHostJson(recordPath, record);
  f.config.study.tier = "A0"; saveHostConfiguration(f.file, f.config);
  expect(lessonHistory(f.file, 0).items[0].status).toBe("configuration changed");
  expect(rows(f.engineRoot).filter(r => r.event.phase === "request")).toHaveLength(1);
});
it("desktop lesson uses host case/budget and blocks substituted cases and duplicate clicks", async () => {
  const f = await fixture();
  let complete: ((v: any) => void) | undefined;
  const calls: any[] = [];
  const lesson = new Lesson(f.file, undefined, () => {}, async (_file, request) => {
    calls.push(request); return await new Promise(resolve => { complete = resolve; });
  });
  await lesson.run({ caseId: "approved", actor: { kind: "human" } });
  await lesson.run("unknown");
  expect(calls).toHaveLength(0);
  const running = lesson.run("approved");
  await lesson.run("approved");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ caseId: "approved", budget: f.budget });
  expect(Object.keys(calls[0]).sort()).toEqual(["budget", "caseId", "requestId"]);
  expect(lesson.snapshot().busy).toBe(true);
  complete!({ ok: false, errors: [{ message: "policy refused" }] }); await running;
  expect(lesson.snapshot()).toMatchObject({ busy: false, canSave: false, message: "policy refused" });
  await lesson.save(); expect(calls).toHaveLength(1);
});
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
function cli(file: string, input: unknown, args = ["run"], entry = "seed") {
  // the human-only verbs run through the separate admin entry and its own configuration variable
  const env = entry === "admin" ? { ...process.env, SEED_ADMIN_HOST_CONFIG: file } : { ...process.env, SEED_HOST_CONFIG: file };
  const r = spawnSync(process.execPath, [resolve(__dirname, "../dist/cli/" + entry + ".js"), ...args], { input: JSON.stringify(input), encoding: "utf8", timeout: 30000, env });
  expect(r.error).toBeUndefined(); expect(r.stderr).toBe("");
  expect(r.stdout.trim().split("\n")).toHaveLength(1); return { ...r, reply: JSON.parse(r.stdout) };
}
it("real MCP discovery and run preserve guarded host admission", async () => {
  const f = await fixture(); const m = await connectSeedMcp(f.file);
  try {
    const tools = await m.client.listTools(); expect(tools.tools.map(t => t.name)).toEqual(["seed_run_case", "seed_cancel_calculation", "seed_export_study_report", "seed_query_model", "seed_add_study_note", "seed_replay_run"]);
    expect(tools.tools[0]!.inputSchema.additionalProperties).toBe(false);
    const result = await m.client.callTool({ name: "seed_run_case", arguments: f.request });
    expect(result.isError).toBe(false); expect(result.structuredContent).toMatchObject({ ok: true, state: "completed" });
    expect(rows(f.engineRoot).map(x => x.event.phase)).toEqual(["request", "decision", "outcome"]);
    expect(m.stderr()).toBe("");
  } finally { await m.client.close(); }
});
it("MCP cancels a real adapter calculation through its live owner and records the stop", async () => {
  const f = await fixture(10000); const m = await connectSeedMcp(f.file);
  try {
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request });
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease", "active.json")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    const cancel = await m.client.callTool({ name: "seed_cancel_calculation", arguments: { requestId: f.request.requestId } });
    expect(cancel.isError).toBe(false); expect(cancel.structuredContent).toMatchObject({ state: "cancellation-requested" });
    const outcome = await pending; expect(outcome.structuredContent).toMatchObject({ ok: true, state: "cancelled" });
    expect(rows(f.engineRoot).map(x => x.event.phase)).toContain("cancel-decision");
    expect(rows(f.engineRoot).map(x => x.event.phase)).toContain("cancel-outcome");
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
  } finally { await m.client.close(); }
});
it("cancel and recovery reject unrelated requests, client authority and live-owner takeover", async () => {
  const f = await fixture(1000); const m = await connectSeedMcp(f.file);
  try {
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request });
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease", "active.json")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(requestHostCancellation(f.file, { requestId: "other" }).ok).toBe(false);
    expect(requestHostCancellation(f.file, { requestId: f.request.requestId, pid: process.pid }).ok).toBe(false);
    expect((await recoverHostCalculation(f.file, { requestId: f.request.requestId })).ok).toBe(false);
    f.config.actor = { kind: "human", name: "owner" }; saveHostConfiguration(f.file, f.config);
    expect((await recoverHostCalculation(f.file, { requestId: f.request.requestId })).ok).toBe(false);
    // Revert so the run's unchanged-host check remains satisfied.
    f.config.actor = { kind: "agent", name: "test-agent", model: "fixture" }; saveHostConfiguration(f.file, f.config);
    expect((await pending).isError).toBe(false);
  } finally { await m.client.close(); }
});
it("human recovery stops a calculation after its supervisor dies, preserving run evidence", async () => {
  const f = await fixture(10000); f.config.actor = { kind: "human", name: "owner" }; saveHostConfiguration(f.file, f.config);
  const m = await connectSeedMcp(f.file);
  const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request }).then(() => undefined, () => undefined);
  try {
    const deadline = Date.now() + 10000;
    let record: any;
    while (Date.now() < deadline) {
      const run = readdirSync(join(f.project, "runs")).find(n => n.startsWith("r-"));
      if (run && existsSync(join(f.project, "runs", run, "run-record.json"))) record = JSON.parse(readFileSync(join(f.project, "runs", run, "run-record.json"), "utf8"));
      if (record?.jobId && readHostJson(join(f.engineRoot, "lease", "active.json")).jobId === record.jobId) break; await new Promise(r => setTimeout(r, 20));
    }
    expect(record?.jobId).toBeTruthy();
    const owner = readHostJson(join(f.engineRoot, "lease", "owner.json"));
    process.kill(owner.pid, "SIGKILL"); await pending;
    const originalJob = record.jobId; record.jobId = "job-unrelated";
    writeHostJson(join(f.project, "runs", record.runId, "run-record.json"), record);
    const refused = cli(f.file, { requestId: f.request.requestId }, ["recover"], "admin");
    expect(refused.status).toBe(2); expect(refused.reply.errors[0].message).toMatch(/authoritative job identity/);
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
    expect(rows(f.engineRoot).some(x => x.event.phase === "recovery-request")).toBe(false);
    record.jobId = originalJob; writeHostJson(join(f.project, "runs", record.runId, "run-record.json"), record);
    const recovered = cli(f.file, { requestId: f.request.requestId }, ["recover"], "admin");
    expect(recovered.status, JSON.stringify(recovered.reply)).toBe(0);
    expect(recovered.reply.state).toBe("recovered-cancelled");
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.project, "runs", record.runId, "run-record.json"), "utf8")).state).toBe("cancelled");
    expect(rows(f.engineRoot).at(-1).event.phase).toBe("recovery-outcome");
  } finally { await m.client.close(); }
});
it("a transient unconfirmed stop allows a fresh cancellation attempt", async () => {
  const f = await fixture(10000);
  const wrapper = join(f.root, "retry-adapter.cjs"), flag = join(f.root, "first-cancel");
  const actual = f.config.runtime.path;
  writeFileSync(wrapper, `const fs=require('node:fs'),{spawnSync}=require('node:child_process');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const r=JSON.parse(text),verb=process.argv[2];if(verb==='cancel'&&!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'once');process.stdout.write(JSON.stringify({schema:'seed.adapter-reply/0.1',verb,requestId:r.requestId,ok:true,errors:[],warnings:[],result:{jobId:r.jobId,lifecycle:'running',cancelled:false}})+'\\n');}else{const p=spawnSync(process.execPath,[${JSON.stringify(actual)},verb],{input:text,encoding:'utf8',env:process.env});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exitCode=p.status;}});`);
  f.config.adapter.args = [wrapper]; f.config.runtime = { path: wrapper, sha256: sha256Hex(readFileSync(wrapper)) }; saveHostConfiguration(f.file, f.config);
  f.engineRoot = join(f.state, "engines", sha256Hex(realpathSync(wrapper)));
  const m = await connectSeedMcp(f.file);
  try {
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request });
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease", "active.json")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(requestHostCancellation(f.file, { requestId: f.request.requestId }).ok).toBe(true);
    while (!rows(f.engineRoot).some(x => x.event.phase === "cancel-outcome") && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(rows(f.engineRoot).find(x => x.event.phase === "cancel-outcome").event.event.ok).toBe(false);
    expect(requestHostCancellation(f.file, { requestId: f.request.requestId }).ok).toBe(true);
    expect((await pending).structuredContent).toMatchObject({ state: "cancelled" });
    expect(rows(f.engineRoot).filter(x => x.event.phase === "cancel-decision")).toHaveLength(2);
  } finally { await m.client.close(); }
});
it("an A0 run grant does not allow stopping; the owner reloads a separate cancellation grant", async () => {
  const f = await fixture(5000); f.config.study.tier = "A0";
  const grant = { grantId: "run-only", studyId: "study", actor: { kind: "agent" as const, name: "test-agent" }, operation: "run_case", inputRevisions: [{ artifact: "models/case.json", revision: f.config.cases.approved!.inputs[0]!.sha256 }], issuedAt: "2000-01-01T00:00:00Z", expires: "2099-01-01T00:00:00Z", approvedBy: { kind: "human" as const, name: "owner" } };
  f.config.grants = [grant]; saveHostConfiguration(f.file, f.config);
  const m = await connectSeedMcp(f.file);
  try {
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request });
    const deadline = Date.now() + 10000;
    while ((!existsSync(join(f.engineRoot, "admissions.jsonl")) || !rows(f.engineRoot).some(x => x.event.phase === "decision")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(requestHostCancellation(f.file, { requestId: f.request.requestId }).ok).toBe(false);
    f.config.grants.push({ ...grant, grantId: "cancel-allowed", operation: "cancel" }); saveHostConfiguration(f.file, f.config);
    expect(requestHostCancellation(f.file, { requestId: f.request.requestId }).ok).toBe(true);
    expect((await pending).structuredContent).toMatchObject({ state: "cancelled" });
    expect(rows(f.engineRoot).find(x => x.event.phase === "cancel-decision").event.event.decision).toMatchObject({ allow: true, via: "grant", grantId: "cancel-allowed" });
  } finally { await m.client.close(); }
});
it("MCP refuses client authority and unknown verbs before any host run", async () => {
  const f = await fixture(); const m = await connectSeedMcp(f.file);
  try {
    for (const args of [{ ...f.request, actor: { kind: "human" } }, { ...f.request, hostConfig: f.file }, { ...f.request, budget: { ...f.budget, extra: 1 } }, { ...f.request, budget: { ...f.budget, maxCores: 0 } }]) {
      expect((await m.client.callTool({ name: "seed_run_case", arguments: args })).isError).toBe(true);
    }
    expect((await m.client.callTool({ name: "approve", arguments: {} })).isError).toBe(true);
    expect(readdirSync(join(f.project, "runs"))).toEqual([]);
    expect(existsSync(f.engineRoot)).toBe(false);
  } finally { await m.client.close(); }
});
it("a persistent MCP connection reloads revoked approval and changed oracle evidence", async () => {
  const f = await fixture(); f.config.study.tier = "A0";
  f.config.grants = [{ grantId: "mcp-grant", studyId: "study", actor: { kind: "agent", name: "test-agent" }, operation: "run_case", inputRevisions: [{ artifact: "models/case.json", revision: f.config.cases.approved!.inputs[0]!.sha256 }], issuedAt: "2000-01-01T00:00:00Z", expires: "2099-01-01T00:00:00Z", approvedBy: { kind: "human", name: "owner" } }];
  saveHostConfiguration(f.file, f.config); const m = await connectSeedMcp(f.file);
  try {
    expect((await m.client.callTool({ name: "seed_run_case", arguments: f.request })).isError).toBe(false);
    f.config.grants[0]!.revoked = true; saveHostConfiguration(f.file, f.config);
    const refused = await m.client.callTool({ name: "seed_run_case", arguments: { ...f.request, requestId: "no-grant" } });
    expect(refused.isError).toBe(true); expect(refused.structuredContent).toMatchObject({ ok: false, errors: [{ code: "E_NOT_PERMITTED" }] });
    f.config.study.tier = "A1"; saveHostConfiguration(f.file, f.config);
    writeFileSync(f.config.oracles.evidenceFile, "{}");
    expect((await m.client.callTool({ name: "seed_run_case", arguments: { ...f.request, requestId: "changed-evidence" } })).isError).toBe(true);
    expect(rows(f.engineRoot).filter(x => x.event.phase === "outcome")).toHaveLength(3);
  } finally { await m.client.close(); }
});
it("MCP request cancellation does not release a running engine or lose its outcome record", async () => {
  const f = await fixture(1000); const m = await connectSeedMcp(f.file);
  try {
    const controller = new AbortController();
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request }, undefined, { signal: controller.signal });
    const settled = pending.then(() => false, () => true);
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
    controller.abort(); expect(await settled).toBe(true);
    expect(cli(f.file, { ...f.request, requestId: "after-cancel" }).reply.errors[0].code).toBe("E_BUDGET_EXCEEDED");
    while (existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
    expect(rows(f.engineRoot).at(-1).event).toMatchObject({ phase: "outcome", event: { ok: true, state: "completed" } });
  } finally { await m.client.close(); }
});
it("MCP stdin disconnect lets an admitted calculation finish and record its outcome", async () => {
  const f = await fixture(700);
  const child = spawn(process.execPath, [resolve(__dirname, "../dist/mcp/seed.js")], { env: { ...process.env, SEED_HOST_CONFIG: f.file }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  let stderr = ""; child.stderr.on("data", b => { stderr += b; });
  const initialized = new Promise<void>((resolve, reject) => {
    let buffer = ""; const timer = setTimeout(() => reject(Error("initialize timeout")), 10000);
    const onData = (b: Buffer) => { buffer += b.toString(); if (buffer.includes("\n")) { clearTimeout(timer); child.stdout.off("data", onData); expect(JSON.parse(buffer.split("\n")[0]!).id).toBe(1); resolve(); } };
    child.stdout.on("data", onData);
  });
  child.stdout.resume();
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "disconnect-test", version: "1" } } }) + "\n");
    await initialized;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "seed_run_case", arguments: f.request } }) + "\n");
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
    child.stdin.end();
    expect(cli(f.file, { ...f.request, requestId: "after-disconnect" }).reply.errors[0].code).toBe("E_BUDGET_EXCEEDED");
    const code = await Promise.race([exited, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(Error("MCP did not exit after outcome")), 10000); t.unref(); })]);
    expect(code).toBe(0); expect(stderr).toBe("");
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
    expect(rows(f.engineRoot).at(-1).event).toMatchObject({ phase: "outcome", event: { ok: true, state: "completed" } });
  } finally { if (child.exitCode === null) { child.kill(); await exited; } }
});
it("SDK client shutdown cannot kill the admitted calculation supervisor", async () => {
  const f = await fixture(4500); const m = await connectSeedMcp(f.file);
  const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request }).then(() => undefined, () => undefined);
  const deadline = Date.now() + 15000;
  while (!existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
  await m.client.close(); await pending;
  while (existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
  expect(existsSync(join(f.engineRoot, "lease"))).toBe(false);
  expect(rows(f.engineRoot).at(-1).event).toMatchObject({ phase: "outcome", event: { ok: true, state: "completed" } });
});
it("MCP and CLI coordinate through the same cross-process engine lease", async () => {
  const f = await fixture(2000); const m = await connectSeedMcp(f.file);
  try {
    const pending = m.client.callTool({ name: "seed_run_case", arguments: f.request });
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.engineRoot, "lease")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(join(f.engineRoot, "lease"))).toBe(true);
    expect(cli(f.file, { ...f.request, requestId: "competing-cli" }).reply.errors[0].code).toBe("E_BUDGET_EXCEEDED");
    expect((await pending).isError).toBe(false);
  } finally { await m.client.close(); }
});
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
    // the refusal is recorded without the lease (Codex E0 review): who asked, for which case and budget, and the rule that stopped it
    const refusals = readFileSync(join(f.state, "refusals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ schema: "seed.refusal/0.1", event: { phase: "engine-busy", requestId: "parallel", caseId: "approved", rule: "one active case per engine", actor: f.config.actor } });
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

// Review hardening 2026-10-05: reservation maintenance is a separate human admin entry, not a verb of the agent CLI.
it("the agent CLI has no release verb; the admin CLI needs its own human configuration", async () => {
  const f = await fixture(), p = openProject(f.project); if (!p.ok) throw Error("fixture missing");
  const folder = join(f.state, "desktop-intents", sha256Hex(p.value.manifest.projectId + "\n" + realpathSync(f.project))), reservation = join(folder, "reservation");
  mkdirSync(reservation, { recursive: true }); writeHostJson(join(reservation, "owner.json"), { pid: 99999999, token: "dead-fixture" });
  const { Readable } = await import("node:stream");
  const { runCli } = await import("../src/cli/seed");
  const { runAdminCli } = await import("../src/cli/admin");
  const empty = () => Readable.from(["{}"]);
  // the agent CLI does not know the verb, even with a human configuration
  f.config.actor = { kind: "human", name: "maintainer" }; saveHostConfiguration(f.file, f.config);
  const viaAgentCli = await runCli(["release-intent-reservation"], empty(), f.file);
  expect(viaAgentCli.code).toBe(2); expect((viaAgentCli.reply as any).errors[0].code).toBe("E_VERB_UNKNOWN");
  expect(existsSync(reservation)).toBe(true);
  const recoverViaAgentCli = await runCli(["recover"], Readable.from([JSON.stringify({ requestId: "x" })]), f.file);
  expect((recoverViaAgentCli.reply as any).errors[0].code).toBe("E_VERB_UNKNOWN");
  // the admin CLI refuses unknown verbs and a missing configuration
  expect(((await runAdminCli(["run"], empty(), f.file)).reply as any).errors[0].code).toBe("E_VERB_UNKNOWN");
  expect(((await runAdminCli(["release-intent-reservation"], empty(), undefined)).reply as any).errors[0].code).toBe("E_SETUP_REQUIRED");
  // an agent identity in the admin configuration is refused and nothing is released
  f.config.actor = { kind: "agent", name: "bot", model: "m" }; saveHostConfiguration(f.file, f.config);
  const asAgent = await runAdminCli(["release-intent-reservation"], empty(), f.file);
  expect(asAgent.code).toBe(2); expect(existsSync(reservation)).toBe(true);
  // a human configuration releases the dead owner's reservation
  f.config.actor = { kind: "human", name: "maintainer" }; saveHostConfiguration(f.file, f.config);
  const done = await runAdminCli(["release-intent-reservation"], empty(), f.file);
  expect(done).toMatchObject({ code: 0, reply: { ok: true, state: "intent-reservation-released" } });
  expect(existsSync(reservation)).toBe(false);
});

// Review hardening follow-up 2026-10-05: the full cause of an internal refusal goes to the host's diagnostics file only.
it("an internal refusal tells the caller the stage and class, and the host diagnostics file keeps the full cause", async () => {
  const f = await fixture();
  const out = await runFromHostFile(f.file, { ...f.request, caseId: "not-registered-case" });
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("expected a refusal");
  expect(out.errors[0]!.message).toBe("run not started: failed while loading the registered case (Error)");
  expect(JSON.stringify(out)).not.toMatch(/registered case is not|not registered|diagnostics/);
  const lines = readFileSync(join(f.engineRoot, "diagnostics.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ stage: "loading the registered case", kind: "Error", message: "case is not registered" });
  expect(lines[0].project).toMatch(/^p-/); expect(Number.isFinite(Date.parse(lines[0].time))).toBe(true);
});
