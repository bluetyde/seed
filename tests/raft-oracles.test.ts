// @covers R-ADAPT-04, R-ORA-01
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as hostFiles from "../src/core/hostFiles";
import * as adapterClient from "../src/core/adapterClient";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { comparePins, loadOracleEntries, pinsOf, runOracleSet, unverifiedQuantities, type IndexedOracle, type Observed, type OracleEntry } from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";
import { runFromHostFile, saveHostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { recoverHostCalculation, requestHostCancellation } from "../src/core/hostControl";
import { isAlive } from "../src/core/procTree";
import { createProject, openProject } from "../src/core/projectStore";
import { makeHeader } from "./helpers/studyFixtures";
import { verifyStudyLog } from "../src/core/semantic";
import { exportStudyReport } from "../src/core/studyReportHost";
import { Lesson } from "../src/main/lesson";
import { proposeConclusion } from "../src/core/conclusionDraft";
import { inspectConclusion, decideConclusion, listConclusionDrafts, reviewPublication } from "../src/core/conclusionReview";
import { readRegisteredReport, reportReceiptFolder } from "../src/core/reportReceipt";
import { RunDispatcher } from "../src/core/runDispatcher";
import type { SetResult } from "../src/core/oracle";
import { connectSeedMcp } from "./helpers/mcp-client";
import { RunManager, type Budget } from "../src/core/runManager";
import { observedValue } from "./helpers/quantityValue";
import { appTree, gitStatus, hasUncommittedEdits, trackedFiles, treeChanges } from "./helpers/appTree";
import { oracleRequestId } from "./helpers/oracleRequest";
import { appDir } from "./helpers/appDir";

// RAFT's own oracle entries (oracles/seed in the RAFT repo, generated from its engine golden vectors) run through the
// adapter and the run manager. Needs the RAFT repo with the built headless runner and the entries; skipped otherwise.
const repo = process.env.SEED_RAFT_REPO ?? join(appDir("raft"));
const bundle = join(repo, "web", "dist-headless", "raft-headless.mjs");
const base = join(repo, "oracles", "seed");
const have = existsSync(bundle) && existsSync(join(base, "entries"));
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "raft", "cli.cjs")], id: "raft", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "oracle-runner", model: "test-model" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const saved = { h: process.env.SEED_RAFT_HEADLESS, o: process.env.SEED_RAFT_ORACLES };

const appCommit = (() => {
  const r = spawnSync("git", ["-c", "safe.directory=" + repo.replaceAll("\\", "/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
})();

let treeBefore: Map<string, string> | undefined;
let editedBefore = false;
let statusBefore = "";
beforeAll(() => {
  if (have) {
    treeBefore = appTree(repo);
    editedBefore = hasUncommittedEdits(repo);
    statusBefore = gitStatus(repo);
  }
  process.env.SEED_RAFT_HEADLESS = bundle;
  process.env.SEED_RAFT_ORACLES = join(base, "entries");
});
afterAll(() => {
  for (const [k, v] of [["SEED_RAFT_HEADLESS", saved.h], ["SEED_RAFT_ORACLES", saved.o]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!have) console.warn(`RAFT oracle entries or runner not found under ${repo}: the oracle tests were skipped`);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one entry the way a host would: bad-input through the validate verb, good through the run manager. */
async function observe(entry: OracleEntry, baseDir: string, gateSet?: SetResult): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), "seed-raft-oracle-"));
  dirs.push(root);
  for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
  for (const i of entry.inputs) {
    mkdirSync(join(root, dirname(i.path)), { recursive: true });
    cpSync(join(baseDir, i.path), join(root, i.path));
  }
  const casePath = entry.inputs[0]!.path;
  const artifact = { path: casePath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
  if (entry.tag === "bad-input") {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: root, timeoutMs: 30000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const r = o.reply as { ok: boolean; result?: { problems: { code: string }[] } };
    const first = r.result?.problems[0];
    return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
  }
  const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 });
  const out = gateSet ? await new RunDispatcher({
    manager: { projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 },
    actor, engine: "raft-oracle-guarded-test", loadCase: async () => ({ artifact, inputs: entry.inputs, settings: { case: casePath }, params: [] }),
    loadAuthority: async () => ({ context: { study }, currentPins: gateSet.pins, acceptedPins: gateSet.pins, oracleResult: gateSet }),
    audit: async event => { expect(event.decision.allow).toBe(true); writeFileSync(join(root, "admission.json"), JSON.stringify(event)); },
  }).start({ requestId: "guarded-real", caseId: "approved-case", budget }) :
    await mgr.start({ requestId: oracleRequestId(entry.oracleId), actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  return { kind: "value", quantity: q.name, value: observedValue(q, root), unit: q.unit };
}

const observed = new Map<string, Observed>();
async function cached(entry: OracleEntry, baseDir = base): Promise<Observed> {
  const hit = observed.get(entry.oracleId);
  if (hit) return structuredClone(hit);
  const o = await observe(entry, baseDir);
  observed.set(entry.oracleId, o);
  return structuredClone(o);
}

const study = { studyId: "s1", tier: "A3" as const, budget, parameters: [] };
const gate = (blocked: boolean) => evaluateGate({ operation: "run_case", actor, studyId: "s1" }, { study: { ...study, budget: { ...budget } }, oracleBlocked: blocked });

describe.skipIf(!have)("RAFT oracle set through the SEED adapter", () => {
  it("loads 22 entries, all pinned and valid", () => {
    const r = loadOracleEntries(join(base, "entries"));
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(22);
    expect(r.entries.filter((i) => i.entry.tag === "good")).toHaveLength(18);
    expect(r.entries.filter((i) => i.entry.tag === "bad-input")).toHaveLength(4);
  });

  it("the correct adapter passes every entry: set passes, inputs verified, gate open (A9 agreement with the engine vectors)", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: base, run: (e) => cached(e) });
    expect(set.results.filter((r) => r.verdict !== "pass")).toEqual([]);
    expect(set.verdict).toBe("pass");
    expect(set.inputsVerified).toBe(true);
    expect(set.blocked).toBe(false);
    expect(gate(set.blocked).allow).toBe(true);
    // what the oracles do not cover stays unverified
    expect(unverifiedQuantities(["power", "fuelTemp", "energy", "reactivityTotal"], set, entries)).toEqual(["reactivityTotal"]);
  }, 600000);

  it("dispatches a registered real case only after the real oracle set passes", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: base, run: e => cached(e) });
    expect(set.blocked).toBe(false);
    const entry = entries.find(e => e.entry.tag === "good")!.entry;
    expect(await observe(entry, base, set)).toEqual(await cached(entry));
  }, 600000);

  it("runs a real case through persistent configuration, CLI and MCP", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: base, run: e => cached(e) });
    expect(set.blocked).toBe(false);
    const entry = entries.find(e => e.entry.tag === "good")!.entry;
    const hostRoot = mkdtempSync(join(tmpdir(), "seed-raft-host-")); dirs.push(hostRoot);
    const project = join(hostRoot, "project"), state = join(hostRoot, "state"); mkdirSync(state);
    expect(createProject(project, { name: "RAFT CLI acceptance", seedVersion: "0.1.0" }).ok).toBe(true);
    for (const input of entry.inputs) { mkdirSync(dirname(join(project, input.path)), { recursive: true }); cpSync(join(base, input.path), join(project, input.path)); }
    const evidence = join(hostRoot, "oracle-result.json"); writeHostJson(evidence, set);
    const artifact = { path: entry.inputs[0]!.path, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
    const config = join(hostRoot, "host.json");
    saveHostConfiguration(config, { schema: "seed.host/0.1", projectRoot: project, stateRoot: state, adapter: spec, actor, study,
      cases: { approved: { artifact, inputs: entry.inputs, params: [], settings: { case: artifact.path } } },
      runtime: { path: bundle, sha256: sha256Hex(readFileSync(bundle)) },
      oracles: { repository: repo, entriesDir: join(base, "entries"), inputsRoot: base, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: set.pins });
    const cli = spawnSync(process.execPath, [join(__dirname, "../dist/cli/seed.js"), "run"], { input: JSON.stringify({ requestId: "real-cli", caseId: "approved", budget }), encoding: "utf8", timeout: 120000,
      env: { ...process.env, SEED_HOST_CONFIG: config, SEED_RAFT_HEADLESS: "intentionally-wrong-client-environment" } });
    expect(cli.error).toBeUndefined(); expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout.trim().split("\n")).toHaveLength(1);
    const reply = JSON.parse(cli.stdout); expect(reply.state).toBe("completed");
    const index = JSON.parse(readFileSync(join(project, "runs", reply.runId, "results.json"), "utf8"));
    const q = index.quantities.find((q: any) => q.name === entry.expected.quantity);
    const values = JSON.parse(readFileSync(join(project, q.data.path), "utf8")).values;
    expect({ kind: "value", quantity: q.name, unit: q.unit, value: observedValue(q, project) }).toEqual(await cached(entry));
    const log = readFileSync(join(state, "engines", sha256Hex(bundle), "admissions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(log.map(row => row.event.phase)).toEqual(["request", "decision", "outcome"]);
    expect(log[1].event.event.decision.allow).toBe(true); expect(log[2].event.event.runId).toBe(reply.runId);
    const opened = openProject(project); if (!opened.ok) throw Error("project did not reopen");
    const foreignMarker = "PRIVATE-OTHER-PROJECT-CONFIGURATION";
    const sharedEngine = join(state, "engines", sha256Hex(bundle));
    for (const [phase, event] of [
      ["request", { request: { requestId: "real-mcp" }, configuration: { private: foreignMarker } }],
      ["decision", { requestId: "real-mcp", decision: { allow: true } }],
      ["outcome", { ok: true, runId: "r-other-project", state: "completed" }],
    ] as const) hostFiles.appendAdmission(sharedEngine, { phase, projectId: "other-project", configHash: sha256Hex("other-project-config"), event });
    const headerFile = join(hostRoot, "study-header.json");
    writeHostJson(headerFile, makeHeader({ studyId: study.studyId, projectId: opened.value.manifest.projectId,
      question: "How does this synthetic case evolve? <script>alert('test')</script>", hypothesis: "Examine the recorded series without making a safety claim.",
      assumptions: ["Synthetic RAFT library; limited oracle coverage", "No conclusion accepted by a human"],
      parameters: [], budget, tier: study.tier, startRevisions: entry.inputs.map((i, n) => ({ artifact: `input-${n}`, revision: i.sha256 })) }));
    const reportRecordPath = join(project, "runs", reply.runId, "run-record.json"), reportRecordBytes = readFileSync(reportRecordPath);
    writeHostJson(reportRecordPath, { ...JSON.parse(reportRecordBytes.toString()), settings: { case: artifact.path, injected: true } });
    expect((await exportStudyReport(config, headerFile, { requestId: "real-cli" })).ok).toBe(false);
    expect((await runFromHostFile(config, { requestId: "real-cli", caseId: "approved", budget })).ok).toBe(false);
    expect((await exportStudyReport(config, headerFile, { requestId: "real-cli" })).ok).toBe(false);
    writeFileSync(reportRecordPath, reportRecordBytes);
    expect(await runFromHostFile(config, { requestId: "real-cli", caseId: "approved", budget })).toMatchObject({ ok: true, state: "completed", replayed: true });
    const reportDataPath = join(project, q.data.path), reportDataBytes = readFileSync(reportDataPath);
    writeFileSync(reportDataPath, Buffer.concat([reportDataBytes, Buffer.from(" ")]));
    expect((await exportStudyReport(config, headerFile, { requestId: "real-cli" })).ok).toBe(false);
    writeFileSync(reportDataPath, reportDataBytes);
    const manifestPath = join(project, "seed.project.json"), manifestBytes = readFileSync(manifestPath);
    const outsideStudies = join(hostRoot, "outside-studies"); mkdirSync(outsideStudies);
    symlinkSync(outsideStudies, join(project, "redirect"), process.platform === "win32" ? "junction" : "dir");
    writeHostJson(manifestPath, { ...opened.value.manifest, folders: { ...(opened.value.manifest.folders as any), studies: "redirect/new-directory" } });
    try {
      expect((await exportStudyReport(config, headerFile, { requestId: "real-cli" })).ok).toBe(false);
      expect(existsSync(join(outsideStudies, "new-directory"))).toBe(false);
    } finally { writeFileSync(manifestPath, manifestBytes); unlinkSync(join(project, "redirect")); }
    const cliReport = spawnSync(process.execPath, [join(__dirname, "../dist/cli/seed.js"), "report"], {
      input: JSON.stringify({ requestId: "real-cli" }), encoding: "utf8", timeout: 30000, env: { ...process.env, SEED_HOST_CONFIG: config, SEED_STUDY_HEADER: headerFile } });
    expect(cliReport.status, cliReport.stdout + cliReport.stderr).toBe(0);
    const savedReport = JSON.parse(cliReport.stdout);
    const cliHtml = readFileSync(join(project, savedReport.report.html), "utf8");
    expect(cliHtml).toContain(reply.runId); expect(cliHtml).toContain("UNVERIFIED");
    expect(cliHtml).toContain("&lt;script&gt;"); expect(cliHtml).not.toContain("<script>alert");
    const studyDir = dirname(join(project, savedReport.report.html));
    expect(verifyStudyLog(readFileSync(join(studyDir, "study.jsonl"), "utf8").trim().split("\n"))).toEqual([]);
    const evidenceBundle = JSON.parse(readFileSync(join(studyDir, "evidence.json"), "utf8"));
    expect(JSON.stringify(evidenceBundle)).not.toContain(foreignMarker);
    for (const snapshot of evidenceBundle.snapshotFiles) expect(sha256Hex(readFileSync(join(studyDir, snapshot.path)))).toBe(snapshot.sha256);
    expect((await exportStudyReport(config, headerFile, { requestId: "real-cli" })).ok).toBe(false);
    expect((await exportStudyReport(config, headerFile, { requestId: "real-cli", path: "elsewhere" })).ok).toBe(false);
    const savedHeader = readFileSync(headerFile); writeHostJson(headerFile, { ...JSON.parse(savedHeader.toString()), tier: "A0" });
    expect((await exportStudyReport(config, headerFile, { requestId: "real-mcp" })).ok).toBe(false);
    writeFileSync(headerFile, savedHeader);
    const priorHeader = process.env.SEED_STUDY_HEADER; process.env.SEED_STUDY_HEADER = headerFile;
    const m = await connectSeedMcp(config);
    if (priorHeader === undefined) delete process.env.SEED_STUDY_HEADER; else process.env.SEED_STUDY_HEADER = priorHeader;
    try {
      const result = await m.client.callTool({ name: "seed_run_case", arguments: { requestId: "real-mcp", caseId: "approved", budget } }, undefined, { timeout: 360000 });
      expect(result.isError).toBe(false);
      const mcpReply = result.structuredContent as { state: string; runId: string };
      expect(mcpReply.state).toBe("completed");
      const mcpIndex = JSON.parse(readFileSync(join(project, "runs", mcpReply.runId, "results.json"), "utf8"));
      const mq = mcpIndex.quantities.find((q: any) => q.name === entry.expected.quantity);
      expect(JSON.parse(readFileSync(join(project, mq.data.path), "utf8")).values).toEqual(values);
      expect(m.stderr()).toBe("");
      const journal = readFileSync(join(state, "engines", sha256Hex(bundle), "admissions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.event.projectId === opened.value.manifest.projectId);
      expect(journal.slice(-3).map(row => row.event.phase)).toEqual(["request", "decision", "outcome"]);
      expect(journal.at(-1).event.event.runId).toBe(mcpReply.runId);
      const caseFile = join(project, artifact.path), caseBytes = readFileSync(caseFile);
      writeFileSync(caseFile, Buffer.concat([caseBytes, Buffer.from(" ")]));
      const mcpExport = await m.client.callTool({ name: "seed_export_study_report", arguments: { requestId: "real-mcp" } });
      writeFileSync(caseFile, caseBytes);
      expect(mcpExport.isError, JSON.stringify(mcpExport)).toBe(false);
      const exported = mcpExport.structuredContent as any;
      const mcpHtml = readFileSync(join(project, exported.report.html), "utf8");
      expect(mcpHtml).toContain(mcpReply.runId); expect(mcpHtml).toContain("UNVERIFIED");
      expect(mcpHtml).toContain("STALE");
      expect(readFileSync(join(dirname(join(project, exported.report.html)), "evidence.json"), "utf8")).not.toContain(foreignMarker);
      expect(verifyStudyLog(readFileSync(join(dirname(join(project, exported.report.html)), "study.jsonl"), "utf8").trim().split("\n"))).toEqual([]);
      if (process.env.SEED_STUDY_DEMO_OUTPUT) {
        mkdirSync(process.env.SEED_STUDY_DEMO_OUTPUT, { recursive: true });
        cpSync(studyDir, join(process.env.SEED_STUDY_DEMO_OUTPUT, "cli-study"), { recursive: true });
        cpSync(dirname(join(project, exported.report.html)), join(process.env.SEED_STUDY_DEMO_OUTPUT, "mcp-study"), { recursive: true });
      }
    } finally { await m.client.close(); }

    const desktop = new Lesson(config, headerFile, () => {}, require("../dist/mcp/supervisor.js").supervisedRun);
    await desktop.run("approved");
    expect(desktop.snapshot()).toMatchObject({ busy: false, canSave: true, message: "Calculation completed." });
    await desktop.save();
    expect(desktop.snapshot().message).toContain("Report saved:");
    expect(desktop.snapshot().canSave).toBe(false);
    const desktopId = desktop.snapshot().reportId!;
    const viewed = readRegisteredReport(config, desktopId);
    expect(viewed.html.toString()).toContain("UNVERIFIED");
    expect(() => readRegisteredReport(config, "../report.html")).toThrow();
    const receipts = reportReceiptFolder(state, project, opened.value.manifest.projectId);
    const receipt = JSON.parse(readFileSync(join(receipts, desktopId + ".json"), "utf8"));
    const draftRequest = { reportId: desktopId, claims: [{ text: "The saved synthetic case completed; quantities remain UNVERIFIED.", runs: [receipt.runId], oracles: [] }] };
    const proposed = await proposeConclusion(config, draftRequest);
    expect(proposed).toMatchObject({ ok: true, state: "conclusion-drafted" });
    expect(await proposeConclusion(config, draftRequest)).toEqual(proposed);
    expect(await proposeConclusion(config, { ...draftRequest, actor: { kind: "human", name: "forged" } })).toMatchObject({ ok: false });
    expect(await proposeConclusion(config, { ...draftRequest, accepted: true })).toMatchObject({ ok: false });
    expect(await proposeConclusion(config, { ...draftRequest, claims: [{ text: "unrelated", runs: ["foreign-run"], oracles: [] }] })).toMatchObject({ ok: false });
    expect(await proposeConclusion(config, { ...draftRequest, claims: [{ text: "unrelated", runs: [], oracles: ["foreign-oracle"] }] })).toMatchObject({ ok: false });
    expect(await proposeConclusion(config, { ...draftRequest, claims: [{ text: "uncited", runs: [], oracles: [] }] })).toMatchObject({ ok: false });
    expect(await proposeConclusion(config, { ...draftRequest, claims: [] })).toMatchObject({ ok: false });
    expect(readRegisteredReport(config, desktopId).html).toEqual(viewed.html);
    const draftPartition = join(state, "conclusion-drafts", sha256Hex(receipt.projectId + "\n" + project));
    const draftFiles = (await import("node:fs")).readdirSync(draftPartition);
    expect(draftFiles).toHaveLength(1);
    const draftPath = join(draftPartition, draftFiles[0]), draftBytes = readFileSync(draftPath);
    const draft = JSON.parse(draftBytes.toString());
    expect(draft).toMatchObject({ status: "draft", actor, claims: draftRequest.claims, reportId: desktopId });
    expect(draft.acceptedBy).toBeUndefined();
    const savedConfig = readFileSync(config);
    writeHostJson(config, { ...JSON.parse(savedConfig.toString()), actor: { kind: "human", name: "different" } });
    expect(await proposeConclusion(config, draftRequest)).toMatchObject({ ok: false });
    writeFileSync(config, savedConfig);
    const cliDraft = spawnSync(process.execPath, [join(__dirname, "..", "dist", "cli", "seed.js"), "draft-conclusion"], {
      input: JSON.stringify(draftRequest), encoding: "utf8", timeout: 30000, env: { ...process.env, SEED_HOST_CONFIG: config } });
    expect(cliDraft.status, cliDraft.stderr).toBe(0);
    expect(JSON.parse(cliDraft.stdout)).toMatchObject({ ok: true, draftId: draft.draftId });
    writeHostJson(draftPath, { ...draft, claimsHash: "altered" });
    expect(await proposeConclusion(config, draftRequest)).toMatchObject({ ok: false });
    writeFileSync(draftPath, draftBytes);
    const reviewerFile = join(hostRoot, "reviewer.json");
    writeHostJson(reviewerFile, { schema: "seed.reviewer/0.2", osUser: userInfo().username, projectId: receipt.projectId, studyId: receipt.studyId, actor: { kind: "human", name: "Test reviewer" } });
    expect(() => inspectConclusion(config, undefined, draft.draftId)).toThrow(/REVIEWER/);
    const reviewerBytes = readFileSync(reviewerFile);
    writeHostJson(reviewerFile, { ...JSON.parse(reviewerBytes.toString()), actor: { kind: "agent", name: "forged reviewer" } });
    expect(() => inspectConclusion(config, reviewerFile, draft.draftId)).toThrow(/reviewer/);
    writeHostJson(reviewerFile, { ...JSON.parse(reviewerBytes.toString()), projectId: "foreign-project" });
    expect(() => inspectConclusion(config, reviewerFile, draft.draftId)).toThrow(/reviewer/);
    writeHostJson(reviewerFile, { ...JSON.parse(reviewerBytes.toString()), osUser: "someone-else" });
    expect(() => inspectConclusion(config, reviewerFile, draft.draftId)).toThrow(/another operating-system account/);
    const { osUser: _dropped, ...withoutAccount } = JSON.parse(reviewerBytes.toString());
    writeHostJson(reviewerFile, withoutAccount);
    expect(() => inspectConclusion(config, reviewerFile, draft.draftId)).toThrow(/reviewer/);
    writeFileSync(reviewerFile, reviewerBytes);
    const reviewSnapshot = inspectConclusion(config, reviewerFile, draft.draftId);
    expect(reviewSnapshot.binding.unverified.length).toBeGreaterThan(0);
    await expect(decideConclusion(config, reviewerFile, draft.draftId, "forged", "accepted")).rejects.toThrow(/changed/);
    const inputFile = join(project, reviewSnapshot.evidence.record.inputs[0].path), inputBytes = readFileSync(inputFile);
    writeFileSync(inputFile, Buffer.concat([inputBytes, Buffer.from(" ")]));
    await expect(decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "accepted")).rejects.toThrow(/changed/);
    writeFileSync(inputFile, inputBytes);
    // Inject a failure after receipt finalization; retry keeps the one immutable acceptance and report identity.
    const hostWrite = hostFiles.writeHostJson;
    const publicationFailure = vi.spyOn(hostFiles, "writeHostJson").mockImplementation((file, value: any) => {
      if (file.endsWith(draft.draftId + "-report.json") && value.status === "published") throw Error("injected publication marker failure");
      hostWrite(file, value);
    });
    try { await expect(decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "accepted")).rejects.toThrow(/injected/); }
    finally { publicationFailure.mockRestore(); }
    const publicationPath = join(state, "conclusion-reviews", sha256Hex(receipt.projectId + "\n" + project), draft.draftId + "-report.json");
    const pendingPublication = JSON.parse(readFileSync(publicationPath, "utf8"));
    const acceptedReceipt = JSON.parse(readFileSync(join(receipts, pendingPublication.reportId + ".json"), "utf8"));
    const acceptedBundle = dirname(join(project, acceptedReceipt.files[0].path));
    const copiedSnapshot = join(acceptedBundle, reviewSnapshot.evidence.snapshotFiles[0].path), copiedBytes = readFileSync(copiedSnapshot);
    writeFileSync(copiedSnapshot, "altered copied evidence");
    await expect(decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "accepted")).rejects.toThrow(/changed/);
    expect(() => readRegisteredReport(config, pendingPublication.reportId)).toThrow(/changed/);
    writeFileSync(copiedSnapshot, copiedBytes);
    expect(hostFiles.inside(project, acceptedBundle)).toBe(true);
    renameSync(acceptedBundle, acceptedBundle + "-missing-test");
    try { await expect(decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "accepted")).rejects.toThrow(/never replace/); }
    finally { renameSync(acceptedBundle + "-missing-test", acceptedBundle); }
    expect(JSON.parse(readFileSync(publicationPath, "utf8")).reportId).toBe(pendingPublication.reportId);
    writeFileSync(inputFile, Buffer.concat([inputBytes, Buffer.from(" changed after committed acceptance")]));
    const recoverySnapshot = inspectConclusion(config, reviewerFile, draft.draftId);
    const accepted = await decideConclusion(config, reviewerFile, draft.draftId, recoverySnapshot.displayHash, "accepted");
    writeFileSync(inputFile, inputBytes);
    expect(accepted.reportId).toBeTruthy();
    expect(accepted.reportId).toBe(pendingPublication.reportId);
    expect(await decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "accepted")).toEqual(accepted);
    expect(readRegisteredReport(config, accepted.reportId).title).toContain("v2");
    expect(readRegisteredReport(config, accepted.reportId).html.toString()).toContain("Test reviewer");
    expect(readRegisteredReport(config, accepted.reportId).html.toString()).toContain("UNVERIFIED");
    expect(readRegisteredReport(config, desktopId).html).toEqual(viewed.html);
    expect(listConclusionDrafts(config, desktopId)[0].acceptedReportId).toBe(accepted.reportId);
    await expect(decideConclusion(config, reviewerFile, draft.draftId, reviewSnapshot.displayHash, "rejected")).rejects.toThrow(/differently/);
    const rejectedProposal = await proposeConclusion(config, { ...draftRequest, claims: [{ ...draftRequest.claims[0], text: "Reject this test draft." }] });
    if (!rejectedProposal.ok) throw Error("test proposal refused");
    const rejectSnapshot = inspectConclusion(config, reviewerFile, rejectedProposal.draftId);
    expect(await decideConclusion(config, reviewerFile, rejectedProposal.draftId, rejectSnapshot.displayHash, "rejected")).toEqual({ decision: "rejected", draftId: rejectedProposal.draftId });
    await expect(decideConclusion(config, reviewerFile, rejectedProposal.draftId, rejectSnapshot.displayHash, "accepted")).rejects.toThrow(/differently/);
    for (const failurePhase of ["write", "rename"] as const) {
      const proposal = await proposeConclusion(config, { ...draftRequest, claims: [{ ...draftRequest.claims[0], text: `Recover ${failurePhase} failure without another acceptance.` }] });
      if (!proposal.ok) throw Error("recovery proposal failed");
      const snapshot = inspectConclusion(config, reviewerFile, proposal.draftId);
      const write = reviewPublication.write, rename = reviewPublication.rename;
      let injected = false;
      const mock = failurePhase === "write" ? vi.spyOn(reviewPublication, "write").mockImplementation(((path: any, data: any, options: any) => {
        if (!injected && typeof path === "string" && path.includes(".accepted-" + proposal.draftId) && path.endsWith("report.html")) { injected = true; write(path, "partial"); throw Error("injected staging write"); }
        return write(path, data, options);
      }) as any) : vi.spyOn(reviewPublication, "rename").mockImplementation((from, to) => {
        if (!injected && String(from).endsWith(".accepted-" + proposal.draftId)) { injected = true; throw Error("injected staging rename"); }
        return rename(from, to);
      });
      try { await expect(decideConclusion(config, reviewerFile, proposal.draftId, snapshot.displayHash, "accepted")).rejects.toThrow(/injected/); }
      finally { mock.mockRestore(); }
      expect(injected).toBe(true);
      const reviewFile = join(state, "conclusion-reviews", sha256Hex(receipt.projectId + "\n" + project), proposal.draftId + ".json"), reviewBytes = readFileSync(reviewFile);
      const recovered = await decideConclusion(config, reviewerFile, proposal.draftId, snapshot.displayHash, "accepted");
      expect(recovered.reportId).toBeTruthy(); expect(readFileSync(reviewFile)).toEqual(reviewBytes);
      expect(await decideConclusion(config, reviewerFile, proposal.draftId, snapshot.displayHash, "accepted")).toEqual(recovered);
    }
    // L7: the Markdown copy is bound by the receipt like the HTML, so the loop below alters it too and the saved report refuses to display
    expect(receipt.schema).toBe("seed.report-receipt/0.2");
    expect(receipt.files.map((x: { path: string }) => x.path.split("/").pop())).toEqual(["report.html", "study.jsonl", "evidence.json", "report.md"]);
    for (const file of receipt.files) {
      const path = join(project, file.path), bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from(" altered")]));
      expect(() => readRegisteredReport(config, desktopId)).toThrow(/changed/);
      expect(await proposeConclusion(config, draftRequest)).toMatchObject({ ok: false });
      writeFileSync(path, bytes);
    }
    const pendingReceipt = join(receipts, "pending-" + sha256Hex(project + "\n" + receipt.requestId) + ".json");
    renameSync(join(receipts, desktopId + ".json"), pendingReceipt);
    const pendingHtml = join(project, receipt.files[0].path), originalHtml = readFileSync(pendingHtml);
    writeFileSync(pendingHtml, "edited after publication");
    expect((await exportStudyReport(config, headerFile, { requestId: receipt.requestId })).ok).toBe(false);
    expect(existsSync(pendingReceipt)).toBe(true);
    writeFileSync(pendingHtml, originalHtml);
    expect(await exportStudyReport(config, headerFile, { requestId: receipt.requestId })).toMatchObject({ ok: true, reportId: desktopId });
    expect(existsSync(pendingReceipt)).toBe(false);

    if (process.env.SEED_GUI_ACCEPTANCE === "1") {
      const { _electron } = await import("@playwright/test");
      const registry = join(hostRoot, "gui-apps.json"), catalog = join(hostRoot, "gui-catalog.json");
      writeHostJson(registry, { apps: [] }); writeHostJson(catalog, { repos: [] });
      const launchGui = () => _electron.launch({ args: [join(__dirname, "..")], env: { ...process.env,
        SEED_HOST_CONFIG: config, SEED_STUDY_HEADER: headerFile, SEED_REVIEWER_CONFIG: reviewerFile, SEED_CATALOG: catalog,
        EXPERIMENT_STUDIO_APPS: registry, EXPERIMENT_STUDIO_USER_DATA: join(hostRoot, "gui-user") } });
      let gui = await launchGui();
      try {
        let page = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html"));
        for (let n = 0; !page && n < 100; n++) { await new Promise(r => setTimeout(r, 100)); page = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html")); }
        if (!page) throw Error("lesson page missing");
        await page.locator('[data-lesson-case="approved"]').click();
        await page.getByRole("button", { name: "Save study report" }).waitFor({ timeout: 60000 });
        await page.getByRole("button", { name: "Save study report" }).click();
        let reportPage = gui.windows().find(p => p.url().startsWith("seed-report://"));
        for (let n = 0; !reportPage && n < 100; n++) { await new Promise(r => setTimeout(r, 100)); reportPage = gui.windows().find(p => p.url().startsWith("seed-report://")); }
        if (!reportPage) throw Error("saved report tab missing");
        expect(await reportPage.locator("body").textContent()).toContain("UNVERIFIED");
        expect(await reportPage.evaluate(() => typeof (window as any).host)).toBe("undefined");
        expect(await reportPage.evaluate(() => fetch("https://example.invalid/report-test").then(() => false, () => true))).toBe(true);
        const bar = gui.windows().find(p => p.url().endsWith("/renderer/index.html"))!;
        await bar.locator('[data-tab="welcome"]').click();
        expect(await page.locator("[data-lesson-status]").textContent()).toContain("Report saved:");
        expect(await page.locator("[data-lesson-status]").textContent()).toContain("No scientific conclusion has been accepted.");
        const guiId = (await page.evaluate(() => window.host.getState())).lesson.reportId!;
        const guiReceipt = JSON.parse(readFileSync(join(receipts, guiId + ".json"), "utf8"));
        const guiHtmlPath = join(project, guiReceipt.files[0].path), guiHtmlBytes = readFileSync(guiHtmlPath);
        writeFileSync(guiHtmlPath, "corrupt report");
        await page.getByRole("button", { name: "Open report", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("[data-lesson-status]")?.textContent?.includes("could not open"));
        expect((await page.evaluate(() => window.host.getState())).lesson.reportId).toBe(guiId);
        writeFileSync(guiHtmlPath, guiHtmlBytes);
        await page.getByRole("button", { name: "Open report", exact: true }).click();
        expect(gui.windows().filter(p => p.url().startsWith("seed-report://"))).toHaveLength(1);
        await bar.locator('[data-tab="welcome"]').click();
        await page.locator('[data-lesson-case="approved"]').click();
        await page.getByRole("button", { name: "Save study report" }).waitFor({ timeout: 60000 });
        await page.getByRole("button", { name: "Save study report" }).click();
        for (let n = 0; n < 100 && gui.windows().filter(p => p.url().startsWith("seed-report://")).length < 2; n++) await new Promise(r => setTimeout(r, 100));
        expect(gui.windows().filter(p => p.url().startsWith("seed-report://"))).toHaveLength(2);
        const openId = new URL(reportPage.url()).hostname;
        await bar.locator(`[data-close="report:${openId}"]`).click();
        await bar.locator('[data-tab="welcome"]').click();
        await page.getByRole("button", { name: "Open report", exact: true }).click();
        for (let n = 0; n < 100 && !gui.windows().some(p => p.url().startsWith("seed-report://")); n++) await new Promise(r => setTimeout(r, 100));
        expect(gui.windows().filter(p => p.url().startsWith("seed-report://"))).toHaveLength(1);
        const admissionPath = join(state, "engines", sha256Hex(bundle), "admissions.jsonl"), beforeRestart = readFileSync(admissionPath, "utf8");
        await gui.close(); gui = await launchGui();
        page = undefined;
        for (let n = 0; !page && n < 100; n++) { await new Promise(r => setTimeout(r, 100)); page = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html")); }
        if (!page) throw Error("restarted lesson page missing");
        await page.locator("[data-lesson-history]").waitFor();
        expect(await page.locator("[data-lesson-history]").textContent()).toContain("completed");
        await page.getByRole("button", { name: "Open report", exact: true }).click();
        for (let n = 0; n < 100 && !gui.windows().some(p => p.url().startsWith("seed-report://")); n++) await new Promise(r => setTimeout(r, 100));
        expect(gui.windows().filter(p => p.url().startsWith("seed-report://"))).toHaveLength(1);
        expect(readFileSync(admissionPath, "utf8")).toBe(beforeRestart);
        // Native dialogs receive automated test responses; this verifies routing, not a real person's decision.
        const welcomeBar = gui.windows().find(p => p.url().endsWith("/renderer/index.html"));
        if (!welcomeBar) throw Error("review bar missing");
        await welcomeBar.getByRole("tab", { name: "Welcome" }).click();
        const selectedReport = (await page.evaluate(() => window.host.getState())).lesson.reportId!;
        await page.getByRole("textbox", { name: "Draft conclusion", exact: true }).fill("GUI review test draft; values remain UNVERIFIED.");
        await page.getByRole("button", { name: "Save conclusion draft", exact: true }).click();
        await page.waitForFunction(() => window.host.getState().then(s => s.lesson.message.includes("Conclusion draft saved")));
        const guiDraft = listConclusionDrafts(config, selectedReport)[0];
        await gui.evaluate(({ dialog }) => {
          (globalThis as any).reviewPrompts = [];
          (globalThis as any).reviewResponses = [0, 2];
          dialog.showMessageBox = (async (_win: any, options: any) => {
            (globalThis as any).reviewPrompts.push(options);
            return { response: (globalThis as any).reviewResponses.shift() ?? 2, checkboxChecked: false };
          }) as any;
        });
        await page.getByRole("button", { name: "Review conclusion drafts", exact: true }).click();
        for (let n = 0; n < 100 && (await gui.evaluate(() => (globalThis as any).reviewPrompts.length)) < 2; n++) await new Promise(r => setTimeout(r, 100));
        const reviewsRoot = join(state, "conclusion-reviews", sha256Hex(receipt.projectId + "\n" + project));
        expect(existsSync(join(reviewsRoot, guiDraft.draftId + ".json"))).toBe(false);
        await page.waitForFunction(() => window.host.getState().then(s => s.lesson.message.includes("draft remains unaccepted")));
        await gui.evaluate(() => { (globalThis as any).reviewResponses = [0, 0]; });
        await gui.evaluate((_electron, modulePath) => {
          const core = (process as any).mainModule.require(modulePath), write = core.reviewPublication.write;
          let once = false;
          core.reviewPublication.write = (path: any, data: any, options: any) => {
            if (!once && typeof path === "string" && path.includes(".accepted-") && path.endsWith("report.html")) {
              once = true; write(path, "partial"); throw Error("injected desktop staging write");
            }
            return write(path, data, options);
          };
        }, join(__dirname, "..", "dist", "core", "conclusionReview.js"));
        await page.getByRole("button", { name: "Review conclusion drafts", exact: true }).click();
        await page.waitForFunction(() => window.host.getState().then(s => s.lesson.message.includes("injected desktop staging write")));
        const committedGuiReview = readFileSync(join(reviewsRoot, guiDraft.draftId + ".json"));
        await gui.evaluate(() => { (globalThis as any).reviewResponses = [0, 0]; });
        await page.getByRole("button", { name: "Review conclusion drafts", exact: true }).click();
        for (let n = 0; n < 100 && !existsSync(join(reviewsRoot, guiDraft.draftId + "-report.json")); n++) await new Promise(r => setTimeout(r, 100));
        const guiPublication = JSON.parse(readFileSync(join(reviewsRoot, guiDraft.draftId + "-report.json"), "utf8"));
        expect(guiPublication.status).toBe("published");
        for (let n = 0; n < 100 && !gui.windows().some(p => p.url() === `seed-report://${guiPublication.reportId}/report.html`); n++) await new Promise(r => setTimeout(r, 100));
        const acceptedPage = gui.windows().find(p => p.url() === `seed-report://${guiPublication.reportId}/report.html`);
        if (!acceptedPage) throw Error("accepted report tab missing");
        await acceptedPage.waitForLoadState("domcontentloaded");
        expect(await acceptedPage.locator("body").textContent()).toContain("GUI review test draft");
        expect(readRegisteredReport(config, guiPublication.reportId).title).toContain("v2");
        const prompts = await gui.evaluate(() => (globalThis as any).reviewPrompts);
        expect(prompts[1].detail).toContain("UNVERIFIED"); expect(prompts[1].detail).toContain("GUI review test draft");
        expect(prompts[1].defaultId).toBe(2);
        expect(prompts[5].buttons[0]).toBe("Finish accepted report");
        expect(readFileSync(join(reviewsRoot, guiDraft.draftId + ".json"))).toEqual(committedGuiReview);
        expect(readFileSync(admissionPath, "utf8")).toBe(beforeRestart);
        await gui.close(); gui = await launchGui();
        let restartedReviewPage = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html"));
        for (let n = 0; !restartedReviewPage && n < 100; n++) { await new Promise(r => setTimeout(r, 100)); restartedReviewPage = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html")); }
        if (!restartedReviewPage) throw Error("accepted history restart page missing");
        await gui.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any; });
        await restartedReviewPage.getByRole("button", { name: "Review conclusion drafts", exact: true }).click();
        for (let n = 0; n < 100 && !gui.windows().some(p => p.url() === `seed-report://${guiPublication.reportId}/report.html`); n++) await new Promise(r => setTimeout(r, 100));
        expect(gui.windows().some(p => p.url() === `seed-report://${guiPublication.reportId}/report.html`)).toBe(true);
        expect(readFileSync(admissionPath, "utf8")).toBe(beforeRestart);
      } finally { await gui.close(); }
    }

    // Lifecycle acceptance only: lengthen a registered synthetic case, without claiming new physics oracle coverage.
    const host = JSON.parse(readFileSync(config, "utf8"));
    const longPath = "models/recovery-long.json";
    const longCase = JSON.parse(readFileSync(join(project, artifact.path), "utf8"));
    longCase.steps = 2_000_000; longCase.sampleEvery = 100_000;
    writeHostJson(join(project, longPath), longCase);
    const longHash = sha256Hex(readFileSync(join(project, longPath)));
    host.actor = { kind: "human", name: "recovery-acceptance" };
    host.cases.long = { artifact: { path: longPath, revision: { hash: longHash, counter: 1 } },
      inputs: [...entry.inputs.filter(i => i.path !== artifact.path), { path: longPath, sha256: longHash }], params: [], settings: { case: longPath } };
    saveHostConfiguration(config, host);
    if (process.env.SEED_GUI_ACCEPTANCE === "1") {
      const { _electron } = await import("@playwright/test");
      const launch = () => _electron.launch({ args: [join(__dirname, "..")], env: { ...process.env, SEED_HOST_CONFIG: config, SEED_STUDY_HEADER: headerFile,
        SEED_CATALOG: join(hostRoot, "gui-catalog.json"), EXPERIMENT_STUDIO_APPS: join(hostRoot, "gui-apps.json"), EXPERIMENT_STUDIO_USER_DATA: join(hostRoot, "reconnect-user") } });
      let gui = await launch();
      const welcome = async () => {
        for (let n = 0; n < 100; n++) { const page = gui.windows().find(p => p.url().endsWith("/renderer/welcome.html")); if (page) return page; await new Promise(r => setTimeout(r, 100)); }
        throw Error("reconnection welcome missing");
      };
      try {
        let page = await welcome(); await page.locator('[data-lesson-case="long"]').click();
        const enginePath = join(state, "engines", sha256Hex(bundle)), activePath = join(enginePath, "lease/active.json");
        let binding: any;
        for (let n = 0; n < 1500; n++) { if (existsSync(activePath)) binding = JSON.parse(readFileSync(activePath, "utf8")); if (binding?.jobId) break; await new Promise(r => setTimeout(r, 20)); }
        expect(binding?.jobId).toBeTruthy(); const id = binding.requestId;
        const original = JSON.parse(readFileSync(join(enginePath, "lease/owner.json"), "utf8")); expect(isAlive(original.pid)).toBe(true);
        await gui.close(); gui = await launch(); page = await welcome();
        await page.waitForFunction(id => window.host.getState().then(s => s.lesson.history?.some(i => i.requestId === id && ["running", "completed"].includes(i.status))), id, { timeout: 30000 });
        const observed = (await page.evaluate(() => window.host.getState())).lesson.history?.find(i => i.requestId === id);
        if (observed?.status === "running" && await page.getByRole("button", { name: "Cancel calculation", exact: true }).isVisible()) await page.getByRole("button", { name: "Cancel calculation", exact: true }).click();
        await page.waitForFunction(id => window.host.getState().then(s => s.lesson.history?.some(i => i.requestId === id && ["cancelled", "completed"].includes(i.status))), id, { timeout: 30000 });
        expect(hostFiles.readAdmissions(enginePath).filter((r: any) => r.event.phase === "request" && r.event.event.request?.requestId === id)).toHaveLength(1);
      } finally {
        await gui.close();
        const activePath = join(state, "engines", sha256Hex(bundle), "lease/active.json");
        if (existsSync(activePath)) {
          const activeRequest = JSON.parse(readFileSync(activePath, "utf8")).requestId;
          if (typeof activeRequest === "string" && activeRequest.startsWith("desktop-")) requestHostCancellation(config, { requestId: activeRequest });
          for (let n = 0; n < 100 && existsSync(activePath); n++) await new Promise(r => setTimeout(r, 100));
        }
      }
    }
    const crashed = await connectSeedMcp(config);
    const pending = crashed.client.callTool({ name: "seed_run_case", arguments: { requestId: "real-crash", caseId: "long", budget } }, undefined, { timeout: 360000 }).then(() => undefined, () => undefined);
    const engine = join(state, "engines", sha256Hex(bundle));
    let active: any, nativeDir: string | undefined;
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const activeFile = join(engine, "lease", "active.json");
        if (existsSync(activeFile)) active = JSON.parse(readFileSync(activeFile, "utf8"));
        if (active?.jobId) {
          nativeDir = join(project, "runs", active.runId, "native");
          if (existsSync(join(nativeDir, "child.json")) && existsSync(join(nativeDir, "heartbeat.json"))) break;
        }
        await new Promise(r => setTimeout(r, 20));
      }
      expect(active?.jobId).toBeTruthy();
      expect(nativeDir).toBeTruthy();
      const job = JSON.parse(readFileSync(join(nativeDir!, "job.json"), "utf8"));
      const child = JSON.parse(readFileSync(join(nativeDir!, "child.json"), "utf8"));
      expect(isAlive(job.pid)).toBe(true); expect(isAlive(child.pid)).toBe(true);
      expect(await recoverHostCalculation(config, { requestId: "real-crash" })).toMatchObject({ ok: false,
        errors: [{ message: "owner is alive or its identity is ambiguous; recovery refused" }] });
      const owner = JSON.parse(readFileSync(join(engine, "lease", "owner.json"), "utf8"));
      process.kill(owner.pid, "SIGKILL"); await pending;
      const registryPath = join(project, ".seed", "jobs", active.jobId + ".json");
      const registryBytes = readFileSync(registryPath);
      const otherJobPath = join(project, "runs", reply.runId, "native", "job.json");
      const otherJobBytes = readFileSync(otherJobPath);
      writeHostJson(registryPath, { runDir: `runs/${reply.runId}` });
      writeHostJson(otherJobPath, { ...JSON.parse(otherJobBytes.toString()), jobId: active.jobId });
      try {
        expect((await recoverHostCalculation(config, { requestId: "real-crash" })).ok).toBe(false);
        expect(isAlive(job.pid)).toBe(true); expect(isAlive(child.pid)).toBe(true);
        expect(existsSync(join(engine, "lease"))).toBe(true);
      } finally { writeFileSync(registryPath, registryBytes); writeFileSync(otherJobPath, otherJobBytes); }
      // Project-writable metadata cannot substitute dead PIDs for the protected launch identities.
      const jobPath = join(nativeDir!, "job.json"), childPath = join(nativeDir!, "child.json"), statusPath = join(nativeDir!, "status.json");
      const savedStatus = readFileSync(statusPath);
      writeHostJson(jobPath, { ...job, pid: null }); writeHostJson(childPath, { pid: 99999999 }); writeHostJson(statusPath, { status: "finished" });
      try {
        expect(await recoverHostCalculation(config, { requestId: "real-crash" })).toMatchObject({ ok: false,
          errors: [{ message: "adapter stop not confirmed; lease retained for inspection" }] });
        expect(existsSync(join(engine, "lease"))).toBe(true);
      } finally { writeHostJson(jobPath, job); writeHostJson(childPath, child); writeFileSync(statusPath, savedStatus); }
      expect(await runFromHostFile(config, { requestId: "blocked-after-crash", caseId: "approved", budget })).toMatchObject({ ok: false,
        errors: [{ code: "E_BUDGET_EXCEEDED", message: expect.stringContaining("E_ENGINE_BUSY") }] });
      const append = hostFiles.appendAdmission;
      const failingAudit = vi.spyOn(hostFiles, "appendAdmission").mockImplementation((root, event: any) => {
        if (event.phase === "recovery-outcome") throw Error("injected audit interruption after saved cancellation");
        return append(root, event);
      });
      try { expect((await recoverHostCalculation(config, { requestId: "real-crash" })).ok).toBe(false); }
      finally { failingAudit.mockRestore(); }
      const cancelledPath = join(project, "runs", active.runId, "run-record.json");
      const cancelledBytes = readFileSync(cancelledPath);
      expect(JSON.parse(cancelledBytes.toString()).state).toBe("cancelled");
      expect(existsSync(join(engine, "lease"))).toBe(true);
      const recovery = spawnSync(process.execPath, [join(__dirname, "../dist/cli/admin.js"), "recover"], {
        input: JSON.stringify({ requestId: "real-crash" }), encoding: "utf8", timeout: 30000, env: { ...process.env, SEED_ADMIN_HOST_CONFIG: config } });
      expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
      expect(JSON.parse(recovery.stdout)).toMatchObject({ state: "recovered-cancelled", runId: active.runId });
      expect(isAlive(job.pid)).toBe(false); expect(isAlive(child.pid)).toBe(false);
      expect(readFileSync(cancelledPath)).toEqual(cancelledBytes);
      expect(existsSync(join(engine, "lease"))).toBe(false);
      expect(JSON.parse(readFileSync(join(project, "runs", active.runId, "run-record.json"), "utf8")).state).toBe("cancelled");
      const recoveredLog = readFileSync(join(engine, "admissions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(recoveredLog.slice(-3).map(row => row.event.phase)).toEqual(["recovery-request", "recovery-stop", "recovery-outcome"]);
      expect((await runFromHostFile(config, { requestId: "after-recovery", caseId: "approved", budget })).state).toBe("completed");
    } finally {
      // Only this test's bound job; ensure a failed assertion cannot leave its runner behind.
      if (active?.jobId) await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "cancel", requestId: "acceptance-cleanup", actor: host.actor, jobId: active.jobId }, { projectRoot: project, timeoutMs: 30000 });
      await crashed.client.close();
    }

    // A second crash lets the real native calculation finish before the human collects it.
    longCase.steps = 200_000; longCase.sampleEvery = 10_000;
    writeHostJson(join(project, longPath), longCase);
    const finishedHash = sha256Hex(readFileSync(join(project, longPath)));
    host.cases.long.artifact.revision.hash = finishedHash;
    host.cases.long.inputs.find((i: any) => i.path === longPath).sha256 = finishedHash;
    saveHostConfiguration(config, host);
    const finishing = await connectSeedMcp(config);
    const abandoned = finishing.client.callTool({ name: "seed_run_case", arguments: { requestId: "real-finished-crash", caseId: "long", budget } }, undefined, { timeout: 360000 }).then(() => undefined, () => undefined);
    active = undefined;
    try {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const f = join(engine, "lease", "active.json");
        if (existsSync(f)) active = JSON.parse(readFileSync(f, "utf8"));
        if (active?.jobId) break;
        await new Promise(r => setTimeout(r, 10));
      }
      expect(active?.jobId).toBeTruthy();
      const owner = JSON.parse(readFileSync(join(engine, "lease", "owner.json"), "utf8"));
      process.kill(owner.pid, "SIGKILL"); await abandoned;
      nativeDir = join(project, "runs", active.runId, "native");
      while (Date.now() < deadline) {
        const statusFile = join(nativeDir, "status.json");
        if (existsSync(statusFile) && JSON.parse(readFileSync(statusFile, "utf8")).status === "finished") {
          const job = JSON.parse(readFileSync(join(nativeDir, "job.json"), "utf8"));
          const child = JSON.parse(readFileSync(join(nativeDir, "child.json"), "utf8"));
          if (!isAlive(job.pid) && !isAlive(child.pid)) break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      const recordPath = join(project, "runs", active.runId, "run-record.json");
      expect(JSON.parse(readFileSync(recordPath, "utf8")).state).toBe("running");
      // Corrupt native output must retain the running record and external lease.
      const resultsPath = join(nativeDir, "out", "raft", "results.json");
      const original = readFileSync(resultsPath);
      writeFileSync(resultsPath, "{}");
      expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
      expect(existsSync(join(engine, "lease"))).toBe(true);
      expect(JSON.parse(readFileSync(recordPath, "utf8")).state).toBe("running");
      writeFileSync(resultsPath, original);
      const append = hostFiles.appendAdmission;
      const failingAudit = vi.spyOn(hostFiles, "appendAdmission").mockImplementation((root, event: any) => {
        if (event.phase === "recovery-outcome") throw Error("injected audit interruption after saved completion");
        return append(root, event);
      });
      try { expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false); }
      finally { failingAudit.mockRestore(); }
      const terminalBytes = readFileSync(recordPath);
      const finished = JSON.parse(readFileSync(recordPath, "utf8"));
      expect(finished.state).toBe("completed"); expect(finished.outputs.length).toBeGreaterThan(0);
      for (const output of finished.outputs) expect(sha256Hex(readFileSync(join(project, output.path)))).toBe(output.sha256);
      expect(existsSync(join(engine, "lease"))).toBe(true);
      writeHostJson(recordPath, { ...finished, state: "cancelled" });
      expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
      expect(existsSync(join(engine, "lease"))).toBe(true);
      writeFileSync(recordPath, terminalBytes);
      const journalPath = join(engine, "admissions.jsonl"), journalBytes = readFileSync(journalPath);
      writeFileSync(journalPath, Buffer.concat([journalBytes, Buffer.from('{"partial":')]));
      expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
      expect(readFileSync(recordPath)).toEqual(terminalBytes); expect(existsSync(join(engine, "lease"))).toBe(true);
      expect(readFileSync(journalPath)).toEqual(Buffer.concat([journalBytes, Buffer.from('{"partial":')]));
      writeFileSync(journalPath, journalBytes); // Fixture restoration only; production never repairs the audit log automatically.
      const outputPath = join(project, finished.outputs[0].path), outputBytes = readFileSync(outputPath);
      writeFileSync(outputPath, "{}");
      expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
      expect(readFileSync(recordPath)).toEqual(terminalBytes); expect(existsSync(join(engine, "lease"))).toBe(true);
      writeFileSync(outputPath, outputBytes);
      // A hash-consistent but invalid saved index must not rewrite records, outputs or prior error evidence.
      const invalidRecord = structuredClone(finished);
      const invalidIndex = JSON.stringify({ schema: "seed.results-index/0.1" });
      writeFileSync(outputPath, invalidIndex); invalidRecord.outputs[0].sha256 = sha256Hex(invalidIndex);
      writeHostJson(recordPath, invalidRecord);
      const invalidBytes = readFileSync(recordPath), errorsPath = join(project, "runs", active.runId, "log", "errors.json");
      const priorErrors = readFileSync(errorsPath);
      expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
      expect(readFileSync(recordPath)).toEqual(invalidBytes); expect(readFileSync(outputPath, "utf8")).toBe(invalidIndex);
      expect(readFileSync(errorsPath)).toEqual(priorErrors); expect(existsSync(join(engine, "lease"))).toBe(true);
      writeFileSync(recordPath, terminalBytes); writeFileSync(outputPath, outputBytes);
      for (const field of ["id", "version"]) {
        const wrongIndex = JSON.parse(outputBytes.toString()); wrongIndex.adapter[field] = "unrelated-adapter";
        writeHostJson(outputPath, wrongIndex);
        const wrongRecord = structuredClone(finished); wrongRecord.outputs[0].sha256 = sha256Hex(readFileSync(outputPath));
        writeHostJson(recordPath, wrongRecord);
        const wrongBytes = readFileSync(recordPath), wrongOutput = readFileSync(outputPath);
        expect((await recoverHostCalculation(config, { requestId: "real-finished-crash" })).ok).toBe(false);
        expect(readFileSync(recordPath)).toEqual(wrongBytes); expect(readFileSync(outputPath)).toEqual(wrongOutput);
        expect(existsSync(join(engine, "lease"))).toBe(true);
        writeFileSync(recordPath, terminalBytes); writeFileSync(outputPath, outputBytes);
      }
      const savedOutputs = finished.outputs.map((output: any) => ({ path: output.path, bytes: readFileSync(join(project, output.path)) }));
      const call = adapterClient.callAdapter;
      const readOnlyVerification = vi.spyOn(adapterClient, "callAdapter").mockImplementation((spec, request: any, options) => {
        if (request.verb === "collect") throw Error("terminal verification must not invoke a mutating collector");
        return call(spec, request, options);
      });
      try { expect(await recoverHostCalculation(config, { requestId: "real-finished-crash" })).toMatchObject({ ok: true, state: "recovered-completed", runId: active.runId }); }
      finally { readOnlyVerification.mockRestore(); }
      expect(readFileSync(recordPath)).toEqual(terminalBytes);
      for (const output of savedOutputs) expect(readFileSync(join(project, output.path))).toEqual(output.bytes);
      expect(existsSync(join(engine, "lease"))).toBe(false);
    } finally {
      if (active?.jobId) await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "cancel", requestId: "finished-cleanup", actor: host.actor, jobId: active.jobId }, { projectRoot: project, timeoutMs: 30000 });
      await finishing.client.close();
    }
  }, 600000);

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 30000 });
    if (!o.ok) throw new Error("transport");
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
    expect((o.reply as { result: { resources?: unknown } }).result.resources).toEqual(JSON.parse(readFileSync(join(__dirname, "..", "adapters", "shared", "resources.json"), "utf8")).raft);
    expect([...new Set(cov.map((c) => c.quantity))].sort()).toEqual(["energy", "fuelTemp", "power"]);
    expect(cov).toHaveLength(18);
  });

  describe("a deliberately wrong adapter output fails the set and blocks the study", () => {
    const wrong: [string, (e: OracleEntry, o: Observed) => Observed][] = [
      ["perturbed power (1e-7 relative)", (e, o) => (o.kind === "value" && e.expected.quantity === "power" ? { ...o, value: o.value * (1 + 1e-7) } : o)],
      ["swapped unit", (e, o) => (o.kind === "value" && e.expected.quantity === "fuelTemp" ? { ...o, unit: "C" } : o)],
      ["dropped refusal", (e, o) => (e.tag === "bad-input" ? { kind: "verdict", verdict: "accepted" } : o)],
      ["wrong refusal code", (e, o) => (e.tag === "bad-input" ? { kind: "refusal", code: "E_UNITS" } : o)],
    ];
    it.each(wrong)("%s", async (_n, tweak) => {
      const { entries } = loadOracleEntries(join(base, "entries"));
      const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: base, run: async (e) => tweak(e, await cached(e)) });
      expect(set.verdict).toBe("fail");
      expect(set.blocked).toBe(true);
      const d = gate(set.blocked);
      expect(d.allow).toBe(false);
    }, 600000);
  });

  it("a changed model input makes its entries invalid before any case runs", async () => {
    const copy = mkdtempSync(join(tmpdir(), "seed-raft-oracles-copy-"));
    dirs.push(copy);
    cpSync(base, copy, { recursive: true });
    writeFileSync(join(copy, "models", "lib", "manifest.json"), readFileSync(join(copy, "models", "lib", "manifest.json"), "utf8") + " ");
    const { entries } = loadOracleEntries(join(copy, "entries"));
    let calls = 0;
    const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: copy, run: async (e) => { calls++; return cached(e); } });
    expect(set.results.every((r) => r.verdict === "invalid")).toBe(true);
    expect(set.blocked).toBe(true);
    expect(calls).toBe(0);
  });

  it("a tolerance edited without a new pin does not load", () => {
    const copy = mkdtempSync(join(tmpdir(), "seed-raft-oracles-tol-"));
    dirs.push(copy);
    cpSync(join(base, "entries"), copy, { recursive: true });
    const file = join(copy, "raft-pulse-final-power.json");
    const e = JSON.parse(readFileSync(file, "utf8"));
    e.tolerance = { abs: 1, rel: 1 };
    writeFileSync(file, JSON.stringify(e, null, 2));
    const r = loadOracleEntries(copy);
    expect(r.entries).toHaveLength(21);
    expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "raft-pulse-final-power.json/toleranceHash" });
  });

  it("a new RAFT commit or an edited entry file flags the pins until a human accepts them", () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const accepted = pinsOf(entries, appCommit);
    expect(comparePins(accepted, pinsOf(entries, appCommit))).toEqual([]);
    expect(comparePins(accepted, pinsOf(entries, "0".repeat(40)))).toEqual([`app commit ${appCommit} -> ${"0".repeat(40)}`]);
    const edited: IndexedOracle[] = entries.map((i, k) => (k === 0 ? { ...i, fileSha256: sha256Hex("changed") } : i));
    expect(comparePins(accepted, pinsOf(edited, appCommit))).toHaveLength(1);
    expect(evaluateGate({ operation: "run_case", actor, studyId: "s1" }, { study, pinsChanged: true }).allow).toBe(false);
  });
});

// E2 exit, "standalone launch of the app unchanged by its adapter": everything above ran the real RAFT through its adapter; its own folder must be as found.
describe.skipIf(!have)("RAFT is left as the adapter found it", () => {
  it("no file of the app's own folder was added, changed or removed by the runs above", (ctx) => {
    expect(treeBefore).toBeDefined();
    const changes = treeChanges(treeBefore!, appTree(repo), trackedFiles(repo));
    // someone was editing the app when the runs began, or changed what git sees in it while they ran (another session on this machine):
    // the changes cannot be told from theirs
    if (changes.length > 0 && (editedBefore || gitStatus(repo) !== statusBefore)) return ctx.skip();
    expect(changes).toEqual([]);
  });
});
