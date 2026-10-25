// @covers R-STUDY-09
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { readAdmissions, writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { issueGrant, type Actor, type Grant } from "../src/core/policy";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import type { PassFunction } from "../src/core/coupling";
import { runCouplingFromHostFile, saveCouplingHostConfig, validateCouplingHostConfig, type CouplingHostConfig, type PassBuilder } from "../src/core/couplingHost";

// The coupling host with scripted apps: a pass is a function with a known fixed point (x -> 0.5 x + 500, so 1000), so the number of passes and the
// answer are exact. Real project store, real oracle evidence per app (a git repository, an entry, a passing set), real gate, real journal.
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };

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

const Q = "temperature_fuel_mean";
async function fixture(over: { blockedApp?: boolean; maxCases?: number; maxPasses?: number; purpose?: "plumbing-test" | "physics" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seed coupling host "));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  expect(createProject(project, { name: "Coupling fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const a = JSON.stringify({ model: "openmc" }), b = JSON.stringify({ case: "feed" });
  writeFileSync(join(project, "models/a.json"), a);
  writeFileSync(join(project, "models/b.json"), b);
  const p = openProject(project);
  if (!p.ok) throw Error("project");
  const manifest = structuredClone(p.value.manifest) as Record<string, any>;
  manifest.artifacts = [
    { id: "a-model", app: "appa", path: "models/a.json", format: "a.model", formatVersion: "1", revision: { hash: sha256Hex(a), counter: 1 } },
    { id: "b-case", app: "appb", path: "models/b.json", format: "b.case", formatVersion: "1", revision: { hash: sha256Hex(b), counter: 1 } },
  ];
  expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);
  const apps = { appa: await appOracles(root, "a", "appa"), appb: await appOracles(root, "b", "appb", { blocked: over.blockedApp }) };
  const inputs = [{ artifact: "a-model", revision: sha256Hex(a) }, { artifact: "b-case", revision: sha256Hex(b) }];
  const config = (actor: Actor, grants: Grant[] = []): CouplingHostConfig => ({
    schema: "seed.coupling-host/0.1", projectRoot: project, stateRoot: state, actor,
    study: { studyId: "study-1", tier: "A2", budget: { ...budget, maxCases: over.maxCases ?? 100 }, parameters: [] },
    grants, apps,
    loops: {
      lumped: {
        purpose: over.purpose ?? "plumbing-test", kind: "scripted", apps: ["appa", "appb"], inputs,
        definition: { exchanged: [{ id: Q, tolerance: 1e-3, min: 250, max: 2500 }], maxPasses: over.maxPasses ?? 10, relaxation: 1, consecutive: 2 },
        start: { [Q]: 900 },
      },
    },
  });
  const grant = (over2: Partial<Grant> = {}): Grant => {
    const g = issueGrant(human, {
      grantId: "g-1", studyId: "study-1", actor: { kind: agent.kind, name: agent.name }, operation: "enable_coupling", inputRevisions: inputs,
      issuedAt: "2026-10-25T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z", ...over2,
    } as any);
    if (!g.ok) throw Error(JSON.stringify(g.errors));
    return g.grant;
  };
  const file = join(root, "agent-host.json");
  const write = (grants: Grant[], edit: (c: CouplingHostConfig) => void = () => {}) => {
    const c = config(agent, grants);
    edit(c);
    saveCouplingHostConfig(file, c);
  };
  return { root, project, state, file, config, grant, write, inputs, a, b, journal: () => readAdmissions(join(state, "coupling-journal")) };
}
type F = Awaited<ReturnType<typeof fixture>>;
const codes = (r: { ok: boolean; errors?: { code: string; field: string }[] }) => (r.ok ? [] : r.errors!.map((e) => `${e.code} ${e.field}`));
const phases = (f: F) => f.journal().map((r) => (r.event as { phase: string }).phase);

/** Passes with a known fixed point; `calls` counts how often the builder and the pass ran. */
function scripted(map: (x: number, index: number) => Awaited<ReturnType<PassFunction>> | Promise<Awaited<ReturnType<PassFunction>>>) {
  const calls = { builder: 0, pass: 0 };
  const builder: PassBuilder = () => {
    calls.builder++;
    return async (iterate, index) => { calls.pass++; return map(iterate[Q] as number, index); };
  };
  return { builders: { scripted: builder }, calls };
}
const contraction = (x: number, index: number) => ({ ok: true as const, calc: { [Q]: 0.5 * x + 500 }, runs: { appa: `a-${index}`, appb: `b-${index}` } });
let n = 0;
const req = (loopId = "lumped") => ({ requestId: "req-" + ++n, loopId });

describe("running a registered loop", () => {
  it("with a human grant it converges on the known fixed point, journals every pass and says it is a plumbing test", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    const s = scripted(contraction);
    const out = await runCouplingFromHostFile(f.file, req(), s.builders);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, verification: "unverified", purpose: "plumbing-test", grantId: "g-1" });
    if (!out.ok) return;
    expect(out.claim).toContain("not the physics");
    expect(out.outcome.state).toBe("converged");
    expect(out.outcome.result!.iterate[Q]).toBeCloseTo(1000, 0);
    expect(out.outcome.result!.passes).toBe(s.calls.pass);
    // the journal: start, one row per pass (with both apps' run ids), the outcome; the hash chain reads whole
    const ph = phases(f);
    expect(ph[0]).toBe("start");
    expect(ph.at(-1)).toBe("outcome");
    expect(ph.filter((x) => x === "pass")).toHaveLength(s.calls.pass);
    const rows = f.journal().map((r) => r.event as any);
    expect(rows.filter((r) => r.phase === "pass")[0]).toMatchObject({ index: 1, iterate: { [Q]: 900 }, runs: { appa: "a-1", appb: "b-1" } });
    expect(rows[0]).toMatchObject({ purpose: "plumbing-test", via: "grant", grantId: "g-1", start: { [Q]: 900 } });
    expect(rows.at(-1)).toMatchObject({ state: "converged", verification: "unverified" });
  });

  it("a loop that does not converge in its passes ends not-converged and produces no result", async () => {
    const f = await fixture({ maxPasses: 3 });
    f.write([f.grant()]);
    const s = scripted((x) => ({ ok: true, calc: { [Q]: x + 50 } }));
    const out = await runCouplingFromHostFile(f.file, req(), s.builders);
    expect(out.ok && out.outcome.state).toBe("not-converged");
    expect(out.ok && out.outcome.result).toBeUndefined();
    expect(out.ok && out.outcome.passes).toHaveLength(3);
    expect(f.journal().map((r) => r.event as any).at(-1)).toMatchObject({ phase: "outcome", state: "not-converged" });
  });

  it("a failing or throwing pass ends engine-failure, the earlier passes stay as evidence", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    const failing = scripted((x, i) => (i === 3 ? { ok: false, reason: "FEED run ended failed", runs: { appb: "b-3" } } : contraction(x, i)));
    const out = await runCouplingFromHostFile(f.file, req(), failing.builders);
    expect(out.ok && out.outcome.state).toBe("engine-failure");
    expect(out.ok && out.outcome.passes).toHaveLength(2);
    expect(f.journal().map((r) => r.event as any).filter((r) => r.phase === "pass")[2]).toMatchObject({ index: 3, failed: "FEED run ended failed", runs: { appb: "b-3" } });
    const throwing = scripted(() => { throw new Error("boom"); });
    const t = await runCouplingFromHostFile(f.file, req(), throwing.builders);
    expect(t.ok && t.outcome.state).toBe("engine-failure");
    expect(f.journal().map((r) => r.event as any).filter((r) => r.failed).pop().failed).toContain("boom");
  });

  it("a loop with the purpose physics says so and still reports its quantities unverified", async () => {
    const f = await fixture({ purpose: "physics" });
    f.write([f.grant()]);
    const out = await runCouplingFromHostFile(f.file, req(), scripted(contraction).builders);
    expect(out).toMatchObject({ ok: true, purpose: "physics", verification: "unverified" });
    expect(out.ok && out.claim).toContain("coupled oracle");
  });

  it("a request id is used once; a new id runs again", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    const s = scripted(contraction);
    const r = req();
    expect((await runCouplingFromHostFile(f.file, r, s.builders)).ok).toBe(true);
    const again = s.calls.pass;
    expect(codes(await runCouplingFromHostFile(f.file, r, s.builders))).toEqual(["E_REQUEST_CONFLICT /requestId"]);
    expect(s.calls.pass).toBe(again);
    expect((await runCouplingFromHostFile(f.file, req(), s.builders)).ok).toBe(true);
  });

  it("a second request for a loop that is running is refused, not interleaved, and the first finishes whole", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    const s = scripted(async (x, i) => { await new Promise((r) => setTimeout(r, 15)); return contraction(x, i); });
    const [p, q] = await Promise.all([runCouplingFromHostFile(f.file, req(), s.builders), runCouplingFromHostFile(f.file, req(), s.builders)]);
    expect([p.ok, q.ok].sort()).toEqual([false, true]);
    expect(codes(p.ok ? q : p)).toEqual(["E_PROJECT_LOCKED "]);
    const ph = phases(f);
    expect(ph.filter((x) => x === "start")).toHaveLength(1);
    expect(ph.filter((x) => x === "outcome")).toHaveLength(1);
    expect(ph.at(-1)).toBe("outcome");
  });
});

describe("who may run a loop", () => {
  it("an agent without a grant is refused, the refusal is journaled and no pass runs", async () => {
    const f = await fixture();
    f.write([]);
    const s = scripted(contraction);
    const out = await runCouplingFromHostFile(f.file, req(), s.builders);
    expect(codes(out)).toEqual(["E_NOT_PERMITTED /operation"]);
    expect(s.calls).toEqual({ builder: 0, pass: 0 });
    expect(phases(f)).toEqual(["refused"]);
    expect((f.journal()[0]!.event as any).gateStop.rule).toBe("grant-required");
  });

  it.each<[string, (f: F) => Grant]>([
    ["expired", (f) => f.grant({ issuedAt: "2019-01-01T00:00:00.000Z", expires: "2020-01-01T00:00:00.000Z" })],
    ["another actor's", (f) => f.grant({ actor: { kind: "agent", name: "someone-else" } })],
    ["for other input revisions", (f) => f.grant({ inputRevisions: [{ artifact: "a-model", revision: "f".repeat(64) }, f.inputs[1]!] })],
    ["for fewer inputs", (f) => f.grant({ inputRevisions: [f.inputs[0]!] })],
    ["revoked", (f) => ({ ...f.grant(), revoked: true })],
  ])("a grant that is %s does not open the loop", async (_n, make) => {
    const f = await fixture();
    f.write([make(f)]);
    const s = scripted(contraction);
    expect((await runCouplingFromHostFile(f.file, req(), s.builders)).ok).toBe(false);
    expect(s.calls.builder).toBe(0);
  });

  it("a grant for another operation does not open it", async () => {
    const f = await fixture();
    f.write([f.grant({ operation: "enable_transfer" })]);
    expect((await runCouplingFromHostFile(f.file, req(), scripted(contraction).builders)).ok).toBe(false);
  });

  it("a configuration with a grant that no human approved cannot be saved", async () => {
    const f = await fixture();
    const g = { ...f.grant(), approvedBy: agent };
    expect(() => f.write([g])).toThrow(/grant/);
  });

  it("changed pins or a failed oracle set stop the loop for every actor", async () => {
    const f = await fixture();
    f.write([f.grant()], (c) => { c.apps.appa!.acceptedPins = { ...c.apps.appa!.acceptedPins, appCommit: "0".repeat(40) }; });
    const s = scripted(contraction);
    expect(codes(await runCouplingFromHostFile(f.file, req(), s.builders))).toEqual(["E_NOT_PERMITTED /operation"]);
    expect(s.calls.builder).toBe(0);
    const g = await fixture({ blockedApp: true });
    g.write([g.grant()]);
    expect(codes(await runCouplingFromHostFile(g.file, req(), s.builders))).toEqual(["E_NOT_PERMITTED /operation"]);
    expect((g.journal()[0]!.event as any).gateStop.rule).toBe("oracle-failed");
  });

  it("a project that moved on since the loop was registered makes it stale", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    const p = openProject(f.project);
    if (!p.ok) throw Error("project");
    const m = structuredClone(p.value.manifest) as Record<string, any>;
    m.artifacts[1].revision = { hash: "e".repeat(64), counter: 2 };
    expect(saveProject(f.project, m, p.value.revision).ok).toBe(true);
    const s = scripted(contraction);
    expect(codes(await runCouplingFromHostFile(f.file, req(), s.builders))).toEqual(["E_STALE_REVISION /loopId"]);
    expect(s.calls.builder).toBe(0);
  });

  it("the passes of a loop count against the study's case limit", async () => {
    const f = await fixture({ maxCases: 5 });
    f.write([f.grant()]);
    const s = scripted(contraction);
    const out = await runCouplingFromHostFile(f.file, req(), s.builders);
    expect(codes(out)).toEqual(["E_BUDGET_EXCEEDED /cases"]);
    expect(s.calls.builder).toBe(0);
  });
});

describe("the request and the setup", () => {
  it.each<[string, unknown, string]>([
    ["an extra field", { requestId: "r1", loopId: "lumped", relaxation: 0.1 }, "E_SCHEMA_INVALID "],
    ["a missing loop id", { requestId: "r1" }, "E_SCHEMA_INVALID "],
    ["an id that is not an id", { requestId: "../x", loopId: "lumped" }, "E_SCHEMA_INVALID "],
    ["not an object", "lumped", "E_SCHEMA_INVALID "],
    ["an unknown loop", { requestId: "r1", loopId: "nope" }, "E_NOT_FOUND /loopId"],
  ])("refuses %s", async (_n, request, expected) => {
    const f = await fixture();
    f.write([f.grant()]);
    const s = scripted(contraction);
    expect(codes(await runCouplingFromHostFile(f.file, request, s.builders))).toEqual([expected]);
    expect(s.calls.builder).toBe(0);
  });

  it("a loop kind with no pass builder is a setup error, and a builder may refuse before pass 1", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    expect(codes(await runCouplingFromHostFile(f.file, req(), {}))).toEqual(["E_SETUP_REQUIRED /loopId"]);
    const refusing: Record<string, PassBuilder> = { scripted: () => ({ ok: false, errors: [{ code: "E_UNSUPPORTED", field: "/x", message: "no", source: "seed" }] }) };
    expect(codes(await runCouplingFromHostFile(f.file, req(), refusing))).toEqual(["E_UNSUPPORTED /x"]);
    expect(f.journal().map((r) => r.event as any).at(-1)).toMatchObject({ phase: "outcome", state: "refused", passes: [] });
  });

  it("a prototype key cannot name a pass builder", async () => {
    const f = await fixture();
    f.write([f.grant()], (c) => { (c.loops.lumped as any).kind = "constructor"; });
    expect(codes(await runCouplingFromHostFile(f.file, req(), {}))).toEqual(["E_SETUP_REQUIRED /loopId"]);
  });

  it.each<[string, (c: CouplingHostConfig) => void, RegExp]>([
    ["a loop naming an app that is not configured", (c) => { c.loops.lumped!.apps = ["appa", "ghost"]; }, /not configured/],
    ["a loop without a start value for an exchanged quantity", (c) => { c.loops.lumped!.start = { other: 1 }; }, /no start value/],
    ["a start value for a quantity that is not exchanged", (c) => { c.loops.lumped!.start = { [Q]: 900, extra: 1 }; }, /not exchanged/],
    ["a definition over the hard ceiling of passes", (c) => { (c.loops.lumped!.definition as any).maxPasses = 26; }, /ceiling/],
    ["a definition with a zero tolerance", (c) => { (c.loops.lumped!.definition as any).exchanged[0].tolerance = 0; }, /tolerance/],
    ["an unknown field", (c) => { (c as any).extra = 1; }, /invalid seed\.coupling-host/],
  ])("the configuration refuses %s", async (_n, edit, why) => {
    const f = await fixture();
    const c = f.config(agent);
    edit(c);
    expect(() => validateCouplingHostConfig(JSON.parse(JSON.stringify(c)))).toThrow(why);
  });

  it("the configuration must live outside the project", async () => {
    const f = await fixture();
    expect(() => saveCouplingHostConfig(join(f.project, "host.json"), f.config(agent))).toThrow(/outside the project/);
  });

  it("a rerun after the journal has rows still reads the whole chain", async () => {
    const f = await fixture();
    f.write([f.grant()]);
    for (let i = 0; i < 2; i++) expect((await runCouplingFromHostFile(f.file, req(), scripted(contraction).builders)).ok).toBe(true);
    expect(f.journal().length).toBeGreaterThan(4);
    expect(readFileSync(join(f.state, "coupling-journal/admissions.jsonl"), "utf8").endsWith("\n")).toBe(true);
  });
});
