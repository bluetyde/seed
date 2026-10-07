import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { runFromHostFile, saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry, type PinSet, type SetResult } from "../src/core/oracle";
import { clearFailure, journalBlock, journalRoot, recordEvaluation } from "../src/core/oracleJournal";
import { clearOracleFailure, oracleJournalStatus, recordOracleEvaluation } from "../src/core/oracleJournalHost";
import { createProject } from "../src/core/projectStore";

// L1 (docs/policy-and-oracles.md): a failed oracle evaluation of unchanged inputs is kept in an append-only journal and blocks the gate until
// a human clears it. A later pass never clears it; a failure recorded for other pins has no effect; a broken journal blocks.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-ojournal-"));
  dirs.push(d);
  return d;
};

const sha = (c: string) => c.repeat(64);
const pins = (commit = "a".repeat(40), file = sha("b")): PinSet => ({ appCommit: commit, oracleFiles: [{ oracleId: "o1", entryVersion: 1, sha256: file }] });
const result = (over: Partial<SetResult> = {}): SetResult => ({
  adapter: "fake",
  adapterVersion: "0.1.0",
  verdict: "pass",
  inputsVerified: true,
  blocked: false,
  blockedQuantities: [],
  results: [{ oracleId: "o1", entryVersion: 1, tag: "good", verdict: "pass" }],
  pins: pins(),
  ...over
});
const failed = (over: Partial<SetResult> = {}) =>
  result({ verdict: "fail", blocked: true, results: [{ oracleId: "o1", entryVersion: 1, tag: "good", verdict: "fail", reason: "value off" }], ...over });
const adapter = { id: "fake", version: "0.1.0" };
const human = { kind: "human", name: "owner" } as const;
const agent = { kind: "agent", name: "bot" } as const;
const rec = (state: string, r: SetResult) => recordEvaluation(state, adapter, r, sha("c"), human);
const block = (state: string, p = pins()) => journalBlock(state, "fake", "0.1.0", p);

describe("the journal alone", () => {
  it("no journal means nothing blocks", () => {
    expect(block(tmp())).toEqual({ blocked: false });
  });

  it("a recorded failure for the current pins blocks, and names the row to clear", () => {
    const s = tmp();
    const row = rec(s, failed());
    expect(block(s)).toMatchObject({ blocked: true, rowHash: row.hash });
  });

  it("a recorded pass blocks nothing", () => {
    const s = tmp();
    rec(s, result());
    expect(block(s).blocked).toBe(false);
  });

  it("a pass after a failure does not clear it: only a human's clearance does", () => {
    const s = tmp();
    const row = rec(s, failed());
    rec(s, result());
    rec(s, result());
    expect(block(s)).toMatchObject({ blocked: true, rowHash: row.hash });
  });

  it("a failure recorded for another app commit or another oracle file has no effect on the current pins", () => {
    const s = tmp();
    rec(s, failed({ pins: pins("1".repeat(40)) }));
    expect(block(s).blocked).toBe(false);
    rec(s, failed({ pins: pins("a".repeat(40), sha("d")) }));
    expect(block(s).blocked).toBe(false);
  });

  it("a failure of another adapter version has no effect", () => {
    const s = tmp();
    recordEvaluation(s, { id: "fake", version: "0.2.0" }, failed({ adapterVersion: "0.2.0" }), sha("c"), human);
    expect(block(s).blocked).toBe(false);
  });

  it("a set that passes in its verdict but is blocked, or whose inputs were not verified, is recorded as a failure", () => {
    for (const odd of [{ blocked: true }, { inputsVerified: false }]) {
      const s = tmp();
      rec(s, result(odd));
      expect(block(s).blocked, JSON.stringify(odd)).toBe(true);
    }
  });

  describe("clearing", () => {
    it("the right row hash and a reason clear it, and the journal says who and why", () => {
      const s = tmp();
      const row = rec(s, failed());
      const c = clearFailure(s, adapter, pins(), row.hash, "tolerance re-derived and the entry fixed", human);
      expect(block(s).blocked).toBe(false);
      expect(c.event).toMatchObject({ type: "clearance", clears: row.hash, actor: { kind: "human", name: "owner" } });
    });

    it("a wrong row hash, a missing failure and a missing reason are refused", () => {
      const s = tmp();
      expect(() => clearFailure(s, adapter, pins(), sha("e"), "nothing to clear", human)).toThrow(/no recorded failure/);
      const row = rec(s, failed());
      expect(() => clearFailure(s, adapter, pins(), sha("e"), "wrong row", human)).toThrow(/not the failure that is blocking/);
      expect(() => clearFailure(s, adapter, pins(), row.hash, "", human)).toThrow(/reason/);
      expect(() => clearFailure(s, adapter, pins(), row.hash, "ab", human)).toThrow(/reason/);
      expect(() => clearFailure(s, adapter, pins(), row.hash, "x".repeat(501), human)).toThrow(/reason/);
      expect(block(s).blocked).toBe(true);
    });

    it("a new failure after a clearance blocks again, and the old clearance does not clear it", () => {
      const s = tmp();
      const first = rec(s, failed());
      clearFailure(s, adapter, pins(), first.hash, "fixed the first", human);
      const second = rec(s, failed());
      expect(block(s)).toMatchObject({ blocked: true, rowHash: second.hash });
      expect(() => clearFailure(s, adapter, pins(), first.hash, "the old one again", human)).toThrow(/not the failure that is blocking/);
    });

    it("a clearance cannot be replayed to clear a later failure (it names one row hash)", () => {
      const s = tmp();
      const first = rec(s, failed());
      clearFailure(s, adapter, pins(), first.hash, "fixed the first", human);
      rec(s, failed());
      rec(s, result());
      expect(block(s).blocked).toBe(true);
    });
  });

  describe("what is refused when recording", () => {
    it("a set that did not run, another adapter, another version, no verdict and a non-result", () => {
      const s = tmp();
      expect(() => rec(s, result({ verdict: "not-run" }))).toThrow(/did not run/);
      expect(() => rec(s, result({ adapter: "other" }))).toThrow(/another adapter/);
      expect(() => rec(s, result({ adapterVersion: "9.9.9" }))).toThrow(/version/);
      expect(() => rec(s, result({ verdict: "maybe" as never }))).toThrow(/no verdict/);
      expect(() => rec(s, null as never)).toThrow(/not an oracle set result/);
      expect(() => rec(s, {} as never)).toThrow(/not an oracle set result/);
      expect(journalRoot(s, "fake")).toBeNull(); // nothing was written
    });
  });

  describe("the row says what failed, without the whole result", () => {
    it("lists the entries that did not pass, at most 50, with short reasons", () => {
      const s = tmp();
      const many = Array.from({ length: 80 }, (_, i) => ({ oracleId: "o" + i, entryVersion: 1, tag: "good", verdict: "fail" as const, reason: "r".repeat(900) }));
      const row = rec(s, failed({ results: [{ oracleId: "ok", entryVersion: 1, tag: "good", verdict: "pass" }, ...many] }));
      const ev = row.event as { failed: { oracleId: string; reason: string }[] };
      expect(ev.failed).toHaveLength(50);
      expect(ev.failed.every((f) => f.oracleId !== "ok")).toBe(true);
      expect(ev.failed[0]!.reason).toHaveLength(200);
    });
  });

  describe("a journal that cannot be trusted blocks", () => {
    const file = (s: string) => join(journalRoot(s, "fake")!, "admissions.jsonl");

    it("a row changed after it was written", () => {
      const s = tmp();
      rec(s, failed());
      rec(s, result());
      const lines = readFileSync(file(s), "utf8").trim().split("\n");
      const row = JSON.parse(lines[0]!);
      row.event.verdict = "pass"; // someone edits the failure into a pass
      lines[0] = JSON.stringify(row);
      writeFileSync(file(s), lines.join("\n") + "\n");
      expect(block(s)).toMatchObject({ blocked: true, reason: expect.stringContaining("broken") });
    });

    it("a row removed from the middle, a garbled line and a half-written last line", () => {
      for (const damage of ["middle", "garbled", "partial"] as const) {
        const s = tmp();
        rec(s, failed());
        rec(s, result());
        rec(s, result());
        const f = file(s);
        const lines = readFileSync(f, "utf8").trim().split("\n");
        if (damage === "middle") writeFileSync(f, [lines[0], lines[2]].join("\n") + "\n");
        if (damage === "garbled") writeFileSync(f, lines[0] + "\n{not json\n");
        if (damage === "partial") appendFileSync(f, '{"schema":"seed.adm');
        expect(block(s).blocked, damage).toBe(true);
      }
    });

    it("a row of an unknown kind or with no event object", () => {
      const s = tmp();
      const root = journalRoot(s, "fake", true)!;
      // a correctly chained row whose event is not a known kind
      const body = { schema: "seed.admission/0.1", seq: 1, time: "2026-10-07T00:00:00.000Z", prev: null, event: { type: "mystery" } };
      writeFileSync(join(root, "admissions.jsonl"), JSON.stringify({ ...body, hash: sha256Hex(canonicalJson(body)) }) + "\n");
      expect(block(s)).toMatchObject({ blocked: true, reason: expect.stringContaining("unknown kind") });
    });

    it("an adapter id that cannot be a folder name blocks instead of leaving the state folder", () => {
      const s = tmp();
      for (const id of ["../escape", "a/b", "", ".hidden", "x".repeat(65)]) expect(journalBlock(s, id, "0.1.0", pins()), id).toMatchObject({ blocked: true });
      // an id with capitals is a valid id in the contract and must not be blocked for that
      expect(journalBlock(s, "RAFT", "0.1.0", pins())).toEqual({ blocked: false });
    });
  });

  it("each adapter has its own journal", () => {
    const s = tmp();
    rec(s, failed());
    expect(journalBlock(s, "another", "0.1.0", pins()).blocked).toBe(false);
  });
});

// ---- the real host: a recorded failure stops a run that the old passing evidence would have allowed -------------------------------------

async function fixture(actor: HostConfiguration["actor"]) {
  const root = tmp();
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "Journal fixture", seedVersion: "0.1.0" }).ok).toBe(true);
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
  const good = await runOracleSet({ entries: indexed.entries, adapter: { id: "fake", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json");
  writeHostJson(evidence, good);
  const runtime = resolve(__dirname, "fixtures/fake-adapter/cli.cjs");
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const config: HostConfiguration = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "fake", version: "0.1.0", command: process.execPath, args: [runtime] }, actor,
    study: { studyId: "study", tier: "A1", budget, parameters: [] },
    cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: [], settings: { scenario: "success", delayMs: 10 } } },
    runtime: { path: runtime, sha256: sha256Hex(readFileSync(runtime)) },
    oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) },
    acceptedPins: good.pins
  };
  const agentFile = join(root, "host-agent.json");
  saveHostConfiguration(agentFile, config);
  const adminFile = join(root, "host-admin.json");
  saveHostConfiguration(adminFile, { ...config, actor: { kind: "human", name: "owner" } });
  const resultsDir = join(root, "results");
  mkdirSync(resultsDir);
  const write = (name: string, r: SetResult) => {
    const f = join(resultsDir, name);
    writeHostJson(f, r);
    return f;
  };
  return { root, project, state, agentFile, adminFile, good, write, budget, request: (id: string) => ({ requestId: id, caseId: "approved", budget }) };
}
const refusedByOracle = (o: { ok: boolean; errors?: { code: string; message: string }[] }) =>
  !o.ok && o.errors![0]!.code === "E_NOT_PERMITTED" && /oracle/.test(o.errors![0]!.message);

describe("the host", () => {
  it("without a journal a run goes through (the old behaviour is unchanged)", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    expect(await runFromHostFile(f.agentFile, f.request("r1"))).toMatchObject({ ok: true, state: "completed" });
  });

  it("a recorded failure stops the next run although the pinned evidence file still says pass; a pass does not lift it; a clearance does", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    expect(await runFromHostFile(f.agentFile, f.request("r1"))).toMatchObject({ ok: true });

    const failFile = f.write("fail.json", { ...f.good, verdict: "fail", blocked: true, results: f.good.results.map((r) => ({ ...r, verdict: "fail" as const, reason: "drifted" })) });
    const rec = recordOracleEvaluation(f.adminFile, { resultFile: failFile });
    expect(rec).toMatchObject({ ok: true, state: "recorded-failure" });
    const rowHash = (rec as { rowHash: string }).rowHash;
    expect(refusedByOracle(await runFromHostFile(f.agentFile, f.request("r2")))).toBe(true);

    const passFile = f.write("pass.json", f.good);
    expect(recordOracleEvaluation(f.adminFile, { resultFile: passFile })).toMatchObject({ ok: true, state: "recorded-pass" });
    expect(refusedByOracle(await runFromHostFile(f.agentFile, f.request("r3")))).toBe(true);
    expect(oracleJournalStatus(f.adminFile, {})).toMatchObject({ ok: true, state: "blocked", rowHash });

    expect(clearOracleFailure(f.adminFile, { rowHash, reason: "re-derived the tolerance and re-ran" })).toMatchObject({ ok: true, state: "cleared" });
    expect(oracleJournalStatus(f.adminFile, {})).toMatchObject({ ok: true, state: "clear" });
    expect(await runFromHostFile(f.agentFile, f.request("r4"))).toMatchObject({ ok: true, state: "completed" });
  });

  it("the refusal is audited like any gate refusal, and no run directory is made for it", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    recordOracleEvaluation(f.adminFile, { resultFile: f.write("fail.json", { ...f.good, verdict: "fail", blocked: true }) });
    const before = readdirSync(join(f.project, "runs")).length;
    const o = await runFromHostFile(f.agentFile, f.request("r2"));
    expect(refusedByOracle(o)).toBe(true);
    expect(readdirSync(join(f.project, "runs")).length).toBe(before);
    const engine = join(f.state, "engines", sha256Hex(resolve(__dirname, "fixtures/fake-adapter/cli.cjs")));
    const rows = readFileSync(join(engine, "admissions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.some((r) => r.event.phase === "decision" && r.event.event.decision.allow === false && r.event.event.decision.gateStop.rule === "oracle-failed")).toBe(true);
  });

  it("a damaged journal stops runs", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    recordOracleEvaluation(f.adminFile, { resultFile: f.write("pass.json", f.good) });
    const file = join(journalRoot(f.state, "fake")!, "admissions.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"verdict":"pass"', '"verdict":"fail"').replace('"verdict": "pass"', '"verdict": "fail"'));
    expect(refusedByOracle(await runFromHostFile(f.agentFile, f.request("r2")))).toBe(true);
  });

  it("a host whose actor is an agent cannot record, clear or read the journal", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    const file = f.write("fail.json", { ...f.good, verdict: "fail", blocked: true });
    for (const out of [
      recordOracleEvaluation(f.agentFile, { resultFile: file }),
      clearOracleFailure(f.agentFile, { rowHash: sha("a"), reason: "please" }),
      oracleJournalStatus(f.agentFile, {})
    ]) {
      expect(out).toMatchObject({ ok: false });
      expect((out as { errors: { message: string }[] }).errors[0]!.message).toMatch(/human/);
    }
    expect(journalRoot(f.state, "fake")).toBeNull();
  });

  it("a result file inside the project, a relative path, extra fields and a result for another adapter are refused", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    const inside = join(f.project, "fail.json");
    writeHostJson(inside, { ...f.good, verdict: "fail" });
    expect(recordOracleEvaluation(f.adminFile, { resultFile: inside })).toMatchObject({ ok: false });
    expect(recordOracleEvaluation(f.adminFile, { resultFile: "results/fail.json" })).toMatchObject({ ok: false });
    expect(recordOracleEvaluation(f.adminFile, { resultFile: f.write("x.json", f.good), actor: "me" })).toMatchObject({ ok: false });
    expect(recordOracleEvaluation(f.adminFile, {})).toMatchObject({ ok: false });
    expect(recordOracleEvaluation(f.adminFile, { resultFile: f.write("other.json", { ...f.good, adapter: "other" }) })).toMatchObject({ ok: false });
    expect(journalRoot(f.state, "fake")).toBeNull();
  });

  it("clearing needs the failure's own row hash", async () => {
    const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
    expect(clearOracleFailure(f.adminFile, { rowHash: sha("a"), reason: "nothing blocks" })).toMatchObject({ ok: false });
    recordOracleEvaluation(f.adminFile, { resultFile: f.write("fail.json", { ...f.good, verdict: "fail", blocked: true }) });
    expect(clearOracleFailure(f.adminFile, { rowHash: sha("a"), reason: "wrong row" })).toMatchObject({ ok: false });
    expect(clearOracleFailure(f.adminFile, { rowHash: sha("a") })).toMatchObject({ ok: false });
    expect(oracleJournalStatus(f.adminFile, {})).toMatchObject({ state: "blocked" });
  });

  describe("the admin command line", () => {
    const run = async (verb: string, file: string, input: unknown) => {
      const r = await runAdminCli([verb], Readable.from([JSON.stringify(input)]), file);
      return r as { code: number; reply: { ok: boolean; state?: string; rowHash?: string } };
    };

    it("oracle-record, oracle-status and oracle-clear work end to end, with exit codes", async () => {
      const f = await fixture({ kind: "agent", name: "bot", model: "fixture" });
      const recorded = await run("oracle-record", f.adminFile, { resultFile: f.write("fail.json", { ...f.good, verdict: "fail", blocked: true }) });
      expect(recorded).toMatchObject({ code: 0, reply: { ok: true, state: "recorded-failure" } });
      expect(await run("oracle-status", f.adminFile, {})).toMatchObject({ code: 0, reply: { state: "blocked" } });
      expect(await run("oracle-clear", f.adminFile, { rowHash: sha("a"), reason: "wrong" })).toMatchObject({ code: 2 });
      expect(await run("oracle-clear", f.adminFile, { rowHash: recorded.reply.rowHash, reason: "fixed and re-run" })).toMatchObject({ code: 0, reply: { state: "cleared" } });
      expect(await run("oracle-status", f.adminFile, {})).toMatchObject({ code: 0, reply: { state: "clear" } });
    });

    it("the agent's CLI has no such verb", async () => {
      const { runCli } = await import("../src/cli/seed");
      const r = await runCli(["oracle-record"], Readable.from(["{}"]), "/nonexistent");
      expect(r.code).toBe(2);
    });
  });
});
