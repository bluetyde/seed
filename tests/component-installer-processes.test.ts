// @covers R-INSTALL-04
// The installer with real processes (W4): several installers on one install root at once, and an installer that is killed in the middle of a
// download. These tests start dist/ code: run `npm run build` first.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSelection, recoverInstalls } from "../src/core/componentInstaller";
import { validateInstallState } from "../src/core/components";
import { CAD, CORE, LIBS, cleanWorlds, fixtureManifest, makeWorld } from "./helpers/installFixture";

vi.setConfig({ testTimeout: 120_000 });
const child = path.join(__dirname, "fixtures", "install-child.cjs");
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) { try { if (p.pid) process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
  cleanWorlds();
});

type Ran = { ok: boolean; errors?: { code: string }[]; steps?: { action: string }[]; tries: number };
function runChild(args: string[]): { proc: ChildProcess; done: Promise<Ran> } {
  const proc = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  procs.push(proc);
  let out = "", err = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (err += d));
  const done = new Promise<Ran>((resolve, reject) => {
    proc.on("close", (code) => {
      try { resolve(JSON.parse(out) as Ran); } catch { reject(new Error(`child exited ${code} with: ${out} ${err}`)); }
    });
  });
  return { proc, done };
}
function job(w: ReturnType<typeof makeWorld>, app: string, select: string[], name: string) {
  const m = fixtureManifest([CORE(), LIBS(), CAD()], w.served, app);
  const file = path.join(w.base, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ manifest: m.manifest, sha: m.sha, select }));
  return { file, ...m };
}
function artifacts(w: ReturnType<typeof makeWorld>) {
  const dir = path.join(w.base, "served");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, bytes] of w.served) fs.writeFileSync(path.join(dir, id), bytes);
  return dir;
}

describe("installers in separate processes", () => {
  it("six apps installing into one root at the same time: every one gets installed, none is lost from the record, nothing is left over", async () => {
    const w = makeWorld();
    const apps = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const jobs = apps.map((a) => job(w, a, ["fake-cad"], a));
    const dir = artifacts(w);
    const runs = jobs.map((j) => runChild([w.root, j.file, dir]));
    const results = await Promise.all(runs.map((r) => r.done));
    expect(results.map((r) => r.ok)).toEqual(apps.map(() => true));
    const st = JSON.parse(fs.readFileSync(path.join(w.root, ".seed", "components.json"), "utf8"));
    expect(validateInstallState(st).ok).toBe(true);
    const have = st.installs.map((i: { app: string; component: string }) => `${i.app}/${i.component}`).sort();
    expect(have).toEqual(apps.flatMap((a) => ["fake-cad", "fakeapp-core", "shared-libs"].map((c) => `${a}/${c}`)).sort());
    for (const a of apps) for (const c of ["fakeapp-core", "shared-libs"]) {
      expect(fs.readFileSync(path.join(w.root, ".seed", "active", a, c), "utf8").trim()).toBe(c === "fakeapp-core" ? "1.2.0" : "2.0.0");
    }
    expect(w.leftovers()).toEqual([]);
    // some of them had to wait for the lock, which is the point of the test
    expect(results.some((r) => r.tries > 1)).toBe(true);
  });

  it("four installers asking for the same thing: it is installed once and the others find it there", async () => {
    const w = makeWorld();
    const j = job(w, "fakeapp", ["fake-cad"], "same");
    const dir = artifacts(w);
    const results = await Promise.all([1, 2, 3, 4].map(() => runChild([w.root, j.file, dir]).done));
    expect(results.every((r) => r.ok)).toBe(true);
    const actions = results.flatMap((r) => r.steps ?? []).map((s) => s.action);
    expect(actions.filter((a) => a === "install")).toHaveLength(3);
    expect(actions.filter((a) => a === "keep")).toHaveLength(9);
    expect(w.state().installs).toHaveLength(3);
    expect(w.leftovers()).toEqual([]);
  });

  it("an installer killed in the middle of a download: the next one takes the lock over, settles the unfinished install and completes", async () => {
    const w = makeWorld();
    const j = job(w, "fakeapp", [], "killed");
    const dir = artifacts(w);
    const ready = path.join(w.base, "ready.txt");
    const { proc, done } = runChild([w.root, j.file, dir, "hang", ready]);
    const settled = done.catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(ready)).toBe(true);
    const tx = w.state().transaction;
    expect(tx).toMatchObject({ state: "staging", component: "fakeapp-core", owner: { pid: proc.pid } });
    process.kill(proc.pid!, "SIGKILL");
    await settled;
    // the lock folder and the staging folder of the dead process are still there
    expect(fs.existsSync(path.join(w.root, ".seed", "lock"))).toBe(true);
    expect(w.leftovers().length).toBe(1);
    // nothing is told to the installer about the death: it finds out by the pid and its start identity
    const r = await installSelection({ ...w.env, lock: { waitMs: 5000 } }, j.manifest, j.sha, []);
    expect(r.ok).toBe(true);
    expect(w.leftovers()).toEqual([]);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.state().installs).toHaveLength(1);
    expect(w.state().transaction).toMatchObject({ state: "ready" });
  });

  it("the same death, settled at startup by recoverInstalls alone", async () => {
    const w = makeWorld();
    const j = job(w, "fakeapp", [], "killed2");
    const dir = artifacts(w);
    const ready = path.join(w.base, "ready2.txt");
    const { proc, done } = runChild([w.root, j.file, dir, "hang", ready]);
    const settled = done.catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    process.kill(proc.pid!, "SIGKILL");
    await settled;
    const r = await recoverInstalls({ ...w.env, lock: { waitMs: 5000 } });
    expect(r.ok && r.report).toMatchObject({ component: "fakeapp-core", was: "staging", now: "interrupted" });
    expect(w.leftovers()).toEqual([]);
    expect(w.pointer("fakeapp-core")).toBeNull();
    expect(w.state().installs).toEqual([]);
  });
});
