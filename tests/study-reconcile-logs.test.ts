// @covers R-STUDY-02, R-STUDY-06
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFromHostFile, saveHostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { replayFromHostFile } from "../src/core/replayHost";
import { samplingSummaryProblem } from "../src/core/report";
import { runSamplingFromHostFile } from "../src/core/samplingHost";
import { verifyStudyLog } from "../src/core/semantic";
import { BACKFILL_PREFIX, reconcileStudyRecord } from "../src/core/studyReconcile";
import { readStudyRecord, studyRecordFile } from "../src/core/studyRecord";
import { budget, fixture, fixtureDirs, policyDir } from "./helpers/replayFixture";
import { FIXTURE_HUMAN, makeHeader } from "./helpers/studyFixtures";

// Reconciliation also rebuilds the step of a replay and the summary step of a sampling, from their own logs in the state folder (docs/study-record.md):
// if the record is lost or a step could not be appended, a human asks for it and gets the same words the live step had.
const saved = process.env.SEED_STUDY_HEADER;
beforeEach(() => { delete process.env.SEED_STUDY_HEADER; });
afterEach(() => {
  if (saved === undefined) delete process.env.SEED_STUDY_HEADER; else process.env.SEED_STUDY_HEADER = saved;
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const marker = / \(ref [0-9a-f]{16}\)$/;
async function world() {
  const f = await fixture({
    scenario: "series", maxCases: 20,
    samplings: { uq: { base: "approved", design: { method: "lhs", n: 4, seed: 11 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" }] } }
  });
  const projectId = JSON.parse(readFileSync(join(f.project, "seed.project.json"), "utf8")).projectId;
  writeHostJson(join(f.root, "study-header.json"), makeHeader({ studyId: "study", projectId, parameters: f.config.study.parameters, budget: f.config.study.budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN }));
  process.env.SEED_STUDY_HEADER = join(f.root, "study-header.json");
  const record = studyRecordFile(f.project, "studies", "study");
  const rows = () => { const r = readStudyRecord(record); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.rows; };
  // a human's copy of the host configuration: the same host, the same state, another identity
  const adminFile = join(f.root, "admin-host.json");
  saveHostConfiguration(adminFile, { ...f.config, actor: { kind: "human", name: "the user" } });
  const orig = await runFromHostFile(f.file, { requestId: "orig", caseId: "approved", budget });
  const replay = await replayFromHostFile(f.file, { requestId: "rep1", originalRequestId: "orig", budget }, { adaptersDir: policyDir({ mode: "exact" }) });
  const sampling = await runSamplingFromHostFile(f.file, { requestId: "s1", samplingId: "uq", budget });
  expect([orig.ok, replay.ok, sampling.ok]).toEqual([true, true, true]);
  return { ...f, record, rows, adminFile };
}
const textOf = (rows: { reason?: unknown }[], start: string) => {
  const r = rows.find((x) => typeof x.reason === "string" && (x.reason as string).replace(BACKFILL_PREFIX, "").startsWith(start));
  return r ? (r.reason as string).replace(marker, "") : undefined;
};

describe("reconcile rebuilds the replay step and the sampling summary from their logs", () => {
  it("after the record is lost: both steps come back, marked as backfilled, in the live step's own words", async () => {
    const w = await world();
    const liveReplay = textOf(w.rows(), "Replay of run");
    const liveSampling = textOf(w.rows(), "Sampling summary uq");
    expect(liveReplay).toBeDefined();
    expect(liveSampling).toBeDefined();
    rmSync(w.record);

    const dry = reconcileStudyRecord(w.adminFile, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, state: "dry-run" });
    const keys = ((dry as { would: { key: string }[] }).would).map((x) => x.key);
    expect(keys).toContain("replay:rep1");
    expect(keys).toContain("sampling:s1");

    const done = reconcileStudyRecord(w.adminFile, {});
    expect(done).toMatchObject({ ok: true, state: "reconciled" });
    const rows = w.rows();
    const backReplay = textOf(rows, "Replay of run");
    const backSampling = textOf(rows, "Sampling summary uq");
    expect(backReplay).toBe(BACKFILL_PREFIX + liveReplay);
    expect(backSampling).toBe(BACKFILL_PREFIX + liveSampling);
    expect(samplingSummaryProblem(backSampling!)).toBeNull();
    expect(rows.filter((x) => x.action === "compare")).toHaveLength(2);
    expect(verifyStudyLog(readFileSync(w.record, "utf8").trim().split("\n"))).toEqual([]);
  }, 300000);

  it("a second reconcile has nothing to do, and a record that still has the steps is left alone", async () => {
    const w = await world();
    const before = readFileSync(w.record, "utf8");
    expect(reconcileStudyRecord(w.adminFile, {})).toMatchObject({ ok: true, state: "nothing-to-do", appended: 0 });
    expect(readFileSync(w.record, "utf8")).toBe(before);
    rmSync(w.record);
    reconcileStudyRecord(w.adminFile, {});
    expect(reconcileStudyRecord(w.adminFile, {})).toMatchObject({ ok: true, state: "nothing-to-do" });
  }, 300000);

  it("only the missing step is written: a record that lost just the sampling summary gets just that", async () => {
    const w = await world();
    const lines = readFileSync(w.record, "utf8").trim().split("\n");
    // keep everything but the last step (the sampling summary is the last row written)
    expect(JSON.parse(lines.at(-1)!).reason).toMatch(/Sampling summary uq/);
    rmSync(w.record);
    reconcileStudyRecord(w.adminFile, {});
    const all = readFileSync(w.record, "utf8").trim().split("\n");
    // cut the backfilled record back to before the sampling summary, then ask again
    const cut = all.findIndex((l) => /Sampling summary uq/.test(JSON.parse(l).reason ?? ""));
    expect(cut).toBeGreaterThan(0);
    const keep = all.slice(0, cut);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(w.record, keep.join("\n") + "\n");
    const again = reconcileStudyRecord(w.adminFile, {});
    expect(again).toMatchObject({ ok: true, state: "reconciled", appended: 1 });
    expect(w.rows().at(-1)!.reason).toMatch(/Sampling summary uq/);
  }, 300000);

  it("lines of the logs that cannot be read are counted and left alone; a request this study's audit does not show is not written", async () => {
    const w = await world();
    appendFileSync(join(w.state, "replays.jsonl"), "this is not json\n");
    appendFileSync(join(w.state, "samplings.jsonl"), JSON.stringify({ schema: "seed.sampling-record/0.1", time: "2026-10-24T12:00:00.000Z", event: { phase: "summary", samplingId: "other", requestId: "stranger", facts: { samplingId: "other", requestId: "stranger", design: { method: "lhs", n: 4, seed: 1 }, parameters: [], planned: 4, completed: 4, runIds: [], outputs: [] } } }) + "\n");
    appendFileSync(join(w.state, "samplings.jsonl"), JSON.stringify({ schema: "seed.sampling-record/0.1", time: "2026-10-24T12:00:00.000Z", event: { phase: "summary", samplingId: "uq", requestId: "s1" } }) + "\n");
    rmSync(w.record);
    const r = reconcileStudyRecord(w.adminFile, {});
    expect(r).toMatchObject({ ok: true, state: "reconciled", unreadableLogLines: 2 });
    expect(w.rows().some((x) => /stranger/.test(String(x.reason)))).toBe(false);
    expect(w.rows().filter((x) => x.action === "compare")).toHaveLength(2);
  }, 300000);

  it("a replay that never finished (no finished row) writes no step", async () => {
    const w = await world();
    const logFile = join(w.state, "replays.jsonl");
    const kept = readFileSync(logFile, "utf8").trim().split("\n").filter((l) => JSON.parse(l).event.phase !== "finished");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logFile, kept.join("\n") + "\n");
    rmSync(w.record);
    reconcileStudyRecord(w.adminFile, {});
    expect(textOf(w.rows(), "Replay of run")).toBeUndefined();
    expect(textOf(w.rows(), "Sampling summary uq")).toBeDefined();
  }, 300000);
});
