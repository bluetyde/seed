// @covers R-STUDY-05
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFromHostFile } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { replayFromHostFile } from "../src/core/replayHost";
import { runSweepFromHostFile } from "../src/core/sweepHost";
import { budget, fixture, fixtureDirs, lines, policyDir, runDirs } from "./helpers/replayFixture";

// The replay verb through the real host path with the fake adapter (docs/replay.md). The fixture is the one of tests/sweep-host.test.ts.
const dirs: string[] = [];
afterEach(() => { for (const d of [...dirs.splice(0), ...fixtureDirs.splice(0)]) rmSync(d, { recursive: true, force: true }); });

// ---- the replay policy of the fake adapter (the shipped adapters have theirs in adapters/<id>/replay.json) ------------------------------------------------
const policies = (policy: unknown | null) => ({ adaptersDir: policyDir(policy) });
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
    expect(log(f)).toEqual([]); // refused by the verb's own check: it never got as far as the log, nor the run path
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

  it("refuses a sweep case whose sweep is no longer registered: the case is not there to run", async () => {
    const f = await fx();
    const sw = await runSweepFromHostFile(f.file, { requestId: "s1", sweepId: "t", budget });
    expect(sw.ok && sw.complete).toBe(true);
    const before = runCount(f.project);
    // the sweeps may differ from the original's, so the configuration check passes; the case is gone
    writeHostJson(f.file, { ...f.config, sweeps: {} });
    const r = await replayFromHostFile(f.file, replayRequest({ originalRequestId: "s1.t-002" }), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_NOT_FOUND");
    expect(r.ok === false && r.errors[0]!.message).toMatch(/no longer registered/);
    await nothingRan(f, before);
  });

  it("refuses a sweep case whose sweep now gives that case id another value: nothing is launched", async () => {
    const f = await fx();
    const sw = await runSweepFromHostFile(f.file, { requestId: "s1", sweepId: "t", budget });
    expect(sw.ok && sw.complete).toBe(true);
    const before = runCount(f.project);
    writeHostJson(f.file, { ...f.config, sweeps: { t: { base: "approved", axes: [{ id: "delayMs", values: [10, 25, 30] }] } } });
    const r = await replayFromHostFile(f.file, replayRequest({ originalRequestId: "s1.t-002" }), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    await nothingRan(f, before);
    // the same sweep as when it ran still replays
    writeHostJson(f.file, f.config);
    const same = await replayFromHostFile(f.file, replayRequest({ requestId: "rep9", originalRequestId: "s1.t-002" }), policies(EXACT));
    expect(same.ok && same.result.verdict).toBe("reproduced");
  });

  it("refuses a replay request id that was already used for a replay of another original: nothing is launched, the first replay is not handed back", async () => {
    const f = await fx();
    await run(f, "orig");
    await run(f, "orig2");
    const first = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(first.ok && first.result.verdict).toBe("reproduced");
    const before = runCount(f.project);
    const r = await replayFromHostFile(f.file, replayRequest({ originalRequestId: "orig2" }), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    expect(r.ok === false && r.errors[0]!.message).toMatch(/already used for a replay of orig/);
    await nothingRan(f, before);
    // the same id for the same original is still the same replay
    const again = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(again.ok).toBe(true);
  });

  it("refuses a stale original: an input changed since it ran", async () => {
    const f = await fx();
    await run(f);
    writeFileSync(join(f.project, "models/case.json"), JSON.stringify({ name: "case", counter: 2, fake: { validate: "ok" } }));
    const r = await replayFromHostFile(f.file, replayRequest(), policies(EXACT));
    expect(r.ok === false && r.errors[0]!.code).toBe("E_STALE_REVISION");
    await nothingRan(f, 1);
    // refused by the verb itself, before it asked the run path (which would also refuse a changed input, with the same code)
    expect(log(f).map((x) => x.phase)).toEqual(["refused"]);
    expect(log(f)[0]!.reason).toMatch(/stale: an input has changed/);
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
    // a saved data file changed to another valid series: only the hash can tell
    const out = record.outputs.find((o: any) => o.path.endsWith("out.json"));
    const outFile = join(f.project, out.path);
    const data = JSON.parse(readFileSync(outFile, "utf8"));
    writeFileSync(outFile, JSON.stringify({ ...data, values: [1, 2, 3.5] }));
    const b = await replayFromHostFile(f.file, replayRequest({ requestId: "rep2" }), policies(EXACT));
    expect(b.ok === false && b.errors[0]!.message).toMatch(/no longer matches its hash/);
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
