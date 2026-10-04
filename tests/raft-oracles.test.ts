import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { comparePins, loadOracleEntries, pinsOf, runOracleSet, unverifiedQuantities, type IndexedOracle, type Observed, type OracleEntry } from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";
import { runFromHostFile, saveHostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { createProject } from "../src/core/projectStore";
import { RunDispatcher } from "../src/core/runDispatcher";
import type { SetResult } from "../src/core/oracle";
import { connectSeedMcp } from "./helpers/mcp-client";
import { RunManager, type Budget } from "../src/core/runManager";

// RAFT's own oracle entries (oracles/seed in the RAFT repo, generated from its engine golden vectors) run through the
// adapter and the run manager. Needs the RAFT repo with the built headless runner and the entries; skipped otherwise.
const repo = process.env.SEED_RAFT_REPO ?? join(__dirname, "..", "..", "virtual-reactor");
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

beforeAll(() => {
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
    await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  const data = JSON.parse(readFileSync(join(root, q.data.path), "utf8")) as { values: number[] };
  return { kind: "value", quantity: q.name, value: data.values[data.values.length - 1]!, unit: q.unit };
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
    expect({ kind: "value", quantity: q.name, unit: q.unit, value: values.at(-1) }).toEqual(await cached(entry));
    const log = readFileSync(join(state, "engines", sha256Hex(bundle), "admissions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(log.map(row => row.event.phase)).toEqual(["request", "decision", "outcome"]);
    expect(log[1].event.event.decision.allow).toBe(true); expect(log[2].event.event.runId).toBe(reply.runId);
    const m = await connectSeedMcp(config);
    try {
      const result = await m.client.callTool({ name: "seed_run_case", arguments: { requestId: "real-mcp", caseId: "approved", budget } }, undefined, { timeout: 360000 });
      expect(result.isError).toBe(false);
      const mcpReply = result.structuredContent as { state: string; runId: string };
      expect(mcpReply.state).toBe("completed");
      const mcpIndex = JSON.parse(readFileSync(join(project, "runs", mcpReply.runId, "results.json"), "utf8"));
      const mq = mcpIndex.quantities.find((q: any) => q.name === entry.expected.quantity);
      expect(JSON.parse(readFileSync(join(project, mq.data.path), "utf8")).values).toEqual(values);
      expect(m.stderr()).toBe("");
      const journal = readFileSync(join(state, "engines", sha256Hex(bundle), "admissions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(journal.map(row => row.event.phase)).toEqual(["request", "decision", "outcome", "request", "decision", "outcome"]);
      expect(journal[5].event.event.runId).toBe(mcpReply.runId);
    } finally { await m.client.close(); }
  }, 600000);

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 30000 });
    if (!o.ok) throw new Error("transport");
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
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
