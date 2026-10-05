import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { isAlive } from "../src/core/procTree";

// The shared job wrapper and flows (adapters/shared/{job,flow,outcome}.cjs) through a tiny fake adapter whose runner behavior this file controls
// (tests/fixtures/shared-adapter). No real app is involved, so every rule of the shared code can be pinned on its own; the real adapters'
// suites then test what is theirs.
const spec = { command: process.execPath, args: [join(__dirname, "fixtures", "shared-adapter", "cli.cjs")], id: "fixture", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const inputs = [{ path: "models/x.json", sha256: "0".repeat(64) }];

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "seed shared flow ") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 60000 });
const reply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; message: string }[]; result?: any };
};
const runReq = (requestId: string, runDir: string, settings: Record<string, unknown>) => ({ verb: "run", requestId, runDir, snapshot: { inputs }, budget, settings });

function project() {
  const root = tmp();
  mkdirSync(join(root, "runs"));
  return root;
}
function runFolder(root: string, name: string) {
  mkdirSync(join(root, "runs", name), { recursive: true });
  return `runs/${name}`;
}
async function startAndTrack(root: string, requestId: string, runDir: string, settings: Record<string, unknown>) {
  const r = reply(await ask(root, runReq(requestId, runDir, settings)));
  if (r.ok) {
    const native = join(root, runDir, "native");
    const job = read(join(native, "job.json"));
    pids.push(job.pid);
    if (existsSync(join(native, "child.json"))) pids.push(read(join(native, "child.json")).pid);
  }
  return r;
}
async function finalStatus(root: string, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const s = reply(await ask(root, { verb: "status", jobId }));
    if (s.result.lifecycle !== "running") return s.result;
    await sleep(100);
  }
  throw new Error("the job never ended");
}

describe("the job wrapper and its outcome mapping", () => {
  it.each<[string, string, string, string?]>([
    ["ok", "completed", "finished"],
    ["exit3", "failed", "failed"], // the runner says "completed" but its process failed: never a success
    ["cancelled", "cancelled", "cancelled"],
    ["refuse", "failed", "failed", "refused for a reason"],
    ["failed", "failed", "failed", "the engine said no"],
  ])("runner mode %s ends %s", async (mode, lifecycle, native, detail) => {
    const root = project();
    const r = await startAndTrack(root, "req-" + mode, runFolder(root, mode), { mode });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    const s = await finalStatus(root, r.result.jobId);
    expect(s.lifecycle).toBe(lifecycle);
    expect(s.native.status).toBe(native);
    if (detail) expect(s.native.detail).toContain(detail);
  }, 60000);

  it("when it can no longer report, the wrapper asks the app's own cancel, stops the runner and leaves its reason behind", async () => {
    const root = project();
    const runDir = runFolder(root, "abort");
    const r = await startAndTrack(root, "req-abort", runDir, { mode: "hang", native: true });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    const native = join(root, runDir, "native");
    const child = read(join(native, "child.json"));
    expect(isAlive(child.pid)).toBe(true);
    // The heartbeat file becomes a folder: the wrapper's next write fails and it must give up responsibly.
    rmSync(join(native, "heartbeat.json"), { force: true });
    mkdirSync(join(native, "heartbeat.json"));
    for (let i = 0; i < 100 && !existsSync(join(native, "job-error.txt")); i++) await sleep(100);
    expect(existsSync(join(native, "job-error.txt"))).toBe(true);
    const why = readFileSync(join(native, "job-error.txt"), "utf8");
    expect(why).toContain("heartbeat write failed");
    expect(why).toContain("native run cancelled");
    expect(existsSync(join(root, runDir, "native-cancelled.txt"))).toBe(true); // the app's own cancel ran
    for (let i = 0; i < 50 && isAlive(child.pid); i++) await sleep(100);
    expect(isAlive(child.pid)).toBe(false);
  }, 60000);

  it("log.txt is replaced by the wrapper, never written through a link to a file outside the run folder", async () => {
    const root = project();
    const runDir = runFolder(root, "loglink");
    const outside = join(tmp("seed shared outside "), "precious.txt");
    writeFileSync(outside, "OUTSIDE");
    mkdirSync(join(root, runDir, "native"));
    try {
      linkSync(outside, join(root, runDir, "native", "log.txt"));
    } catch {
      return; // hard links are not permitted in this environment
    }
    const r = await startAndTrack(root, "req-loglink", runDir, { mode: "ok" });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect((await finalStatus(root, r.result.jobId)).lifecycle).toBe("completed");
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(root, runDir, "native", "log.txt"), "utf8")).toContain("exit 0");
  }, 60000);

  it("a native/out that is a link is refused: the wrapper never writes through it", async () => {
    const root = project();
    const runDir = runFolder(root, "outlink");
    const outside = tmp("seed shared outside ");
    mkdirSync(join(root, runDir, "native"));
    try {
      symlinkSync(outside, join(root, runDir, "native", "out"), "junction");
    } catch {
      return; // links are not permitted in this environment
    }
    const r = await startAndTrack(root, "req-outlink", runDir, { mode: "ok" });
    // either the start is refused or the job fails: in no case does it complete or touch the folder behind the link
    if (r.ok) expect((await finalStatus(root, r.result.jobId)).lifecycle).not.toBe("completed");
    expect(existsSync(join(outside, "anything"))).toBe(false);
  }, 60000);
});

describe("starting and cancelling a job", () => {
  it("a request id bound to another run folder is refused before anything is created in that folder", async () => {
    const root = project();
    const first = await startAndTrack(root, "req-bound", runFolder(root, "a"), { mode: "hang" });
    expect(first.ok).toBe(true);
    const second = reply(await ask(root, runReq("req-bound", runFolder(root, "b"), { mode: "hang" })));
    expect(second.ok).toBe(false);
    expect(second.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    expect(existsSync(join(root, "runs", "b", "native"))).toBe(false); // nothing was created there
    expect(reply(await ask(root, { verb: "status", jobId: first.result.jobId })).result.lifecycle).toBe("running"); // and the first job is untouched
  }, 60000);

  it("the request id is the idempotency key: the same payload gives the same job, another payload is a conflict", async () => {
    const root = project();
    const runDir = runFolder(root, "payload");
    const first = await startAndTrack(root, "req-payload", runDir, { mode: "hang" });
    expect(first.ok, JSON.stringify(first.errors)).toBe(true);
    const again = reply(await ask(root, runReq("req-payload", runDir, { mode: "hang" })));
    expect(again.ok).toBe(true);
    expect(again.result.jobId).toBe(first.result.jobId); // the same request again: the same job, nothing new started
    for (const [what, request] of [
      ["other settings", runReq("req-payload", runDir, { mode: "hang", extra: 1 })],
      ["another seed", { ...runReq("req-payload", runDir, { mode: "hang" }), seed: 5 }],
      ["other inputs", { ...runReq("req-payload", runDir, { mode: "hang" }), snapshot: { inputs: [{ path: "models/x.json", sha256: "1".repeat(64) }] } }],
    ] as const) {
      const r = reply(await ask(root, request));
      expect(r.ok, what).toBe(false);
      expect(r.errors[0]?.code, what).toBe("E_REQUEST_CONFLICT");
    }
    expect(reply(await ask(root, { verb: "status", jobId: first.result.jobId })).result.lifecycle).toBe("running"); // and the first job is untouched
  }, 60000);

  it("a failed launch leaves no job or registry entry behind, and the same request can be started again", async () => {
    const root = project();
    const runDir = runFolder(root, "bad");
    const bad = reply(await ask(root, runReq("req-retry", runDir, { mode: "ok", missingRunner: true })));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.code).toBe("E_APP_FAILED");
    expect(existsSync(join(root, runDir, "native", "job.json"))).toBe(false);
    expect(existsSync(join(root, ".seed", "jobs"))).toBe(true);
    expect(existsSync(join(root, ".seed", "jobs", readJobIdFile(root) ?? "none"))).toBe(false);
    const again = await startAndTrack(root, "req-retry", runDir, { mode: "ok" });
    expect(again.ok, JSON.stringify(again.errors)).toBe(true);
    expect((await finalStatus(root, again.result.jobId)).lifecycle).toBe("completed");
  }, 90000);

  it("the registry entry left by an earlier launch of the same run folder is reused, not deleted", async () => {
    const root = project();
    const runDir = runFolder(root, "stale");
    const r1 = await startAndTrack(root, "req-stale", runDir, { mode: "ok" });
    expect(r1.ok).toBe(true);
    await finalStatus(root, r1.result.jobId);
    rmSync(join(root, runDir, "native", "job.json")); // the job record is gone, the index entry remains
    const r2 = await startAndTrack(root, "req-stale", runDir, { mode: "ok" });
    expect(r2.ok, JSON.stringify(r2.errors)).toBe(true);
    expect(r2.result.jobId).toBe(r1.result.jobId);
  }, 90000);

  it("cancel checks the host's launch binding: another run folder or other process ids are refused, the right ones are cancelled", async () => {
    const root = project();
    const runDir = runFolder(root, "bind");
    const r = await startAndTrack(root, "req-bind", runDir, { mode: "hang", native: true });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    const procs: number[] = r.result.nativeProcesses;
    const jobId = r.result.jobId;
    const withLaunch = (launch: Record<string, unknown>) => ask(root, { verb: "cancel", jobId, extensions: { "seed.launch": launch } });
    for (const launch of [{ runDir: "runs/other", nativeProcesses: procs }, { runDir, nativeProcesses: [procs[0], procs[1]! + 1] }, { runDir, nativeProcesses: [procs[0]] }]) {
      const refused = reply(await withLaunch(launch));
      expect(refused.ok, JSON.stringify(launch)).toBe(false);
      expect(refused.errors[0]?.code).toBe("E_NOT_OWNED");
    }
    expect(isAlive(procs[0]!)).toBe(true);
    const done = reply(await withLaunch({ runDir, nativeProcesses: procs }));
    expect(done.result).toMatchObject({ lifecycle: "cancelled", cancelled: true, nativeStopped: true });
    expect(existsSync(join(root, runDir, "native-cancelled.txt"))).toBe(true);
    expect(isAlive(procs[0]!)).toBe(false);
  }, 90000);
});

/** The job id file name of the only registry entry, if any. */
function readJobIdFile(root: string): string | null {
  const dir = join(root, ".seed", "jobs");
  try {
    const names = readdirSync(dir);
    return names[0] ?? null;
  } catch {
    return null;
  }
}
