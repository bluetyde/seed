import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { RunManager, withRequestsLock, type StartRequest } from "../src/core/runManager";
import { createTempProject, type TempProject } from "./helpers/project";

// E2 limits L5 and L6 of the exit review (docs/reviews/exit-reviews-e0-e2-2026-10-06.md): several managers (or processes) on one project.
const adapter = { command: process.execPath, args: [join(__dirname, "fixtures", "fake-adapter", "cli.cjs")], id: "fake", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const projects: TempProject[] = [];
afterEach(async () => {
  while (projects.length > 0) await projects.pop()?.cleanup();
});

let counter = 0;
function modelProject() {
  const proj = createTempProject("seed-conc-");
  projects.push(proj);
  const content = JSON.stringify({ name: "pin", counter: 1, fake: { validate: "ok" } }) + "\n";
  proj.createFile("models/pin.json", content);
  const hash = sha256Hex(content);
  const req = (over: Partial<StartRequest> = {}): StartRequest => ({
    requestId: "req-conc-" + ++counter,
    actor,
    artifact: { path: "models/pin.json", revision: { hash, counter: 1 } },
    inputs: [{ path: "models/pin.json", sha256: hash }],
    settings: { scenario: "success", delayMs: 100 },
    budget,
    ...over,
  });
  const mgr = (extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter, pollMs: 50, ...extra });
  const runs = join(proj.root, "runs");
  const runDirs = () => readdirSync(runs).filter((n) => n.startsWith("r-"));
  const reservations = () => readdirSync(runs).filter((n) => n.startsWith(".reserve-"));
  return { proj, req, mgr, runs, runDirs, reservations };
}

describe("L6: a request that another manager finished between the first look and the reservation is replayed, not run twice", () => {
  it("manager B read the request log before manager A finished the same request: B joins A's run", async () => {
    const { req, mgr, runDirs } = modelProject();
    const r = req();
    const a = mgr();
    const outcomeA: { value?: Awaited<ReturnType<RunManager["start"]>> } = {};
    const b = mgr({
      testHooks: {
        beforeReserve: async () => {
          outcomeA.value = await a.start(r); // A starts and finishes the whole request while B stands between its look and its reservation
        },
      },
    });
    const outcomeB = await b.start(r);
    expect(outcomeA.value?.ok).toBe(true);
    expect(outcomeB.ok).toBe(true);
    if (!outcomeA.value?.ok || !outcomeB.ok) return;
    expect(outcomeB.replayed).toBe(true);
    expect(outcomeB.runId).toBe(outcomeA.value.runId);
    expect(runDirs()).toHaveLength(1);
  }, 30000);

  it("the late look also refuses a changed payload under the same request id", async () => {
    const { req, mgr, runDirs } = modelProject();
    const r = req();
    const a = mgr();
    const b = mgr({ testHooks: { beforeReserve: async () => void (await a.start(r)) } });
    const changed = await b.start({ ...r, settings: { scenario: "success", delayMs: 101 } });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    expect(runDirs()).toHaveLength(1);
  }, 30000);
});

describe("L6: the request log is not lost when two processes add to it at once", () => {
  const lib = join(__dirname, "..", "dist", "core", "runManager.js");
  const worker = join(__dirname, "fixtures", "requests-writer.cjs");
  const runWorker = (file: string, prefix: string, n: number) =>
    new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [worker, lib, file, prefix, String(n)], { stdio: "ignore" });
      c.on("exit", (code) => resolve(code));
    });

  it("three processes add 40 entries each to one log: all 120 are there", async () => {
    const { runs } = modelProject();
    const file = join(runs, "requests.json");
    const codes = await Promise.all([runWorker(file, "a", 40), runWorker(file, "b", 40), runWorker(file, "c", 40)]);
    expect(codes).toEqual([0, 0, 0]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(120);
    expect(existsSync(file + ".lock")).toBe(false);
  }, 120000);

  it("a lock left by a dead process is taken over; a live holder makes the writer wait and then refuse", () => {
    const { runs } = modelProject();
    const file = join(runs, "requests.json");
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    expect(dead.status).toBe(0);
    mkdirSync(file + ".lock");
    writeFileSync(join(file + ".lock", "owner.json"), JSON.stringify({ pid: dead.pid, host: os.hostname(), time: new Date().toISOString(), token: "t" }));
    expect(withRequestsLock(file, () => "ran")).toBe("ran");
    // now a live holder (this very process) that never lets go
    mkdirSync(file + ".lock");
    writeFileSync(join(file + ".lock", "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: "t" }));
    expect(() => withRequestsLock(file, () => "never", { waitMs: 150 })).toThrow(/in use by another manager/);
    rmSync(file + ".lock", { recursive: true, force: true });
  });
});

describe("L5: recover() in one manager does not remove the reservation of another manager that is running", () => {
  it("a second manager's recover() leaves a live run's reservation alone, and the run still completes", async () => {
    const { req, mgr, reservations, runDirs } = modelProject();
    const r = req({ settings: { scenario: "slow", delayMs: 2000 } });
    const a = mgr();
    const first = a.start(r);
    await new Promise((res) => setTimeout(res, 300)); // A holds the reservation and is mid-run
    expect(reservations()).toHaveLength(1);
    await mgr().recover(); // another manager over the same folder
    expect(reservations()).toHaveLength(1);
    const done = await first;
    expect(done.ok).toBe(true);
    expect(runDirs()).toHaveLength(1);
    expect(reservations()).toEqual([]);
  }, 30000);

  it("a reservation whose holder is dead is removed; one of another host, and a young one with no owner, are kept", async () => {
    const { runs, mgr, reservations } = modelProject();
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const owner = (dir: string, o: Record<string, unknown> | null) => {
      mkdirSync(join(runs, dir));
      if (o) writeFileSync(join(runs, dir, "owner.json"), JSON.stringify(o));
    };
    owner(".reserve-dead", { pid: dead.pid, host: os.hostname(), time: "2026-10-06T00:00:00Z", token: "t" });
    owner(".reserve-alive", { pid: process.pid, host: os.hostname(), time: "2026-10-06T00:00:00Z", token: "t" });
    owner(".reserve-foreign", { pid: 1, host: "another-machine", time: "2026-10-06T00:00:00Z", token: "t" });
    owner(".reserve-young", null);
    owner(".reserve-old", null);
    utimesSync(join(runs, ".reserve-old"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await mgr().recover();
    expect(reservations().sort()).toEqual([".reserve-alive", ".reserve-foreign", ".reserve-young"]);
  });
});

describe("L6: the wall limit is part of what a request id stands for", () => {
  it("the same request with the same limit is replayed; with another limit it is a conflict and starts nothing", async () => {
    const { req, mgr, runDirs } = modelProject();
    const r = req({ wallLimitMs: 20000 });
    const first = await mgr().start(r);
    expect(first.ok).toBe(true);
    const same = await mgr().start({ ...r });
    expect(same.ok && same.replayed).toBe(true);
    const other = await mgr().start({ ...r, wallLimitMs: 30000 });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.errors[0]).toMatchObject({ code: "E_REQUEST_CONFLICT", field: "/requestId" });
    const without = await mgr().start({ ...r, wallLimitMs: undefined });
    expect(without.ok).toBe(false);
    expect(runDirs()).toHaveLength(1);
  }, 30000);
});
