// @covers R-PROC-01, R-SHELL-07
// W3 (runtime contract, "Process ownership"; plan 11 acceptance R4 and R5): the process-owner records, the start identity of a process, and the recovery that a
// restarted host runs. The rules are tested with fake identities; the two acceptance cases run real processes: a fake host that is killed from outside, and a
// server it only attached to. These tests start dist/ code: run `npm run build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverOwners, type RecoveryDeps, type Worker } from "../src/core/ownerRecovery";
import { OwnerStore, type OwnerRecord } from "../src/core/ownerStore";
import { identityOf, identityOfStrict, linuxIdentity } from "../src/core/processIdentity";
import { freePort } from "../src/main/processes";
import type { ProcessIdentity } from "../src/core/components";

const fakeApp = join(__dirname, "fixtures", "fake-app.cjs");
const fakeHost = join(__dirname, "fixtures", "fake-host.cjs");

const dirs: string[] = [];
const procs: ChildProcess[] = [];
const servers: http.Server[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "seed-owner-")); dirs.push(d); return d; };
afterEach(async () => {
  for (const p of procs.splice(0)) { try { if (p.pid) process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hex = (n: number) => n.toString(16).padStart(32, "0");
const ident = (pid: number, s = `id-${pid}`): ProcessIdentity => ({ pid, startIdentity: s });
const record = (n: number, over: Partial<OwnerRecord> = {}): OwnerRecord => ({
  schema: "seed.process-owner/0.1", launchId: hex(n), kind: "launch", runtime: { component: "fake", version: "0.0.0" }, supervisor: "seed",
  host: ident(1000 + n), worker: { via: "native", identity: ident(2000 + n) }, endpoint: "http://127.0.0.1:5000", generation: hex(900 + n), state: "running",
  startedAt: "2026-10-12T10:00:00.000Z", ...over,
});

describe("the owner store", () => {
  it("writes, reads, marks and removes a record, and lists them in order", () => {
    const s = new OwnerStore(tmp());
    s.write(record(2)); s.write(record(1));
    expect(s.list().records.map((r) => r.launchId)).toEqual([hex(1), hex(2)]);
    expect(s.mark(hex(1), "stopping")?.state).toBe("stopping");
    expect(s.read(hex(1))?.state).toBe("stopping");
    s.remove(hex(1)); s.remove(hex(1));
    expect(s.read(hex(1))).toBeNull();
    expect(s.mark(hex(1), "running")).toBeNull();
  });

  it("refuses a record that does not match the schema and writes nothing", () => {
    const dir = tmp();
    const s = new OwnerStore(dir);
    expect(() => s.write({ ...record(1), state: "flying" } as unknown as OwnerRecord)).toThrow(/refused/);
    expect(() => s.write({ ...record(1), launchId: "not-hex" })).toThrow();
    expect(s.list().records).toEqual([]);
  });

  it("reports a file that is not a valid record, and never trusts it", () => {
    const dir = tmp();
    const s = new OwnerStore(dir);
    s.write(record(1));
    writeFileSync(join(dir, `${hex(2)}.json`), "{ not json");
    writeFileSync(join(dir, `${hex(3)}.json`), JSON.stringify({ ...record(3), state: "flying" }));
    writeFileSync(join(dir, `${hex(4)}.json`), JSON.stringify(record(5)));
    const l = s.list();
    expect(l.records.map((r) => r.launchId)).toEqual([hex(1)]);
    expect(l.unreadable.map((u) => u.file).sort()).toEqual([`${hex(2)}.json`, `${hex(3)}.json`, `${hex(4)}.json`]);
    expect(l.unreadable.find((u) => u.file.startsWith(hex(4)))?.reason).toMatch(/does not match the file name/);
  });
});

describe("the start identity of a process", () => {
  it("is stable for a running process, differs between two processes, and is null for a process that is not there", async () => {
    const a = await identityOf(process.pid);
    expect(a).not.toBeNull();
    expect(await identityOf(process.pid)).toEqual(a);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    procs.push(child);
    const b = await identityOf(child.pid!);
    expect(b).not.toBeNull();
    expect(b!.startIdentity).not.toBe(a!.startIdentity);
    expect(await identityOf(2147483000)).toBeNull();
    expect(await identityOf(0)).toBeNull();
  });

  it("the strict lookup agrees with the plain one for a running process, answers null for one that is not there", async () => {
    const mine = await identityOf(process.pid);
    expect(await identityOfStrict(process.pid)).toEqual(mine);
    expect(await identityOfStrict(0)).toBeNull();
    const gone = spawnSync(process.execPath, ["-e", "0"]);
    expect(await identityOfStrict(gone.pid ?? 0)).toBeNull();
  });
  it("reads field 22 of a Linux stat line even when the command name holds spaces and parentheses", () => {
    const tail = (n: string) => `S 1 1 1 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${n} 12345678 100 18446744073709551615`;
    expect(linuxIdentity(`42 (node) ${tail("987654")}`, "boot-a\n")).toBe("linux:boot-a:987654");
    expect(linuxIdentity(`42 (my (odd) name) ${tail("555")}`, "boot-a")).toBe("linux:boot-a:555");
    expect(linuxIdentity("garbage", "boot-a")).toBeNull();
    expect(linuxIdentity(`42 (node) ${tail("x")}`, "boot-a")).toBeNull();
    expect(linuxIdentity(`42 (node) ${tail("1")}`, "  ")).toBeNull();
  });
});

describe("recovery rules (fake identities)", () => {
  // alive: pid -> the identity the process has now; gone: absent
  const world = (alive: Record<number, string>, hosts: Record<number, string> = {}) => {
    const killed: number[] = [];
    const deps: RecoveryDeps = {
      workerIdentity: async (w: Worker) => (alive[w.identity.pid] ? ident(w.identity.pid, alive[w.identity.pid]) : null),
      hostIdentity: async (pid) => (hosts[pid] ? ident(pid, hosts[pid]) : null),
      killWorker: async (w) => { killed.push(w.identity.pid); delete alive[w.identity.pid]; },
    };
    return { deps, killed };
  };
  const run = async (recs: OwnerRecord[], w: ReturnType<typeof world>) => {
    const s = new OwnerStore(tmp());
    recs.forEach((r) => s.write(r));
    return { s, report: await recoverOwners(s, w.deps, { settleMs: 1 }) };
  };

  it("stops a worker whose host is gone when the pid and the start identity both match, and removes the record", async () => {
    const w = world({ 2001: "id-2001" });
    const { s, report } = await run([record(1)], w);
    expect(report.results).toEqual([{ launchId: hex(1), outcome: "terminated", pid: 2001 }]);
    expect(w.killed).toEqual([2001]);
    expect(s.list().records).toEqual([]);
  });

  it("does not stop a process that now holds the recorded pid but started at another time (a reused pid): the record is stale", async () => {
    const w = world({ 2001: "id-OTHER" });
    const { s, report } = await run([record(1)], w);
    expect(report.results[0]).toMatchObject({ outcome: "stale-identity", pid: 2001 });
    expect(report.results[0]!.detail).toMatch(/left running/);
    expect(w.killed).toEqual([]);
    expect(s.list().records).toEqual([]);
  });

  it("leaves the records of a host that is still running alone, even when its worker looks like the recorded one", async () => {
    const w = world({ 2001: "id-2001" }, { 1001: "id-1001" });
    const { s, report } = await run([record(1)], w);
    expect(report.results).toEqual([{ launchId: hex(1), outcome: "host-alive", pid: 1001 }]);
    expect(w.killed).toEqual([]);
    expect(s.list().records).toHaveLength(1);
  });

  it("treats a host pid that was reused by another process as a dead host", async () => {
    const w = world({ 2001: "id-2001" }, { 1001: "id-SOMEONE-ELSE" });
    const { report } = await run([record(1)], w);
    expect(report.results[0]!.outcome).toBe("terminated");
  });

  it("never stops a worker that its app supervises itself", async () => {
    const w = world({ 2001: "id-2001" });
    const { s, report } = await run([record(1, { supervisor: "standalone" })], w);
    expect(report.results[0]!.outcome).toBe("standalone");
    expect(w.killed).toEqual([]);
    expect(s.list().records).toHaveLength(1);
  });

  it("a worker that is already gone, or never started, only clears the record", async () => {
    const w = world({});
    const { s, report } = await run([record(1), (() => { const r = record(2); delete r.worker; return r; })()], w);
    expect(report.results.map((r) => r.outcome)).toEqual(["already-gone", "no-worker"]);
    expect(s.list().records).toEqual([]);
  });

  it("a worker that survives the stop keeps its record, marked orphaned, and is reported", async () => {
    const alive: Record<number, string> = { 2001: "id-2001" };
    const deps: RecoveryDeps = { workerIdentity: async (x) => ident(x.identity.pid, alive[x.identity.pid]!), hostIdentity: async () => null, killWorker: async () => { /* does not work */ } };
    const s = new OwnerStore(tmp());
    s.write(record(1));
    const report = await recoverOwners(s, deps, { settleMs: 1 });
    expect(report.results[0]).toMatchObject({ outcome: "kill-failed", pid: 2001 });
    expect(s.read(hex(1))?.state).toBe("orphaned");
  });

  it("one record that cannot be settled does not stop the others, and a stopped record is cleared", async () => {
    const w = world({ 2002: "id-2002" });
    const seen = w.deps.workerIdentity;
    w.deps.workerIdentity = async (x) => { if (x.identity.pid === 2001) throw new Error("boom"); return seen(x); };
    const { s, report } = await run([record(1), record(2), record(3, { state: "stopped" })], w);
    expect(report.results.map((r) => r.outcome)).toEqual(["kill-failed", "terminated"]);
    expect(report.results[0]!.detail).toMatch(/boom/);
    expect(s.list().records.map((r) => r.launchId)).toEqual([hex(1)]);
  });

  it("a lookup that fails is not an answer: the record stays, nothing is stopped, and it is reported", async () => {
    const killed: number[] = [];
    const deps: RecoveryDeps = { workerIdentity: async () => ident(2001), hostIdentity: async () => { throw new Error("powershell timed out"); }, killWorker: async (x) => { killed.push(x.identity.pid); } };
    const s = new OwnerStore(tmp());
    s.write(record(1));
    const report = await recoverOwners(s, deps, { settleMs: 1 });
    expect(report.results[0]).toMatchObject({ outcome: "kill-failed" });
    expect(report.results[0]!.detail).toMatch(/powershell timed out/);
    expect(killed).toEqual([]);
    expect(s.read(hex(1))?.state).toBe("running");
  });

  it("a stop that throws after the record was marked stopping leaves it orphaned, not stopping", async () => {
    const deps: RecoveryDeps = { workerIdentity: async (x) => ident(x.identity.pid), hostIdentity: async () => null, killWorker: async () => { throw new Error("taskkill failed"); } };
    const s = new OwnerStore(tmp());
    s.write(record(1));
    const report = await recoverOwners(s, deps, { settleMs: 1 });
    expect(report.results[0]).toMatchObject({ outcome: "kill-failed" });
    expect(s.read(hex(1))?.state).toBe("orphaned");
  });

  it("a worker that ended between the first look and the stop is not signalled", async () => {
    const killed: number[] = [];
    let looks = 0;
    const deps: RecoveryDeps = { workerIdentity: async (x) => (++looks === 1 ? ident(x.identity.pid) : null), hostIdentity: async () => null, killWorker: async (x) => { killed.push(x.identity.pid); } };
    const s = new OwnerStore(tmp());
    s.write(record(1));
    const report = await recoverOwners(s, deps, { settleMs: 1 });
    expect(report.results[0]).toMatchObject({ outcome: "already-gone" });
    expect(killed).toEqual([]);
    expect(s.list().records).toEqual([]);
  });

  it("a WSL worker record without a distro is not a valid record (it would have been looked up and stopped as a native process)", () => {
    const s = new OwnerStore(tmp());
    expect(() => s.write(record(1, { worker: { via: "wsl", identity: ident(2001) } }))).toThrow(/refused/);
    expect(() => s.write(record(1, { worker: { via: "wsl", distro: "Ubuntu", identity: ident(2001) } }))).not.toThrow();
  });

  it("a record file that can not be removed is an error, not a removed record", () => {
    const dir = tmp();
    const s = new OwnerStore(dir);
    s.write(record(1));
    rmSync(join(dir, `${hex(1)}.json`));
    mkdirSync(join(dir, `${hex(1)}.json`)); // a folder stands where the file was: unlink fails with EPERM or EISDIR, not ENOENT
    expect(() => s.remove(hex(1))).toThrow();
  });

  it("a startIdentity that is empty authorizes nothing", async () => {
    const w = world({ 2001: "" });
    const { report } = await run([record(1, { worker: { via: "native", identity: ident(2001, "x") } })], w);
    expect(w.killed).toEqual([]);
    expect(report.results[0]!.outcome).not.toBe("terminated");
  });

  it("reports the files it could not read", async () => {
    const dir = tmp();
    writeFileSync(join(dir, `${hex(9)}.json`), "nope");
    const report = await recoverOwners(new OwnerStore(dir), world({}).deps, { settleMs: 1 });
    expect(report.unreadable).toHaveLength(1);
  });
});

// ---- acceptance with real processes -------------------------------------------------------------------------------------------------------------------

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const alive = async (id: ProcessIdentity) => { const now = await identityOf(id.pid); return now !== null && now.startIdentity === id.startIdentity; };
const forceKill = (pid: number) => { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore" }); else process.kill(pid, "SIGKILL"); };
const sleeper = () => { const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); procs.push(c); return c; };
const answers = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).status; } catch { return 0; } };

async function startFakeHost(ownersDir: string, appExtra: Record<string, unknown>) {
  const app = { id: "fake", name: "Fake", icon: "app", healthPath: "/health", urlPath: "/?token={token}", startTimeoutMs: 15000, ...appExtra,
    ...(appExtra.attachUrl ? {} : { start: { command: process.execPath, args: [fakeApp, "--port", "{port}"] } }) };
  const host = spawn(process.execPath, [fakeHost, JSON.stringify({ ownersDir, app })], { stdio: ["ignore", "pipe", "pipe"] });
  procs.push(host);
  let out = "";
  host.stdout!.on("data", (b) => { out += b; });
  host.stderr!.on("data", (b) => { out += b; });
  const ready = await waitFor(() => out.includes("READY") || out.includes("FAILED"), 30000);
  if (!ready || !out.includes("READY")) throw new Error(`the fake host did not become ready: ${out}`);
  return { host, info: JSON.parse(out.slice(out.indexOf("READY") + 6).split("\n")[0]!) as { pid: number; url: string; owned: boolean } };
}

describe("acceptance R4: a host that is killed from outside", () => {
  it("leaves its server running (the problem), and the next start stops that server and nothing else", async () => {
    const dir = tmp();
    const store = new OwnerStore(dir);
    const sibling = sleeper(); // an unrelated process of the same kind: it must survive
    const siblingId = (await identityOf(sibling.pid!))!;
    const { host, info } = await startFakeHost(dir, {});
    expect(info.owned).toBe(true);

    // the record is there, says running, and names the server's pid with its start identity
    await waitFor(() => store.list().records[0]?.state === "running");
    const [rec] = store.list().records;
    expect(rec).toMatchObject({ state: "running", supervisor: "seed", kind: "launch", host: { pid: host.pid } });
    expect(rec!.worker!.identity.pid).not.toBe(host.pid);
    const workerId = rec!.worker!.identity;
    expect(await alive(workerId)).toBe(true);
    const url = `http://127.0.0.1:${new URL(info.url).port}/health`;
    expect(await answers(url)).toBe(200);

    forceKill(host.pid!);
    await waitFor(async () => !(await alive(rec!.host)));
    // the premise of R4: nothing stopped the server when the host died
    expect(await alive(workerId)).toBe(true);

    const report = await recoverOwners(store);
    expect(report.results.map((r) => r.outcome)).toEqual(["terminated"]);
    expect(await alive(workerId)).toBe(false);
    expect(await answers(url)).toBe(0);
    expect(await alive(siblingId)).toBe(true);
    expect(store.list().records).toEqual([]);
  }, 90000);

  it("a clean stop removes the record, so there is nothing to recover", async () => {
    const dir = tmp();
    const store = new OwnerStore(dir);
    const { ProcessManager } = await import("../src/main/processes");
    const pm = new ProcessManager(undefined, store);
    const running = await pm.ensure({ id: "fake", name: "Fake", icon: "app", healthPath: "/health", urlPath: "/", startTimeoutMs: 15000, start: { command: process.execPath, args: [fakeApp, "--port", "{port}"] } });
    expect(await waitFor(() => store.list().records[0]?.state === "running")).toBe(true);
    expect(running.owned).toBe(true);
    await pm.stop("fake");
    expect(store.list().records).toEqual([]);
  }, 60000);
});

describe("acceptance R5: what the host did not start, and records that are old", () => {
  it("a server the host only attached to has no record and survives the host being killed and the recovery", async () => {
    const dir = tmp();
    const store = new OwnerStore(dir);
    const port = await freePort();
    const server = spawn(process.execPath, [fakeApp, "--port", String(port)], { stdio: "ignore" });
    procs.push(server);
    const serverId = (await (async () => { await waitFor(async () => (await answers(`http://127.0.0.1:${port}/health`)) === 200); return identityOf(server.pid!); })())!;
    const { host, info } = await startFakeHost(dir, { attachUrl: `http://127.0.0.1:${port}` });
    expect(info.owned).toBe(false);
    expect(store.list().records).toEqual([]);
    forceKill(host.pid!);
    const report = await recoverOwners(store);
    expect(report.results).toEqual([]);
    expect(await alive(serverId)).toBe(true);
    expect(await answers(`http://127.0.0.1:${port}/health`)).toBe(200);
  }, 90000);

  it("a record whose pid now belongs to an unrelated process does not stop it", async () => {
    const dir = tmp();
    const store = new OwnerStore(dir);
    const stranger = sleeper();
    const strangerId = (await identityOf(stranger.pid!))!;
    // the record says a worker with this pid started long ago; the process under that pid now started later
    store.write(record(7, { host: { pid: 2147483000, startIdentity: "gone" }, worker: { via: "native", identity: { pid: stranger.pid!, startIdentity: strangerId.startIdentity.replace(/.$/, (c) => (c === "0" ? "1" : "0")) } } }));
    const report = await recoverOwners(store);
    expect(report.results.map((r) => r.outcome)).toEqual(["stale-identity"]);
    expect(await alive(strangerId)).toBe(true);
  }, 60000);
});
