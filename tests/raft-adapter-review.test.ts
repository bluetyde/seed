// @covers R-ADAPT-01
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";

// Regression tests for the Codex review of the RAFT adapter (2026-10-03). Same requirements as raft-adapter.test.ts:
// the RAFT repo (SEED_RAFT_REPO, default a sibling folder virtual-reactor) with its headless runner built.
const repo = process.env.SEED_RAFT_REPO ?? join(__dirname, "..", "..", "virtual-reactor");
const realBundle = join(repo, "web", "dist-headless", "raft-headless.mjs");
const haveRaft = existsSync(realBundle);
const stubBundle = join(__dirname, "fixtures", "raft-stub", "raft-headless.mjs");
const coreDir = join(repo, "schema", "vectors", "synthetic-core");
const vectorsDir = join(repo, "schema", "engine-vectors");
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "raft", "cli.cjs")], id: "raft", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const CASE = "models/raft/case.json";
type Vec = Record<string, any>;

const dirs: string[] = [];
const pids: number[] = [];
const savedEnv = process.env.SEED_RAFT_HEADLESS;
beforeEach(() => {
  if (haveRaft) process.env.SEED_RAFT_HEADLESS = realBundle;
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup of a test's leftovers
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.RAFT_STUB_MODE;
  if (savedEnv === undefined) delete process.env.SEED_RAFT_HEADLESS;
  else process.env.SEED_RAFT_HEADLESS = savedEnv;
});

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), "seed-raft-rev-"));
  dirs.push(root);
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  return root;
}
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}
function raftProject(name = "scram", edit: (c: Vec) => void = () => {}) {
  const root = newProject();
  cpSync(coreDir, join(root, "models", "raft", "lib"), { recursive: true });
  const vec: Vec = JSON.parse(readFileSync(join(vectorsDir, `${name}.json`), "utf8"));
  const c: Vec = {
    format: "raft-headless-case",
    version: 1,
    library: "lib",
    seed: vec.seed,
    init: vec.init,
    config: vec.config,
    steps: vec.steps,
    sampleEvery: vec.sampleEvery,
    script: vec.script.map((i: Vec) => ({ ...i, clientId: "local" })),
  };
  edit(c);
  const caseText = JSON.stringify(c, null, 2) + "\n";
  writeFileSync(join(root, CASE), caseText);
  const inputs = listFiles(join(root, "models", "raft")).map((p) => {
    const path = `models/raft/${p}`;
    return { path, sha256: sha256Hex(readFileSync(join(root, path))) };
  });
  return { root, inputs, artifact: { path: CASE, revision: { hash: sha256Hex(caseText), counter: 1 } } };
}
const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 20000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 30000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; result?: any };
};
const longCase = (c: Vec) => {
  c.steps = 2_000_000;
  c.sampleEvery = 100_000;
  c.script = [];
};
/** A run folder as the host leaves it before the run verb: inputs copied under <runDir>/inputs. */
function prepareRunDir(root: string, inputs: { path: string }[], runDir: string): void {
  for (const i of inputs) {
    mkdirSync(join(root, runDir, "inputs", dirname(i.path)), { recursive: true });
    cpSync(join(root, i.path), join(root, runDir, "inputs", i.path));
  }
}
const runRequest = (inputs: { path: string; sha256: string }[], requestId: string, runDir: string) => ({ verb: "run", requestId, snapshot: { inputs }, runDir, budget, settings: { case: CASE } });
const readJsonSafe = (p: string): { pid: number } | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const trackJob = (root: string, runDir: string) => {
  const job = readJsonSafe(join(root, runDir, "native", "job.json"));
  const child = readJsonSafe(join(root, runDir, "native", "child.json"));
  if (job) pids.push(job.pid);
  if (child) pids.push(child.pid);
};
const cli = (root: string, verb: string, request: unknown) =>
  spawnSync(process.execPath, [spec.args[0]!, verb], { input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, SEED_PROJECT_ROOT: root } });
const sleepingProcess = () => {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  p.unref();
  pids.push(p.pid!);
  return p.pid!;
};

describe.skipIf(!haveRaft)("RAFT adapter: review fixes (Codex, 2026-10-03)", () => {
  it("job ids differ for request ids that share a long prefix, and each id reaches its own run", async () => {
    const { root, inputs, artifact } = raftProject("rod-withdrawal");
    const prefix = "a".repeat(55);
    const jobs: string[] = [];
    for (const id of [prefix + "1", prefix + "2"]) {
      const out = await manager(root).start({ requestId: id, actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      jobs.push(JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId);
    }
    expect(jobs[0]).not.toBe(jobs[1]);
    expect(jobs.every((j) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(j))).toBe(true);
    for (const j of jobs) expect(okReply(await ask(root, { verb: "status", jobId: j })).result.lifecycle).toBe("completed");
  });

  it("two starts of the same request at once give one job and one runner (exclusive reservation)", async () => {
    const { root, inputs } = raftProject("scram", longCase);
    prepareRunDir(root, inputs, "runs/r-one");
    const [a, b] = await Promise.all([ask(root, runRequest(inputs, "req-race", "runs/r-one")), ask(root, runRequest(inputs, "req-race", "runs/r-one"))]);
    const ra = okReply(a);
    const rb = okReply(b);
    expect(ra.ok && rb.ok).toBe(true);
    expect(ra.result.jobId).toBe(rb.result.jobId);
    await new Promise((r) => setTimeout(r, 500));
    trackJob(root, "runs/r-one");
    const c = okReply(await ask(root, { verb: "cancel", jobId: ra.result.jobId }));
    expect(c.result).toMatchObject({ lifecycle: "cancelled", cancelled: true });
  }, 60000);

  it("another request cannot take over a reserved run folder", async () => {
    const { root, inputs } = raftProject("scram", longCase);
    prepareRunDir(root, inputs, "runs/r-two");
    const first = okReply(await ask(root, runRequest(inputs, "req-first", "runs/r-two")));
    await new Promise((r) => setTimeout(r, 500));
    trackJob(root, "runs/r-two");
    const second = okReply(await ask(root, runRequest(inputs, "req-second", "runs/r-two")));
    expect(second.ok).toBe(false);
    expect(second.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    expect(okReply(await ask(root, { verb: "cancel", jobId: first.result.jobId })).result.cancelled).toBe(true);
  }, 60000);

  it("cancel kills only a process that really is this run's job wrapper, whatever the project files say", async () => {
    const { root, inputs } = raftProject("scram", longCase);
    prepareRunDir(root, inputs, "runs/r-forged");
    const other = sleepingProcess();
    const native = join(root, "runs", "r-forged", "native");
    mkdirSync(native, { recursive: true });
    const token = "forged-token";
    writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-forged", requestId: "req-forged", pid: other, token, case: CASE, inputs }));
    writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: new Date().toISOString() }));
    mkdirSync(join(root, ".seed", "jobs"), { recursive: true });
    writeFileSync(join(root, ".seed", "jobs", "job-forged.json"), JSON.stringify({ runDir: "runs/r-forged" }));
    const r = okReply(await ask(root, { verb: "cancel", jobId: "job-forged" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
    expect(isAlive(other)).toBe(true);
    // a job.json without any token does not match a heartbeat without one either (undefined must not equal undefined)
    writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-forged", requestId: "req-forged", pid: other, case: CASE, inputs }));
    writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ time: new Date().toISOString() }));
    const r2 = okReply(await ask(root, { verb: "cancel", jobId: "job-forged" }));
    expect(r2.result?.cancelled ?? false).toBe(false);
    expect(isAlive(other)).toBe(true);
  }, 60000);

  it("a live job with a late heartbeat is still running; only a confirmed death is a failure", async () => {
    const { root, inputs } = raftProject("scram");
    const live = sleepingProcess();
    const setup = (name: string, pid: number, heartbeatAgeMs: number | null, jobAgeMs: number) => {
      const runDir = `runs/${name}`;
      const native = join(root, runDir, "native");
      mkdirSync(native, { recursive: true });
      const token = "tok-" + name;
      writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-" + name, requestId: "r-" + name, pid, token, case: CASE, inputs }));
      writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
      const old = new Date(Date.now() - jobAgeMs);
      utimesSync(join(native, "job.json"), old, old);
      if (heartbeatAgeMs !== null) {
        writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: "x" }));
        const t = new Date(Date.now() - heartbeatAgeMs);
        utimesSync(join(native, "heartbeat.json"), t, t);
      }
      mkdirSync(join(root, ".seed", "jobs"), { recursive: true });
      writeFileSync(join(root, ".seed", "jobs", "job-" + name + ".json"), JSON.stringify({ runDir }));
      return "job-" + name;
    };
    const state = async (jobId: string) => okReply(await ask(root, { verb: "status", jobId })).result;
    const late = await state(setup("late", live, 60_000, 120_000));
    expect(late.lifecycle).toBe("running");
    expect(late.native.detail).toContain("no heartbeat");
    expect((await state(setup("starting", live, null, 1_000))).native.detail).toBe("starting");
    expect((await state(setup("neverstarted", live, null, 120_000))).lifecycle).toBe("failed");
    expect((await state(setup("dead", 2_000_000_000, 100, 120_000))).lifecycle).toBe("failed");
  });

  it("collect refuses a job id that is not the one registered for the run folder", async () => {
    const a = raftProject("rod-withdrawal");
    const outA = await manager(a.root).start({ requestId: "req-a", actor, artifact: a.artifact, inputs: a.inputs, budget, settings: { case: CASE } });
    const outB = await manager(a.root).start({ requestId: "req-b", actor, artifact: a.artifact, inputs: a.inputs, budget, settings: { case: CASE } });
    if (!outA.ok || !outB.ok) throw new Error("refused");
    const jobA = JSON.parse(readFileSync(join(a.root, "runs", outA.runId, "native", "job.json"), "utf8")).jobId;
    const r = okReply(await ask(a.root, { verb: "collect", jobId: jobA, runDir: `runs/${outB.runId}` }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toContain("not registered for this run folder");
  });

  it("direct calls of the adapter CLI re-check every path (the client schema is not relied on)", () => {
    const { root, inputs } = raftProject("scram");
    prepareRunDir(root, inputs, "runs/r-direct");
    const base = { schema: "seed.adapter-request/0.1", verb: "run", requestId: "req-direct", actor, runDir: "runs/r-direct", budget };
    const cases: [string, Record<string, unknown>, string][] = [
      ["case path outside", { snapshot: { inputs: [{ path: "../../etc/case.json", sha256: "0".repeat(64) }] }, settings: { case: "../../etc/case.json" } }, "E_PATH_INVALID"],
      ["absolute input", { snapshot: { inputs: [{ path: "/etc/passwd", sha256: "0".repeat(64) }] }, settings: { case: "/etc/passwd" } }, "E_PATH_INVALID"],
      ["run folder outside", { runDir: "../outside", snapshot: { inputs }, settings: { case: CASE } }, "E_PATH_TRAVERSAL"],
      ["input that changed", { snapshot: { inputs: inputs.map((i, k) => (k === 0 ? { ...i, sha256: "0".repeat(64) } : i)) }, settings: { case: CASE } }, "E_STALE_REVISION"],
    ];
    for (const [what, extra, code] of cases) {
      const r = cli(root, "run", { ...base, ...extra });
      expect(r.status, what).toBe(0);
      const reply = JSON.parse(r.stdout);
      expect(reply.ok, what).toBe(false);
      expect(reply.errors[0].code, what).toBe(code);
    }
    expect(existsSync(join(root, "runs", "r-direct", "native", "job.json"))).toBe(false);
  });

  it("a state folder that is a link is refused and nothing is written through it", () => {
    for (const which of ["native", "jobs"]) {
      const { root, inputs } = raftProject("scram", longCase);
      const runDir = "runs/r-link";
      prepareRunDir(root, inputs, runDir);
      const outside = mkdtempSync(join(tmpdir(), "seed-raft-outside-"));
      dirs.push(outside);
      try {
        if (which === "native") symlinkSync(outside, join(root, runDir, "native"), "junction");
        else {
          mkdirSync(join(root, ".seed"));
          symlinkSync(outside, join(root, ".seed", "jobs"), "junction");
        }
      } catch {
        return; // links are not permitted in this environment
      }
      const r = cli(root, "run", { schema: "seed.adapter-request/0.1", verb: "run", requestId: "req-link", actor, runDir, budget, snapshot: { inputs }, settings: { case: CASE } });
      const reply = JSON.parse(r.stdout);
      expect(reply.ok, which).toBe(false);
      expect(reply.errors[0].code, which).toBe("E_PATH_TRAVERSAL");
      expect(readdirSync(outside), which).toEqual([]);
    }
  });
});

describe("RAFT adapter: refusal without a reason (stub)", () => {
  it("a runner that refuses with an empty error list is not a valid case", async () => {
    process.env.SEED_RAFT_HEADLESS = stubBundle;
    process.env.RAFT_STUB_MODE = "refuse-empty";
    const root = newProject();
    const text = JSON.stringify({ library: "lib" });
    writeFileSync(join(root, "models", "case.json"), text);
    mkdirSync(join(root, "models", "lib"));
    const r = okReply(await ask(root, { verb: "validate", artifact: { path: "models/case.json", revision: { hash: sha256Hex(text), counter: 1 } } }));
    expect(r.result.valid).toBe(false);
    expect(r.result.problems[0]).toMatchObject({ code: "E_APP_FAILED", source: "app-content" });
  });
});
