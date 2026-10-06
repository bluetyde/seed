import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";
import { checkResultsAgainstRecord, checkResultsIndex } from "../src/core/semantic";
import { validate } from "../src/core/validate";

// These tests drive the FEED adapter against a scripted stand-in for FEED's headless runner (tests/fixtures/feed-stub), so
// they need neither the FEED build nor its WSL solver. The real-runner checks live in feed-oracles.test.ts.
const stubBundle = join(__dirname, "fixtures", "feed-stub", "headless.cjs");
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "feed", "cli.cjs")], id: "feed", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const CASE = "models/feed/case.json";
const QUANTITIES = ["temperature_radial", "temperature_peak", "temperature_fuel_surface", "temperature_clad_inner", "temperature_surface", "heat_flux_outer", "energy_balance_residual"];

const dirs: string[] = [];
const pids: number[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup of a test's leftovers
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const useStub = (mode = "ok", verbs?: string, extra: Record<string, string> = {}) => {
  process.env.SEED_FEED_HEADLESS = stubBundle;
  process.env.FEED_STUB_MODE = mode;
  if (verbs) process.env.FEED_STUB_VERBS = verbs;
  Object.assign(process.env, extra);
};

function feedProject(caseObj: unknown = { format: "feed.case", version: "0.1" }) {
  const root = mkdtempSync(join(tmpdir(), "seed-feed-"));
  dirs.push(root);
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  mkdirSync(join(root, "models", "feed"));
  const caseText = JSON.stringify(caseObj, null, 2) + "\n";
  writeFileSync(join(root, CASE), caseText);
  const hash = sha256Hex(caseText);
  return { root, caseText, inputs: [{ path: CASE, sha256: hash }], artifact: { path: CASE, revision: { hash, counter: 1 } } };
}

const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 20000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 30000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; warnings: any[]; result?: any };
};
const runStart = (root: string, p: ReturnType<typeof feedProject>, id: string, extra: Record<string, unknown> = {}) =>
  manager(root).start({ requestId: id, actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { case: CASE }, ...extra });
const jobIdOf = (root: string, runId: string): string => JSON.parse(readFileSync(join(root, "runs", runId, "native", "job.json"), "utf8")).jobId;

const collectError = async (root: string, out: { ok: boolean; runId?: string }) => okReply(await ask(root, { verb: "collect", jobId: jobIdOf(root, out.runId!), runDir: `runs/${out.runId}` }));

describe("FEED adapter: configuration", () => {
  it.each([
    ["unset", undefined],
    ["relative", "headless.js"],
    ["missing file", join(tmpdir(), "no-such-feed-headless.js")],
  ])("without a usable runner path (%s) every verb that needs it says setup is required", async (_n, value) => {
    if (value === undefined) delete process.env.SEED_FEED_HEADLESS;
    else process.env.SEED_FEED_HEADLESS = value;
    const p = feedProject();
    for (const req of [
      { verb: "describe" },
      { verb: "validate", artifact: p.artifact },
      { verb: "run", snapshot: { inputs: p.inputs }, runDir: "runs/r-x", budget },
    ]) {
      const r = okReply(await ask(p.root, req));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.code).toBe("E_SETUP_REQUIRED");
    }
  });

  it("describe: runner version, formats, the steady and transient quantities, thermal-only capability", async () => {
    useStub();
    const r = okReply(await ask(feedProject().root, { verb: "describe" }));
    expect(r.ok).toBe(true);
    expect(r.result.app.id).toBe("feed");
    expect(r.result.engine).toEqual({ name: "feed-headless", version: "9.9.9" });
    expect(r.result.formats).toEqual([{ id: "feed.case", version: "0.1" }]);
    expect(r.result.quantities.map((q: { name: string }) => q.name)).toEqual([...QUANTITIES, "temperature_peak_history", "temperature_outer_wall_history", "temperature_peak_max", "time_of_peak", "energy_deposited", "energy_balance_gap"]);
    expect(r.result.capabilities).toContain("thermal-only");
    expect(r.result.oracleCoverage).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("describe passes the runner's declared transfers on, drops malformed ones, and says nothing when there are none", async () => {
    const good = { field: "heating-to-pin", accepts: [{ dimension: "energy", normalization: "per-source-particle" }, { dimension: "power", normalization: "none" }], parameters: { time: "steady only" } };
    useStub("ok", undefined, { FEED_STUB_TRANSFERS: JSON.stringify([good, { field: "bad field!", accepts: [{ dimension: "power" }] }, { field: "no-accepts", accepts: [] }, { field: "bad-norm", accepts: [{ dimension: "power", normalization: "per-banana" }] }, { field: "half", accepts: [{ dimension: "power" }, { normalization: "none" }] }]) });
    const r = okReply(await ask(feedProject().root, { verb: "describe" }));
    expect(r.ok).toBe(true);
    expect(r.result.transfers).toEqual([good]);
    expect(validate("adapter-reply", r)).toEqual({ ok: true });
    delete process.env.FEED_STUB_TRANSFERS;
    const none = okReply(await ask(feedProject().root, { verb: "describe" }));
    expect("transfers" in none.result).toBe(false);
  });

  it("describe: a missing solver is a warning, and run is then refused as setup required, with no job", async () => {
    useStub("ok", undefined, { FEED_STUB_SOLVER: "missing" });
    const p = feedProject();
    const d = okReply(await ask(p.root, { verb: "describe" }));
    expect(d.warnings.map((w) => w.code)).toEqual(["W_SOLVER_MISSING"]);
    const out = await runStart(p.root, p, "req-nosolver");
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify(out.ok && out.record)).toContain("E_SETUP_REQUIRED");
    expect(existsSync(join(p.root, "runs", (out as { runId: string }).runId, "native", "job.json"))).toBe(false);
  });

  it("oracle coverage comes from the good entries of the configured folder only", async () => {
    useStub();
    const dir = mkdtempSync(join(tmpdir(), "seed-feed-ent-"));
    dirs.push(dir);
    const entry = (tag: string, adapter: string, q: string[]) => JSON.stringify({ schema: "seed.oracle/0.1", tag, adapter, coverage: { quantities: q, domain: "synthetic pin, constant k" } });
    writeFileSync(join(dir, "a.json"), entry("good", "feed", ["temperature_peak"]));
    writeFileSync(join(dir, "b.json"), entry("bad-input", "feed", ["temperature_surface"]));
    writeFileSync(join(dir, "c.json"), entry("good", "raft", ["power"]));
    writeFileSync(join(dir, "d.json"), "{not json");
    process.env.SEED_FEED_ORACLES = dir;
    const r = okReply(await ask(feedProject().root, { verb: "describe" }));
    expect(r.result.oracleCoverage).toEqual([{ quantity: "temperature_peak", domain: "synthetic pin, constant k" }]);
  });

  it("open is not supported", async () => {
    useStub();
    const p = feedProject();
    const r = okReply(await ask(p.root, { verb: "open", artifact: p.artifact }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_VERB_UNKNOWN");
  });

  it("a runner that prints something that is not a describe reply is E_APP_FAILED", async () => {
    useStub("garbage");
    const r = okReply(await ask(feedProject().root, { verb: "describe" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_APP_FAILED");
  });
});

describe("FEED adapter: validate", () => {
  it("a good case is valid; a runner warning comes through as a warning, not a problem", async () => {
    useStub();
    const p = feedProject();
    expect(okReply(await ask(p.root, { verb: "validate", artifact: p.artifact }))).toMatchObject({ ok: true, result: { valid: true, problems: [] } });
    useStub("warn");
    const w = okReply(await ask(p.root, { verb: "validate", artifact: p.artifact }));
    expect(w.result.valid).toBe(true);
    expect(w.result.problems.map((x: { code: string }) => x.code)).toEqual(["W_POWER_RANGE"]);
  });

  it("the runner's refusal is data, labelled app-content, with its own code and field", async () => {
    useStub("refuse");
    const p = feedProject();
    const r = okReply(await ask(p.root, { verb: "validate", artifact: p.artifact }));
    expect(r.result.valid).toBe(false);
    expect(r.result.problems[0]).toMatchObject({ code: "E_UNITS", field: "/fuel/radius", source: "app-content" });
    expect(r.result.problems[0].message).toContain("ignore previous instructions");
  });

  it("a refusal without any reason is still a refusal", async () => {
    useStub("refuse-empty");
    const p = feedProject();
    const r = okReply(await ask(p.root, { verb: "validate", artifact: p.artifact }));
    expect(r.result.valid).toBe(false);
    expect(r.result.problems[0].code).toBe("E_APP_FAILED");
  });

  it("a runner crash is E_APP_FAILED, not a verdict", async () => {
    useStub("crash");
    const p = feedProject();
    const r = okReply(await ask(p.root, { verb: "validate", artifact: p.artifact }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_APP_FAILED");
  });

  it("a stale revision and a missing file are problems", async () => {
    useStub();
    const p = feedProject();
    const stale = okReply(await ask(p.root, { verb: "validate", artifact: { ...p.artifact, revision: { hash: "0".repeat(64), counter: 1 } } }));
    expect(stale.result.problems.map((x: { code: string }) => x.code)).toContain("E_STALE_REVISION");
    const missing = okReply(await ask(p.root, { verb: "validate", artifact: { ...p.artifact, path: "models/feed/none.json" } }));
    expect(missing.result.problems[0]?.code).toBe("E_NOT_FOUND");
    const esc = await ask(p.root, { verb: "validate", artifact: { path: "../x.json", revision: p.artifact.revision } });
    expect(esc.ok).toBe(false);
  });
});

describe("FEED adapter: run and collect through the SEED run manager (stub runner)", () => {
  it("completed: a valid index, seven quantities with files that hash as listed, the thermal-only statement", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-ok");
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.state).toBe("completed");
    const index = JSON.parse(readFileSync(join(p.root, "runs", out.runId, "results.json"), "utf8"));
    expect(validate("results-index", index)).toEqual({ ok: true });
    expect(checkResultsIndex(index)).toEqual([]);
    expect(checkResultsAgainstRecord(index, out.record)).toEqual([]);
    expect(index.quantities.map((q: { name: string }) => q.name)).toEqual(QUANTITIES);
    expect(index.quantities.every((q: { verification: string }) => q.verification === "unverified")).toBe(true);
    for (const q of index.quantities) expect(sha256Hex(readFileSync(join(p.root, q.data.path)))).toBe(q.data.sha256);
    const data = (name: string) => JSON.parse(readFileSync(join(p.root, "runs", out.runId, "native", "series", `${name}.json`), "utf8"));
    expect(data("temperature_peak")).toEqual({ quantity: "temperature_peak", unit: "K", values: [900.5] });
    expect(data("temperature_surface").values).toEqual([600.125]);
    expect(data("heat_flux_outer")).toMatchObject({ unit: "W/m2", values: [670000] });
    expect(data("energy_balance_residual")).toMatchObject({ unit: "1", values: [1.25e-4] });
    expect(data("temperature_radial")).toMatchObject({ unit: "K", r: [0.0001, 0.004, 0.0045], values: [900.5, 700.25, 600.125] });
    expect(index.extensions.feed.thermalOnly).toMatch(/Not a stress, failure or integrity assessment/);
    expect(index.extensions.feed.caseSha256).toBe(sha256Hex(p.caseText));
    expect(index.extensions.feed.domain).toBe("in-domain");
    expect(index.inputHashes).toEqual(p.inputs);
  });

  it.each([
    ["failed", "E_TIMEOUT"],
    ["refuse", "the runner reported"],
    ["crash", "stub crashed"],
    ["garbage", "the runner exited with 0"],
  ])("a run where the runner is %s ends failed with the reason, and nothing is collected", async (mode, detail) => {
    useStub(mode, "run");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-" + mode);
    if (!out.ok) throw new Error("refused: " + JSON.stringify(out.errors));
    expect(out.state).toBe("failed");
    expect(JSON.stringify(out.record)).toContain(detail);
    expect(existsSync(join(p.root, "runs", out.runId, "results.json"))).toBe(false);
  });

  it("a result whose own checks failed is not collected", async () => {
    useStub("checkfail");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-checkfail");
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify((await collectError(p.root, out as any)).errors)).toContain("energyBalance");
    expect(existsSync(join(p.root, "runs", (out as { runId: string }).runId, "results.json"))).toBe(false);
  });

  it("a result computed outside a conductivity law's range is refused as E_OUT_OF_DOMAIN", async () => {
    useStub("out-of-domain");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-ood");
    expect(out.ok && out.state).toBe("failed");
    expect((await collectError(p.root, out as any)).errors[0]?.code).toBe("E_OUT_OF_DOMAIN");
  });

  it("a value that is not a finite number is not collected", async () => {
    useStub("nan");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-nan");
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify((await collectError(p.root, out as any)).errors)).toContain("temperature_peak");
  });

  it("a manifest listing another file set is refused", async () => {
    useStub("extra-file");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-extra");
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify((await collectError(p.root, out as any)).errors)).toContain("exactly its five files");
  });

  it("the request seed is refused: FEED is deterministic; no job is created", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-seed", { seed: 99 });
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify(out.ok && out.record)).toContain("E_UNSUPPORTED");
    expect(existsSync(join(p.root, "runs", (out as { runId: string }).runId, "native", "job.json"))).toBe(false);
  });

  it("the snapshot must be exactly one case, and settings.case must be that file", async () => {
    useStub();
    const p = feedProject();
    writeFileSync(join(p.root, "models", "feed", "other.json"), "{}");
    const two = [...p.inputs, { path: "models/feed/other.json", sha256: sha256Hex("{}") }];
    const a = await manager(p.root).start({ requestId: "req-two", actor, artifact: p.artifact, inputs: two, budget, settings: { case: CASE } });
    expect(a.ok && a.state).toBe("failed");
    expect(JSON.stringify(a.ok && a.record)).toContain("E_UNSUPPORTED");
    const b = await manager(p.root).start({ requestId: "req-name", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { case: "models/feed/not-there.json" } });
    expect(b.ok && b.state).toBe("failed");
    expect(JSON.stringify(b.ok && b.record)).toContain("E_PROP_MISSING");
  });

  it("collect refuses a run whose files were changed after it finished, and one whose snapshot was replaced", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-tamper");
    if (!out.ok) throw new Error("refused");
    const jobId = jobIdOf(p.root, out.runId);
    const results = join(p.root, "runs", out.runId, "native", "out", "feed", "results.json");
    const original = readFileSync(results, "utf8");
    writeFileSync(results, original.replace("900.5", "901.5"));
    const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "E_OUTPUT_INCOMPLETE" });
    expect(r.errors[0]?.message).toContain("does not match its manifest hash");
    writeFileSync(results, original);
    const snap = join(p.root, "runs", out.runId, "inputs", CASE);
    writeFileSync(snap, readFileSync(snap, "utf8").replace("0.1", "0.2"));
    const r2 = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r2.ok).toBe(false);
    expect(r2.errors[0]?.message).toContain("snapshot changed");
  });

  it("collect does not trust a re-hashed results file that names another case or a manifest with another file list", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-rehash");
    if (!out.ok) throw new Error("refused");
    const jobId = jobIdOf(p.root, out.runId);
    const dir = join(p.root, "runs", out.runId, "native", "out", "feed");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, caseSha256: "0".repeat(64) }));
    const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r.errors[0]?.message).toContain("did not use the snapshot's case");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, files: m.files.filter((f: { path: string }) => f.path !== "run.json") }));
    const r2 = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r2.errors[0]?.message).toContain("exactly its five files");
  });

  it("status and cancel of an unknown job are typed failures; a finished job is not cancelled again", async () => {
    useStub();
    const p = feedProject();
    expect(okReply(await ask(p.root, { verb: "status", jobId: "job-none" })).errors[0]?.code).toBe("E_APP_FAILED");
    expect(okReply(await ask(p.root, { verb: "cancel", jobId: "job-none" })).errors[0]?.code).toBe("E_APP_FAILED");
    const out = await runStart(p.root, p, "req-done");
    if (!out.ok) throw new Error("refused");
    const jobId = jobIdOf(p.root, out.runId);
    expect(okReply(await ask(p.root, { verb: "cancel", jobId })).result).toMatchObject({ lifecycle: "completed", cancelled: false });
    expect(okReply(await ask(p.root, { verb: "status", jobId })).result.lifecycle).toBe("completed");
  });

  it("the same request twice gives one job; another request on that run folder conflicts", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-idem");
    if (!out.ok) throw new Error("refused");
    const runDir = `runs/${out.runId}`;
    const snapshot = { inputs: p.inputs };
    expect(okReply(await ask(p.root, { verb: "run", requestId: "req-idem", snapshot, runDir, budget, settings: { case: CASE } })).ok).toBe(true);
    const other = okReply(await ask(p.root, { verb: "run", requestId: "req-other", snapshot, runDir, budget, settings: { case: CASE } }));
    expect(other.ok).toBe(false);
    expect(other.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
  });
});

describe("FEED adapter: transient (pulse) results (stub runner)", () => {
  const TRANSIENT = ["temperature_peak_history", "temperature_outer_wall_history", "temperature_peak_max", "time_of_peak", "energy_deposited", "energy_balance_gap"];

  it("describe lists the steady and the transient quantities and the transient capability", async () => {
    useStub();
    const r = okReply(await ask(feedProject().root, { verb: "describe" }));
    const names = r.result.quantities.map((q: { name: string }) => q.name);
    for (const q of [...QUANTITIES, ...TRANSIENT]) expect(names).toContain(q);
    expect(r.result.capabilities).toContain("transient-pulse");
  });

  it("a transient run is collected as time series and scalars, valid against the index schema, with the thermal-only statement", async () => {
    useStub("transient");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-transient");
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.state).toBe("completed");
    const index = JSON.parse(readFileSync(join(p.root, "runs", out.runId, "results.json"), "utf8"));
    expect(validate("results-index", index)).toEqual({ ok: true });
    expect(checkResultsIndex(index)).toEqual([]);
    expect(checkResultsAgainstRecord(index, out.record)).toEqual([]);
    expect(index.quantities.map((q: { name: string }) => q.name)).toEqual(TRANSIENT);
    for (const q of index.quantities) expect(sha256Hex(readFileSync(join(p.root, q.data.path)))).toBe(q.data.sha256);
    const data = (name: string) => JSON.parse(readFileSync(join(p.root, "runs", out.runId, "native", "series", name + ".json"), "utf8"));
    expect(data("temperature_peak_history")).toMatchObject({ unit: "K", t: [0, 0.005, 0.01], values: [300, 460.95, 615.5958] });
    expect(data("temperature_peak_max")).toEqual({ quantity: "temperature_peak_max", unit: "K", values: [615.5958] });
    expect(data("time_of_peak").values).toEqual([0.01]);
    expect(data("energy_deposited")).toMatchObject({ unit: "J/m", values: [50000] });
    expect(data("energy_balance_gap").values).toEqual([0.02]);
    const series = index.quantities.find((q: { name: string }) => q.name === "temperature_peak_history");
    expect(series.coordinates).toEqual({ system: "time", axes: [{ name: "t", unit: "s" }] });
    expect(index.extensions.feed.kind).toBe("transient");
    expect(index.extensions.feed.thermalOnly).toMatch(/Not a stress, failure or integrity assessment/);
  });

  it("a steady run is still a steady record (kind steady, the seven steady quantities)", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-steady-kind");
    if (!out.ok) throw new Error("refused");
    const index = JSON.parse(readFileSync(join(p.root, "runs", out.runId, "results.json"), "utf8"));
    expect(index.extensions.feed.kind).toBe("steady");
    expect(index.quantities.map((q: { name: string }) => q.name)).toEqual(QUANTITIES);
  });

  it.each([
    ["transient-shortseries", "peakT"],
    ["transient-badtimes", "increasing"],
  ])("a malformed transient (%s) is not collected", async (mode, word) => {
    useStub(mode);
    const p = feedProject();
    const out = await runStart(p.root, p, "req-" + mode);
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify((await collectError(p.root, out as any)).errors)).toContain(word);
  });
});

describe("FEED adapter: cancel (stub runner that never finishes)", () => {
  async function startHanging(p: ReturnType<typeof feedProject>, id: string) {
    const mgr = manager(p.root);
    const started = mgr.start({ requestId: id, actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { case: CASE } });
    let runId: string | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !runId) {
      try {
        const rid = JSON.parse(readFileSync(join(p.root, "runs", "requests.json"), "utf8"))[id]?.runId as string | undefined;
        if (rid && existsSync(join(p.root, "runs", rid, "native", "child.json"))) runId = rid;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).toBeDefined();
    const job = JSON.parse(readFileSync(join(p.root, "runs", runId!, "native", "job.json"), "utf8"));
    const child = JSON.parse(readFileSync(join(p.root, "runs", runId!, "native", "child.json"), "utf8"));
    pids.push(job.pid, child.pid);
    return { mgr, started, runId: runId!, job, child };
  }

  it("asks the runner to stop the solver first, then kills the job and the runner; nothing is collected", async () => {
    useStub("hang", "run");
    const p = feedProject();
    const { mgr, started, runId, job, child } = await startHanging(p, "req-cancel");
    expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
    const c = await mgr.cancel(runId);
    expect(c.ok && c.state).toBe("cancelled");
    const s = await started;
    expect(s.ok && s.state).toBe("cancelled");
    expect(isAlive(job.pid)).toBe(false);
    expect(isAlive(child.pid)).toBe(false);
    expect(existsSync(join(p.root, "runs", runId, "native", "out", "cancel-called"))).toBe(true);
    expect(existsSync(join(p.root, "runs", runId, "results.json"))).toBe(false);
  }, 60000);

  it("if the runner cannot confirm the solver stopped, nothing is killed and nothing is claimed cancelled", async () => {
    useStub("hang", "run", { FEED_STUB_CANCEL: "fail" });
    const p = feedProject();
    const { job, child, runId } = await startHanging(p, "req-cancel-fail");
    const r = okReply(await ask(p.root, { verb: "cancel", jobId: job.jobId }));
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ lifecycle: "running", cancelled: false });
    expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
    expect(existsSync(join(p.root, "runs", runId, "native", "out", "cancel-called"))).toBe(true);
  }, 60000);

  it("does not kill a process whose heartbeat does not carry the job's token (pid reuse guard)", async () => {
    useStub("hang", "run");
    const p = feedProject();
    const { mgr, started, runId, job, child } = await startHanging(p, "req-owner");
    const jobPath = join(p.root, "runs", runId, "native", "job.json");
    writeFileSync(jobPath, JSON.stringify({ ...job, token: "not-the-token" }));
    const early = okReply(await ask(p.root, { verb: "collect", jobId: job.jobId, runDir: `runs/${runId}` }));
    expect(early.errors[0]).toMatchObject({ code: "E_OUTPUT_INCOMPLETE", message: "job is not completed" });
    const r = okReply(await ask(p.root, { verb: "cancel", jobId: job.jobId }));
    expect(r.result).toMatchObject({ lifecycle: "failed", cancelled: false });
    expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
    writeFileSync(jobPath, JSON.stringify(job));
    await mgr.cancel(runId);
    await started;
  }, 60000);
});

describe("FEED adapter: review findings (Codex, 2026-10-05)", () => {
  async function startHanging(p: ReturnType<typeof feedProject>, id: string) {
    const mgr = manager(p.root);
    const started = mgr.start({ requestId: id, actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { case: CASE } });
    let runId: string | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !runId) {
      try {
        const rid = JSON.parse(readFileSync(join(p.root, "runs", "requests.json"), "utf8"))[id]?.runId as string | undefined;
        if (rid && existsSync(join(p.root, "runs", rid, "native", "child.json"))) runId = rid;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).toBeDefined();
    const job = JSON.parse(readFileSync(join(p.root, "runs", runId!, "native", "job.json"), "utf8"));
    const child = JSON.parse(readFileSync(join(p.root, "runs", runId!, "native", "child.json"), "utf8"));
    pids.push(job.pid, child.pid);
    return { mgr, started, runId: runId!, job, child };
  }

  it("a runner that answers cancelled:false (no solver run registered) is asked again after the kill; the job is then cancelled", async () => {
    useStub("hang", "run", { FEED_STUB_CANCEL: "none" });
    const p = feedProject();
    const { job, child, runId } = await startHanging(p, "req-none");
    const r = okReply(await ask(p.root, { verb: "cancel", jobId: job.jobId }));
    expect(r.result).toMatchObject({ lifecycle: "cancelled", cancelled: true });
    expect(isAlive(job.pid) || isAlive(child.pid)).toBe(false);
    expect(existsSync(join(p.root, "runs", runId, "native", "out", "cancel-called"))).toBe(true);
  }, 60000);

  it("a process of another run is never killed: a forged pid in job.json fails the ownership check", async () => {
    useStub("hang", "run");
    const p = feedProject();
    const q = feedProject();
    const a = await startHanging(p, "req-own-a");
    const b = await startHanging(q, "req-own-b");
    const jobPath = join(p.root, "runs", a.runId, "native", "job.json");
    writeFileSync(jobPath, JSON.stringify({ ...a.job, pid: b.job.pid }));
    const r = okReply(await ask(p.root, { verb: "cancel", jobId: a.job.jobId }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
    expect(isAlive(b.job.pid) && isAlive(b.child.pid)).toBe(true);
    writeFileSync(jobPath, JSON.stringify(a.job));
    await a.mgr.cancel(a.runId);
    await b.mgr.cancel(b.runId);
    await a.started;
    await b.started;
  }, 90000);

  it("the same request id for another run folder is a conflict and leaves the first job findable", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-shared");
    if (!out.ok) throw new Error("refused");
    const jobId = jobIdOf(p.root, out.runId);
    const other = join(p.root, "runs", "r-other");
    mkdirSync(join(other, "inputs", "models", "feed"), { recursive: true });
    writeFileSync(join(other, "inputs", CASE), p.caseText);
    const r = okReply(await ask(p.root, { verb: "run", requestId: "req-shared", snapshot: { inputs: p.inputs }, runDir: "runs/r-other", budget, settings: { case: CASE } }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    expect(okReply(await ask(p.root, { verb: "status", jobId })).result.lifecycle).toBe("completed");
    expect(existsSync(join(other, "native", "job.json"))).toBe(false);
  });

  it("an unfinished reservation (no process id yet) is not reported as a running job", async () => {
    useStub();
    const p = feedProject();
    const dir = join(p.root, "runs", "r-res");
    mkdirSync(join(dir, "inputs", "models", "feed"), { recursive: true });
    mkdirSync(join(dir, "native"));
    writeFileSync(join(dir, "inputs", CASE), p.caseText);
    writeFileSync(join(dir, "native", "job.json"), JSON.stringify({ jobId: "job-x", requestId: "req-res", pid: null, token: "t" }));
    const r = okReply(await ask(p.root, { verb: "run", requestId: "req-res", snapshot: { inputs: p.inputs }, runDir: "runs/r-res", budget, settings: { case: CASE } }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
  });

  it("a result with no domain verdict is not collected, and is never labelled in-domain", async () => {
    useStub("nodomain");
    const p = feedProject();
    const out = await runStart(p.root, p, "req-nodomain");
    expect(out.ok && out.state).toBe("failed");
    expect(JSON.stringify((await collectError(p.root, out as any)).errors)).toContain("no domain verdict");
  });

  it("collect does not write through a series folder that is a link", async () => {
    useStub();
    const p = feedProject();
    const out = await runStart(p.root, p, "req-series");
    if (!out.ok) throw new Error("refused");
    const jobId = jobIdOf(p.root, out.runId);
    const outside = mkdtempSync(join(tmpdir(), "seed-feed-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "temperature_peak.json"), "SENTINEL");
    const series = join(p.root, "runs", out.runId, "native", "series");
    rmSync(series, { recursive: true, force: true });
    try {
      symlinkSync(outside, series, "junction");
    } catch {
      return; // links are not permitted in this environment
    }
    const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toContain("series folder");
    expect(readFileSync(join(outside, "temperature_peak.json"), "utf8")).toBe("SENTINEL");
  });
});
