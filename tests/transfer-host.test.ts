// @covers R-XFER-03, R-XFER-08
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { runCli } from "../src/cli/seed";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { readAdmissions, writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { recordEvaluation } from "../src/core/oracleJournal";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import { recipeDigest, type Recipe } from "../src/core/transfer";
import { applyTransferFromHost, approveTransfer, proposeTransfer, saveTransferHostConfig, transferStatus, type TransferHostConfig } from "../src/core/transferHost";
import { createSeedMcpServer } from "../src/mcp/seed";

// Transfers through the trusted host with fake apps: a source app whose run holds a heating table, and a target app whose `transfer` command is
// tests/fixtures/fake-transfer/target.cjs. Real project store, real oracle evidence (a git repository, an entry, a passing set) per app, real
// approval records in the state folder, the real CLI and admin CLI entry points and the MCP tools in process.
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { delete process.env.FAKE_TRANSFER_MODE; });
const target = resolve(__dirname, "fixtures/fake-transfer/target.cjs");
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const EV_J = 1.602176634e-19;

async function appOracles(root: string, name: string, adapterId: string, over: { blocked?: boolean } = {}) {
  const repo = join(root, name + "-repo"), entries = join(repo, "entries");
  mkdirSync(entries, { recursive: true });
  const model = JSON.stringify({ name });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "q", value: 1, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = { schema: "seed.oracle/0.1", oracleId: name + "-one", entryVersion: 1, adapter: adapterId, adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
    source: { kind: "hand", text: "test", check: "fixture" }, coverage: { quantities: ["q"], domain: "fixture" }, toleranceHash: sha256Hex(canonicalJson({ expected, tolerance })) };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  expect(indexed.errors).toEqual([]);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: adapterId, version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...(over.blocked ? { quantity: "q", value: 2, unit: "1" } : expected) }) });
  const evidence = join(root, name + "-evidence.json");
  writeHostJson(evidence, result);
  return { adapter: { id: adapterId, version: "0.1.0" }, oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: result.pins };
}

async function fixture(over: { blockedTarget?: boolean; tier?: "A0" | "A1" | "A2" | "A3" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seed transfer host "));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  expect(createProject(project, { name: "Transfer fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  // two registered artifacts
  const srcModel = JSON.stringify({ model: "source" }), dstCase = JSON.stringify({ pin: "pin-1", powerW: 0 }) + "\n";
  writeFileSync(join(project, "models/src-model.json"), srcModel);
  writeFileSync(join(project, "models/dst-case.json"), dstCase);
  const p = openProject(project);
  if (!p.ok) throw Error("project");
  const manifest = structuredClone(p.value.manifest) as Record<string, any>;
  manifest.artifacts = [
    { id: "src-model", app: "srcapp", path: "models/src-model.json", format: "src.model", formatVersion: "1", revision: { hash: sha256Hex(srcModel), counter: 1 } },
    { id: "dst-case", app: "dstapp", path: "models/dst-case.json", format: "dst.case", formatVersion: "1", revision: { hash: sha256Hex(dstCase), counter: 1 } },
  ];
  expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);
  // a completed source run with a heating table
  const table = {
    schema: "seed.quantity-data/0.2", quantity: "Fuel:heating", kind: "table", unit: "eV",
    columns: [{ name: "bin", unit: "1", role: "label" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }],
    rows: [[["a"], 1e6, 1e3], [["b"], 2e6, 1e3], [["c"], 3e6, 1e3]],
  };
  const dataText = JSON.stringify(table);
  mkdirSync(join(project, "runs/run-001/native/quantities"), { recursive: true });
  writeFileSync(join(project, "runs/run-001/native/quantities/000.json"), dataText);
  const index = {
    schema: "seed.results-index/0.2", runId: "run-001", status: "completed", adapter: { id: "srcapp", version: "0.1.0" }, engine: { name: "e", version: "1" },
    inputHashes: [{ path: "models/src-model.json", sha256: sha256Hex(srcModel) }], nativeStatus: { status: "ok", detail: "ok" },
    quantities: [{ name: "Fuel:heating", unit: "eV", dimension: "energy", normalization: "per-source-particle", provenance: { runId: "run-001", inputRevisions: [sha256Hex(srcModel)] }, data: { path: "runs/run-001/native/quantities/000.json", sha256: sha256Hex(dataText) }, verification: "unverified" }],
  };
  const indexText = JSON.stringify(index);
  writeFileSync(join(project, "runs/run-001/results.json"), indexText);
  writeFileSync(join(project, "runs/run-001/run-record.json"), JSON.stringify({ schema: "seed.run-record/0.1", runId: "run-001", state: "completed" }));

  const config = (actor: TransferHostConfig["actor"]): TransferHostConfig => ({
    schema: "seed.transfer-host/0.1", projectRoot: project, stateRoot: state, actor, study: { studyId: "study-1", tier: over.tier ?? "A2", budget, parameters: [] },
    apps: { srcapp: apps.src, dstapp: { ...apps.dst, transfer: { command: process.execPath, args: [target], fields: [{ field: "heating-to-pin", accepts: [{ dimension: "energy", normalization: "per-source-particle" }] }] } } },
  });
  const apps = { src: await appOracles(root, "src", "srcapp"), dst: await appOracles(root, "dst", "dstapp", { blocked: over.blockedTarget }) };
  const agent = { kind: "agent" as const, name: "claude", model: "opus" }, human = { kind: "human" as const, name: "John" };
  const agentFile = join(root, "agent-host.json"), humanFile = join(root, "human-host.json");
  saveTransferHostConfig(agentFile, config(agent));
  saveTransferHostConfig(humanFile, config(human));
  const recipe: Recipe = {
    schema: "seed.transfer-recipe/0.2", recipeId: "heat-1", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
    source: { runId: "run-001", resultsSha256: sha256Hex(indexText), quantity: "Fuel:heating", dataSha256: sha256Hex(dataText), unit: "eV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "src-model", revision: sha256Hex(srcModel) }] },
    target: { app: "dstapp", artifact: "dst-case", revision: sha256Hex(dstCase), field: "heating-to-pin" },
    units: { to: "W" },
    normalization: { kind: "source-rate", value: { value: 1.5e17, unit: "1/s" }, origin: "a source rate chosen for the test" },
    mapping: { spatial: { slices: [{ id: "s1", bins: ["a", "b"] }, { id: "s2", bins: ["c"] }] }, time: { kind: "steady" }, extrapolation: "refused" },
    tolerance: { conservation: 0.01, fixedBefore: "mapping" },
  };
  return { root, project, state, agentFile, humanFile, recipe, config, agent, human, dstCase, srcModel, dataText, indexText, journal: () => readAdmissions(join(state, "transfer-journal")) };
}
type F = Awaited<ReturnType<typeof fixture>>;
const codes = (r: { ok: boolean; errors?: { code: string; field: string }[] }) => (r.ok ? [] : r.errors!.map((e) => `${e.code} ${e.field}`));
const propose = (f: F, recipe: Recipe = f.recipe) => proposeTransfer(f.agentFile, { recipe });
const approve = (f: F, extra: Record<string, unknown> = {}) => approveTransfer(f.humanFile, { recipeId: f.recipe.recipeId, recipeDigest: recipeDigest(f.recipe), ...extra });
const dstFile = (f: F) => join(f.project, "models/dst-case.json");
const dstRevision = (f: F) => (openProject(f.project) as any).value.manifest.artifacts.find((a: any) => a.id === "dst-case").revision;

describe("propose and status", () => {
  it("a good recipe is saved in the project and stands as proposed", async () => {
    const f = await fixture();
    const out = await propose(f);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, state: "proposed", digest: recipeDigest(f.recipe) });
    expect(existsSync(join(f.project, "transfers/heat-1.json"))).toBe(true);
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "proposed" });
    expect(await transferStatus(f.agentFile, { recipeId: "nope" })).toMatchObject({ ok: false });
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1", extra: 1 })).toMatchObject({ ok: false });
  });

  it.each<[string, (r: any) => void, string]>([
    ["a unit that does not fit the dimension", (r) => { r.units.to = "W/m"; }, "E_UNITS /units/to"],
    ["no normalization for a per-source-particle score", (r) => { r.normalization = { kind: "none" }; r.units.to = "eV"; }, "E_NORMALIZATION_MISSING /normalization"],
    ["a source revision that is not the project's", (r) => { r.source.revisionPins[0].revision = "f".repeat(64); }, "E_STALE_REVISION /source/revisionPins/0"],
    ["a target that is not the project's current revision", (r) => { r.target.revision = "f".repeat(64); }, "E_STALE_REVISION /target/revision"],
    ["a target field the app does not declare", (r) => { r.target.field = "coolant-boundary"; }, "E_UNSUPPORTED /target/field"],
    ["a source run that does not exist", (r) => { r.source.runId = "run-404"; }, "E_OUTPUT_INCOMPLETE /source/runId"],
  ])("refuses %s, saving nothing", async (_n, edit, expected) => {
    const f = await fixture();
    const r: any = structuredClone(f.recipe);
    edit(r);
    const out = await propose(f, r);
    expect(out.ok).toBe(false);
    expect(codes(out as any)).toContain(expected);
    expect(existsSync(join(f.project, "transfers"))).toBe(false);
  });

  it("refuses an app that is not configured, a recipe from another proposer and a request with extra fields", async () => {
    const f = await fixture();
    const other: any = structuredClone(f.recipe);
    other.target.app = "otherapp";
    expect((await propose(f, other)).ok).toBe(false);
    const spoof = { ...f.recipe, proposedBy: { kind: "agent" as const, name: "someone-else", model: "x" } };
    const s = await propose(f, spoof);
    expect(codes(s as any)).toContain("E_NOT_PERMITTED /proposedBy");
    expect((await proposeTransfer(f.agentFile, { recipe: f.recipe, extra: 1 })).ok).toBe(false);
    expect((await proposeTransfer(f.agentFile, {})).ok).toBe(false);
  });

  it("the gate decides: tier A1 may not propose, and a target whose oracle set fails blocks it", async () => {
    const lowTier = await fixture({ tier: "A1" });
    expect(codes((await propose(lowTier)) as any)).toContain("E_NOT_PERMITTED /operation");
    const blocked = await fixture({ blockedTarget: true });
    const out = await propose(blocked);
    expect(out.ok).toBe(false);
    expect(existsSync(join(blocked.project, "transfers"))).toBe(false);
  });

  it("a recipe that would close a cycle is refused", async () => {
    const f = await fixture();
    expect((await propose(f)).ok).toBe(true);
    // a second run that was produced from the first recipe's target (dst-case): its result feeding src-model would close the loop
    const run1 = JSON.parse(f.indexText);
    const run2 = { ...run1, runId: "run-002", inputHashes: [{ path: "models/dst-case.json", sha256: sha256Hex(f.dstCase) }], quantities: run1.quantities.map((q: any) => ({ ...q, provenance: { ...q.provenance, runId: "run-002", inputRevisions: [sha256Hex(f.dstCase)] }, data: { ...q.data, path: "runs/run-002/native/quantities/000.json" } })) };
    const run2Text = JSON.stringify(run2);
    mkdirSync(join(f.project, "runs/run-002/native/quantities"), { recursive: true });
    writeFileSync(join(f.project, "runs/run-002/native/quantities/000.json"), f.dataText);
    writeFileSync(join(f.project, "runs/run-002/results.json"), run2Text);
    writeFileSync(join(f.project, "runs/run-002/run-record.json"), JSON.stringify({ schema: "seed.run-record/0.1", runId: "run-002", state: "completed" }));
    const back: any = structuredClone(f.recipe);
    back.recipeId = "back-1";
    back.source.runId = "run-002";
    back.source.resultsSha256 = sha256Hex(run2Text);
    back.source.revisionPins = [{ artifact: "dst-case", revision: sha256Hex(f.dstCase) }];
    back.target = { ...back.target, app: "srcapp", artifact: "src-model", revision: sha256Hex(f.srcModel) };
    const out = await propose(f, back);
    expect(codes(out as any).some((c) => c.startsWith("E_RECIPE_CYCLE")), JSON.stringify(out)).toBe(true);
  });

  it("pins that are not inputs of the source run are refused: a stale run cannot look current", async () => {
    const f = await fixture();
    const r: any = structuredClone(f.recipe);
    r.source.revisionPins = [{ artifact: "dst-case", revision: sha256Hex(f.dstCase) }]; // current, but run-001 was not made from it
    expect(codes((await propose(f, r)) as any)).toContain("E_STALE_REVISION /source/revisionPins/0");
    const unknown: any = structuredClone(f.recipe);
    unknown.source.revisionPins = [{ artifact: "no-such-artifact", revision: sha256Hex(f.srcModel) }];
    expect(codes((await propose(f, unknown)) as any)).toContain("E_NOT_FOUND /source/revisionPins/0");
  });

  it("an exact recipe that is already approved is not proposed again", async () => {
    const f = await fixture();
    await propose(f);
    expect((await approve(f)).ok).toBe(true);
    expect(codes((await propose(f)) as any)).toContain("E_EXISTS /recipeId");
  });
});

describe("approval is human and exact", () => {
  it("only a human host may approve, and only the digest the reviewer read", async () => {
    const f = await fixture();
    await propose(f);
    const byAgent = await approveTransfer(f.agentFile, { recipeId: "heat-1", recipeDigest: recipeDigest(f.recipe) });
    expect(byAgent.ok).toBe(false);
    expect(codes(byAgent as any)).toContain("E_NOT_PERMITTED /approver");
    expect(readdirSync(f.state)).not.toContain("transfer-approvals");
    expect(codes((await approveTransfer(f.humanFile, { recipeId: "heat-1", recipeDigest: "0".repeat(64) })) as any)).toContain("E_STALE_REVISION /recipeDigest");
    expect((await approveTransfer(f.humanFile, { recipeId: "heat-1", recipeDigest: recipeDigest(f.recipe), expiresInHours: 1000 })).ok).toBe(false);
    expect((await approveTransfer(f.humanFile, { recipeId: "nope", recipeDigest: recipeDigest(f.recipe) })).ok).toBe(false);
    const ok = await approve(f);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(existsSync(join(f.project, "transfer-approvals"))).toBe(false); // never in the project
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "approved" });
  });

  it("an approval of a recipe that is no longer a clean proposal is refused (it went stale)", async () => {
    const f = await fixture();
    await propose(f);
    writeFileSync(join(f.project, "models/src-model.json"), f.srcModel + " ");
    const p = openProject(f.project) as any;
    const m = structuredClone(p.value.manifest);
    m.artifacts[0].revision = { hash: sha256Hex(f.srcModel + " "), counter: 2 };
    expect(saveProject(f.project, m, p.value.revision).ok).toBe(true);
    const out = await approve(f);
    expect(out.ok).toBe(false);
    expect(codes(out as any)).toContain("E_STALE_REVISION /source/revisionPins/0");
  });

  it("editing the proposal after approval voids it", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const edited = { ...f.recipe, tolerance: { ...f.recipe.tolerance, conservation: 0.5 } };
    writeFileSync(join(f.project, "transfers/heat-1.json"), JSON.stringify(edited));
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "proposed" });
    expect(codes((await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })) as any)).toContain("E_NOT_PERMITTED /operation");
  });
});

describe("apply", () => {
  it("maps through the target's command, writes the new target and its revision, records provenance, and cannot run twice", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const before = dstRevision(f);
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, state: "applied" });
    const doc = JSON.parse(readFileSync(dstFile(f), "utf8"));
    const total = (1e6 + 2e6 + 3e6) * 1.5e17 * EV_J;
    expect(doc.powerW.s1 + doc.powerW.s2).toBeCloseTo(total, 3);
    const after = dstRevision(f);
    expect(after).toEqual({ hash: sha256Hex(readFileSync(dstFile(f))), counter: before.counter + 1 });
    expect((out as any).provenance).toMatchObject({ recipeId: "heat-1", sourceRunId: "run-001", targetRevisionBefore: before.hash, targetRevisionAfter: after.hash });
    expect(doc.from).toBe(recipeDigest(f.recipe));
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "applied" });
    expect(codes((await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })) as any)).toContain("E_EXISTS /recipeId");
    // the journal is a hash chain of every decision
    const rows = f.journal();
    expect(rows.map((r: any) => r.event.phase)).toEqual(expect.arrayContaining(["propose-outcome", "approve-outcome", "apply-request", "apply-outcome"]));
    rows.forEach((r: any, i: number) => expect(r.prev).toBe(i === 0 ? null : rows[i - 1]!.hash));
    // the target moving on by itself afterwards makes the recipe stale
    writeFileSync(dstFile(f), JSON.stringify({ other: 1 }));
    const p = openProject(f.project) as any;
    const m = structuredClone(p.value.manifest);
    m.artifacts[1].revision = { hash: sha256Hex(JSON.stringify({ other: 1 })), counter: 5 };
    saveProject(f.project, m, p.value.revision);
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "stale" });
  });

  it("nothing is written without an approval, for an edited recipe, after expiry, or when a revision moved", async () => {
    const f = await fixture();
    await propose(f);
    const target0 = readFileSync(dstFile(f), "utf8");
    expect((await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })).ok).toBe(false);
    await approve(f, { expiresInHours: 0.00002 });
    await new Promise((r) => setTimeout(r, 250));
    expect(codes((await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })) as any)).toContain("E_NOT_PERMITTED /operation");
    // a source change after approval
    const g = await fixture();
    await propose(g);
    await approve(g);
    writeFileSync(join(g.project, "runs/run-001/native/quantities/000.json"), g.dataText.replace("1000000", "1000001"));
    const out = await applyTransferFromHost(g.agentFile, { recipeId: "heat-1" });
    expect(out.ok).toBe(false);
    expect(readFileSync(dstFile(g), "utf8")).toBe(g.dstCase);
    expect(readFileSync(dstFile(f), "utf8")).toBe(target0);
    expect(existsSync(join(f.state, "transfer-applied"))).toBe(false);
  });

  it("the target file edited outside SEED is refused, not overwritten", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    writeFileSync(dstFile(f), JSON.stringify({ edited: true }));
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    expect(codes(out as any)).toContain("E_STALE_REVISION /target/revision");
    expect(JSON.parse(readFileSync(dstFile(f), "utf8"))).toEqual({ edited: true });
  });

  it("the app's refusals leave the target and the project untouched, and are journaled", async () => {
    for (const mode of ["lossy", "exit", "nochange"]) {
      const f = await fixture();
      await propose(f);
      await approve(f);
      process.env.FAKE_TRANSFER_MODE = mode;
      const before = dstRevision(f);
      const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
      expect(out.ok, mode).toBe(false);
      expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
      expect(dstRevision(f)).toEqual(before);
      expect(existsSync(join(f.state, "transfer-applied")), mode).toBe(false);
      expect(f.journal().some((r: any) => r.event.phase === "apply-refused")).toBe(true);
      delete process.env.FAKE_TRANSFER_MODE;
      expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ state: "approved" });
    }
  });

  it("a failure recorded in the oracle journal stops propose and apply of a transfer to that app, although its evidence file still passes", async () => {
    const f = await fixture();
    expect((await propose(f)).ok).toBe(true);
    const pins = f.config(f.agent).apps.dstapp!.acceptedPins;
    recordEvaluation(
      f.state,
      { id: "dstapp", version: "0.1.0" },
      { adapter: "dstapp", adapterVersion: "0.1.0", verdict: "fail", inputsVerified: true, blocked: true, blockedQuantities: [], results: [{ oracleId: "dst-one", entryVersion: 1, tag: "good", verdict: "fail" }], pins },
      "c".repeat(64),
      f.human
    );
    const refused = await propose(f);
    expect(refused.ok).toBe(false);
    expect((refused as any).errors[0].message).toMatch(/oracle/);
    mkdirSync(join(f.project, "transfers"), { recursive: true });
    writeFileSync(join(f.project, "transfers/heat-1.json"), JSON.stringify(f.recipe));
    expect((await approve(f)).ok).toBe(true);
    expect(codes((await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })) as any)).toContain("E_NOT_PERMITTED /oracles");
    expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
  });

  it("a failed oracle set stops apply as well as propose", async () => {
    const f = await fixture({ blockedTarget: true });
    // approve and apply bypass propose: save the recipe and approval directly the way a previous good moment would have
    mkdirSync(join(f.project, "transfers"));
    writeFileSync(join(f.project, "transfers/heat-1.json"), JSON.stringify(f.recipe));
    expect((await approve(f)).ok).toBe(true);
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    expect(codes(out as any)).toContain("E_NOT_PERMITTED /oracles");
    expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
    expect(existsSync(join(f.state, "transfer-applied"))).toBe(false);
  });
});

describe("the entry points", () => {
  const stream = (o: unknown) => { const s = new PassThrough(); s.end(JSON.stringify(o)); return s; };

  it("the agent CLI proposes, reads and applies; the admin CLI approves; the agent CLI has no approval verb", async () => {
    const f = await fixture();
    const agent = (verb: string, req: unknown) => runCli([verb], stream(req), undefined, f.agentFile);
    const p = await agent("transfer-propose", { recipe: f.recipe });
    expect(p.code).toBe(0);
    expect((await agent("transfer-status", { recipeId: "heat-1" })).reply).toMatchObject({ ok: true, state: "proposed" });
    expect((await agent("transfer-apply", { recipeId: "heat-1" })).code).toBe(2);
    expect((await runCli(["approve-transfer"], stream({}), undefined, f.agentFile)).reply).toMatchObject({ ok: false, errors: [{ code: "E_VERB_UNKNOWN" }] });
    const a = await runAdminCli(["approve-transfer"], stream({ recipeId: "heat-1", recipeDigest: recipeDigest(f.recipe) }), undefined, f.humanFile);
    expect(a.code, JSON.stringify(a.reply)).toBe(0);
    const applied = await agent("transfer-apply", { recipeId: "heat-1" });
    expect(applied.code, JSON.stringify(applied.reply)).toBe(0);
    expect(applied.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, state: "applied" });
    expect((await runCli(["transfer-status"], stream({}), undefined, undefined)).reply).toMatchObject({ ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] });
    expect((await runAdminCli(["approve-transfer"], stream({}), undefined, undefined)).reply).toMatchObject({ ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] });
    expect((await runAdminCli(["approve-transfer"], stream({ recipeId: "heat-1", recipeDigest: recipeDigest(f.recipe) }), undefined, f.agentFile)).code).toBe(2);
  });

  it("the MCP server offers the three agent tools only when a transfer host is named, and no approval tool", async () => {
    const f = await fixture();
    const connect = async (transferFile?: string) => {
      const server = createSeedMcpServer(f.agentFile, transferFile);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return { client, close: async () => { await client.close(); await server.close(); } };
    };
    const without = await connect();
    expect((await without.client.listTools()).tools.map((t) => t.name).filter((n) => n.includes("transfer"))).toEqual([]);
    await without.close();
    const withT = await connect(f.agentFile);
    const names = (await withT.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["seed_propose_transfer", "seed_transfer_status", "seed_apply_transfer"]));
    expect(names.filter((n) => /approve|enable|grant/.test(n))).toEqual([]);
    const proposed = await withT.client.callTool({ name: "seed_propose_transfer", arguments: { recipe: f.recipe } });
    expect(proposed.isError).toBe(false);
    const status = await withT.client.callTool({ name: "seed_transfer_status", arguments: { recipeId: "heat-1" } });
    expect((status.structuredContent as any).state).toBe("proposed");
    expect((await withT.client.callTool({ name: "seed_apply_transfer", arguments: { recipeId: "heat-1" } })).isError).toBe(true);
    await expect(withT.client.callTool({ name: "seed_apply_transfer", arguments: { recipeId: "heat-1", approval: "x" } })).resolves.toMatchObject({ isError: true });
    await withT.close();
  });
});

describe("the trusted configuration is held to its rules", () => {
  it("a configuration or state folder inside the project is refused, and a config file inside the project cannot be saved", async () => {
    const f = await fixture();
    const inside = f.config(f.agent);
    inside.stateRoot = join(f.project, "state");
    mkdirSync(inside.stateRoot, { recursive: true });
    const file = join(f.root, "inside-state.json");
    saveTransferHostConfig(file, inside);
    const out = await transferStatus(file, { recipeId: "heat-1" });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain("outside the project");
    expect(() => saveTransferHostConfig(join(f.project, "host.json"), f.config(f.agent))).toThrow(/outside the project/);
  });

  it("pins changed since a human accepted them stop a proposal", async () => {
    const f = await fixture();
    const c = f.config(f.agent);
    c.apps.dstapp!.acceptedPins = { ...c.apps.dstapp!.acceptedPins, appCommit: "0".repeat(40) };
    const file = join(f.root, "pins-changed.json");
    saveTransferHostConfig(file, c);
    const out = await proposeTransfer(file, { recipe: f.recipe });
    expect(out.ok).toBe(false);
    expect(codes(out as any)).toContain("E_NOT_PERMITTED /operation");
    expect(existsSync(join(f.project, "transfers"))).toBe(false);
  });

  it("an applied record of another project in the state folder does not count", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const dir = join(f.state, "transfer-applied", sha256Hex("proj\n" + realpathSync(f.project)));
    const p = openProject(f.project) as any;
    const right = join(f.state, "transfer-applied", sha256Hex(p.value.manifest.projectId + "\n" + realpathSync(f.project)));
    mkdirSync(right, { recursive: true });
    writeFileSync(join(right, "fake.json"), JSON.stringify({ schema: "seed.transfer-applied/0.2", projectId: "another-project", recipeId: "heat-1", recipeDigest: recipeDigest(f.recipe), targetRevisionAfter: sha256Hex(f.dstCase) }));
    expect(dir).not.toBe(right);
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ ok: true, state: "approved" });
  });

  it("applying to an app with no transfer command says so", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const c = f.config(f.agent);
    delete c.apps.dstapp!.transfer;
    const file = join(f.root, "no-command.json");
    saveTransferHostConfig(file, c);
    const out = await applyTransferFromHost(file, { recipeId: "heat-1" });
    expect(codes(out as any)).toContain("E_SETUP_REQUIRED /target/app");
    expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
  });
});

describe("the commit is one critical section, and nothing leaves the project (Codex review, E0 exit)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("two applies of one approved recipe: one commits, the other is refused, and the target and its revision agree", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    process.env.FAKE_TRANSFER_DELAY_MS = "700";
    const [a, b] = await Promise.all([applyTransferFromHost(f.agentFile, { recipeId: "heat-1" }), applyTransferFromHost(f.agentFile, { recipeId: "heat-1" })]);
    delete process.env.FAKE_TRANSFER_DELAY_MS;
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = (a.ok ? b : a) as { ok: false; errors: { code: string }[] };
    expect(loser.errors[0]!.code).toMatch(/^E_(STALE_REVISION|EXISTS)$/);
    const doc = JSON.parse(readFileSync(dstFile(f), "utf8"));
    expect(doc.from).toBe(recipeDigest(f.recipe));
    expect(dstRevision(f)).toEqual({ hash: sha256Hex(readFileSync(dstFile(f))), counter: 2 });
    expect(await transferStatus(f.agentFile, { recipeId: "heat-1" })).toMatchObject({ state: "applied" });
  });

  it("a source revision that changes while the mapper runs stops the commit and leaves the target alone", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    process.env.FAKE_TRANSFER_DELAY_MS = "1500";
    const pending = applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    await sleep(500);
    const p = openProject(f.project) as any;
    const m = structuredClone(p.value.manifest);
    m.artifacts[0].revision = { hash: sha256Hex("the source moved"), counter: 2 };
    expect(saveProject(f.project, m, p.value.revision).ok).toBe(true);
    const out = await pending;
    delete process.env.FAKE_TRANSFER_DELAY_MS;
    expect(out.ok).toBe(false);
    expect(codes(out as any).some((c) => c.startsWith("E_STALE_REVISION"))).toBe(true);
    expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
    expect(dstRevision(f)).toEqual({ hash: sha256Hex(f.dstCase), counter: 1 });
  });

  it("an approval that expires while the mapper runs is not honoured at the commit", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f, { expiresInHours: 0.0002 }); // 0.72 s
    process.env.FAKE_TRANSFER_DELAY_MS = "1500";
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    delete process.env.FAKE_TRANSFER_DELAY_MS;
    expect(out.ok).toBe(false);
    expect(readFileSync(dstFile(f), "utf8")).toBe(f.dstCase);
  });

  it("an applied record that cannot be written does not turn a committed transfer into a failure; it is reported", async () => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const p = openProject(f.project) as any;
    const dir = join(f.state, "transfer-applied", sha256Hex(p.value.manifest.projectId + "\n" + realpathSync(f.project)));
    mkdirSync(join(dir, `heat-1-${recipeDigest(f.recipe).slice(0, 16)}.json`), { recursive: true });
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, state: "applied" });
    expect((out as any).incomplete.join(" ")).toMatch(/applied record could not be written/);
    expect(JSON.parse(readFileSync(dstFile(f), "utf8")).from).toBe(recipeDigest(f.recipe));
    expect(dstRevision(f).counter).toBe(2);
    expect(f.journal().some((r: any) => r.event.phase === "apply-outcome" && r.event.event.incomplete)).toBe(true);
  });

  it("a linked ancestor does not move the recipe folder out of the project", async (ctx) => {
    const f = await fixture();
    const external = join(f.root, "external");
    mkdirSync(join(external, "transfers"), { recursive: true });
    try { symlinkSync(external, join(f.project, "linked"), "junction"); } catch { return ctx.skip(); } // no link rights on this machine: skipped, never a silent pass
    const c = f.config(f.agent);
    c.transfersFolder = "linked/transfers";
    const file = join(f.root, "linked-folder.json");
    saveTransferHostConfig(file, c);
    const out = await proposeTransfer(file, { recipe: f.recipe });
    expect(out.ok).toBe(false);
    expect(readdirSync(join(external, "transfers"))).toEqual([]);
  });

  it("a target reached through a linked ancestor is neither read nor written", async (ctx) => {
    const f = await fixture();
    await propose(f);
    await approve(f);
    const external = join(f.root, "external-target");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "dst-case.json"), f.dstCase);
    try { symlinkSync(external, join(f.project, "linkdir"), "junction"); } catch { return ctx.skip(); } // no link rights on this machine: skipped, never a silent pass
    const p = openProject(f.project) as any;
    const m = structuredClone(p.value.manifest);
    m.artifacts[1].path = "linkdir/dst-case.json";
    expect(saveProject(f.project, m, p.value.revision).ok).toBe(true);
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "heat-1" });
    expect(out.ok).toBe(false);
    expect(readFileSync(join(external, "dst-case.json"), "utf8")).toBe(f.dstCase);
  });
});
