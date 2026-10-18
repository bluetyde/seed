// @covers R-INSTALL-01
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSelection, listInstalled, rollbackComponent } from "../src/core/componentInstaller";
import { validateInstallState } from "../src/core/components";
import { makeTarGz } from "./helpers/archives";
import { CAD, CORE, LIBS, cleanWorlds, linux, makeWorld, type Spec } from "./helpers/installFixture";

// The staged install (W4, acceptance R1-R3 and R6) against small fake artifacts: nothing is downloaded from anywhere and no engine is needed.
afterEach(cleanWorlds);

const SKIP_MODES = process.platform === "win32";
const full = [CORE(), LIBS(), CAD()];
async function install(w: ReturnType<typeof makeWorld>, specs: Spec[], select: string[] = [], env = w.env) {
  const m = w.manifest(specs);
  const r = await installSelection(env, m.manifest, m.sha, select);
  return { ...r, m };
}
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const read = (p: string) => fs.readFileSync(p, "utf8");

describe("a first install", () => {
  it("unpacks the core into <root>/<app>/<component>/<version>/<artifact>, flips the pointer, records it, and leaves no staging behind", async () => {
    const w = makeWorld();
    const r = await install(w, full);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toEqual([{ component: "fakeapp-core", action: "install", version: "1.2.0" }]);
    const dir = w.versionDir("fakeapp-core", "1.2.0");
    expect(read(path.join(dir, "fakeapp-core-1.2.0", "bin", "run"))).toBe("fakeapp-core 1.2.0\n");
    expect(read(path.join(dir, "fakeapp-core-1.2.0", "README.txt"))).toBe("fakeapp-core 1.2.0");
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    const rec = w.state().installs[0];
    expect(rec).toMatchObject({ app: "fakeapp", component: "fakeapp-core", version: "1.2.0", origin: "managed", location: dir, selectedByUser: true });
    expect(rec.manifestSha256).toBe(r.m.sha);
    expect(rec.artifactSha256).toEqual(r.m.manifest.components[0]!.artifacts.map((a) => a.sha256));
    expect(w.state().transaction).toMatchObject({ state: "ready", operation: "install", component: "fakeapp-core", to: "1.2.0" });
    expect(w.leftovers()).toEqual([]);
    expect(validateInstallState(w.state()).ok).toBe(true);
  });

  it("the install root's path has a space in it (R1), and so may a user's: nothing in the flow splits on it", async () => {
    const w = makeWorld({}, "SEED apps é 日本");
    expect((await install(w, full)).ok).toBe(true);
    expect(fs.existsSync(path.join(w.root, "fakeapp", "fakeapp-core", "1.2.0"))).toBe(true);
  });

  it("an add-on brings the libraries and the core it needs, dependencies first, and the library, which nobody chose, is marked as not chosen", async () => {
    const w = makeWorld();
    const r = await install(w, full, ["fake-cad"]);
    expect(r.ok && r.steps.map((s) => `${s.action}:${s.component}`)).toEqual(["install:fakeapp-core", "install:shared-libs", "install:fake-cad"]);
    const chosen = Object.fromEntries(w.state().installs.map((i: { component: string; selectedByUser: boolean }) => [i.component, i.selectedByUser]));
    expect(chosen).toEqual({ "fake-cad": true, "fakeapp-core": true, "shared-libs": false });
    expect(fs.existsSync(path.join(w.versionDir("fake-cad", "0.3.0"), "fake-cad-0.3.0", "bin", "run"))).toBe(true);
  });

  it.skipIf(SKIP_MODES)("an executable file stays executable", async () => {
    const w = makeWorld();
    await install(w, [{ ...CORE(), tarEntries: [{ name: "bin/run", data: "x", mode: 0o755 }, { name: "data.txt", data: "y" }] }]);
    expect(fs.statSync(path.join(w.versionDir("fakeapp-core", "1.2.0"), "fakeapp-core-1.2.0", "bin", "run")).mode & 0o111).not.toBe(0);
  });

  it("asking again installs nothing and downloads nothing; asking for the add-on later marks it chosen without touching files", async () => {
    const w = makeWorld();
    await install(w, full, ["fake-cad"]);
    const before = w.downloads.length;
    const marker = path.join(w.versionDir("fakeapp-core", "1.2.0"), "fakeapp-core-1.2.0", "marker");
    fs.writeFileSync(marker, "mine");
    const again = await install(w, full, ["fake-cad"]);
    expect(again.ok && again.steps.map((s) => s.action)).toEqual(["keep", "keep", "keep"]);
    expect(w.downloads.length).toBe(before);
    expect(read(marker)).toBe("mine");
  });

  it("an add-on chosen after the core: only what is new is fetched", async () => {
    const w = makeWorld();
    await install(w, full);
    w.downloads.length = 0;
    await install(w, full, ["fake-cad"]);
    expect(w.downloads.sort()).toEqual(["fake-cad-0.3.0", "shared-libs-2.0.0"]);
    expect(w.state().installs.map((i: { component: string }) => i.component).sort()).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
  });
});

describe("preflight (R1)", () => {
  it("a missing prerequisite stops the install before anything is fetched, and says which", async () => {
    const w = makeWorld({ prerequisites: (c) => (c.id === "fakeapp-core" ? "the WSL distro openmc-mcnp is not installed" : null) });
    const r = await install(w, full);
    expect(codes(r)).toEqual(["E_PREREQUISITE"]);
    expect(!r.ok && r.errors[0]!.message).toContain("openmc-mcnp");
    expect(w.downloads).toEqual([]);
    expect(w.state().installs).toEqual([]);
    expect(w.state().transaction).toMatchObject({ state: "failed" });
    expect(w.leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(w.root, "fakeapp"))).toBe(false);
  });
  it("not enough disk is refused with the numbers, before a byte is fetched", async () => {
    const w = makeWorld({ freeBytes: () => 10 });
    const r = await install(w, full);
    expect(codes(r)).toEqual(["E_DISK_SPACE"]);
    expect(w.downloads).toEqual([]);
  });
  it("a platform the component does not run on is refused by name", async () => {
    const w = makeWorld({ platform: { os: "macos", arch: "arm64" } });
    const r = await install(w, full);
    expect(codes(r)).toEqual(["E_COMPONENT_PLATFORM"]);
    expect(w.downloads).toEqual([]);
  });
  it("an app version the component does not work with is refused by name", async () => {
    const w = makeWorld({ appVersion: "1.5.0" });
    const r = await install(w, [{ ...CORE(), appVersions: { min: "2.0.0" } }]);
    expect(codes(r)).toEqual(["E_COMPONENT_APP_VERSION"]);
    expect(w.downloads).toEqual([]);
  });
});

describe("a damaged or hostile artifact (R2)", () => {
  it("a hash that does not match is refused and not kept in the cache", async () => {
    const w = makeWorld();
    const m = w.manifest([CORE()]);
    w.served.set("fakeapp-core-1.2.0", makeTarGz([{ name: "evil", data: "swapped on the server" }]));
    const r = await installSelection(w.env, m.manifest, m.sha, []);
    expect(codes(r)).toEqual(["E_HASH_MISMATCH"]);
    expect(fs.existsSync(path.join(w.root, ".seed", "cache"))).toBe(false);
    expect(w.state().installs).toEqual([]);
    expect(w.leftovers()).toEqual([]);
  });
  it("a size that does not match is refused", async () => {
    const w = makeWorld();
    const r = await install(w, [{ ...CORE(), downloadBytes: 5 }]);
    expect(codes(r)).toEqual(["E_HASH_MISMATCH"]);
    expect(!r.ok && r.errors[0]!.message).toMatch(/bytes/);
  });
  it("a source that delivers nothing, or fails, is a named failure and leaves nothing", async () => {
    const w = makeWorld({ source: async () => undefined });
    expect(codes(await install(w, [CORE()]))).toEqual(["E_ARTIFACT_MISSING"]);
    const w2 = makeWorld({ source: async () => { throw new Error("connection reset"); } });
    const r2 = await install(w2, [CORE()]);
    expect(codes(r2)).toEqual(["E_INSTALL_FAILED"]);
    expect(!r2.ok && r2.errors[0]!.message).toContain("connection reset");
    expect(w2.leftovers()).toEqual([]);
  });
  it("an archive that climbs out of its folder is refused even though its hash is the pinned one; nothing is written outside", async () => {
    const w = makeWorld();
    const r = await install(w, [{ ...CORE(), tarEntries: [{ name: "ok.txt", data: "fine" }, { name: "../../escaped.txt", data: "boo" }] }]);
    expect(codes(r)).toEqual(["E_ARCHIVE_UNSAFE"]);
    expect(!r.ok && r.errors[0]!.component).toBe("fakeapp-core");
    expect(fs.existsSync(path.join(w.base, "escaped.txt"))).toBe(false);
    expect(fs.existsSync(path.join(w.root, "escaped.txt"))).toBe(false);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.2.0"))).toBe(false);
    expect(w.state().installs).toEqual([]);
    expect(w.leftovers()).toEqual([]);
  });
  it("an archive that holds a link is refused", async () => {
    const w = makeWorld();
    const r = await install(w, [{ ...CORE(), tarEntries: [{ name: "link", type: "2", linkname: "/etc" }] }]);
    expect(codes(r)).toEqual(["E_ARCHIVE_UNSAFE"]);
  });
  it("an archive that expands to more than the manifest declares is refused", async () => {
    const w = makeWorld();
    const r = await install(w, [{ ...CORE(), files: { big: "x".repeat(5000) }, expandedBytes: 1000 }]);
    expect(codes(r)).toEqual(["E_ARCHIVE_TOO_LARGE"]);
    expect(w.leftovers()).toEqual([]);
  });
  it("a refused update leaves the version in use exactly as it was", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.2.0")]);
    const mark = path.join(w.versionDir("fakeapp-core", "1.2.0"), "fakeapp-core-1.2.0", "bin", "run");
    const r = await install(w, [{ ...CORE("1.3.0"), tarEntries: [{ name: "/abs/evil", data: "x" }] }]);
    expect(codes(r)).toEqual(["E_ARCHIVE_UNSAFE"]);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(read(mark)).toBe("fakeapp-core 1.2.0\n");
    expect(w.state().installs[0].version).toBe("1.2.0");
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(false);
    expect(w.leftovers()).toEqual([]);
  });
  it("what was completed before a failure stays installed and is listed", async () => {
    const w = makeWorld();
    const r = await install(w, [CORE(), LIBS(), CAD("0.3.0", { zipEntries: [{ name: "../out", data: "x" }] })], ["fake-cad"]);
    expect(codes(r)).toEqual(["E_ARCHIVE_UNSAFE"]);
    expect(!r.ok && r.completed.map((c) => c.component)).toEqual(["fakeapp-core", "shared-libs"]);
    expect(w.state().installs.map((i: { component: string }) => i.component).sort()).toEqual(["fakeapp-core", "shared-libs"]);
    expect(w.state().transaction).toMatchObject({ component: "fake-cad", state: "failed" });
  });
  it("a state file that is damaged is not replaced: the install is refused and the file stays", async () => {
    const w = makeWorld();
    await install(w, [CORE()]);
    const file = path.join(w.root, ".seed", "components.json");
    fs.writeFileSync(file, "{ this is not json");
    const r = await install(w, [CORE()]);
    expect(codes(r)).toEqual(["E_SCHEMA_INVALID"]);
    expect(read(file)).toBe("{ this is not json");
  });
});

describe("the offline cache (R6)", () => {
  async function populated() {
    const online = makeWorld();
    await install(online, full, ["fake-cad"]);
    return online;
  }
  it("an offline install from a complete cache works and fetches nothing", async () => {
    const online = await populated();
    const offline = makeWorld({ source: undefined });
    fs.cpSync(path.join(online.root, ".seed", "cache"), path.join(offline.root, ".seed", "cache"), { recursive: true });
    const m = online.manifest(full);
    const r = await installSelection(offline.env, m.manifest, m.sha, ["fake-cad"]);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(offline.versionDir("fake-cad", "0.3.0"), "fake-cad-0.3.0", "bin", "run"))).toBe(true);
  });
  it("an offline install with a missing artifact says which, before it changes anything", async () => {
    const w = makeWorld({ source: undefined });
    const r = await install(w, full, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_OFFLINE_MISSING"]);
    expect(!r.ok && r.errors[0]!.message).toContain("fakeapp-core/fakeapp-core-1.2.0");
    expect(fs.existsSync(path.join(w.root, "fakeapp"))).toBe(false);
    expect(w.state).toThrow(); // no state file was even written
  });
  it("what is installed already runs offline: nothing in the cache is needed to keep it", async () => {
    const w = await populated();
    const r = await install(w, full, ["fake-cad"], w.with({ source: undefined }));
    expect(r.ok && r.steps.every((s) => s.action === "keep")).toBe(true);
  });
  it("a cached copy that no longer matches its hash is deleted, never used", async () => {
    const online = await populated();
    const sha = online.manifest(full).manifest.components[0]!.artifacts[0]!.sha256;
    const offline = makeWorld({ source: undefined });
    fs.cpSync(path.join(online.root, ".seed", "cache"), path.join(offline.root, ".seed", "cache"), { recursive: true });
    const cached = path.join(offline.root, ".seed", "cache", sha);
    fs.appendFileSync(cached, "tampered");
    const m = online.manifest(full);
    const r = await installSelection(offline.env, m.manifest, m.sha, []);
    expect(codes(r)).toEqual(["E_HASH_MISMATCH"]);
    expect(fs.existsSync(cached)).toBe(false);
    expect(fs.existsSync(offline.versionDir("fakeapp-core", "1.2.0"))).toBe(false);
  });
  it("online, the same damaged cache entry is replaced by a fresh download", async () => {
    const online = await populated();
    const m = online.manifest(full);
    const sha = m.manifest.components[0]!.artifacts[0]!.sha256;
    const target = makeWorld();
    fs.cpSync(path.join(online.root, ".seed", "cache"), path.join(target.root, ".seed", "cache"), { recursive: true });
    fs.writeFileSync(path.join(target.root, ".seed", "cache", sha), "garbage");
    target.served.set("fakeapp-core-1.2.0", online.served.get("fakeapp-core-1.2.0")!);
    const r = await installSelection(target.env, m.manifest, m.sha, []);
    expect(r.ok).toBe(true);
    expect(target.downloads).toEqual(["fakeapp-core-1.2.0"]);
  });
  it("a second install of the same artifact reuses the cache without a download", async () => {
    const w = makeWorld();
    await install(w, [CORE()]);
    fs.rmSync(path.join(w.root, "fakeapp"), { recursive: true });
    fs.rmSync(path.join(w.root, ".seed", "components.json"));
    fs.rmSync(path.join(w.root, ".seed", "active"), { recursive: true });
    w.downloads.length = 0;
    expect((await install(w, [CORE()])).ok).toBe(true);
    expect(w.downloads).toEqual([]);
  });
});

describe("upgrade, health check and rollback (R3)", () => {
  it("an update keeps the version it replaced, and switches the pointer", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.2.0")]);
    const r = await install(w, [CORE("1.3.0")]);
    expect(r.ok && r.steps).toEqual([{ component: "fakeapp-core", action: "update", version: "1.3.0" }]);
    expect(w.pointer("fakeapp-core")).toBe("1.3.0");
    const rec = w.state().installs[0];
    expect(rec.version).toBe("1.3.0");
    expect(rec.previous).toMatchObject({ version: "1.2.0", location: w.versionDir("fakeapp-core", "1.2.0") });
    expect(read(path.join(w.versionDir("fakeapp-core", "1.2.0"), "fakeapp-core-1.2.0", "bin", "run"))).toBe("fakeapp-core 1.2.0\n");
    expect(read(path.join(w.versionDir("fakeapp-core", "1.3.0"), "fakeapp-core-1.3.0", "bin", "run"))).toBe("fakeapp-core 1.3.0\n");
  });
  it("a failed health check never switches the new version on: the old one stays active and nothing is left", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.2.0")]);
    const seen: string[] = [];
    const r = await install(w, [CORE("1.3.0")], [], w.with({ healthCheck: (dir) => { seen.push(dir); return "the smoke test did not start"; } }));
    expect(codes(r)).toEqual(["E_HEALTH_CHECK"]);
    expect(!r.ok && r.errors[0]!.message).toContain("smoke test");
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.state().installs[0].version).toBe("1.2.0");
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(false);
    expect(w.leftovers()).toEqual([]);
    // the check ran on the staged files, not on an empty folder
    expect(seen).toHaveLength(1);
  });
  it("the health check is given the unpacked files", async () => {
    const w = makeWorld();
    let listing: string[] = [];
    await install(w, [CORE()], [], w.with({ healthCheck: (dir) => { listing = fs.readdirSync(path.join(dir, "fakeapp-core-1.2.0")); return null; } }));
    expect(listing.sort()).toEqual(["README.txt", "bin"]);
  });
  it("an update is refused while a launch or job uses the component", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.2.0")]);
    const r = await install(w, [CORE("1.3.0")], [], w.with({ inUse: () => new Set(["fakeapp-core"]) }));
    expect(codes(r)).toEqual(["E_COMPONENT_IN_USE"]);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.downloads.filter((d) => d.includes("1.3.0"))).toEqual([]);
  });
  it("rollback switches back to the kept version with its record complete, and a second rollback goes forward again", async () => {
    const w = makeWorld();
    const first = await install(w, [CORE("1.2.0")]);
    const second = await install(w, [CORE("1.3.0")]);
    if (!first.ok || !second.ok) throw new Error("setup");
    const pinsOld = first.m.manifest.components[0]!.artifacts.map((a) => a.sha256);
    const pinsNew = second.m.manifest.components[0]!.artifacts.map((a) => a.sha256);
    const back = await rollbackComponent(w.env, second.m.manifest, "fakeapp-core");
    expect(back).toEqual({ ok: true, version: "1.2.0" });
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    let rec = w.state().installs[0];
    expect(rec).toMatchObject({ version: "1.2.0", manifestSha256: first.m.sha, artifactSha256: pinsOld, previous: { version: "1.3.0", manifestSha256: second.m.sha, artifactSha256: pinsNew } });
    expect(validateInstallState(w.state()).ok).toBe(true);
    const forward = await rollbackComponent(w.env, second.m.manifest, "fakeapp-core");
    expect(forward).toEqual({ ok: true, version: "1.3.0" });
    rec = w.state().installs[0];
    expect(rec.version).toBe("1.3.0");
    expect(w.leftovers()).toEqual([]);
  });
  it("rollback with nothing kept, with a job running, or with a failing health check changes nothing", async () => {
    const w = makeWorld();
    const first = await install(w, [CORE("1.2.0")]);
    if (!first.ok) throw new Error("setup");
    expect(codes(await rollbackComponent(w.env, first.m.manifest, "fakeapp-core"))).toEqual(["E_ARTIFACT_MISSING"]);
    const second = await install(w, [CORE("1.3.0")]);
    if (!second.ok) throw new Error("setup");
    expect(codes(await rollbackComponent(w.with({ inUse: () => new Set(["fakeapp-core"]) }), second.m.manifest, "fakeapp-core"))).toEqual(["E_COMPONENT_IN_USE"]);
    expect(codes(await rollbackComponent(w.with({ healthCheck: () => "broken" }), second.m.manifest, "fakeapp-core"))).toEqual(["E_HEALTH_CHECK"]);
    expect(codes(await rollbackComponent(w.env, second.m.manifest, "no-such-component"))).toEqual(["E_COMPONENT_UNKNOWN"]);
    expect(w.pointer("fakeapp-core")).toBe("1.3.0");
    expect(w.state().installs[0].version).toBe("1.3.0");
    expect(w.leftovers()).toEqual([]);
  });
  it("three versions in a row keep two: the one before the previous is deleted", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.0.0")]);
    await install(w, [CORE("1.1.0")]);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.0.0"))).toBe(true);
    await install(w, [CORE("1.2.0")]);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.0.0"))).toBe(false);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.1.0"))).toBe(true);
    expect(w.state().installs[0]).toMatchObject({ version: "1.2.0", previous: { version: "1.1.0" } });
  });
  it("a component SEED did not install is never replaced: the update is refused and its files stay", async () => {
    const w = makeWorld();
    const adopted = path.join(w.base, "somebody-elses-install");
    fs.mkdirSync(adopted, { recursive: true });
    fs.writeFileSync(path.join(adopted, "keep.txt"), "theirs");
    fs.mkdirSync(path.join(w.root, ".seed"), { recursive: true });
    fs.writeFileSync(path.join(w.root, ".seed", "components.json"), JSON.stringify({
      schema: "seed.install-state/0.1",
      installs: [{ app: "fakeapp", component: "fakeapp-core", version: "1.0.0", origin: "adopted", location: adopted, manifestSha256: "a".repeat(64), selectedByUser: true, installedAt: "2026-10-01T00:00:00Z" }]
    }));
    const r = await install(w, [CORE("1.2.0"), LIBS(), CAD("0.3.0", { dependsOn: [{ component: "fakeapp-core", min: "1.2.0" }] })], ["fake-cad"]);
    expect(codes(r)).toEqual(["E_ADOPTED_PROTECTED"]);
    expect(read(path.join(adopted, "keep.txt"))).toBe("theirs");
    expect(w.downloads).toEqual([]);
  });
});

describe("one installer at a time, and cancel", () => {
  it("a second install on the same root is told it is busy while the first runs, and works once it has finished", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inside = new Promise<void>((r) => { entered = r; });
    const w = makeWorld();
    const slow = w.with({ source: async (a, dest) => { entered(); await gate; fs.writeFileSync(dest, w.served.get(a.id)!); } });
    const m = w.manifest([CORE()]);
    const first = installSelection(slow, m.manifest, m.sha, []);
    await inside;
    const second = await installSelection(w.env, m.manifest, m.sha, []);
    expect(codes(second)).toEqual(["E_INSTALL_BUSY"]);
    release();
    expect((await first).ok).toBe(true);
    expect((await installSelection(w.env, m.manifest, m.sha, [])).ok).toBe(true);
  });
  it("cancelling during the download ends the transaction as cancelled and leaves nothing", async () => {
    const ac = new AbortController();
    const w = makeWorld({ source: (_a, _d, signal) => new Promise((_res, rej) => { signal?.addEventListener("abort", () => rej(new Error("aborted"))); setTimeout(() => ac.abort(), 20); }) });
    const m = w.manifest([CORE()]);
    const r = await installSelection(w.env, m.manifest, m.sha, [], { signal: ac.signal });
    expect(codes(r)).toEqual(["E_INSTALL_CANCELLED"]);
    expect(w.state().transaction).toMatchObject({ state: "cancelled" });
    expect(w.state().installs).toEqual([]);
    expect(w.leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(w.root, ".seed", "cache"))).toBe(false);
  });
  it("cancelling at the health check ends it cancelled, and the old version stays", async () => {
    const w = makeWorld();
    await install(w, [CORE("1.2.0")]);
    const ac = new AbortController();
    const m = w.manifest([CORE("1.3.0")]);
    const r = await installSelection(w.with({ healthCheck: () => { ac.abort(); return null; } }), m.manifest, m.sha, [], { signal: ac.signal });
    expect(codes(r)).toEqual(["E_INSTALL_CANCELLED"]);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.3.0"))).toBe(false);
  });
  it("a cancel that arrives once the switch has started does not stop it", async () => {
    const ac = new AbortController();
    const w = makeWorld({ hooks: { step: (s) => { if (s === "activating:moved") ac.abort(); } } });
    const m = w.manifest([CORE()]);
    const r = await installSelection(w.env, m.manifest, m.sha, [], { signal: ac.signal });
    expect(r.ok).toBe(true);
    expect(w.pointer("fakeapp-core")).toBe("1.2.0");
    expect(w.state().transaction).toMatchObject({ state: "ready" });
  });
});

describe("listInstalled", () => {
  it("reads the record without taking the lock", async () => {
    const w = makeWorld();
    await install(w, [CORE()]);
    const l = listInstalled(w.root);
    expect(l.ok && l.installs.map((i) => i.component)).toEqual(["fakeapp-core"]);
    expect(l.ok && l.transaction?.state).toBe("ready");
    expect(linux.os).toBe("linux");
  });
});
