// @covers R-INSTALL-01, R-INSTALL-03
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimulatedCrash, installSelection, recoverInstalls, removeComponent, type InstallEnv } from "../src/core/componentInstaller";
import { verifiedCachedShas } from "../src/core/installStore";
import { CAD, CORE, LIBS, cleanWorlds, makeWorld, type Spec, type World } from "./helpers/installFixture";

// Findings of the Codex review of W3/W4 (2026-10-24), each with the case that showed it.
afterEach(cleanWorlds);

const dead: Pick<InstallEnv, "ownerAlive"> = { ownerAlive: () => false };
const read = (p: string) => fs.readFileSync(p, "utf8");
const at = (point: string, make: () => Error): NonNullable<InstallEnv["hooks"]> => ({ step: (s) => { if (s === point) throw make(); } });
async function run(w: World, specs: Spec[], select: string[] = [], env: InstallEnv = w.env) {
  const m = w.manifest(specs);
  return { r: await installSelection(env, m.manifest, m.sha, select), m };
}
const runFile = (w: World, v: string) => path.join(w.versionDir("fakeapp-core", v), "fakeapp-core-" + v, "bin", "run");
const NEW = (v = "1.2.0"): Spec => ({ ...CORE(v), files: { "bin/run": "changed bytes\n", "README.txt": "changed" } });

describe("a same-version update (a changed pin under the same version number) keeps the active folder until the new one is in place", () => {
  it("works: the new bytes are active, the record names the new pin, nothing is left over", async () => {
    const w = makeWorld();
    const first = await run(w, [CORE()]);
    expect(first.r.ok).toBe(true);
    const second = await run(w, [NEW()]);
    expect(second.r.ok).toBe(true);
    expect(read(runFile(w, "1.2.0"))).toBe("changed bytes\n");
    expect(w.state().installs[0].artifactSha256).toEqual(second.m.manifest.components[0]!.artifacts.map((a) => a.sha256));
    expect(w.leftovers()).toEqual([]);
  });
  it("a failure after the old folder was set aside puts it back whole", async () => {
    const w = makeWorld();
    await run(w, [CORE()]);
    const before = read(path.join(w.root, ".seed", "components.json"));
    const { r } = await run(w, [NEW()], [], w.with({ hooks: at("activating:moved", () => new Error("disk went away")) }));
    expect(r.ok).toBe(false);
    expect(read(runFile(w, "1.2.0"))).toBe("fakeapp-core 1.2.0\n");
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.state().installs[0].artifactSha256).toEqual(JSON.parse(before).installs[0].artifactSha256);
    expect(w.leftovers()).toEqual([]);
  });
  it("a host that dies after the move, with the pending record lost, comes back with the old folder and the old record", async () => {
    const w = makeWorld();
    await run(w, [CORE()]);
    const old = w.state().installs[0].artifactSha256;
    await expect(run(w, [NEW()], [], w.with({ hooks: at("activating:moved", () => new SimulatedCrash("x")) }))).rejects.toBeInstanceOf(SimulatedCrash);
    expect(read(runFile(w, "1.2.0"))).toBe("changed bytes\n");
    // the record of the switch is lost
    const staging = path.join(w.root, ".seed", "staging");
    for (const n of fs.readdirSync(staging)) fs.rmSync(path.join(staging, n, "installed.json"), { force: true });
    expect((await recoverInstalls(w.with(dead))).ok).toBe(true);
    expect(read(runFile(w, "1.2.0"))).toBe("fakeapp-core 1.2.0\n");
    expect(w.state().installs[0].artifactSha256).toEqual(old);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.leftovers()).toEqual([]);
  });
});

describe("a removal that fails after the files were moved to the trash", () => {
  it("puts the files back, keeps the record, and recovery does not delete anything", async () => {
    const w = makeWorld();
    const { m } = await run(w, [CORE(), LIBS(), CAD()], ["fake-cad"]);
    // the pointer can not be removed: a folder stands where the file should be
    const pointer = path.join(w.root, ".seed", "active", "fakeapp", "fake-cad");
    fs.rmSync(pointer);
    fs.mkdirSync(pointer);
    fs.writeFileSync(path.join(pointer, "x"), "x");
    const r = await removeComponent(w.env, m.manifest, "fakeapp", "fake-cad");
    expect(r.ok).toBe(false);
    expect(fs.existsSync(w.versionDir("fake-cad", "0.3.0"))).toBe(true);
    expect(w.state().installs.map((i: { component: string }) => i.component)).toContain("fake-cad");
    expect((await recoverInstalls(w.with(dead))).ok).toBe(true);
    expect(fs.existsSync(w.versionDir("fake-cad", "0.3.0"))).toBe(true);
    expect(w.state().installs.map((i: { component: string }) => i.component)).toContain("fake-cad");
  });
});

describe("pruning an older version", () => {
  it("is decided by the version folder under the root, never by a path in the state file", async () => {
    const w = makeWorld();
    await run(w, [CORE("1.2.0")]);
    await run(w, [CORE("1.3.0")]);
    const sibling = w.root + "-sibling";
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "keep.txt"), "not ours");
    const file = path.join(w.root, ".seed", "components.json");
    const st = JSON.parse(read(file));
    st.installs[0].previous.location = sibling; // starts with the root's name, but is not under it
    fs.writeFileSync(file, JSON.stringify(st));
    expect((await run(w, [CORE("1.4.0")])).r.ok).toBe(true);
    expect(read(path.join(sibling, "keep.txt"))).toBe("not ours");
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.2.0"))).toBe(false);
    fs.rmSync(sibling, { recursive: true, force: true });
  });
});

describe("the offline cache is counted by what is in it", () => {
  it("a file with a digest as its name but other content is not a hit", async () => {
    const w = makeWorld();
    const m = w.manifest([CORE()]);
    const a = m.manifest.components[0]!.artifacts[0]!;
    fs.mkdirSync(path.join(w.root, ".seed", "cache"), { recursive: true });
    const file = path.join(w.root, ".seed", "cache", a.sha256);
    fs.writeFileSync(file, "not the artifact");
    expect((await verifiedCachedShas(w.root)).has(a.sha256)).toBe(false);
    fs.writeFileSync(file, w.served.get(a.id)!);
    expect((await verifiedCachedShas(w.root)).has(a.sha256)).toBe(true);
  });
});

describe("a pointer that can not be read", () => {
  it("stops recovery of an unfinished install instead of being taken for 'no pointer'", async () => {
    const w = makeWorld();
    await run(w, [CORE("1.2.0")]);
    await expect(run(w, [CORE("1.3.0")], [], w.with({ hooks: at("activating:pointer", () => new SimulatedCrash("x")) }))).rejects.toBeInstanceOf(SimulatedCrash);
    const pointer = path.join(w.root, ".seed", "active", "fakeapp", "fakeapp-core");
    fs.rmSync(pointer);
    fs.mkdirSync(pointer); // reading a folder as a file fails with EISDIR, not ENOENT
    const r = await recoverInstalls(w.with(dead));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0]!.message).toMatch(/pointer of fakeapp-core could not be read/);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(true); // nothing was deleted on a guess
  });
});
