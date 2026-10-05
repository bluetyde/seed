import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { loadOracleEntries, runOracleSet, unverifiedQuantities, comparePins, pinsOf, type Observed, type OracleEntry } from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";
import { RunManager, type Budget } from "../src/core/runManager";

// NODAL's own oracle entries (oracles/seed in the NODAL repo): four analytic cases whose expected values come from formulas and integrals that
// do not use the solver, golden-vector regression cases, and bad inputs. They run through the adapter and the run manager. Needs the NODAL repo
// (SEED_NODAL_REPO, default a sibling folder pipe-studio) on a branch with the runner's JSON modes and the entries, and its Python.
const repo = process.env.SEED_NODAL_REPO ?? join(__dirname, "..", "..", "pipe-studio");
const python = [process.env.SEED_NODAL_PYTHON, join(repo, ".venv", "Scripts", "python.exe"), join(repo, ".venv", "bin", "python")].find(p => p && existsSync(p)) ?? "";
const base = join(repo, "oracles", "seed");
const have =
  python !== "" &&
  existsSync(join(base, "entries")) &&
  spawnSync(python, ["-m", "nodal_studio.run", "--describe"], { cwd: repo, env: { ...process.env, PYTHONPATH: repo }, encoding: "utf8" }).status === 0;
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "nodal", "cli.cjs")], id: "nodal", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "oracle-runner", model: "test-model" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const saved = { py: process.env.SEED_NODAL_PYTHON, repo: process.env.SEED_NODAL_REPO, o: process.env.SEED_NODAL_ORACLES };

const appCommit = (() => {
  const r = spawnSync("git", ["-c", "safe.directory=" + repo.split("\\").join("/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
})();

beforeAll(() => {
  process.env.SEED_NODAL_PYTHON = python;
  process.env.SEED_NODAL_REPO = repo;
  process.env.SEED_NODAL_ORACLES = join(base, "entries");
});
afterAll(() => {
  for (const [k, v] of [["SEED_NODAL_PYTHON", saved.py], ["SEED_NODAL_REPO", saved.repo], ["SEED_NODAL_ORACLES", saved.o]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!have) console.warn(`NODAL oracle entries or runner not found under ${repo}: the oracle tests were skipped`);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one entry the way a host does: bad-input through validate, good through the run manager. */
async function observe(entry: OracleEntry, baseDir: string): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), "seed-nodal-oracle-"));
  dirs.push(root);
  for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
  for (const i of entry.inputs) {
    mkdirSync(join(root, dirname(i.path)), { recursive: true });
    cpSync(join(baseDir, i.path), join(root, i.path));
  }
  const modelPath = entry.inputs[0]!.path;
  const commands = entry.inputs.find(i => i.path.endsWith(".commands.json"))?.path;
  const artifact = { path: modelPath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
  if (entry.tag === "bad-input") {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: root, timeoutMs: 60000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const first = (o.reply as { result?: { problems: { code: string }[] } }).result?.problems.find(p => p.code.startsWith("E_"));
    return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
  }
  const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 60000 });
  const out = await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact, inputs: entry.inputs, budget, settings: { model: modelPath, ...(commands ? { commands } : {}) } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  if (!q) throw new Error("the run has no quantity " + String(entry.expected.quantity));
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
const gate = (blocked: boolean) => evaluateGate({ operation: "run_case", actor, studyId: "s1" }, { study, oracleBlocked: blocked });

describe.skipIf(!have)("NODAL oracle set through the SEED adapter", () => {
  it("loads 24 entries (4 analytic and 16 regression good, 4 bad input), all pinned and valid", () => {
    const r = loadOracleEntries(join(base, "entries"));
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(24);
    expect(r.entries.filter(i => i.entry.tag === "good")).toHaveLength(20);
    expect(r.entries.filter(i => i.entry.tag === "bad-input")).toHaveLength(4);
    expect(r.entries.filter(i => i.entry.source.kind === "analytic")).toHaveLength(4);
  });

  it("the correct adapter passes every entry: set passes, inputs verified, gate open", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: { id: "nodal", version: "0.1.0" }, appCommit, baseDir: base, run: e => cached(e) });
    expect(set.results.filter(r => r.verdict !== "pass")).toEqual([]);
    expect(set.verdict).toBe("pass");
    expect(set.inputsVerified).toBe(true);
    expect(set.blocked).toBe(false);
    expect(gate(set.blocked).allow).toBe(true);
    // what the oracles do not name stays unverified
    expect(unverifiedQuantities(["p_mid", "not-a-covered-channel"], set, entries)).toEqual(["not-a-covered-channel"]);
  }, 1500000);

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 60000 });
    if (!o.ok) throw new Error("transport");
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
    expect(cov.length).toBe(19); // distinct (quantity, domain) pairs of the 20 good entries: the two A2 cases share w_in and a domain
    expect(cov.map(c => c.quantity)).toEqual(expect.arrayContaining(["w_in", "p_mid"]));
  });

  describe("a deliberately wrong adapter output fails the set and blocks the study", () => {
    const wrong: [string, (e: OracleEntry, o: Observed) => Observed][] = [
      ["a perturbed analytic value (1% on the turbulent flow)", (e, o) => (o.kind === "value" && e.oracleId === "nodal-a2-turbulent" ? { ...o, value: o.value * 1.01 } : o)],
      ["a perturbed regression value (1e-4 relative on a pressure)", (e, o) => (o.kind === "value" && o.unit === "Pa" && e.source.kind === "direct-engine" ? { ...o, value: o.value * (1 + 1e-4) } : o)],
      ["a swapped unit", (e, o) => (o.kind === "value" && o.unit === "K" ? { ...o, unit: "C" } : o)],
      ["a dropped refusal", (e, o) => (e.tag === "bad-input" ? { kind: "verdict", verdict: "accepted" } : o)],
      ["a wrong refusal code", (e, o) => (e.tag === "bad-input" ? { kind: "refusal", code: "E_UNITS" } : o)],
    ];
    it.each(wrong)("%s", async (_n, tweak) => {
      const { entries } = loadOracleEntries(join(base, "entries"));
      const set = await runOracleSet({ entries, adapter: { id: "nodal", version: "0.1.0" }, appCommit, baseDir: base, run: async e => tweak(e, await cached(e)) });
      expect(set.verdict).toBe("fail");
      expect(set.blocked).toBe(true);
      expect(gate(set.blocked).allow).toBe(false);
    }, 1500000);
  });

  it("a changed model input makes its entries invalid before any case runs", async () => {
    const copy = mkdtempSync(join(tmpdir(), "seed-nodal-oracles-copy-"));
    dirs.push(copy);
    cpSync(base, copy, { recursive: true });
    writeFileSync(join(copy, "models", "steady-pipe.json"), readFileSync(join(copy, "models", "steady-pipe.json"), "utf8") + " ");
    const { entries } = loadOracleEntries(join(copy, "entries"));
    let calls = 0;
    const set = await runOracleSet({ entries, adapter: { id: "nodal", version: "0.1.0" }, appCommit, baseDir: copy, run: async e => { calls++; return cached(e); } });
    const bad = set.results.filter(r => r.verdict === "invalid");
    expect(bad.map(r => r.oracleId).sort()).toEqual(["nodal-steady-pipe-final-p-mid", "nodal-steady-pipe-final-t-in"]);
    expect(set.verdict).toBe("fail");
    expect(set.blocked).toBe(true);
    expect(calls).toBe(set.results.length - bad.length);
  }, 1500000);

  it("a tolerance edited without a new pin does not load; a new commit flags the pins", () => {
    const copy = mkdtempSync(join(tmpdir(), "seed-nodal-oracles-tol-"));
    dirs.push(copy);
    cpSync(join(base, "entries"), copy, { recursive: true });
    const file = join(copy, "nodal-a2-turbulent.json");
    const e = JSON.parse(readFileSync(file, "utf8"));
    e.tolerance = { abs: 1, rel: 1 };
    writeFileSync(file, JSON.stringify(e, null, 2));
    const r = loadOracleEntries(copy);
    expect(r.entries).toHaveLength(23);
    expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "nodal-a2-turbulent.json/toleranceHash" });
    const { entries } = loadOracleEntries(join(base, "entries"));
    const accepted = pinsOf(entries, appCommit);
    expect(comparePins(accepted, pinsOf(entries, "0".repeat(40)))).toEqual([`app commit ${appCommit} -> ${"0".repeat(40)}`]);
  });
});
