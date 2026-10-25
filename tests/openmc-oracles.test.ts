// @covers R-ORA-03
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { comparePins, loadOracleEntries, pinsOf, runOracleSet, unverifiedQuantities, type Observed, type OracleEntry } from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";
import { RunManager, type Budget } from "../src/core/runManager";
import { observedValue } from "./helpers/quantityValue";
import { appTree, gitStatus, hasUncommittedEdits, trackedFiles, treeChanges } from "./helpers/appTree";
import { oracleRequestId } from "./helpers/oracleRequest";
import { appDir } from "./helpers/appDir";

// OpenMC Studio's own oracle entries (oracles/seed in the OpenMC repository): analytic cases whose expected values come from formulas and from
// cross sections read out of the nuclear data library (a void ball's track length, absorption and track length in a pure B-10 slab), with
// tolerances of 4 sigma of the predicted statistical error, fixed before any case was run; plus bad-input refusals. They run through the adapter
// and the run manager against real OpenMC in WSL. Needs the same pieces as tests/openmc-adapter.test.ts.
const win = process.platform === "win32";
const candidates = [process.env.SEED_OPENMC_REPO, join(appDir("openmc-studio"))];
const repo = candidates.find(p => p && existsSync(join(p, "oracles", "seed", "entries")) && existsSync(join(p, "studio", "tools", "regen_script.cjs"))) ?? "";
const electron = process.env.SEED_ELECTRON ?? join(__dirname, "..", "node_modules", "electron", "dist", win ? "electron.exe" : "electron");
const distro = process.env.SEED_OPENMC_WSL_DISTRO ?? "Ubuntu";
const py = process.env.SEED_OPENMC_PYTHON ?? "/root/miniconda3/envs/openmc-mcnp/bin/python";
const data = process.env.SEED_OPENMC_DATA ?? "/root/nuclear_data/endfb-viii.0-hdf5/cross_sections.xml";
const probe = (args: string[]) => (win ? spawnSync("wsl.exe", ["-d", distro, "--exec", ...args], { encoding: "utf8" }) : spawnSync(args[0]!, args.slice(1), { encoding: "utf8" }));
const have = repo !== "" && existsSync(electron) && probe(["/usr/bin/test", "-f", data]).status === 0 && probe(["/usr/bin/test", "-x", py]).status === 0;
const base = join(repo, "oracles", "seed");

const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "openmc", "cli.cjs")], id: "openmc", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "oracle-runner", model: "test-model" };
const budget: Budget = { maxWallSeconds: 600, maxCores: 1, maxMemoryMB: 4096, maxDiskMB: 1024 };
const adapterId = { id: "openmc", version: "0.1.0" };
const dirs: string[] = [];
const names = ["SEED_OPENMC_REPO", "SEED_ELECTRON", "SEED_OPENMC_PYTHON", "SEED_OPENMC_DATA", "SEED_OPENMC_WSL_DISTRO", "SEED_OPENMC_ORACLES"] as const;
const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));

const appCommit = (() => {
  const r = spawnSync("git", ["-c", "safe.directory=" + repo.split("\\").join("/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
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
  if (have) Object.assign(process.env, { SEED_OPENMC_REPO: repo, SEED_ELECTRON: electron, SEED_OPENMC_PYTHON: py, SEED_OPENMC_DATA: data, SEED_OPENMC_WSL_DISTRO: distro, SEED_OPENMC_ORACLES: join(base, "entries") });
});
afterAll(() => {
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  if (!have) console.warn(`OpenMC oracle entries or runtime not found (repo ${repo || "none"}): the oracle tests were skipped`);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one entry the way a host does: bad-input through validate, good through the run manager (a project folder that contains a space). */
async function observe(entry: OracleEntry, baseDir: string): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), "seed openmc oracle "));
  dirs.push(root);
  for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
  for (const i of entry.inputs) {
    mkdirSync(join(root, dirname(i.path)), { recursive: true });
    cpSync(join(baseDir, i.path), join(root, i.path));
  }
  const projectPath = entry.inputs.find(i => i.path.endsWith(".json"))!.path;
  const modelPath = entry.inputs.find(i => i.path.endsWith(".py"))?.path;
  const projectInput = entry.inputs.find(i => i.path === projectPath)!;
  const artifact = { path: projectPath, revision: { hash: projectInput.sha256, counter: 1 } };
  if (entry.tag === "bad-input") {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: root, timeoutMs: 180000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const first = (o.reply as { result?: { problems: { code: string }[] } }).result?.problems.find(p => p.code.startsWith("E_"));
    return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
  }
  const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 180000 });
  const out = await mgr.start({ requestId: oracleRequestId(entry.oracleId), actor, artifact, inputs: entry.inputs, budget, settings: { project: projectPath, model: modelPath, threads: 1 } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  if (!q) throw new Error("the run has no quantity " + String(entry.expected.quantity) + " (has " + index.quantities.map((x: { name: string }) => x.name).join(", ") + ")");
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
const gate = (blocked: boolean) => evaluateGate({ operation: "run_case", actor, studyId: "s1" }, { study, oracleBlocked: blocked });

describe.skipIf(!have)("OpenMC oracle set through the SEED adapter (real OpenMC)", () => {
  it("loads 10 entries (6 analytic good, 4 bad input: the two eigenvalue refusals are among them), all pinned and valid", () => {
    const r = loadOracleEntries(join(base, "entries"));
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(10);
    expect(r.entries.filter(i => i.entry.tag === "good")).toHaveLength(6);
    expect(r.entries.filter(i => i.entry.tag === "bad-input")).toHaveLength(4);
    expect(r.entries.filter(i => i.entry.source.kind === "analytic")).toHaveLength(6);
  });

  it("the correct adapter passes every entry: set passes, inputs verified, gate open", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: adapterId, appCommit, baseDir: base, run: e => cached(e) });
    expect(set.results.filter(r => r.verdict !== "pass")).toEqual([]);
    expect(set.verdict).toBe("pass");
    expect(set.inputsVerified).toBe(true);
    expect(set.blocked).toBe(false);
    expect(gate(set.blocked).allow).toBe(true);
    // what the oracles do not name stays unverified: other tallies, other scores
    expect(unverifiedQuantities(["Void ball:flux", "B-10 thin slab:absorption", "Some other tally:flux"], set, entries)).toEqual(["Some other tally:flux"]);
  }, 1500000);

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 180000 });
    if (!o.ok) throw new Error("transport");
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
    expect((o.reply as { result: { resources?: unknown } }).result.resources).toEqual(JSON.parse(readFileSync(join(__dirname, "..", "adapters", "shared", "resources.json"), "utf8")).openmc);
    expect(cov.length).toBe(6); // distinct (quantity, domain) pairs of the 6 good entries
    expect(cov.map(c => c.quantity)).toEqual(expect.arrayContaining(["Void ball:flux", "B-10 thin slab:absorption", "B-10 thick slab:flux"]));
  }, 240000);

  describe("a deliberately wrong adapter output fails the set and blocks the study", () => {
    const wrong: [string, (e: OracleEntry, o: Observed) => Observed][] = [
      ["a 2 % high absorption (what a 2 % density or cross-section error would give)", (e, o) => (o.kind === "value" && e.oracleId === "openmc-b10-slab-thin-absorption" ? { ...o, value: o.value * 1.02 } : o)],
      ["a void-ball flux off by one part in a million", (e, o) => (o.kind === "value" && e.oracleId === "openmc-void-ball-flux" ? { ...o, value: o.value * (1 + 1e-6) } : o)],
      ["a swapped unit", (e, o) => (o.kind === "value" && o.unit === "cm" ? { ...o, unit: "m" } : o)],
      ["a dropped refusal", (e, o) => (e.tag === "bad-input" ? { kind: "verdict", verdict: "accepted" } : o)],
      ["a wrong refusal code", (e, o) => (e.tag === "bad-input" ? { kind: "refusal", code: "E_UNITS" } : o)],
    ];
    it.each(wrong)("%s", async (_n, tweak) => {
      const { entries } = loadOracleEntries(join(base, "entries"));
      const set = await runOracleSet({ entries, adapter: adapterId, appCommit, baseDir: base, run: async e => tweak(e, await cached(e)) });
      expect(set.verdict).toBe("fail");
      expect(set.blocked).toBe(true);
      expect(gate(set.blocked).allow).toBe(false);
    }, 1500000);
  });

  it("a changed project input makes its entries invalid before any case runs", async () => {
    const copy = mkdtempSync(join(tmpdir(), "seed openmc oracles copy "));
    dirs.push(copy);
    cpSync(base, copy, { recursive: true });
    const file = join(copy, "models", "b10-slab-thin.openmc-studio.json");
    writeFileSync(file, readFileSync(file, "utf8") + " ");
    const { entries } = loadOracleEntries(join(copy, "entries"));
    let calls = 0;
    const set = await runOracleSet({ entries, adapter: adapterId, appCommit, baseDir: copy, run: async e => { calls++; return cached(e); } });
    const bad = set.results.filter(r => r.verdict === "invalid");
    expect(bad.map(r => r.oracleId).sort()).toEqual(["openmc-b10-slab-thin-absorption", "openmc-b10-slab-thin-flux"]);
    expect(set.verdict).toBe("fail");
    expect(set.blocked).toBe(true);
    expect(calls).toBe(set.results.length - bad.length);
  }, 1500000);

  it("a tolerance edited without a new pin does not load; a new commit flags the pins", () => {
    const copy = mkdtempSync(join(tmpdir(), "seed openmc oracles tol "));
    dirs.push(copy);
    cpSync(join(base, "entries"), copy, { recursive: true });
    const file = join(copy, "openmc-b10-slab-thin-absorption.json");
    const e = JSON.parse(readFileSync(file, "utf8"));
    e.tolerance = { abs: 1, rel: 1 };
    writeFileSync(file, JSON.stringify(e, null, 2));
    const r = loadOracleEntries(copy);
    expect(r.entries).toHaveLength(9);
    expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "openmc-b10-slab-thin-absorption.json/toleranceHash" });
    const { entries } = loadOracleEntries(join(base, "entries"));
    const accepted = pinsOf(entries, appCommit);
    expect(comparePins(accepted, pinsOf(entries, "0".repeat(40)))).toEqual([`app commit ${appCommit} -> ${"0".repeat(40)}`]);
  });
});

// E2 exit, "standalone launch of the app unchanged by its adapter": everything above ran the real OpenMC Studio through its adapter; its own folder must be as found.
describe.skipIf(!have)("OpenMC Studio is left as the adapter found it", () => {
  it("no file of the app's own folder was added, changed or removed by the runs above", (ctx) => {
    expect(treeBefore).toBeDefined();
    const changes = treeChanges(treeBefore!, appTree(repo), trackedFiles(repo));
    // someone was editing the app when the runs began, or changed what git sees in it while they ran (another session on this machine):
    // the changes cannot be told from theirs
    if (changes.length > 0 && (editedBefore || gitStatus(repo) !== statusBefore)) return ctx.skip();
    expect(changes).toEqual([]);
  });
});
