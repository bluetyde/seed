// @covers R-STUDY-05
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { runFromHostFile, saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject } from "../src/core/projectStore";
import { replayFromHostFile } from "../src/core/replayHost";
import { runSweepFromHostFile } from "../src/core/sweepHost";

// The replay verb through the real host path with the fake adapter (docs/replay.md). The fixture is the one of tests/sweep-host.test.ts.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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

// ---- the replay policy of the fake adapter (the shipped adapters have theirs in adapters/<id>/replay.json) ------------------------------------------------
function policies(policy: unknown | null) {
  const dir = mkdtempSync(join(tmpdir(), "seed replay policies "));
  dirs.push(dir);
  if (policy !== null) {
    mkdirSync(join(dir, "fake"));
    writeFileSync(join(dir, "fake", "replay.json"), JSON.stringify({ schema: "seed.replay-policy/0.1", adapter: "fake", policy, basis: "the fake adapter, for the tests of the replay verb" }));
  }
  return { adaptersDir: dir };
}
const EXACT = { mode: "exact" };
const fx = (o: Parameters<typeof fixture>[0] = {}) => fixture({ scenario: "series", ...o });
const run = (f: { file: string }, requestId = "orig") => runFromHostFile(f.file, { requestId, caseId: "approved", budget });
const replayRequest = (over: Record<string, unknown> = {}) => ({ requestId: "rep1", originalRequestId: "orig", budget, ...over });
const runCount = (project: string) => runDirs(project).length;
const log = (f: { state: string }) => lines(join(f.state, "replays.jsonl")).map((x) => x.event);

describe("replaying a recorded run", () => {
  it("runs the registered case again and says the second run reproduces the first", async () => {
    const f = await fx();
    const first = await run(f);
    expect(first).toMatchObject({ ok: true, state: "completed" });
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok || !first.ok) return;
    expect(r.result.verdict).toBe("reproduced");
    expect(r.original).toEqual({ requestId: "orig", runId: first.runId });
    expect(r.replay).toMatchObject({ requestId: "rep1", state: "completed" });
    expect(r.replay.runId).not.toBe(first.runId);
    expect(r.adapter).toBe("fake");
    expect(r.policy).toEqual(EXACT);
    expect(r.result.quantities.map((q) => [q.name, q.verdict])).toEqual([["out", "reproduced"]]);
    expect(runCount(f.project)).toBe(2);
    // the replay went through the guarded path: it has its own request, decision and outcome in the audit log
    const record = JSON.parse(readFileSync(join(f.project, "runs", r.replay.runId, "run-record.json"), "utf8"));
    expect(record.extensions["seed.dispatch"].requestId).toBe("rep1");
  });

  it("writes the replay log: admitted, then finished with the verdict", async () => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok).toBe(true);
    const rows = log(f);
    expect(rows.map((x) => x.phase)).toEqual(["admitted", "finished"]);
    expect(rows[0]).toMatchObject({ requestId: "rep1", originalRequestId: "orig", caseId: "approved", policy: EXACT });
    expect(rows[1]).toMatchObject({ verdict: "reproduced", replayState: "completed", differences: [] });
  });

  it("a nondeterministic engine differs under an exact policy and reproduces within a tolerance", async () => {
    const f = await fx({ scenario: "jitter" });
    await run(f);
    const exact = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(exact.ok && exact.result.verdict).toBe("differs");
    if (exact.ok) expect(exact.result.differences.map((d) => [d.kind, d.field])).toEqual([["value", "out"]]);
    const loose = await replayFromHostFile(f.file, replayRequest({ requestId: "rep2" }), policies({ mode: "tolerance", abs: 1e-5, rel: 0 }));
    expect(loose.ok && loose.result.verdict).toBe("reproduced-within-tolerance");
    expect(log(f).filter((x) => x.phase === "finished").map((x) => x.verdict)).toEqual(["differs", "reproduced-within-tolerance"]);
  });

  it("the same replay request again gives the same replay run, not a third run", async () => {
    const f = await fx();
    await run(f);
    const a = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    const b = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(a.ok && b.ok && a.replay.runId === b.replay.runId).toBe(true);
    expect(runCount(f.project)).toBe(2);
  });

  it("a replay of a sweep case replays that case with its values", async () => {
    const f = await fx();
    const sw = await runSweepFromHostFile(f.file, { requestId: "s1", sweepId: "t", budget });
    expect(sw.ok && sw.complete).toBe(true);
    if (!sw.ok) return;
    const r = await replayFromHostFile(f.file, replayRequest({ originalRequestId: "s1.t-002" }), policies(EXACT));
    expect(r.ok && r.result.verdict).toBe("reproduced");
    if (r.ok) {
      const orig = JSON.parse(readFileSync(join(f.project, "runs", sw.results[1]!.runId!, "run-record.json"), "utf8"));
      const again = JSON.parse(readFileSync(join(f.project, "runs", r.replay.runId, "run-record.json"), "utf8"));
      expect(again.settings).toEqual(orig.settings);
      expect(again.settings.delayMs).toBe(20);
    }
  });
});

describe("what is refused before anything runs", () => {
  const nothingRan = async (f: Awaited<ReturnType<typeof fixture>>, before: number) => { expect(runCount(f.project)).toBe(before); };

  it.each([
    ["an extra field", { extra: 1 }],
    ["a missing original", { originalRequestId: undefined }],
    ["a request id that is not an id", { requestId: "has space" }],
    ["a budget with a missing limit", { budget: { maxCores: 1, maxDiskMB: 1, maxMemoryMB: 1 } }],
    ["a budget with a limit that is not a whole number", { budget: { ...budget, maxCores: 0.5 } }],
    ["no budget", { budget: undefined }],
  ])("refuses a request with %s", async (_n, over) => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, { ...replayRequest(), ...over }, policies(EXACT));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors[0]!.code).toBe("E_SCHEMA_INVALID");
    await nothingRan(f, 1);
  });

  it("refuses a request that uses the original's id as its own", async () => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, replayRequest({ requestId: "orig" }), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    await nothingRan(f, 1);
  });

  it("refuses when the adapter has no replay policy: there is no default", async () => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, replayRequest(), policies(null));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_SETUP_REQUIRED");
    expect(r.ok === false && r.errors[0]!.message).toMatch(/no replay policy for adapter fake/);
    await nothingRan(f, 1);
    expect(log(f).map((x) => x.phase)).toEqual(["refused"]);
  });

  it("refuses an original request that was never admitted or never ran", async () => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, replayRequest({ originalRequestId: "nope" }), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_NOT_FOUND");
    await nothingRan(f, 1);
  });

  it("refuses an original that did not complete: only a completed run can be reproduced", async () => {
    const f = await fx({ scenario: "crash" });
    const first = await run(f);
    expect(first.ok && first.state).toBe("failed");
    const before = runCount(f.project);
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_NOT_PERMITTED");
    expect(r.ok === false && r.errors[0]!.message).toMatch(/ended failed/);
    await nothingRan(f, before);
  });

  it("refuses when the host configuration changed in more than other cases since the original ran, naming why", async () => {
    const f = await fx();
    await run(f);
    // the study rules (here the tier) are not the ones the original was admitted under
    const changed = { ...f.config, study: { ...f.config.study, budget: { ...f.config.study.budget, maxWallSeconds: 31 } } };
    writeHostJson(f.file, changed);
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    expect(r.ok === false && r.errors[0]!.message).toMatch(/runtime, adapter, study rules, oracle evidence or the case changed/);
    await nothingRan(f, 1);
  });

  it("refuses when the case itself changed, but not when only another case or a sweep did", async () => {
    const f = await fx();
    await run(f);
    const base = f.config.cases.approved!;
    writeHostJson(f.file, { ...f.config, cases: { ...f.config.cases, approved: { ...base, settings: { ...(base.settings as object), delayMs: 11 } } } });
    const changedCase = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(changedCase.ok === false && changedCase.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    // the same file as when the original ran, with another case added and the sweeps removed: still the same experiment
    writeHostJson(f.file, { ...f.config, cases: { ...f.config.cases, other: { ...base, params: base.params } }, sweeps: {} });
    const other = await replayFromHostFile(f.file, replayRequest({ requestId: "rep2" }), policies(EXACT));
    expect(other.ok && other.result.verdict).toBe("reproduced");
  });

  it("refuses a stale original: an input changed since it ran", async () => {
    const f = await fx();
    await run(f);
    writeFileSync(join(f.project, "models/case.json"), JSON.stringify({ name: "case", counter: 2, fake: { validate: "ok" } }));
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_STALE_REVISION");
    await nothingRan(f, 1);
  });

  it("refuses an original whose saved record or saved output was changed after the run", async () => {
    const f = await fx();
    const first = await run(f);
    if (!first.ok) throw Error("the original did not run");
    const recordFile = join(f.project, "runs", first.runId, "run-record.json");
    const original = readFileSync(recordFile, "utf8");
    const record = JSON.parse(original);
    writeFileSync(recordFile, JSON.stringify({ ...record, finishedAt: "2030-01-01T00:00:00.000Z" }));
    const a = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(a.ok === false && a.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    expect(a.ok === false && a.errors[0]!.message).toMatch(/differs from its audited outcome/);
    writeFileSync(recordFile, original);
    const out = record.outputs.find((o: any) => /out\.json$|data/.test(o.path)) ?? record.outputs[0];
    writeFileSync(join(f.project, out.path), "{}");
    const b = await replayFromHostFile(f.file, replayRequest({ requestId: "rep2" }), policies(EXACT));
    expect(b.ok).toBe(false);
    await nothingRan(f, 1);
  });

  it("when the guarded run path refuses the replay (a budget over the study's), it reports that and the run never starts", async () => {
    const f = await fx();
    await run(f);
    const r = await replayFromHostFile(f.file, replayRequest({ budget: { ...budget, maxWallSeconds: 999999 } }), policies(EXACT));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors[0]!.code).toBe("E_BUDGET_EXCEEDED"); expect(r.replay).toEqual({ requestId: "rep1" }); }
    await nothingRan(f, 1);
    expect(log(f).map((x) => x.phase)).toEqual(["admitted", "refused"]);
  });
});
