// @covers R-STUDY-02
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { runFromHostFile, saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject, openProject } from "../src/core/projectStore";
import { verifyStudyLog } from "../src/core/semantic";
import { replayFromHostFile } from "../src/core/replayHost";
import { exportStudyReport } from "../src/core/studyReportHost";
import { appendStudySteps, readStudyRecord, studyRecordFile } from "../src/core/studyRecord";
import { makeHeader } from "./helpers/studyFixtures";

// E3: the report export reads the live study record (docs/study-record.md, docs/study-report.md). The study of the report is the live record
// when the study has one: its notes and every run it cites appear, each run proven from the audit log like the run of the request. A record that
// cannot be trusted, or does not cite the run, is a refusal and never a silent fallback to a made-up study.
// The adapter is a copy of the fake adapter that calls itself "raft" and writes a time series, because the report workflow reads RAFT-shaped series.

const dirs: string[] = [];
const priorHeader = process.env.SEED_STUDY_HEADER;
afterEach(() => {
  if (priorHeader === undefined) delete process.env.SEED_STUDY_HEADER;
  else process.env.SEED_STUDY_HEADER = priorHeader;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-livereport-"));
  dirs.push(d);
  return d;
};
const agent = { kind: "agent", name: "bot", model: "fixture" } as const;
const human = { kind: "human", name: "Alice" } as const;

function raftShapedFake(root: string): string {
  const dir = join(root, "raft-shaped");
  cpSync(resolve(__dirname, "fixtures/fake-adapter"), dir, { recursive: true });
  const swap = (file: string, from: string, to: string, all = false) => {
    const p = join(dir, file);
    const text = readFileSync(p, "utf8");
    if (!text.includes(from)) throw Error("fixture text not found in " + file + ": " + from);
    writeFileSync(p, all ? text.split(from).join(to) : text.replace(from, to));
  };
  swap("cli.cjs", 'id: "fake"', 'id: "raft"', true);
  swap("job.cjs", "JSON.stringify({ values: [1, 2, 3] })", 'JSON.stringify({ quantity: "out", unit: "1", t: [0, 1, 2], values: [1, 2, 3] })');
  return join(dir, "cli.cjs");
}

async function fixture() {
  const root = tmp();
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "Live report fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const model = JSON.stringify({ name: "case", counter: 1, fake: { validate: "ok" } });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  writeFileSync(join(project, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "p_top", value: 0.02, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = {
    schema: "seed.oracle/0.1", oracleId: "test-one", entryVersion: 1, adapter: "raft", adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
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
  const good = await runOracleSet({ entries: indexed.entries, adapter: { id: "raft", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json");
  writeHostJson(evidence, good);
  const runtime = raftShapedFake(root);
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const config: HostConfiguration = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "raft", version: "0.1.0", command: process.execPath, args: [runtime] }, actor: agent,
    study: { studyId: "s1", tier: "A1", budget, parameters: [] },
    cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: [], settings: { scenario: "success", delayMs: 10 } } },
    runtime: { path: runtime, sha256: sha256Hex(readFileSync(runtime)) },
    oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) },
    acceptedPins: good.pins
  };
  const hostFile = join(root, "host.json");
  saveHostConfiguration(hostFile, config);
  const opened = openProject(project);
  if (!opened.ok) throw Error("project");
  const projectId = opened.value.manifest.projectId as string;
  const headerFile = join(root, "header.json");
  const header = makeHeader({ studyId: "s1", projectId, parameters: [], budget, tier: "A1", startRevisions: [{ artifact: "input-0", revision: inputs[0]!.sha256 }], setBy: human });
  writeHostJson(headerFile, header);
  const record = studyRecordFile(project, "studies", "s1");
  const request = (id: string) => ({ requestId: id, caseId: "approved", budget });
  const run = async (id: string) => {
    const out = await runFromHostFile(hostFile, request(id));
    if (!out.ok || out.state !== "completed") throw Error("run did not complete: " + JSON.stringify(out));
    return out.runId as string;
  };
  const note = (key: string, text: string, runs: string[] = []) => {
    const r = appendStudySteps(record, header, [{ action: "note", actor: agent, time: "2026-10-07T12:00:00.000Z", reason: text, runs, key }], project);
    if (!r.ok) throw Error(JSON.stringify(r));
  };
  const exportReport = (id: string) => exportStudyReport(hostFile, headerFile, { requestId: id });
  const bundleDirs = () => (existsSync(join(project, "studies")) ? readdirSync(join(project, "studies")).filter(n => n.startsWith("s1-")) : []);
  return { root, project, state, hostFile, headerFile, header, record, run, note, exportReport, bundleDirs, inputs };
}

const read = (p: string) => readFileSync(p, "utf8");
const saved = (project: string, r: any) => ({ dir: dirname(join(project, r.report.html)), html: read(join(project, r.report.html)), md: read(join(project, r.report.markdown)) });

describe("without a live record the export keeps its single-case study", () => {
  it("a run made with no human header has no record; the report still builds from the audit log, as before", async () => {
    const f = await fixture();
    const runId = await f.run("r1");
    expect(existsSync(f.record)).toBe(false);
    const r: any = await f.exportReport("r1");
    expect(r).toMatchObject({ ok: true, state: "report-saved", runId });
    const s = saved(f.project, r);
    expect(s.html).toContain(runId);
    expect(read(join(s.dir, "study.jsonl")).trim().split("\n")).toHaveLength(4);
    expect(JSON.parse(read(join(s.dir, "evidence.json"))).liveRecord).toBeUndefined();
    expect(s.html).toContain("single-case");
  });
});

describe("with a live record the report is the record's study", () => {
  it("carries the record's rows, a note an agent added, and says it came from the live record", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const runId = await f.run("r1");
    f.note("n1", "Observation by the agent: the series is flat. UNIQUENOTETEXT", [runId]);
    const r: any = await f.exportReport("r1");
    expect(r).toMatchObject({ ok: true, state: "report-saved", runId });
    const s = saved(f.project, r);
    expect(s.html).toContain("UNIQUENOTETEXT");
    expect(s.md).toContain("UNIQUENOTETEXT");
    expect(s.html).toContain("live study record");
    expect(read(join(s.dir, "study.jsonl"))).toBe(read(f.record)); // byte for byte the verified record
    expect(verifyStudyLog(read(join(s.dir, "study.jsonl")).trim().split("\n"))).toEqual([]);
    const evidence = JSON.parse(read(join(s.dir, "evidence.json")));
    const rec = readStudyRecord(f.record);
    expect(evidence.liveRecord).toEqual({ rows: 5, head: rec.ok ? rec.rows.at(-1)!.hash : "" });
    expect(evidence.otherRuns).toEqual([]);
  });

  it("a replay's step is in the report, and both runs it cites are proven and included (the shipped RAFT replay policy, exact)", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const first = await f.run("r1");
    const rep: any = await replayFromHostFile(f.hostFile, { requestId: "rep1", originalRequestId: "r1", budget: { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 } });
    expect(rep).toMatchObject({ ok: true, adapter: "raft", result: { verdict: "reproduced" }, studyRecord: { appended: 1 } });
    const r: any = await f.exportReport("r1");
    expect(r).toMatchObject({ ok: true, state: "report-saved", runId: first });
    const s = saved(f.project, r);
    expect(s.html).toContain("Replay of run " + first);
    expect(s.html).toContain(rep.replay.runId);
    expect(s.md).toContain("it is not a scientific conclusion");
    expect(read(join(s.dir, "study.jsonl"))).toBe(read(f.record));
    expect(verifyStudyLog(read(join(s.dir, "study.jsonl")).trim().split("\n"))).toEqual([]);
    expect(JSON.parse(read(join(s.dir, "evidence.json"))).otherRuns.map((x: any) => x.runId ?? x)).toContain(rep.replay.runId);
  });

  it("every run the record cites is in the report, proven from the audit log, with its files under runs/<id>/", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    const r2 = await f.run("r2");
    expect(r1).not.toBe(r2);
    const r: any = await f.exportReport("r2");
    expect(r).toMatchObject({ ok: true, runId: r2 });
    const s = saved(f.project, r);
    expect(s.html).toContain(r1);
    expect(s.html).toContain(r2);
    const evidence = JSON.parse(read(join(s.dir, "evidence.json")));
    expect(evidence.otherRuns.map((o: any) => [o.requestId, o.runId])).toEqual([["r1", r1]]);
    expect(evidence.otherRuns[0].admission.references).toHaveLength(3);
    expect(existsSync(join(s.dir, "inputs", "models", "case.json"))).toBe(true); // the run of the request: the single-run layout
    expect(existsSync(join(s.dir, "runs", r1, "inputs", "models", "case.json"))).toBe(true);
    expect(existsSync(join(s.dir, "runs", r1, "outputs"))).toBe(true);
    expect(existsSync(join(s.dir, "runs", r2))).toBe(false);
    for (const snap of evidence.snapshotFiles) expect(existsSync(join(s.dir, snap.path))).toBe(true);
  });

  it("exporting the same request again is refused (a saved bundle is never overwritten), and a note added since does not change it", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const runId = await f.run("r1");
    const a: any = await f.exportReport("r1");
    const before = read(join(f.project, a.report.html));
    f.note("late", "A late note LATENOTE", [runId]);
    const b: any = await f.exportReport("r1");
    expect(b.ok).toBe(false);
    expect(b.errors[0].message).toMatch(/already exists/);
    expect(read(join(f.project, a.report.html))).toBe(before);
    expect(before).not.toContain("LATENOTE");
    expect(f.bundleDirs()).toHaveLength(1);
    const c: any = await f.exportReport("r1-again");
    expect(c.ok).toBe(false); // no such request
  });

  it("a run whose input file has changed since it ran is marked STALE, and only that run", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    const model = JSON.parse(read(join(f.project, "models/case.json")));
    writeFileSync(join(f.project, "models/case.json"), JSON.stringify({ ...model, edited: true }));
    // the second run would refuse the edited file, so only the record of the first is checked: export the first
    const r: any = await f.exportReport("r1");
    expect(r.ok).toBe(true);
    const html = saved(f.project, r).html;
    expect(html).toContain("STALE");
    expect(html.split("STALE").length - 1).toBeGreaterThanOrEqual(1);
    expect(html).toContain(r1);
  });

  it("a request made after the note gets a report that has it, in its own bundle", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    f.note("mid", "Between runs BETWEENRUNS", [r1]);
    await f.run("r2");
    const r: any = await f.exportReport("r2");
    expect(r.ok).toBe(true);
    expect(saved(f.project, r).html).toContain("BETWEENRUNS");
  });

  it("a note that cites no run is in the report too", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    f.note("n0", "A general remark GENERALREMARK");
    const r: any = await f.exportReport("r1");
    expect(r.ok).toBe(true);
    expect(saved(f.project, r).html).toContain("GENERALREMARK");
  });
});

describe("a record that does not cite the run of the request", () => {
  it("leaves the report a single-case one, built from the audit log, and the evidence says the record did not cite it", async () => {
    const f = await fixture();
    const r1 = await f.run("r1"); // made before the host had a header: not in the record
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r2");
    f.note("n", "A note about the other run OTHERRUNNOTE");
    const r: any = await f.exportReport("r1");
    expect(r).toMatchObject({ ok: true, runId: r1 });
    const s = saved(f.project, r);
    expect(s.html).toContain("single-case");
    expect(s.html).not.toContain("OTHERRUNNOTE");
    expect(read(join(s.dir, "study.jsonl")).trim().split("\n")).toHaveLength(4);
    const evidence = JSON.parse(read(join(s.dir, "evidence.json")));
    expect(evidence.liveRecord).toMatchObject({ rows: 5, citesThisRun: false });
    expect(evidence.otherRuns).toBeUndefined();
  });

  it("still refuses when that record has a broken chain", async () => {
    const f = await fixture();
    await f.run("r1");
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r2");
    writeFileSync(f.record, read(f.record).replace('"action":"note"', '"action":"edit"'));
    const r: any = await f.exportReport("r1");
    expect(r.ok).toBe(false);
    expect(f.bundleDirs()).toEqual([]);
  });
});

describe("a record that cannot be trusted stops the export, and nothing is saved", () => {
  const refused = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => {
    const r: any = await f.exportReport(id);
    expect(r.ok).toBe(false);
    expect(f.bundleDirs()).toEqual([]);
    expect(readdirSync(join(f.project, "studies")).filter(n => n.startsWith(".report-"))).toEqual([]);
    return r.errors.map((e: any) => e.message).join("; ") as string;
  };

  it.each([
    ["an edited row", (t: string) => t.replace('"action":"note"', '"action":"edit"')],
    ["a half-written last line", (t: string) => t + '{"schema":"seed.study'],
    ["a removed row", (t: string) => { const l = t.trim().split("\n"); l.splice(1, 1); return l.join("\n") + "\n"; }],
  ])("%s", async (_n, damage) => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    writeFileSync(f.record, damage(read(f.record)));
    expect(await refused(f, "r1")).toMatch(/live study record is not valid/);
  });

  it("a record with another human header than the one given to the host", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    const other = makeHeader({ studyId: "s1", projectId: f.header.projectId as string, question: "Another question entirely?", parameters: [], budget: f.header.budget as any, tier: "A1", startRevisions: f.header.startRevisions as any, setBy: human });
    writeHostJson(f.headerFile, other);
    const msg = await refused(f, "r1");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("a header that does not cover the run's inputs says how many revisions it lists and which, and which the run used", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    writeHostJson(f.headerFile, { ...f.header, startRevisions: [...(f.header.startRevisions as object[]), { artifact: "other.json", revision: "e".repeat(64) }] });
    const msg = await refused(f, "r1");
    expect(msg).toMatch(/the header lists 2 \(.*eeeeeeee.*\), the run used 1 \([0-9a-f]{8}\)/);
  });

  it("a cited run whose saved record was changed after it finished", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    await f.run("r2");
    const file = join(f.project, "runs", r1, "run-record.json");
    const rec = JSON.parse(read(file));
    writeHostJson(file, { ...rec, settings: { ...(rec.settings ?? {}), injected: true } });
    expect(await refused(f, "r2")).toMatch(/saved run differs from audited terminal outcome/);
  });

  it("a cited run whose saved record names another request than the one bound to it", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    await f.run("r2");
    const file = join(f.project, "runs", r1, "run-record.json");
    const rec = JSON.parse(read(file));
    rec.extensions["seed.dispatch"].requestId = "r2";
    writeHostJson(file, rec);
    expect(await refused(f, "r2")).toMatch(/not the one bound to its request/);
  });

  it("a note that cites a run no request is bound to", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    f.note("ghost", "About a run that is not there", ["r-ghost"]);
    expect((await refused(f, "r1")).length).toBeGreaterThan(0);
  });

  it("a run id that is not a run id cannot be put in the record at all", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    expect(() => f.note("bad", "Odd id", ["../../escape"])).toThrow(/line\/\d+\/runs/);
    expect((await f.exportReport("r1") as any).ok).toBe(true); // the record is unchanged and still good
  });
});

// Option C (decided 2026-10-08): a run is verified against the configuration it was admitted under; the present one may differ from it only in
// the other registered cases and the sweeps.
describe("a host configuration that changes during the study", () => {
  const refused = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => {
    const r: any = await f.exportReport(id);
    expect(r.ok).toBe(false);
    expect(f.bundleDirs()).toEqual([]);
    return r.errors.map((e: any) => e.message).join("; ") as string;
  };
  const edit = (f: Awaited<ReturnType<typeof fixture>>, change: (c: HostConfiguration) => HostConfiguration) => {
    const now = JSON.parse(read(f.hostFile)) as HostConfiguration;
    saveHostConfiguration(f.hostFile, change(now));
  };

  it("adding another case does not unprove the runs before it: both runs are in the report", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r1 = await f.run("r1");
    edit(f, (c) => ({ ...c, cases: { ...c.cases, other: c.cases.approved! } }));
    const r2 = await f.run("r2");
    const r: any = await f.exportReport("r2");
    expect(r).toMatchObject({ ok: true, runId: r2 });
    const evidence = JSON.parse(read(join(saved(f.project, r).dir, "evidence.json")));
    expect(evidence.otherRuns.map((o: any) => [o.requestId, o.runId])).toEqual([["r1", r1]]);
  });

  it("changing the run's own case still unproves it", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    edit(f, (c) => ({ ...c, cases: { ...c.cases, approved: { ...c.cases.approved!, settings: { scenario: "success", delayMs: 20 } } } }));
    await f.run("r2");
    expect(await refused(f, "r2")).toMatch(/no guarded admission/);
  });

  it("changing who acts (or the runtime, the oracle evidence, the study rules) still unproves the runs before it", async () => {
    const f = await fixture();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await f.run("r1");
    edit(f, (c) => ({ ...c, actor: { kind: "agent", name: "another-bot", model: "fixture" } }));
    await f.run("r2");
    expect(await refused(f, "r2")).toMatch(/no guarded admission/);
  });
});
