import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { loadOracleEntries, runOracleSet, unverifiedQuantities, comparePins, pinsOf, type Observed, type OracleEntry } from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";
import { RunManager, type Budget } from "../src/core/runManager";
import { observedValue } from "./helpers/quantityValue";

// SNEED's own oracle entries (oracles/seed in the SNEED repository): hand-derived exact top-event probabilities (checked there against an
// exhaustive enumeration) and bad-input refusals. They run through the adapter and the run manager. Needs the SNEED checkout built with
// `npm run build:cli` (SEED_PRA_REPO, default a sibling folder pra-studio or sneed) and its installed SCRAM runtime. Only read, never written.
const candidates = [process.env.SEED_PRA_REPO, join(__dirname, "..", "..", "pra-studio"), join(__dirname, "..", "..", "sneed"), join(homedir(), "Claude Code Test", "pra-studio")];
const repo = candidates.find(p => p && existsSync(join(p, "dist", "node", "cli", "headless.js"))) ?? "";
const base = join(repo, "oracles", "seed");
const describeOut = repo ? spawnSync(process.execPath, [join(repo, "dist", "node", "cli", "headless.js"), "describe"], { encoding: "utf8" }) : null;
const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? "{}";
const have = !!describeOut && describeOut.status === 0 && existsSync(join(base, "entries")) && JSON.parse(lastLine(describeOut.stdout)).scram?.installed === true;
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "pra", "cli.cjs")], id: "pra", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "oracle-runner", model: "test-model" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const saved = { repo: process.env.SEED_PRA_REPO, o: process.env.SEED_PRA_ORACLES };

const appCommit = (() => {
  const r = spawnSync("git", ["-c", "safe.directory=" + repo.split("\\").join("/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
})();

beforeAll(() => {
  process.env.SEED_PRA_REPO = repo;
  process.env.SEED_PRA_ORACLES = join(base, "entries");
});
afterAll(() => {
  for (const [k, v] of [["SEED_PRA_REPO", saved.repo], ["SEED_PRA_ORACLES", saved.o]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!have) console.warn(`SNEED oracle entries, build or SCRAM runtime not found under ${repo}: the oracle tests were skipped`);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one entry the way a host does: bad-input through validate, good through the run manager. */
async function observe(entry: OracleEntry, baseDir: string): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), "seed pra oracle "));
  dirs.push(root);
  for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
  for (const i of entry.inputs) {
    mkdirSync(join(root, dirname(i.path)), { recursive: true });
    cpSync(join(baseDir, i.path), join(root, i.path));
  }
  const modelPath = entry.inputs[0]!.path;
  const artifact = { path: modelPath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
  if (entry.tag === "bad-input") {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: root, timeoutMs: 60000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const first = (o.reply as { result?: { problems: { code: string }[] } }).result?.problems.find(p => p.code.startsWith("E_"));
    return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
  }
  const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 60000 });
  const out = await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact, inputs: entry.inputs, budget, settings: { model: modelPath } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  if (!q) throw new Error("the run has no quantity " + String(entry.expected.quantity));
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

describe.skipIf(!have)("SNEED oracle set through the SEED adapter", () => {
  const adapterId = { id: "pra", version: "0.1.0" };
  it("loads 14 entries (11 good, 3 bad input), all pinned and valid", () => {
    const r = loadOracleEntries(join(base, "entries"));
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(14);
    expect(r.entries.filter(i => i.entry.tag === "good")).toHaveLength(11);
    expect(r.entries.filter(i => i.entry.tag === "bad-input")).toHaveLength(3);
  });

  it("the correct adapter passes every entry: set passes, inputs verified, gate open", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: adapterId, appCommit, baseDir: base, run: e => cached(e) });
    expect(set.results.filter(r => r.verdict !== "pass")).toEqual([]);
    expect(set.verdict).toBe("pass");
    expect(set.inputsVerified).toBe(true);
    expect(set.blocked).toBe(false);
    expect(gate(set.blocked).allow).toBe(true);
    // what the oracles do not name stays unverified: the cut sets and the approximation are not covered by any entry
    expect(unverifiedQuantities(["top_event_probability", "minimal_cut_sets", "approximation_value"], set, entries)).toEqual(["minimal_cut_sets", "approximation_value"]);
  }, 1500000);

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 120000 });
    if (!o.ok) throw new Error("transport");
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
    expect(cov.length).toBe(11); // distinct (quantity, domain) pairs of the 11 good entries
    expect(new Set(cov.map(c => c.quantity))).toEqual(new Set(["top_event_probability"]));
  });

  describe("a deliberately wrong adapter output fails the set and blocks the study", () => {
    const wrong: [string, (e: OracleEntry, o: Observed) => Observed][] = [
      ["a perturbed value (1e-6 relative on the 2-of-3 vote)", (e, o) => (o.kind === "value" && e.oracleId === "pra-vote-exact" ? { ...o, value: o.value * (1 + 1e-6) } : o)],
      ["a probability read as a percentage", (e, o) => (o.kind === "value" && e.oracleId === "pra-or" ? { ...o, value: o.value * 100 } : o)],
      ["a swapped unit", (e, o) => (o.kind === "value" && o.unit === "1" ? { ...o, unit: "1/h" } : o)],
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

  it("a changed model input makes its entry invalid before any case runs", async () => {
    const copy = mkdtempSync(join(tmpdir(), "seed pra oracles copy "));
    dirs.push(copy);
    cpSync(base, copy, { recursive: true });
    writeFileSync(join(copy, "models", "pra-and.json"), readFileSync(join(copy, "models", "pra-and.json"), "utf8") + " ");
    const { entries } = loadOracleEntries(join(copy, "entries"));
    let calls = 0;
    const set = await runOracleSet({ entries, adapter: adapterId, appCommit, baseDir: copy, run: async e => { calls++; return cached(e); } });
    const bad = set.results.filter(r => r.verdict === "invalid");
    expect(bad.map(r => r.oracleId)).toEqual(["pra-and"]);
    expect(set.verdict).toBe("fail");
    expect(set.blocked).toBe(true);
    expect(calls).toBe(set.results.length - bad.length);
  }, 1500000);

  it("a tolerance edited without a new pin does not load; a new commit flags the pins", () => {
    const copy = mkdtempSync(join(tmpdir(), "seed pra oracles tol "));
    dirs.push(copy);
    cpSync(join(base, "entries"), copy, { recursive: true });
    const file = join(copy, "pra-vote-exact.json");
    const e = JSON.parse(readFileSync(file, "utf8"));
    e.tolerance = { abs: 1, rel: 1 };
    writeFileSync(file, JSON.stringify(e, null, 2));
    const r = loadOracleEntries(copy);
    expect(r.entries).toHaveLength(13);
    expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "pra-vote-exact.json/toleranceHash" });
    const { entries } = loadOracleEntries(join(base, "entries"));
    const accepted = pinsOf(entries, appCommit);
    expect(comparePins(accepted, pinsOf(entries, "0".repeat(40)))).toEqual([`app commit ${appCommit} -> ${"0".repeat(40)}`]);
  });
});
