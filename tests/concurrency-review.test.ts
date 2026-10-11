// @covers R-REV-04
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { RunManager, takeClaim, withRequestsLock, type StartRequest } from "../src/core/runManager";
import { createTempProject, type TempProject } from "./helpers/project";

// Findings of the Codex review of the E2 changes (2026-10-06) on the request log lock, the request reservation and recover().
const adapter = { command: process.execPath, args: [join(__dirname, "fixtures", "fake-adapter", "cli.cjs")], id: "fake", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const projects: TempProject[] = [];
afterEach(async () => {
  while (projects.length > 0) await projects.pop()?.cleanup();
});
let counter = 0;
function modelProject() {
  const proj = createTempProject("seed-concrev-");
  projects.push(proj);
  const content = JSON.stringify({ name: "pin", counter: 1, fake: { validate: "ok" } }) + "\n";
  proj.createFile("models/pin.json", content);
  const hash = sha256Hex(content);
  const req = (over: Partial<StartRequest> = {}): StartRequest => ({
    requestId: "req-rev-" + ++counter,
    actor,
    artifact: { path: "models/pin.json", revision: { hash, counter: 1 } },
    inputs: [{ path: "models/pin.json", sha256: hash }],
    settings: { scenario: "success", delayMs: 100 },
    budget,
    ...over,
  });
  const mgr = (extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter, pollMs: 50, ...extra });
  const runs = join(proj.root, "runs");
  return { proj, req, mgr, runs, reservations: () => readdirSync(runs).filter((n) => n.startsWith(".reserve-")) };
}
const runningRecord = async (root: string): Promise<string> => {
  for (let i = 0; i < 200; i++) {
    const dir = existsSync(join(root, "runs")) ? readdirSync(join(root, "runs")).find((n) => n.startsWith("r-")) : undefined;
    const rec = dir && existsSync(join(root, "runs", dir, "run-record.json")) ? JSON.parse(readFileSync(join(root, "runs", dir, "run-record.json"), "utf8")) : undefined;
    if (rec?.state === "running") return dir!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the run never reached running");
};
const writeOwner = (dir: string, o: Record<string, unknown>) => writeFileSync(join(dir, "owner.json"), JSON.stringify(o));
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid as number;

describe("the request log lock: contenders for an abandoned lock and a holder that was replaced", () => {
  const lib = join(__dirname, "..", "dist", "core", "runManager.js");
  const worker = join(__dirname, "fixtures", "requests-writer.cjs");
  const runWorker = (file: string, prefix: string, n: number) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [worker, lib, file, prefix, String(n)], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      c.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-1500)));
      c.on("exit", (code) => resolve({ code, stderr }));
    });

  it("four processes that all start by finding a dead holder's lock add 30 entries each: none is lost, over several rounds", async () => {
    for (let round = 0; round < 4; round++) {
      const { runs } = modelProject();
      const file = join(runs, "requests.json");
      mkdirSync(file + ".lock");
      writeOwner(file + ".lock", { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
      const results = await Promise.all(["a", "b", "c", "d"].map((p) => runWorker(file, p, 30)));
      expect(results.map((r) => r.code), results.map((r) => r.stderr).filter(Boolean).join(" | ")).toEqual([0, 0, 0, 0]);
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(120);
    }
  }, 240000);

  it("a holder that was replaced while it worked does not delete its successor's lock on the way out", () => {
    const { runs } = modelProject();
    const file = join(runs, "requests.json");
    withRequestsLock(file, () => {
      // somebody judged this holder abandoned and took the lock: the owner file now carries another token
      writeOwner(file + ".lock", { pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: "the-successor" });
    });
    expect(existsSync(file + ".lock")).toBe(true);
    expect(JSON.parse(readFileSync(join(file + ".lock", "owner.json"), "utf8")).token).toBe("the-successor");
  });

  it("a lock held on another machine is taken over once its time is older than staleMs, and not before", () => {
    const { runs } = modelProject();
    const file = join(runs, "requests.json");
    mkdirSync(file + ".lock");
    writeOwner(file + ".lock", { pid: 1, host: "another-machine", time: new Date().toISOString(), token: "far" });
    expect(() => withRequestsLock(file, () => "never", { waitMs: 150, staleMs: 30000 })).toThrow(/in use/);
    writeOwner(file + ".lock", { pid: 1, host: "another-machine", time: new Date(Date.now() - 120000).toISOString(), token: "far" });
    expect(withRequestsLock(file, () => "took over", { staleMs: 30000 })).toBe("took over");
    expect(existsSync(file + ".lock")).toBe(false);
  });

  it("a takeover guard left by a crashed contender does not block for ever", () => {
    const { runs } = modelProject();
    const file = join(runs, "requests.json");
    mkdirSync(file + ".lock");
    writeOwner(file + ".lock", { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
    const guard = join(runs, ".takeover-requests.json.lock");
    mkdirSync(guard);
    const old = new Date(Date.now() - 60000);
    // an old guard is removed by the next contender
    utimesSync(guard, old, old);
    expect(withRequestsLock(file, () => "ran")).toBe("ran");
  });
});

describe("the request reservation: a start that was paused while its reservation was recovered and re-made", () => {
  it("the paused start finds the folder is not its own and does not claim, release or delete it", () => {
    const { runs } = modelProject();
    const dir = join(runs, ".reserve-test");
    const claimed = takeClaim(dir, "mine", () => {
      // while this start is paused between making the folder and writing its owner: recovery removed it and another start made it again
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeOwner(dir, { pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: "the-other-start" });
    });
    expect(claimed).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")).token).toBe("the-other-start");
  });

  it("and when the folder was only removed it does not claim either", () => {
    const { runs } = modelProject();
    const dir = join(runs, ".reserve-gone");
    expect(takeClaim(dir, "mine", () => rmSync(dir, { recursive: true, force: true }))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("an uncontested claim succeeds and only its own token releases it", async () => {
    const { runs, req, mgr, reservations } = modelProject();
    const dir = join(runs, ".reserve-ok");
    expect(takeClaim(dir, "mine")).toBe(true);
    expect(takeClaim(dir, "yours")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    // a whole start releases its own reservation at the end
    const r = await mgr().start(req());
    expect(r.ok).toBe(true);
    expect(reservations()).toEqual([]);
  }, 30000);
});

describe("recover() in one manager leaves a run that another live manager is executing alone", () => {
  it("the run keeps running, gets no transition, and completes", async () => {
    const { proj, req, mgr } = modelProject();
    const r = req({ settings: { scenario: "slow", delayMs: 2500 } });
    const a = mgr();
    const first = a.start(r);
    const runDir = await runningRecord(proj.root); // A is mid-run: reservation held, run record running
    const changes = await mgr().recover();
    expect(changes).toEqual([]);
    expect(JSON.parse(readFileSync(join(proj.root, "runs", runDir, "run-record.json"), "utf8")).state).toBe("running");
    const done = await first;
    expect(done.ok && done.state).toBe("completed");
    const transitions = readFileSync(join(proj.root, "runs", runDir, "log", "transitions.jsonl"), "utf8");
    expect(transitions).not.toContain("interrupted");
  }, 30000);

  it("a run whose manager is gone (no live reservation) is still recovered as before", async () => {
    const { proj, req, mgr } = modelProject();
    const r = req({ settings: { scenario: "slow", delayMs: 2500 } });
    // an in-flight run of a manager that no longer exists: build the state by starting, then abandoning the reservation as a dead holder
    const a = mgr();
    const first = a.start(r);
    await runningRecord(proj.root);
    const res = readdirSync(join(proj.root, "runs")).find((n) => n.startsWith(".reserve-"))!;
    writeOwner(join(proj.root, "runs", res), { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: JSON.parse(readFileSync(join(proj.root, "runs", res, "owner.json"), "utf8")).token });
    const changes = await mgr().recover();
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ from: "running" });
    await first.catch(() => undefined);
  }, 30000);
});
