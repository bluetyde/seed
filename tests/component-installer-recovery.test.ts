// @covers R-INSTALL-03
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimulatedCrash, installSelection, recoverInstalls, removeComponent, type InstallEnv } from "../src/core/componentInstaller";
import { validateInstallState } from "../src/core/components";
import { CAD, CORE, LIBS, cleanWorlds, makeWorld, type Spec, type World } from "./helpers/installFixture";

// A host that dies at any step of an install, an update or a removal is settled from the record and from what is on disk (R2 interrupted,
// R3): the active version is whole, or the new one is, and never a mixture.
afterEach(cleanWorlds);

const dead: Pick<InstallEnv, "ownerAlive"> = { ownerAlive: () => false };
const crashAt = (point: string): NonNullable<InstallEnv["hooks"]> => ({ step: (s) => { if (s === point) throw new SimulatedCrash(point); } });
const read = (p: string) => fs.readFileSync(p, "utf8");
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));

async function run(w: World, specs: Spec[], select: string[] = [], env: InstallEnv = w.env) {
  const m = w.manifest(specs);
  return { r: await installSelection(env, m.manifest, m.sha, select), m };
}

/** What must hold after any recovery: the record, the pointer and the folders agree, and nothing is left over. */
function consistent(w: World, component: string) {
  expect(w.leftovers()).toEqual([]);
  const st = w.state();
  expect(validateInstallState(st).ok).toBe(true);
  const rec = st.installs.find((i: { component: string }) => i.component === component);
  if (!rec) {
    expect(w.pointer(component)).toBeNull();
    expect(fs.existsSync(path.join(w.root, "fakeapp", component))).toBe(false);
    return null;
  }
  expect(w.pointer(component)).toBe(rec.version);
  expect(fs.existsSync(rec.location)).toBe(true);
  const kept = [rec.version, rec.previous?.version].filter(Boolean).sort();
  expect(fs.readdirSync(path.join(w.root, "fakeapp", component)).sort()).toEqual(kept);
  expect(read(path.join(rec.location, `${component}-${rec.version}`, "bin", "run"))).toBe(`${component} ${rec.version}\n`);
  return rec as { version: string; previous?: { version: string } };
}

const BEFORE_SWITCH = ["preflight", "staging", "staged:fakeapp-core-1.3.0", "verifying", "activating", "activating:moved"];
const AFTER_SWITCH = ["activating:pointer", "activating:record"];

describe("a host that dies during an update", () => {
  for (const point of BEFORE_SWITCH) {
    it(`at ${point}: the old version is still the active one, whole, and the retry completes`, async () => {
      const w = makeWorld();
      await run(w, [CORE("1.2.0")]);
      await expect(run(w, [CORE("1.3.0")], [], w.with({ hooks: crashAt(point) }))).rejects.toBeInstanceOf(SimulatedCrash);
      const rec = await recoverInstalls(w.with(dead));
      expect(rec.ok && rec.report).toMatchObject({ component: "fakeapp-core", now: "interrupted" });
      const after = consistent(w, "fakeapp-core");
      expect(after?.version).toBe("1.2.0");
      expect(w.state().transaction).toMatchObject({ state: "interrupted" });
      expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(false);
      // and the update can simply be asked for again
      const again = await run(w, [CORE("1.3.0")], [], w.with(dead));
      expect(again.r.ok).toBe(true);
      expect(consistent(w, "fakeapp-core")?.version).toBe("1.3.0");
    });
  }
  for (const point of AFTER_SWITCH) {
    it(`at ${point}: the pointer already names the new version, so the new version is the active one, recorded from what staging kept`, async () => {
      const w = makeWorld();
      await run(w, [CORE("1.2.0")]);
      await expect(run(w, [CORE("1.3.0")], [], w.with({ hooks: crashAt(point) }))).rejects.toBeInstanceOf(SimulatedCrash);
      const rec = await recoverInstalls(w.with(dead));
      expect(rec.ok && rec.report).toMatchObject({ component: "fakeapp-core", now: "ready", action: "mark-ready" });
      const after = consistent(w, "fakeapp-core");
      expect(after).toMatchObject({ version: "1.3.0", previous: { version: "1.2.0" } });
      expect(w.state().transaction).toMatchObject({ state: "ready" });
    });
  }
});

describe("a host that dies during a first install", () => {
  for (const point of ["preflight", "staging", "staged:fakeapp-core-1.2.0", "verifying", "activating", "activating:moved"]) {
    it(`at ${point}: nothing is installed, nothing is left, the retry works`, async () => {
      const w = makeWorld();
      await expect(run(w, [CORE()], [], w.with({ hooks: crashAt(point) }))).rejects.toBeInstanceOf(SimulatedCrash);
      await recoverInstalls(w.with(dead));
      expect(consistent(w, "fakeapp-core")).toBeNull();
      expect((await run(w, [CORE()], [], w.with(dead))).r.ok).toBe(true);
      expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
    });
  }
  for (const point of AFTER_SWITCH) {
    it(`at ${point}: the install counts as done`, async () => {
      const w = makeWorld();
      await expect(run(w, [CORE()], [], w.with({ hooks: crashAt(point) }))).rejects.toBeInstanceOf(SimulatedCrash);
      await recoverInstalls(w.with(dead));
      expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
      expect(w.state().installs[0]).toMatchObject({ origin: "managed", selectedByUser: true });
    });
  }
  it("the cache survives a crash: the retry downloads nothing", async () => {
    const w = makeWorld();
    await expect(run(w, [CORE()], [], w.with({ hooks: crashAt("verifying") }))).rejects.toBeInstanceOf(SimulatedCrash);
    await recoverInstalls(w.with(dead));
    w.downloads.length = 0;
    expect((await run(w, [CORE()], [], w.with(dead))).r.ok).toBe(true);
    expect(w.downloads).toEqual([]);
  });
});

describe("settling an unfinished transaction", () => {
  it("is done by the next install on its own, without a separate call", async () => {
    const w = makeWorld();
    await expect(run(w, [CORE()], [], w.with({ hooks: crashAt("staging") }))).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await run(w, [CORE()], [], w.with(dead))).r.ok).toBe(true);
    expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
  });
  it("waits while the process that started it is still running, and says so", async () => {
    const w = makeWorld();
    await expect(run(w, [CORE()], [], w.with({ hooks: crashAt("staging") }))).rejects.toBeInstanceOf(SimulatedCrash);
    const alive = await recoverInstalls(w.with({ ownerAlive: () => true }));
    expect(codes(alive)).toEqual(["E_INSTALL_BUSY"]);
    const install = await run(w, [CORE()], [], w.with({ ownerAlive: () => true }));
    expect(codes(install.r)).toEqual(["E_INSTALL_BUSY"]);
    expect(w.state().transaction).toMatchObject({ state: "preflight" }); // it stopped before the step named
  });
  it("asks the system whether the recorded owner is still the same process: a pid that is gone is dead", async () => {
    const w = makeWorld();
    await expect(run(w, [CORE()], [], w.with({ hooks: crashAt("staging") }))).rejects.toBeInstanceOf(SimulatedCrash);
    const st = w.state();
    st.transaction.owner = { pid: 2147480000, startIdentity: "a process that never existed" };
    fs.writeFileSync(path.join(w.root, ".seed", "components.json"), JSON.stringify(st));
    const r = await recoverInstalls(w.env); // the default check
    expect(r.ok && r.report.now).toBe("interrupted");
    expect(w.leftovers()).toEqual([]);
  });
  it("this very process counts as alive for a transaction it owns, a different start identity of the same pid does not", async () => {
    const w = makeWorld();
    await expect(run(w, [CORE()], [], w.with({ hooks: crashAt("staging") }))).rejects.toBeInstanceOf(SimulatedCrash);
    const mine = await recoverInstalls(w.env);
    expect(codes(mine)).toEqual(["E_INSTALL_BUSY"]);
    const st = w.state();
    st.transaction.owner = { pid: process.pid, startIdentity: "the pid was reused by another process" };
    fs.writeFileSync(path.join(w.root, ".seed", "components.json"), JSON.stringify(st));
    const reused = await recoverInstalls(w.env);
    expect(reused.ok && reused.report.now).toBe("interrupted");
  });
  it("deletes staging and trash folders that belong to no transaction", async () => {
    const w = makeWorld();
    await run(w, [CORE()]);
    fs.mkdirSync(path.join(w.root, ".seed", "staging", "0123456789abcdef0123456789abcdef", "junk"), { recursive: true });
    fs.mkdirSync(path.join(w.root, ".seed", "trash", "fedcba9876543210fedcba9876543210"), { recursive: true });
    await recoverInstalls(w.env);
    expect(w.leftovers()).toEqual([]);
    expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
  });
  it("a settled state with nothing wrong is left as it is", async () => {
    const w = makeWorld();
    await run(w, [CORE()]);
    const before = read(path.join(w.root, ".seed", "components.json"));
    const r = await recoverInstalls(w.env);
    expect(r).toEqual({ ok: true, report: {} });
    expect(read(path.join(w.root, ".seed", "components.json"))).toBe(before);
  });
  it("a version folder that nothing refers to, left by a crash after the move, is removed", async () => {
    const w = makeWorld();
    await run(w, [CORE("1.2.0")]);
    await expect(run(w, [CORE("1.3.0")], [], w.with({ hooks: crashAt("activating:moved") }))).rejects.toBeInstanceOf(SimulatedCrash);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(true); // it was moved into place, the pointer was not flipped
    await recoverInstalls(w.with(dead));
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(false);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
  });
});

describe("removal", () => {
  const specs = [CORE(), LIBS(), CAD()];
  async function withCad() {
    const w = makeWorld();
    const { m } = await run(w, specs, ["fake-cad"]);
    fs.mkdirSync(path.join(w.root, "projects"), { recursive: true });
    fs.writeFileSync(path.join(w.root, "projects", "my-model.json"), "the user's model");
    return { w, m };
  }
  it("removes the add-on and the libraries that came only with it, keeps the core, and never touches anything else under the root", async () => {
    const { w, m } = await withCad();
    const r = await removeComponent(w.env, m.manifest, "fakeapp", "fake-cad");
    expect(r.ok && r.removed.sort()).toEqual(["fake-cad", "shared-libs"]);
    expect(fs.existsSync(path.join(w.root, "fakeapp", "fake-cad"))).toBe(false);
    expect(fs.existsSync(path.join(w.root, "fakeapp", "shared-libs"))).toBe(false);
    expect(w.pointer("fake-cad")).toBeNull();
    expect(w.state().installs.map((i: { component: string }) => i.component)).toEqual(["fakeapp-core"]);
    expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
    expect(read(path.join(w.root, "projects", "my-model.json"))).toBe("the user's model");
    expect(w.state().transaction).toMatchObject({ operation: "remove", state: "removed" });
  });
  it("is refused for the core, for a library on its own, and while a job uses the add-on; nothing changes", async () => {
    const { w, m } = await withCad();
    const before = read(path.join(w.root, ".seed", "components.json"));
    expect(codes(await removeComponent(w.env, m.manifest, "fakeapp", "fakeapp-core"))).toHaveLength(1);
    expect(codes(await removeComponent(w.env, m.manifest, "fakeapp", "shared-libs"))).toHaveLength(1);
    expect(codes(await removeComponent(w.with({ inUse: () => new Set(["fake-cad"]) }), m.manifest, "fakeapp", "fake-cad"))).toEqual(["E_COMPONENT_IN_USE"]);
    expect(codes(await removeComponent(w.env, m.manifest, "fakeapp", "nope"))).toHaveLength(1);
    expect(read(path.join(w.root, ".seed", "components.json"))).toBe(before);
    expect(fs.existsSync(w.versionDir("fake-cad", "0.3.0"))).toBe(true);
  });
  it("an adopted component is unregistered and its files stay", async () => {
    const w = makeWorld();
    const { m } = await run(w, [CORE(), LIBS(), CAD("0.3.0", { dependsOn: [{ component: "fakeapp-core", min: "1.2.0" }] })], ["fake-cad"]);
    const theirs = path.join(w.base, "their-cad");
    fs.mkdirSync(theirs);
    fs.writeFileSync(path.join(theirs, "keep.txt"), "theirs");
    const st = w.state();
    const cad = st.installs.find((i: { component: string }) => i.component === "fake-cad");
    Object.assign(cad, { origin: "adopted", location: theirs });
    fs.writeFileSync(path.join(w.root, ".seed", "components.json"), JSON.stringify(st));
    fs.rmSync(path.join(w.root, "fakeapp", "fake-cad"), { recursive: true });
    const r = await removeComponent(w.env, m.manifest, "fakeapp", "fake-cad");
    expect(r.ok && r.unregistered).toContain("fake-cad");
    expect(read(path.join(theirs, "keep.txt"))).toBe("theirs");
    expect(w.state().installs.map((i: { component: string }) => i.component)).not.toContain("fake-cad");
  });
  for (const point of ["removing", "removing:moved", "removing:record"]) {
    it(`a host that dies at ${point} is settled: either still installed whole, or removed completely`, async () => {
      const { w, m } = await withCad();
      await expect(removeComponent(w.with({ hooks: crashAt(point) }), m.manifest, "fakeapp", "fake-cad")).rejects.toBeInstanceOf(SimulatedCrash);
      const rec = await recoverInstalls(w.with(dead));
      expect(rec.ok).toBe(true);
      expect(w.leftovers()).toEqual([]);
      const installed = w.state().installs.map((i: { component: string }) => i.component);
      if (point === "removing") {
        expect(installed).toContain("fake-cad");
        expect(fs.existsSync(w.versionDir("fake-cad", "0.3.0"))).toBe(true);
        expect(w.pointer("fake-cad")).toBe("0.3.0");
        expect(w.state().transaction).toMatchObject({ state: "interrupted" });
      } else {
        expect(installed).not.toContain("fake-cad");
        expect(fs.existsSync(path.join(w.root, "fakeapp", "fake-cad"))).toBe(false);
        expect(w.pointer("fake-cad")).toBeNull();
        expect(w.state().transaction).toMatchObject({ state: "removed" });
      }
      expect(consistent(w, "fakeapp-core")?.version).toBe("1.2.0");
      expect(read(path.join(w.root, "projects", "my-model.json"))).toBe("the user's model");
    });
  }
});
