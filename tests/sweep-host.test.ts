import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { allCases, runFromHostFile, saveHostConfiguration, validateHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject } from "../src/core/projectStore";
import { runSweepFromHostFile } from "../src/core/sweepHost";

// Switches for the review-batch-1 tests below: every other test runs the real code (both mocks pass everything through while a switch is off).
const faults = vi.hoisted(() => ({ failFinishedRow: false, ranButUnrecorded: false }));
vi.mock("../src/core/hostFiles", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/core/hostFiles")>();
  return {
    ...m,
    appendSweepRecord: (state: string, event: any) => {
      if (faults.failFinishedRow && event?.phase === "finished") throw Error("no space left on device");
      return m.appendSweepRecord(state, event);
    },
  };
});
vi.mock("../src/core/fileRunHost", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/core/fileRunHost")>();
  return {
    ...m,
    runFromHostFile: async (...a: Parameters<typeof m.runFromHostFile>) => {
      if (faults.ranButUnrecorded) return { ok: false as const, errors: [{ code: "E_INTERNAL", field: "", message: "the outcome could not be audited", source: "seed" as const }], runId: "r-ran" };
      return m.runFromHostFile(...a);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  faults.failFinishedRow = false;
  faults.ranButUnrecorded = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };

/** The fake-adapter host of tests/file-run-host.test.ts with one bounded parameter, delayMs, that a sweep can vary. */
async function fixture(opts: { scenario?: string; tier?: "A0" | "A1"; maxCases?: number; values?: number[]; sweeps?: HostConfiguration["sweeps"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seed sweep host "));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "Sweep fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const model = JSON.stringify({ name: "case", counter: 1, fake: { validate: "ok" } });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  writeFileSync(join(project, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "p_top", value: 0.02, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = {
    schema: "seed.oracle/0.1", oracleId: "test-one", entryVersion: 1, adapter: "fake", adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
    source: { kind: "hand", text: "test", check: "independent fixture" }, coverage: { quantities: ["p_top"], domain: "fixture" },
    toleranceHash: sha256Hex(canonicalJson({ expected, tolerance }))
  };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  expect(indexed.errors).toEqual([]);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: "fake", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json");
  writeHostJson(evidence, result);
  const runtime = resolve(__dirname, "fixtures/fake-adapter/cli.cjs");
  const config: HostConfiguration = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "fake", version: "0.1.0", command: process.execPath, args: [runtime] },
    actor: { kind: "agent", name: "test-agent", model: "fixture" },
    study: { studyId: "study", tier: opts.tier ?? "A1", budget: { ...budget, ...(opts.maxCases ? { maxCases: opts.maxCases } : {}) }, parameters: [{ id: "delayMs", min: 0, max: 1000 }] },
    cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: [{ id: "delayMs", value: 10 }], settings: { scenario: opts.scenario ?? "success", delayMs: 10 } } },
    sweeps: opts.sweeps ?? { t: { base: "approved", axes: [{ id: "delayMs", values: opts.values ?? [10, 20, 30] }] } },
    runtime: { path: runtime, sha256: sha256Hex(readFileSync(runtime)) },
    oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) },
    acceptedPins: result.pins
  };
  const file = join(root, "host.json");
  saveHostConfiguration(file, config);
  return { root, project, state, file, config, request: { requestId: "sw1", sweepId: "t", budget } };
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : []);
const runDirs = (project: string) => readdirSync(join(project, "runs")).filter((n) => n !== "requests.json" && !n.startsWith("requests.json") && !n.startsWith("."));

describe("running a registered sweep", () => {
  it("runs every case one after another, each with its own run record and the value it was given", async () => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r).toMatchObject({ ok: true, complete: true, sweepId: "t", requestId: "sw1" });
    if (!r.ok) return;
    expect(r.results.map((x) => [x.caseId, x.state])).toEqual([["t-001", "completed"], ["t-002", "completed"], ["t-003", "completed"]]);
    expect(r.results.map((x) => x.values[0]!.value)).toEqual([10, 20, 30]);
    expect(r.results.map((x) => x.requestId)).toEqual(["sw1.t-001", "sw1.t-002", "sw1.t-003"]);
    expect(new Set(r.results.map((x) => x.runId)).size).toBe(3);
    const delays = r.results.map((x) => JSON.parse(readFileSync(join(f.project, "runs", x.runId!, "run-record.json"), "utf8")).settings?.delayMs ?? JSON.parse(readFileSync(join(f.project, "runs", x.runId!, "run-record.json"), "utf8")).adapterRequest?.settings?.delayMs);
    expect(delays).toEqual([10, 20, 30]);
  });

  it("every case passes the full gate and is recorded: three requests, three decisions, three outcomes, in order", async () => {
    const f = await fixture();
    await runSweepFromHostFile(f.file, f.request);
    const engine = join(f.state, "engines", sha256Hex(resolve(__dirname, "fixtures/fake-adapter/cli.cjs")));
    const rows = lines(join(engine, "admissions.jsonl")).map((x) => x.event.phase);
    expect(rows).toEqual(["request", "decision", "outcome", "request", "decision", "outcome", "request", "decision", "outcome"]);
  });

  it("the sweep itself is recorded: admitted with its case count, then finished with every case's state", async () => {
    const f = await fixture();
    await runSweepFromHostFile(f.file, f.request);
    const rows = lines(join(f.state, "sweeps.jsonl")).map((x) => x.event);
    expect(rows.map((x) => x.phase)).toEqual(["admitted", "finished"]);
    expect(rows[0]).toMatchObject({ sweepId: "t", requestId: "sw1", cases: 3, via: "tier", actor: { name: "test-agent" } });
    expect(rows[1]).toMatchObject({ complete: true });
    expect(rows[1].results.map((x: { state: string }) => x.state)).toEqual(["completed", "completed", "completed"]);
  });

  it("asking again with the same request id replays the finished cases and starts no new run", async () => {
    const f = await fixture();
    const a = await runSweepFromHostFile(f.file, f.request);
    const before = runDirs(f.project).length;
    const b = await runSweepFromHostFile(f.file, f.request);
    expect(b.ok && b.complete).toBe(true);
    if (a.ok && b.ok) expect(b.results.map((x) => x.runId)).toEqual(a.results.map((x) => x.runId));
    expect(runDirs(f.project)).toHaveLength(before);
  });

  it("a failed case stays in the table, the sweep stops there and the cases after it are not started (the engine needs a human check first)", async () => {
    const f = await fixture({ scenario: "crash" });
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((x) => x.state)).toEqual(["failed", "not-started", "not-started"]);
    expect(r.results[0]!.runId).toBeDefined();
    expect(r.complete).toBe(false);
    expect(r.stoppedAt).toEqual({ caseId: "t-001", reason: "case ended failed" });
    expect(runDirs(f.project)).toHaveLength(1);
  });

  it("a case ended by a trip is a result of the experiment: the sweep goes on", async () => {
    const f = await fixture({ scenario: "trip" });
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((x) => x.state)).toEqual(["terminated-by-trip", "terminated-by-trip", "terminated-by-trip"]);
    expect(r.complete).toBe(true);
  });

  it("a value outside the study's bounds is refused by the gate before its case; the earlier case stays, the later ones are not started", async () => {
    const f = await fixture({ values: [10, 5000, 20] });
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((x) => x.state)).toEqual(["completed", "refused", "not-started"]);
    expect(r.results[1]!.errors![0]).toMatchObject({ code: "E_BOUNDS_EXCEEDED" });
    expect(r.complete).toBe(false);
    expect(r.stoppedAt).toMatchObject({ caseId: "t-002" });
    expect(runDirs(f.project)).toHaveLength(1);
    expect(lines(join(f.state, "sweeps.jsonl")).at(-1)!.event).toMatchObject({ phase: "finished", complete: false });
  });
});

describe("what the client cannot do", () => {
  it.each([
    ["a value", { requestId: "x", sweepId: "t", budget, values: [1] }],
    ["a case id", { requestId: "x", sweepId: "t", budget, caseId: "approved" }],
    ["an actor", { requestId: "x", sweepId: "t", budget, actor: { kind: "human", name: "h" } }],
    ["no budget", { requestId: "x", sweepId: "t" }],
    ["a budget with a missing key", { requestId: "x", sweepId: "t", budget: { maxWallSeconds: 1 } }],
    ["a budget with a fractional value", { requestId: "x", sweepId: "t", budget: { ...budget, maxCores: 1.5 } }],
    ["a request id that is not text", { requestId: 5, sweepId: "t", budget }],
    ["an empty request id", { requestId: "", sweepId: "t", budget }],
    ["a request id over 64 characters", { requestId: "r".repeat(65), sweepId: "t", budget }],
    ["a sweep id that is not text", { requestId: "x", sweepId: 5, budget }],
    ["nothing", null],
    ["a list", []]
  ])("%s is refused before anything is read or run", async (_name, request) => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, request);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]!.code).toBe("E_SCHEMA_INVALID");
    expect(existsSync(join(f.state, "sweeps.jsonl"))).toBe(false);
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it("a sweep that is not registered is refused and the refusal is recorded; nothing runs", async () => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, { ...f.request, sweepId: "other" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: "E_NOT_PERMITTED", field: "/sweepId" });
    expect(lines(join(f.state, "sweeps.jsonl"))[0].event).toMatchObject({ phase: "refused", sweepId: "other" });
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it.each(["constructor", "__proto__", "toString"])("a sweep named %s is just not registered", async (name) => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, { ...f.request, sweepId: name });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: "E_NOT_PERMITTED", field: "/sweepId" });
    expect(lines(join(f.state, "sweeps.jsonl"))[0].event).toMatchObject({ phase: "refused", reason: "sweep is not registered" });
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it.each(["r".repeat(60), "has space", "a/b"])("a request id that cannot carry a case id after it (%s) is refused and recorded, and nothing runs", async (requestId) => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, { ...f.request, requestId });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/requestId" });
    expect(lines(join(f.state, "sweeps.jsonl"))[0].event).toMatchObject({ phase: "refused" });
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it("a per-case budget over the study's is refused for the whole sweep: no case starts", async () => {
    const f = await fixture();
    const r = await runSweepFromHostFile(f.file, { ...f.request, budget: { ...budget, maxWallSeconds: 31 } });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: "E_BUDGET_EXCEEDED" });
    expect(lines(join(f.state, "sweeps.jsonl"))[0].event).toMatchObject({ phase: "refused", gateStop: { rule: "budget" } });
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it("a study below tier A1 does not run sweeps", async () => {
    const f = await fixture({ tier: "A0" });
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]!.code).toBe("E_NOT_PERMITTED");
    expect(runDirs(f.project)).toHaveLength(0);
  });

  it("a relative host configuration path is refused", async () => {
    const f = await fixture();
    const r = await runSweepFromHostFile("host.json", f.request);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]!.code).toBe("E_SETUP_REQUIRED");
  });

  it("the host configuration changing during the sweep stops it before the next case", async () => {
    const f = await fixture({ values: [10, 20, 30] });
    const original = readFileSync(f.file);
    let changed = false;
    const timer = setInterval(() => {
      const runs = existsSync(join(f.project, "runs")) ? runDirs(f.project).length : 0;
      if (runs >= 1 && !changed) {
        changed = true;
        writeFileSync(f.file, Buffer.concat([original, Buffer.from("\n")]));
      }
    }, 2);
    const r = await runSweepFromHostFile(f.file, f.request);
    clearInterval(timer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.complete).toBe(false);
    expect(r.stoppedAt?.reason).toMatch(/configuration changed/);
    expect(r.results.some((x) => x.state === "not-started")).toBe(true);
  });
});

describe("the host configuration", () => {
  it("expands its sweeps into cases a client may name, and a sweep case is run like any registered case", async () => {
    const f = await fixture();
    const c = validateHostConfiguration(JSON.parse(readFileSync(f.file, "utf8")));
    expect(Object.keys(allCases(c))).toEqual(["approved", "t-001", "t-002", "t-003"]);
    const r = await runFromHostFile(f.file, { requestId: "one", caseId: "t-002", budget });
    expect(r).toMatchObject({ ok: true, state: "completed" });
  });

  it("a configuration with more cases than the study allows is invalid, as is one with a bad sweep", async () => {
    const f = await fixture();
    const eleven = Array.from({ length: 11 }, (_, i) => i * 10);
    expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, sweeps: { t: { base: "approved", axes: [{ id: "delayMs", values: eleven }] } } })).toThrow(/over the study limit|more than/);
    expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, study: { ...f.config.study, budget: { ...budget, maxCases: 2 } } })).toThrow(/invalid sweep t/);
    expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, sweeps: { t: { base: "approved", axes: [{ id: "nope", values: [1] }] } } })).toThrow(/invalid sweep t/);
    expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, sweeps: { t: { base: "missing", axes: [{ id: "delayMs", values: [1] }] } } })).toThrow(/invalid sweep t/);
    expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, sweeps: { t: { base: "approved", axes: [{ id: "delayMs", values: [1], extra: 1 }] } } as never })).toThrow(/invalid seed.host/);
  });

  it("a sweep may not take over the id of a registered case", async () => {
    const f = await fixture();
    const clash = { ...f.config, cases: { ...f.config.cases, "t-001": f.config.cases.approved! } };
    expect(() => saveHostConfiguration(join(f.root, "x.json"), clash)).toThrow(/would reuse the registered case id t-001/);
  });

  it("maxCases larger than the default lets a longer sweep be registered", async () => {
    const f = await fixture({ maxCases: 12, values: Array.from({ length: 12 }, (_, i) => i * 10) });
    const c = validateHostConfiguration(JSON.parse(readFileSync(f.file, "utf8")));
    expect(Object.keys(allCases(c))).toHaveLength(13);
  });

  it("a maxCases that is not a positive integer is invalid", async () => {
    const f = await fixture();
    for (const bad of [0, -1, 1.5, "10"])
      expect(() => saveHostConfiguration(join(f.root, "x.json"), { ...f.config, study: { ...f.config.study, budget: { ...budget, maxCases: bad } } })).toThrow(/invalid seed.host/);
  });
});

describe("the command line", () => {
  const cli = (file: string, input: unknown, verb = "sweep") => {
    const r = spawnSync(process.execPath, [resolve(__dirname, "../dist/cli/seed.js"), verb], { input: JSON.stringify(input), encoding: "utf8", timeout: 60000, env: { ...process.env, SEED_HOST_CONFIG: file } });
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    return { status: r.status, reply: JSON.parse(r.stdout) };
  };

  it("`sweep` runs the sweep and exits 0 when every case ran", async () => {
    const f = await fixture();
    const { status, reply } = cli(f.file, f.request);
    expect(status).toBe(0);
    expect(reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, complete: true, sweepId: "t" });
    expect(reply.results).toHaveLength(3);
  });

  it("exits 1 when the sweep stopped early and 2 when it was refused", async () => {
    const f = await fixture({ values: [10, 5000] });
    expect(cli(f.file, f.request).status).toBe(1);
    const g = await fixture();
    expect(cli(g.file, { ...g.request, sweepId: "other" }).status).toBe(2);
  });

  it("the other verbs keep their exit codes: a completed run exits 0", async () => {
    const f = await fixture();
    expect(cli(f.file, { requestId: "c1", caseId: "approved", budget }, "run").status).toBe(0);
  });
});

// Findings of the Codex review of batch 1 (2026-10-08), each shown by a test that fails without its fix.
describe("review batch 1: sweeps", () => {
  it("a case that ran but whose outcome could not be audited keeps its run id and is not called a refusal", async () => {
    const f = await fixture();
    faults.ranButUnrecorded = true;
    const r = await runSweepFromHostFile(f.file, f.request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results[0]).toMatchObject({ state: "ran-unrecorded", runId: "r-ran" });
    expect(r.results.slice(1).map((x) => x.state)).toEqual(["not-started", "not-started"]);
  });

  it("when the closing row cannot be written the finished cases are still returned, with the recording error named", async () => {
    const f = await fixture();
    faults.failFinishedRow = true;
    const r: any = await runSweepFromHostFile(f.file, f.request);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.results.every((x: any) => typeof x.runId === "string")).toBe(true);
    expect(r.recordingError).toMatch(/closing row could not be written.*no space left/);
  });
});
