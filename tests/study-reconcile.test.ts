// @covers R-DISP-03, R-STUDY-02
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { runFromHostFile, saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { appendAdmission, readAdmissions, writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject, openProject } from "../src/core/projectStore";
import { verifyStudyLog } from "../src/core/semantic";
import { reconcileStudyRecord, BACKFILL_PREFIX } from "../src/core/studyReconcile";
import { makeHeader } from "./helpers/studyFixtures";

// E3: reconciliation of the live study record with the admission log (docs/study-record.md). A step can be missing (an append failed, or the run
// happened before the host had a human header); a human asks for it to be written from the audit log. Only appended, once, with the audit time.

const dirs: string[] = [];
const priorHeader = process.env.SEED_STUDY_HEADER;
beforeEach(() => {
  delete process.env.SEED_STUDY_HEADER;
});
afterEach(() => {
  if (priorHeader === undefined) delete process.env.SEED_STUDY_HEADER;
  else process.env.SEED_STUDY_HEADER = priorHeader;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-reconcile-"));
  dirs.push(d);
  return d;
};
const agent = { kind: "agent", name: "bot", model: "fixture" } as const;
const human = { kind: "human", name: "Alice" } as const;

async function fixture(opts: { actor?: HostConfiguration["actor"]; tier?: "A0" | "A1"; scenario?: string; sweep?: boolean } = {}) {
  const root = tmp();
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "Study record fixture", seedVersion: "0.1.0" }).ok).toBe(true);
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
  const good = await runOracleSet({ entries: indexed.entries, adapter: { id: "fake", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json");
  writeHostJson(evidence, good);
  const runtime = resolve(__dirname, "fixtures/fake-adapter/cli.cjs");
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const parameters = opts.sweep ? [{ id: "delayMs", min: 0, max: 1000 }] : [];
  const config: HostConfiguration = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "fake", version: "0.1.0", command: process.execPath, args: [runtime] }, actor: opts.actor ?? agent,
    study: { studyId: "s1", tier: opts.tier ?? "A1", budget, parameters },
    cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: opts.sweep ? [{ id: "delayMs", value: 10 }] : [], settings: { scenario: opts.scenario ?? "success", delayMs: 10 } } },
    ...(opts.sweep ? { sweeps: { t: { base: "approved", axes: [{ id: "delayMs", values: [10, 20, 30] }] } } } : {}),
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
  const header = makeHeader({ studyId: "s1", projectId, parameters, budget, tier: opts.tier ?? "A1", startRevisions: [], setBy: human });
  writeHostJson(headerFile, header);
  const record = join(project, "studies", "s1", "study.jsonl");
  const rows = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const diagnostics = () => {
    const f = join(state, "engines", sha256Hex(runtime), "diagnostics.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  return { root, project, state, hostFile, headerFile, header, record, rows, diagnostics, budget, good, evidenceSha: sha256Hex(readFileSync(evidence)), request: (id: string) => ({ requestId: id, caseId: "approved", budget }) };
}


async function setup(opts: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(opts);
  const config = JSON.parse(readFileSync(f.hostFile, "utf8")) as HostConfiguration;
  const adminFile = join(f.root, "admin-host.json");
  saveHostConfiguration(adminFile, { ...config, actor: human });
  const engine = join(f.state, "engines", sha256Hex(realpathSync(config.runtime.path)));
  const reconcile = (dryRun?: boolean) => reconcileStudyRecord(adminFile, dryRun === undefined ? {} : { dryRun });
  const text = () => (existsSync(f.record) ? readFileSync(f.record, "utf8") : "");
  return { ...f, config, adminFile, engine, reconcile, text };
}
const ok = (o: any) => {
  if (!o.ok) throw Error("refused: " + JSON.stringify(o.errors));
  return o;
};

describe("a run made before the host had a header", () => {
  it("is written into the record from the audit log: oracle set, run, outcome, each saying it was backfilled and carrying the audit time", async () => {
    const f = await setup();
    const out: any = await runFromHostFile(f.hostFile, f.request("r1"));
    expect(out.state).toBe("completed");
    expect(existsSync(f.record)).toBe(false);
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r).toMatchObject({ state: "reconciled", requestsScanned: 1, stepsFromLog: 3, stepsMissing: 3, appended: 3, unfinished: [] });
    const rows = f.rows();
    expect(rows.map((x) => [x.type, x.seq, x.action])).toEqual([["header", 0, undefined], ["step", 1, "oracle"], ["step", 2, "run"], ["step", 3, "note"]]);
    for (const row of rows.slice(1)) expect(row.reason.startsWith(BACKFILL_PREFIX)).toBe(true);
    for (const row of rows.slice(1)) expect(row.actor).toMatchObject({ kind: "agent", name: "bot" }); // the actor of the request, not the human who ran the backfill
    expect(rows[2]!.runs).toEqual([out.runId]);
    expect(rows[3]!.runs).toEqual([out.runId]);
    const log = readAdmissions(f.engine);
    const decision = log.find((l: any) => l.event.phase === "decision")!, outcome = log.find((l: any) => l.event.phase === "outcome")!;
    expect(rows[1]!.time).toBe(decision.time);
    expect(rows[2]!.time).toBe(decision.time);
    expect(rows[3]!.time).toBe(outcome.time);
    expect(verifyStudyLog(f.text().trim().split("\n"))).toEqual([]);
  });

  it("a second reconciliation finds nothing to do and leaves the file as it was", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    ok(f.reconcile());
    const before = f.text();
    expect(ok(f.reconcile())).toMatchObject({ state: "nothing-to-do", stepsMissing: 0, appended: 0 });
    expect(f.text()).toBe(before);
  });

  it("two requests give one oracle step, then each request's run and outcome, in audit order; a replayed request adds nothing", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    await runFromHostFile(f.hostFile, f.request("r2"));
    await runFromHostFile(f.hostFile, f.request("r1")); // a replay: another request row, the same keys
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r.appended).toBe(5);
    expect(f.rows().map((x) => x.action)).toEqual([undefined, "oracle", "run", "note", "run", "note"]);
  });

  it("a request refused at the gate becomes a gate-stop step", async () => {
    const f = await setup();
    const out: any = await runFromHostFile(f.hostFile, { ...f.request("r1"), budget: { ...f.budget, maxWallSeconds: 31 } });
    expect(out.ok).toBe(false);
    process.env.SEED_STUDY_HEADER = f.headerFile;
    expect(ok(f.reconcile())).toMatchObject({ appended: 1 });
    expect(f.rows()[1]).toMatchObject({ action: "gate-stop", runs: [], gateStop: { rule: "budget" } });
    expect(f.rows()[1]!.reason.startsWith(BACKFILL_PREFIX)).toBe(true);
  });
});

describe("a step lost after the record began", () => {
  it("is written after the rows that are there, which are not touched", async () => {
    const f = await setup();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await runFromHostFile(f.hostFile, f.request("r1"));
    const lines = f.text().trim().split("\n");
    expect(lines).toHaveLength(4);
    const kept = lines.slice(0, 3).join("\n") + "\n"; // header, oracle, run: the outcome step was lost
    writeFileSync(f.record, kept);
    const r = ok(f.reconcile());
    expect(r).toMatchObject({ state: "reconciled", stepsMissing: 1, appended: 1 });
    expect(f.text().startsWith(kept)).toBe(true);
    expect(f.rows().at(-1)!.action).toBe("note");
    expect(f.rows().at(-1)!.reason.startsWith(BACKFILL_PREFIX)).toBe(true);
    expect(verifyStudyLog(f.text().trim().split("\n"))).toEqual([]);
  });

  it("a record that is complete is left byte for byte", async () => {
    const f = await setup();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await runFromHostFile(f.hostFile, f.request("r1"));
    const before = f.text();
    expect(ok(f.reconcile())).toMatchObject({ state: "nothing-to-do" });
    expect(f.text()).toBe(before);
  });
});

describe("a dry run", () => {
  it("lists what would be written and writes nothing, not even the record file", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile(true));
    expect(r).toMatchObject({ state: "dry-run", stepsMissing: 3 });
    expect(r.would.map((w: any) => w.action)).toEqual(["oracle", "run", "note"]);
    expect(existsSync(f.record)).toBe(false);
    expect(existsSync(join(f.project, "studies", "s1"))).toBe(false);
  });
});

describe("what is not written", () => {
  it("a request with no decision, and an allowed one with no outcome, are reported and not written", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const log = readAdmissions(f.engine);
    const request = log.find((l: any) => l.event.phase === "request")! as any;
    // a request that never got a decision, and one that was allowed and never finished
    appendAdmission(f.engine, { ...request.event, event: { ...request.event.event, request: { ...request.event.event.request, requestId: "lost-1" } } });
    appendAdmission(f.engine, { ...request.event, event: { ...request.event.event, request: { ...request.event.event.request, requestId: "lost-2" } } });
    const decision = log.find((l: any) => l.event.phase === "decision")! as any;
    appendAdmission(f.engine, { ...decision.event, event: { ...decision.event.event, requestId: "lost-2" } });
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r.requestsScanned).toBe(3);
    expect(r.unfinished).toEqual([{ requestId: "lost-1", why: "no gate decision was audited" }, { requestId: "lost-2", why: "allowed, but no outcome was audited" }]);
    expect(r.appended).toBe(3); // only r1
  });

  it("an allowed request that never finished does not take a later request's outcome, nor a row of another host configuration", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const log = readAdmissions(f.engine);
    const request = log.find((l: any) => l.event.phase === "request")! as any;
    const decision = log.find((l: any) => l.event.phase === "decision")! as any;
    appendAdmission(f.engine, { ...request.event, event: { ...request.event.event, request: { ...request.event.event.request, requestId: "lost" } } });
    appendAdmission(f.engine, { ...decision.event, event: { ...decision.event.event, requestId: "lost" } });
    appendAdmission(f.engine, { phase: "outcome", actor: request.event.actor, projectId: request.event.projectId, configHash: "another-host-configuration", event: { ok: true, runId: "r-foreign", state: "completed" } });
    await runFromHostFile(f.hostFile, f.request("r2")); // a later request with its own outcome
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r.unfinished).toEqual([{ requestId: "lost", why: "allowed, but no outcome was audited" }]);
    const runs = f.rows().flatMap((x) => x.runs ?? []);
    expect(runs).not.toContain("r-foreign");
    expect(f.rows().filter((x) => x.action === "run")).toHaveLength(2); // r1 and r2 only
  });

  it("rows of another project in the shared engine log are not scanned", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const log = readAdmissions(f.engine);
    for (const phase of ["request", "decision", "outcome"]) {
      const row = log.find((l: any) => l.event.phase === phase)! as any;
      const event = phase === "request" ? { ...row.event.event, request: { ...row.event.event.request, requestId: "foreign" } } : phase === "decision" ? { ...row.event.event, requestId: "foreign" } : { ...row.event.event, runId: "r-foreign-project" };
      appendAdmission(f.engine, { ...row.event, projectId: "someone-else's-project", event });
    }
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r.requestsScanned).toBe(1);
    expect(f.rows().flatMap((x) => x.runs ?? [])).not.toContain("r-foreign-project");
  });

  it("a request of another study is not scanned", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const request = readAdmissions(f.engine).find((l: any) => l.event.phase === "request")! as any;
    const other = { ...request.event.event, configuration: { ...request.event.event.configuration, study: { ...request.event.event.configuration.study, studyId: "other-study" } }, request: { ...request.event.event.request, requestId: "foreign" } };
    appendAdmission(f.engine, { ...request.event, event: other });
    process.env.SEED_STUDY_HEADER = f.headerFile;
    expect(ok(f.reconcile()).requestsScanned).toBe(1);
  });
});

describe("what is refused, with nothing written", () => {
  it("a host identity that is not a human", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r: any = reconcileStudyRecord(f.hostFile, {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/only by a human/);
    expect(existsSync(f.record)).toBe(false);
  });

  it("no human header given", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const r: any = f.reconcile();
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] });
    expect(existsSync(f.record)).toBe(false);
  });

  it("a header that does not match the host's study", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    writeHostJson(f.headerFile, makeHeader({ studyId: "s1", projectId: f.header.projectId as string, tier: "A0", parameters: [], budget: f.budget, startRevisions: [], setBy: human }));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    expect((f.reconcile() as any).ok).toBe(false);
    expect(existsSync(f.record)).toBe(false);
  });

  it("a record whose chain is broken", async () => {
    const f = await setup();
    process.env.SEED_STUDY_HEADER = f.headerFile;
    await runFromHostFile(f.hostFile, f.request("r1"));
    writeFileSync(f.record, f.text().replace('"action":"note"', '"action":"edit"'));
    const broken = f.text();
    expect((f.reconcile() as any).ok).toBe(false);
    expect(f.text()).toBe(broken);
  });

  it("a calculation that holds the engine", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    mkdirSync(join(f.engine, "lease"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r: any = f.reconcile();
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/holds the engine/);
  });

  it.each([[{ dryRun: "yes" }], [{ extra: 1 }], [[]], [null]])("a request that is not {dryRun?: boolean}: %j", async (bad) => {
    const f = await setup();
    const r: any = reconcileStudyRecord(f.adminFile, bad);
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
  });
});

describe("the admin verb", () => {
  it("reconcile-study works end to end with exit codes, and the agent's CLI has no such verb", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const run = (input: unknown) => runAdminCli(["reconcile-study"], Readable.from([JSON.stringify(input)]), f.adminFile);
    expect(await run({ dryRun: true })).toMatchObject({ code: 0, reply: { ok: true, state: "dry-run" } });
    expect(await run({})).toMatchObject({ code: 0, reply: { ok: true, state: "reconciled", appended: 3 } });
    expect(await run({})).toMatchObject({ code: 0, reply: { state: "nothing-to-do" } });
    expect(await run({ nope: 1 })).toMatchObject({ code: 2 });
    const { runCli } = await import("../src/cli/seed");
    expect((await runCli(["reconcile-study"], Readable.from(["{}"]), "/nonexistent")).code).toBe(2);
  });
});

// Findings of the Codex review of batch 2 (2026-10-08), each shown by a test that fails without its fix.
describe("review batch 2: reconciliation", () => {
  it("a request audited twice (a replay) is counted once: the dry run does not promise steps the append would skip", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    await runFromHostFile(f.hostFile, f.request("r1"));
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const dry = ok(f.reconcile(true));
    const real = ok(f.reconcile());
    expect(dry.stepsMissing).toBe(dry.would.length);
    expect(dry.stepsMissing).toBe(real.appended);
    expect(new Set(dry.would.map((w: any) => w.key)).size).toBe(dry.would.length);
  });

  it("runs made under other study rules (same study id, another budget) are named and left in the audit log, not written under the current header", async () => {
    const f = await setup();
    await runFromHostFile(f.hostFile, f.request("r1"));
    const budget = { ...f.budget, maxCores: 2 };
    const changed: HostConfiguration = { ...f.config, actor: human, study: { ...f.config.study, budget } };
    saveHostConfiguration(f.adminFile, changed);
    writeHostJson(f.headerFile, { ...f.header, budget });
    process.env.SEED_STUDY_HEADER = f.headerFile;
    const r = ok(f.reconcile());
    expect(r).toMatchObject({ state: "nothing-to-do", requestsScanned: 0, stepsMissing: 0, skippedOtherPolicy: ["r1"] });
    expect(f.rows()).toEqual([]);
  });
});
