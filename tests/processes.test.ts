// @covers R-SHELL-07
import { spawn } from "node:child_process";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEntry } from "../src/main/apps";
import { OwnerStore } from "../src/core/ownerStore";
import { freePort, ProcessManager } from "../src/main/processes";

const fake = join(__dirname, "fixtures", "fake-app.cjs");
const app = (extra: string[] = [], over: Partial<AppEntry> = {}): AppEntry => ({
  id: "fake", name: "Fake", icon: "app", healthPath: "/health", urlPath: "/?token={token}", startTimeoutMs: 10_000,
  start: { command: process.execPath, args: [fake, "--port", "{port}", ...extra] }, ...over,
});

const managers: ProcessManager[] = [];
const servers: http.Server[] = [];
const manager = () => { const m = new ProcessManager(); managers.push(m); return m; };
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const answers = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; } };

describe("ProcessManager", () => {
  it("cancels a warming child and can reopen without killing an unrelated server", async () => {
    const m = manager();
    const sibling = await m.ensure(app([], { id: "sibling" }));
    const opening = m.ensure(app(["--delay", "60000"]));
    const outcome = opening.catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 300));
    const oldPort = m.running("fake")?.port;
    expect(oldPort).toBeDefined();
    await m.stop("fake");
    expect(await outcome).toContain("cancelled");
    expect(await answers(`http://127.0.0.1:${oldPort}/health`)).toBe(0);
    expect(await answers(`http://127.0.0.1:${sibling.port}/health`)).toBe(200);
    const reopened = await m.ensure(app());
    expect(await answers(`http://127.0.0.1:${reopened.port}/health`)).toBe(200);
  });
  it("starts a server, waits for health, gives a url with a fresh token, and stops it (port freed)", async () => {
    const m = manager();
    const r = await m.ensure(app(["--delay", "400"]));
    expect(r.owned).toBe(true);
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/);
    expect(await answers(`http://127.0.0.1:${r.port}/health`)).toBe(200);
    await m.stop("fake");
    expect(await answers(`http://127.0.0.1:${r.port}/health`)).toBe(0);
    expect(m.running("fake")).toBeUndefined();
  });

  it("starts once for concurrent opens", async () => {
    const m = manager();
    const [a, b] = await Promise.all([m.ensure(app()), m.ensure(app())]);
    expect(a.port).toBe(b.port);
  });

  it("reports the output when the server stops before it is ready", async () => {
    const m = manager();
    await expect(m.ensure(app(["--exit", "2"]))).rejects.toMatchObject({
      name: "AppStartError",
      message: expect.stringContaining("exit code 2"),
      output: expect.stringContaining("ModuleNotFoundError: foo"),
    });
  });

  it("reports a missing command instead of hanging", async () => {
    const m = manager();
    await expect(m.ensure(app([], { start: { command: "definitely-not-a-command-xyz", args: [] } }))).rejects.toMatchObject({ name: "AppStartError" });
  });

  it("times out a server that never answers and stops it", async () => {
    const m = manager();
    await expect(m.ensure(app(["--delay", "60000"], { startTimeoutMs: 1500 }))).rejects.toMatchObject({ message: expect.stringContaining("did not answer") });
    expect(m.running("fake")).toBeUndefined();
  });

  it("uses a server that is already running and never stops it", async () => {
    const port = await freePort();
    const s = http.createServer((_q, res) => { res.writeHead(200); res.end("hi"); });
    servers.push(s);
    await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
    const m = manager();
    const r = await m.ensure(app([], { attachUrl: `http://127.0.0.1:${port}/` }));
    expect(r.owned).toBe(false);
    expect(r.url).toContain(`127.0.0.1:${port}`);
    await m.stop("fake");
    expect(await answers(`http://127.0.0.1:${port}/health`)).toBe(200);
  });

  it("starts its own server when the attach address does not answer", async () => {
    const dead = await freePort();
    const m = manager();
    const r = await m.ensure(app([], { attachUrl: `http://127.0.0.1:${dead}/` }));
    expect(r.owned).toBe(true);
  });

  it("with nothing to start and nothing to attach to, says so", async () => {
    const dead = await freePort();
    const m = manager();
    const a = app([], { attachUrl: `http://127.0.0.1:${dead}/` });
    delete a.start;
    await expect(m.ensure(a)).rejects.toMatchObject({ message: expect.stringContaining("no start command") });
  });

  it("tells the host when a server it started stops by itself", async () => {
    const m = manager();
    const exits: [string, number | null][] = [];
    m.onExit = (id, code) => exits.push([id, code]);
    await m.ensure(app(["--crash-after", "800"]));
    await new Promise((r) => setTimeout(r, 2500));
    expect(exits).toEqual([["fake", 3]]);
    expect(m.running("fake")).toBeUndefined();
  });

  it("stopping a deliberate stop does not report an exit", async () => {
    const m = manager();
    const exits: string[] = [];
    m.onExit = (id) => exits.push(id);
    await m.ensure(app());
    await m.stop("fake");
    await new Promise((r) => setTimeout(r, 500));
    expect(exits).toEqual([]);
  });
});

describe("stopping a server the host started", () => {
  const deps = (kill: () => Promise<void>) => ({
    spawn, freePort, kill, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    fetchStatus: async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).status,
  });
  it("a stop that returns while the process still runs keeps its record, marked orphaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-owners-"));
    const owners = new OwnerStore(dir);
    const m = new ProcessManager(deps(async () => undefined) as never, owners);
    let pid = 0;
    try {
      await m.ensure(app());
      await new Promise((r) => setTimeout(r, 400));
      pid = owners.list().records[0]!.worker!.identity.pid;
      await m.stop("fake");
      const rec = owners.list().records;
      expect(rec).toHaveLength(1);
      expect(rec[0]!.state).toBe("orphaned");
      expect(m.output("fake")).toBe("");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a stop that did stop it removes the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-owners-"));
    const owners = new OwnerStore(dir);
    const m = new ProcessManager(undefined, owners);
    managers.push(m);
    try {
      await m.ensure(app());
      await new Promise((r) => setTimeout(r, 400));
      expect(owners.list().records).toHaveLength(1);
      await m.stop("fake");
      expect(owners.list().records).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("no app is opened while the host is still settling the records of an earlier run", async () => {
    const m = manager();
    let release: () => void = () => undefined;
    m.gate = new Promise<void>((r) => { release = r; });
    let opened = false;
    const p = m.ensure(app()).then((x) => { opened = true; return x; });
    await new Promise((r) => setTimeout(r, 600));
    expect(opened).toBe(false);
    release();
    expect((await p).owned).toBe(true);
  });
});
