// @covers R-STUDY-05, R-STUDY-02
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFromHostFile } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { replayFromHostFile } from "../src/core/replayHost";
import { verifyStudyLog } from "../src/core/semantic";
import { readStudyRecord, studyRecordFile } from "../src/core/studyRecord";
import { replayStepDraft, type ReplayFacts } from "../src/core/studyRecordHost";
import { budget, fixture, fixtureDirs, lines, policyDir } from "./helpers/replayFixture";
import { FIXTURE_HUMAN, makeHeader } from "./helpers/studyFixtures";

// The replay verdict as a step of the live study record (docs/replay.md, docs/study-record.md): action `compare`, citing the original run and the replay run.
const savedHeader = process.env.SEED_STUDY_HEADER;
beforeEach(() => { delete process.env.SEED_STUDY_HEADER; });
afterEach(() => {
  if (savedHeader === undefined) delete process.env.SEED_STUDY_HEADER; else process.env.SEED_STUDY_HEADER = savedHeader;
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const EXACT = { mode: "exact" };
const fx = (o: Parameters<typeof fixture>[0] = {}) => fixture({ scenario: "series", ...o });
const request = (over: Record<string, unknown> = {}) => ({ requestId: "rep1", originalRequestId: "orig", budget, ...over });
const original = { requestId: "orig", caseId: "approved", budget };

/** A fixture whose host has a human study header (outside the project), as the host gets it from SEED_STUDY_HEADER. */
async function withHeader(opts: Parameters<typeof fixture>[0] = {}, headerOver: Record<string, unknown> = {}) {
  const f = await fx(opts);
  const projectId = JSON.parse(readFileSync(join(f.project, "seed.project.json"), "utf8")).projectId;
  const header = makeHeader({ studyId: "study", projectId, parameters: f.config.study.parameters, budget: f.config.study.budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN, ...headerOver });
  const headerFile = join(f.root, "study-header.json");
  writeHostJson(headerFile, header);
  process.env.SEED_STUDY_HEADER = headerFile;
  const record = studyRecordFile(f.project, "studies", "study");
  const rows = () => { const r = readStudyRecord(record); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.rows; };
  return { ...f, record, rows };
}
const run = (f: { file: string }) => runFromHostFile(f.file, original);
const replay = (f: { file: string }, over: Record<string, unknown> = {}, policy: unknown = EXACT) => replayFromHostFile(f.file, request(over), { adaptersDir: policyDir(policy) });

describe("a replay leaves a step in the live study record", () => {
  it("one compare step after the replay run's own steps, citing the original and the replay run, with the verdict and the policy", async () => {
    const f = await withHeader();
    const first = await run(f);
    if (!first.ok) throw new Error("original did not run");
    const r = await replay(f);
    expect(r.ok && r.studyRecord).toEqual({ appended: 1 });
    if (!r.ok) return;
    const rows = f.rows().slice(1);
    const step = rows.at(-1)!;
    expect(step.action).toBe("compare");
    expect(step.runs).toEqual([first.runId, r.replay.runId]);
    expect(step.actor).toMatchObject({ kind: "agent", name: "test-agent" });
    expect(step.reason).toMatch(new RegExp(`Replay of run ${first.runId} \\(request orig\\) by run ${r.replay.runId} \\(request rep1, ended completed\\): reproduced\\. Judged under the fake adapter's replay policy \\(exact\\)\\. No differences\\. A replay tests reproduction; it is not a scientific conclusion\\.`));
    // the replay run's own steps came before it (oracle pin, run, outcome), the original's before those
    const actions = rows.map((x) => x.action);
    expect(actions.at(-1)).toBe("compare");
    expect(actions.filter((a) => a === "run")).toHaveLength(2);
    expect(rows.filter((x) => x.runs.includes(r.replay.runId)).map((x) => x.action)).toEqual(["run", "note", "compare"]);
    expect(verifyStudyLog(readFileSync(f.record, "utf8").trim().split("\n"))).toEqual([]);
  });

  it("says that the replay differs, and where", async () => {
    const f = await withHeader({ scenario: "jitter" });
    await run(f);
    const r = await replay(f);
    expect(r.ok && r.result.verdict).toBe("differs");
    const step = f.rows().at(-1)!;
    expect(step.reason).toMatch(/: differs\. Judged under .*\(exact\)\. Differences \(1\): value out\./);
  });

  it("names a tolerance policy with its bounds, and a within-tolerance verdict", async () => {
    const f = await withHeader({ scenario: "jitter" });
    await run(f);
    await replay(f, {}, { mode: "tolerance", abs: 1e-5, rel: 0 });
    expect(f.rows().at(-1)!.reason).toMatch(/: reproduced-within-tolerance\. Judged under the fake adapter's replay policy \(tolerance, abs 0\.00001, rel 0\)\./);
  });

  it("is written once: the same replay request again adds no second step", async () => {
    const f = await withHeader();
    await run(f);
    const a = await replay(f);
    const rowsAfterFirst = f.rows().length;
    const b = await replay(f);
    expect(a.ok && a.studyRecord).toEqual({ appended: 1 });
    expect(b.ok && b.studyRecord).toEqual({ appended: 0 });
    expect(f.rows().length).toBe(rowsAfterFirst);
    expect(f.rows().filter((x) => x.action === "compare")).toHaveLength(1);
  });

  it("two different replays of one run are two steps", async () => {
    const f = await withHeader();
    await run(f);
    await replay(f);
    await replay(f, { requestId: "rep2" });
    expect(f.rows().filter((x) => x.action === "compare").map((x) => x.reason.match(/request (rep\d)/g)!.at(-1))).toEqual(["request rep1", "request rep2"]);
  });

  it("the replay log says whether the step was written", async () => {
    const f = await withHeader();
    await run(f);
    await replay(f);
    expect(lines(join(f.state, "replays.jsonl")).map((x) => x.event).at(-1)).toMatchObject({ phase: "finished", verdict: "reproduced", studyRecord: { appended: 1 } });
  });
});

describe("when there is nothing to write, or it cannot be written", () => {
  it("a host with no human header has no study record: nothing is written and that is not a failure", async () => {
    const f = await fx();
    await run(f);
    const r = await replay(f);
    expect(r.ok && r.studyRecord).toEqual({ appended: 0 });
    expect(existsSync(studyRecordFile(f.project, "studies", "study"))).toBe(false);
  });

  it("a header that does not match the host: the replay still answers, the failure is returned and goes to the diagnostics", async () => {
    const f = await withHeader();
    // the original is made while the header is right; then the header file is replaced by one for another study
    const first = await run(f);
    expect(first.ok).toBe(true);
    writeHostJson(join(f.root, "study-header.json"), makeHeader({ studyId: "another-study", projectId: "p-x", parameters: [], budget, tier: "A1", startRevisions: [], setBy: FIXTURE_HUMAN }));
    const r = await replay(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.verdict).toBe("reproduced");
    expect(r.studyRecord).toMatchObject({ failed: expect.stringMatching(/differs from the host project or study policy/) });
    const diagnostics = readdirDiagnostics(f.state);
    expect(diagnostics.some((x) => x.stage === "study-record" && /replay step/.test(x.message))).toBe(true);
    expect(lines(join(f.state, "replays.jsonl")).map((x) => x.event).at(-1)).toMatchObject({ phase: "finished", studyRecord: { failed: expect.any(String) } });
  });
});

function readdirDiagnostics(state: string): { stage: string; message: string }[] {
  const out: { stage: string; message: string }[] = [];
  const engines = join(state, "engines");
  if (!existsSync(engines)) return out;
  for (const e of readdirSync(engines)) {
    const file = join(engines, e, "diagnostics.jsonl");
    if (existsSync(file)) out.push(...readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}

describe("replayStepDraft", () => {
  const facts = (over: Partial<ReplayFacts> = {}): ReplayFacts => ({ requestId: "rep1", originalRequestId: "orig", originalRunId: "r-a", replayRunId: "r-b", replayState: "completed", adapter: "feed", policy: { mode: "statistical", sigmas: 3 }, verdict: "differs", differences: [], ...over });
  const draft = (f: ReplayFacts) => replayStepDraft({ actor: FIXTURE_HUMAN, time: "2026-10-14T12:00:00.000Z", facts: f });

  it("is a compare step that cites both runs and is keyed by the replay's request", () => {
    const d = draft(facts());
    expect(d).toMatchObject({ action: "compare", runs: ["r-a", "r-b"], key: "replay:rep1", time: "2026-10-14T12:00:00.000Z" });
    expect(d.reason).toContain("statistical, 3 sigmas");
  });

  it("lists up to ten differences and counts the rest, and stays under the 2000 characters a step may have", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "value", field: `quantity_${i}` }));
    const d = draft(facts({ differences: many }));
    expect(d.reason).toContain("Differences (40): value quantity_0; value quantity_1");
    expect(d.reason).toContain("and 30 more");
    expect(d.reason).not.toContain("quantity_10;");
    expect(d.reason.length).toBeLessThan(900);
  });

  it("a replay that did not complete says how it ended; identity differences are named", () => {
    const d = draft(facts({ replayState: "failed", differences: [{ kind: "state", field: "replay.state" }] }));
    expect(d.reason).toContain("ended failed");
    expect(d.reason).toContain("state replay.state");
  });
});
