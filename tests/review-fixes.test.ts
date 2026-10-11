// @covers R-CORE-02, R-REV-01, R-REV-04, R-REV-05
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { RunManager, type StartRequest } from "../src/core/runManager";
import { createTempProject, type TempProject } from "./helpers/project";

// Tests for the findings of the Codex review of the E0 branch (2026-10-03). Each describe names the finding it covers.
const cliPath = join(__dirname, "fixtures", "fake-adapter", "cli.cjs");
const spec = { command: process.execPath, args: [cliPath] };
const adapter = { ...spec, id: "fake", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const projects: TempProject[] = [];

afterEach(async () => {
  while (projects.length > 0) await projects.pop()?.cleanup();
});

function project(): TempProject {
  const p = createTempProject("seed-review-");
  projects.push(p);
  return p;
}

let counter = 0;
function modelProject() {
  const proj = project();
  const content = JSON.stringify({ name: "pin", counter: 1, fake: { validate: "ok" } }) + "\n";
  proj.createFile("models/pin.json", content);
  const hash = sha256Hex(content);
  const req = (over: Partial<StartRequest> = {}): StartRequest => ({
    requestId: "req-review-" + ++counter,
    actor,
    artifact: { path: "models/pin.json", revision: { hash, counter: 1 } },
    inputs: [{ path: "models/pin.json", sha256: hash }],
    settings: { scenario: "success", delayMs: 100 },
    budget,
    ...over,
  });
  const mgr = (extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) =>
    new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter, pollMs: 50, ...extra });
  return { proj, hash, content, req, mgr };
}

function runDirs(root: string): string[] {
  const runs = join(root, "runs");
  return existsSync(runs) ? readdirSync(runs).filter((n) => n.startsWith("r-")) : [];
}

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

describe("adapter client: a reply must answer the request it was sent for (review: replies not matched to the job)", () => {
  const base = { schema: "seed.adapter-request/0.1", actor, extensions: { fake: { mode: "wrong-job-id" } } };
  const cases: [string, Record<string, unknown>, string][] = [
    ["status", { verb: "status", requestId: "r1", jobId: "job-a" }, "reply jobId does not match"],
    ["cancel", { verb: "cancel", requestId: "r2", jobId: "job-a" }, "reply jobId does not match"],
    ["collect", { verb: "collect", requestId: "r3", jobId: "job-a", runDir: "runs/r-1" }, "reply jobId does not match"],
    [
      "run",
      {
        verb: "run",
        requestId: "r4",
        snapshot: { inputs: [{ path: "models/pin.json", sha256: "a".repeat(64) }] },
        runDir: "runs/r-1",
        budget,
      },
      "reply runDir does not match",
    ],
  ];
  for (const [verb, body, message] of cases) {
    it(verb + " reply about another job or directory is refused", async () => {
      const proj = project();
      const out = await callAdapter(spec, { ...base, ...body }, { projectRoot: proj.root, timeoutMs: 5000 });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.errors[0]?.code).toBe("E_APP_FAILED");
      expect(out.errors[0]?.message).toContain(message);
    });
  }
});

describe("run manager: cancellation must be confirmed (review: failed cancellation recorded as cancelled)", () => {
  it("an adapter that answers cancelled:false leaves the run running; cancel() reports the failure; the run ends by its time limit with the unconfirmed stop on record", async () => {
    const { proj, req, mgr } = modelProject();
    const m = mgr();
    const started = m.start(
      req({ settings: { scenario: "hang" }, wallLimitMs: 3500, extensions: { fake: { mode: "cancel-not-confirmed", verb: "cancel" } } })
    );
    await waitFor(() => runDirs(proj.root).some((d) => existsSync(join(proj.root, "runs", d, "native", "job.json"))));
    const runId = runDirs(proj.root)[0] as string;
    const cancelOutcome = await m.cancel(runId);
    expect(cancelOutcome.ok).toBe(false);
    if (!cancelOutcome.ok) expect(cancelOutcome.errors[0]?.code).toBe("E_APP_FAILED");
    // still tracked and not recorded as cancelled
    const mid = JSON.parse(readFileSync(join(proj.root, "runs", runId, "run-record.json"), "utf8"));
    expect(mid.state).toBe("running");
    const outcome = await started;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("failed");
    const errors = JSON.parse(readFileSync(join(proj.root, "runs", runId, "log", "errors.json"), "utf8")) as { code: string }[];
    expect(errors.map((e) => e.code)).toContain("E_TIMEOUT");
    expect(errors.map((e) => e.code)).toContain("E_APP_FAILED");
    // the fake job is really still alive (nothing stopped it): stop it so the test leaves nothing behind
    const job = JSON.parse(readFileSync(join(proj.root, "runs", runId, "native", "job.json"), "utf8"));
    proj.registerPid(job.pid);
  });
});

describe("run manager: request log and records (review: malformed request log, replay of invalid records, missing records)", () => {
  async function startWithLog(logContent: string) {
    const { proj, req, mgr } = modelProject();
    mkdirSync(join(proj.root, "runs"), { recursive: true });
    writeFileSync(join(proj.root, "runs", "requests.json"), logContent);
    const out = await mgr().start(req());
    return { proj, out };
  }

  for (const [name, content] of [
    ["an array", "[]"],
    ["null", "null"],
    ["an entry that is not an object", JSON.stringify({ "req-x": 5 })],
    ["an entry with a bad payload hash", JSON.stringify({ "req-x": { payloadHash: "nope", runId: "r-1" } })],
    ["an entry with a path-like run id", JSON.stringify({ "req-x": { payloadHash: "a".repeat(64), runId: "../x" } })],
  ] as const) {
    it("a request log that is " + name + " refuses the start and is left untouched", async () => {
      const { proj, out } = await startWithLog(content);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors[0]?.code).toBe("E_INTERNAL");
      expect(readFileSync(join(proj.root, "runs", "requests.json"), "utf8")).toBe(content);
      expect(runDirs(proj.root)).toEqual([]);
    });
  }

  it("a requestId named like an Object.prototype member is an ordinary new request", async () => {
    const { proj, req, mgr } = modelProject();
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const out = await mgr().start(req({ requestId: id }));
      if (!out.ok) throw new Error(id + ": " + JSON.stringify(out.errors));
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.state).toBe("completed");
    }
    expect(runDirs(proj.root)).toHaveLength(4);
  });

  it("a replayed request whose record is invalid is refused, not returned as a result", async () => {
    const { proj, req, mgr } = modelProject();
    const r = req();
    const first = await mgr().start(r);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(proj.root, "runs", first.runId, "run-record.json"), JSON.stringify({ state: "completed" }));
    const again = await mgr().start(r);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors[0]?.code).toBe("E_INTERNAL");
  });

  it("a request entry whose run record is missing does not start a replacement run and keeps the entry", async () => {
    const { proj, req, mgr } = modelProject();
    const r = req();
    const first = await mgr().start(r);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const logBefore = readFileSync(join(proj.root, "runs", "requests.json"), "utf8");
    rmSync(join(proj.root, "runs", first.runId, "run-record.json"));
    const again = await mgr().start(r);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors[0]?.code).toBe("E_INTERNAL");
    expect(runDirs(proj.root)).toHaveLength(1);
    expect(readFileSync(join(proj.root, "runs", "requests.json"), "utf8")).toBe(logBefore);
  });
});

describe("run manager: filesystem containment (review: symlinks, outputs outside the run, run id traversal)", () => {
  it("an input reached through a link that leaves the project is refused", async () => {
    const { proj, content, hash, req, mgr } = modelProject();
    const outside = project();
    outside.createFile("pin.json", content);
    symlinkSync(outside.root, join(proj.root, "linked"), "junction");
    const out = await mgr().start(req({ inputs: [{ path: "linked/pin.json", sha256: hash }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors[0]?.code).toBe("E_PATH_TRAVERSAL");
      expect(out.errors[0]?.field).toBe("/inputs/0/path");
    }
    expect(runDirs(proj.root)).toEqual([]);
  });

  it("a runs folder that is a link leaving the project is refused and nothing is written outside", async () => {
    const { proj, req, mgr } = modelProject();
    const outside = project();
    rmSync(join(proj.root, "runs"), { recursive: true, force: true });
    symlinkSync(outside.root, join(proj.root, "runs"), "junction");
    const out = await mgr().start(req());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors[0]?.code).toBe("E_PATH_TRAVERSAL");
      expect(out.errors[0]?.field).toBe("/runsFolder");
    }
    const leaked = readdirSync(outside.root).filter((n) => n === "requests.json" || n.startsWith("r-") || n.startsWith(".reserve-") || n === "gate-stops.jsonl");
    expect(leaked).toEqual([]);
  });

  for (const [mode, field] of [
    ["outside-run-data", "/quantities/0/data/path"],
    ["bad-input-hashes", "/inputHashes"],
    ["bad-provenance", "/quantities/0/provenance/inputRevisions"],
    // an output that exists but cannot be read (here a folder where a file should be): a failed run with the cause on the record, never a run left "running"
    ["directory-data", "/quantities/0/data/path"],
    ["directory-index", "/resultsIndex"],
  ] as const) {
    it("a collect with " + mode + " ends failed with E_OUTPUT_INCOMPLETE at " + field, async () => {
      const { proj, req, mgr } = modelProject();
      const out = await mgr().start(req({ extensions: { fake: { collect: mode } } }));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.state).toBe("failed");
      expect(out.record.outputs).toBeUndefined();
      const errors = JSON.parse(readFileSync(join(proj.root, "runs", out.runId, "log", "errors.json"), "utf8")) as { code: string; field: string }[];
      expect(errors[0]?.code).toBe("E_OUTPUT_INCOMPLETE");
      expect(errors[0]?.field).toBe(field);
    });
  }

  it("cancel() and transition() refuse run ids that are not plain ids and never touch other records", async () => {
    const { proj, mgr } = modelProject();
    const archived = join(proj.root, "archive", "r-old");
    mkdirSync(archived, { recursive: true });
    const record = JSON.stringify({ state: "queued", note: "must stay as it is" });
    writeFileSync(join(archived, "run-record.json"), record);
    const m = mgr();
    for (const id of ["../archive/r-old", "..", "a/b", "r-old/../../archive/r-old", ""]) {
      const out = await m.cancel(id);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors[0]?.code).toBe("E_PROP_MISSING");
      expect(() => m.transition(id, "cancelled", "test")).toThrow();
    }
    expect(readFileSync(join(archived, "run-record.json"), "utf8")).toBe(record);
  });
});

describe("run manager: two managers on one project (review: concurrent managers could start the same request twice)", () => {
  it("the second manager is refused while the first holds the request, and a stale reservation is cleared by recover()", async () => {
    const { proj, req, mgr } = modelProject();
    const r = req({ settings: { scenario: "slow", delayMs: 800 } });
    const a = mgr();
    const b = mgr();
    const first = a.start(r);
    const second = await b.start(r);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    const firstOutcome = await first;
    expect(firstOutcome.ok).toBe(true);
    expect(runDirs(proj.root)).toHaveLength(1);
    // reservation is released at the end
    expect(readdirSync(join(proj.root, "runs")).filter((n) => n.startsWith(".reserve-"))).toEqual([]);
    // a reservation left by a stopped manager blocks its request until recover() clears it
    const r2 = req();
    const key = ".reserve-" + sha256Hex(r2.requestId).slice(0, 24);
    mkdirSync(join(proj.root, "runs", key));
    // made by something that wrote no owner file: judged abandoned once it is older than a few seconds
    utimesSync(join(proj.root, "runs", key), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const blocked = await mgr().start(r2);
    expect(blocked.ok).toBe(false);
    await mgr().recover();
    expect(existsSync(join(proj.root, "runs", key))).toBe(false);
    const ok = await mgr().start(r2);
    expect(ok.ok).toBe(true);
  });
});
