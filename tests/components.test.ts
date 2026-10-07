import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canTransition,
  compareVersions,
  isTerminal,
  mayActOn,
  planRemoval,
  recoverTransaction,
  resolveSelection,
  validateInstallState,
  validateManifest,
  validateProcessOwner,
  type Installed,
  type Manifest,
  type Platform,
  type Transaction,
  type TxState
} from "../src/core/components";

const raw = () => JSON.parse(readFileSync(join(__dirname, "fixtures/runtime/fake-manifest.json"), "utf8"));
const manifest = (): Manifest => {
  const v = validateManifest(raw());
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.manifest;
};
const linux: Platform = { os: "linux", arch: "x64" };
const win: Platform = { os: "windows", arch: "x64", via: "wsl" };
const rec = (component: string, version: string, over: Partial<Installed> = {}): Installed => ({
  app: "fakeapp", component, version, origin: "managed", location: `/seed/${component}/${version}`,
  manifestSha256: "a".repeat(64), selectedByUser: false, installedAt: "2026-10-07T00:00:00Z", ...over
});
const coreOnly = [rec("fakeapp-core", "1.2.0", { selectedByUser: true })];
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const ids = (r: ReturnType<typeof resolveSelection>) => (r.ok ? r.steps.map((s) => `${s.action}:${s.component}`) : []);

describe("versions", () => {
  it.each([["1.2.0", "1.2.0", 0], ["1.2.0", "1.10.0", -1], ["2.0.0", "1.99.99", 1], ["0.0.1", "0.0.2", -1]])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("the manifest", () => {
  it("the fixture is valid, and every example listed is readable", () => {
    expect(validateManifest(raw()).ok).toBe(true);
  });

  const mutate = (f: (m: any) => void) => {
    const m = raw();
    f(m);
    return validateManifest(m);
  };
  it.each([
    ["an unknown schema version", (m: any) => (m.schema = "seed.component-manifest/0.2"), "E_SCHEMA_INVALID"],
    ["a field the contract does not have", (m: any) => (m.components[0].installCommand = "rm -rf /"), "E_SCHEMA_INVALID"],
    ["a component with no platform", (m: any) => (m.components[0].platforms = []), "E_SCHEMA_INVALID"],
    ["a version that is not three numbers", (m: any) => (m.components[0].version = "1.2"), "E_SCHEMA_INVALID"],
    ["a version with a leading zero", (m: any) => (m.components[0].version = "01.2.0"), "E_SCHEMA_INVALID"],
    ["a hash of the wrong length", (m: any) => (m.components[0].artifacts[0].sha256 = "abc"), "E_SCHEMA_INVALID"],
    ["a plain http download", (m: any) => (m.components[0].artifacts[0].url = "http://example.invalid/x.tgz"), "E_SCHEMA_INVALID"],
    ["a negative size", (m: any) => (m.components[0].artifacts[0].downloadBytes = -1), "E_SCHEMA_INVALID"],
    ["an id with a capital or a space", (m: any) => (m.components[1].id = "Shared libs"), "E_SCHEMA_INVALID"],
    ["a component listed twice", (m: any) => m.components.push(structuredClone(m.components[1])), "E_SCHEMA_INVALID"],
    ["no core component", (m: any) => (m.components[0].kind = "addon"), "E_COMPONENT_CORE"],
    ["a dependency the manifest does not list", (m: any) => (m.components[2].dependsOn[1].component = "nowhere"), "E_COMPONENT_DEPENDENCY"],
    ["a dependency version the manifest cannot supply", (m: any) => (m.components[2].dependsOn[1].min = "3.0.0"), "E_COMPONENT_DEPENDENCY"],
    ["a core that needs an add-on", (m: any) => (m.components[0].dependsOn = [{ component: "fake-cad" }]), "E_COMPONENT_DEPENDENCY"],
    ["a component that depends on itself", (m: any) => (m.components[2].dependsOn = [{ component: "fake-cad" }]), "E_COMPONENT_CYCLE"],
    ["a dependency cycle", (m: any) => (m.components[1].dependsOn = [{ component: "fake-cad" }]), "E_COMPONENT_CYCLE"],
    ["a conflict with an unknown component", (m: any) => (m.components[3].conflicts = ["ghost"]), "E_COMPONENT_UNKNOWN"],
    ["app versions with min above max", (m: any) => (m.components[2].appVersions = { min: "2.0.0", max: "1.0.0" }), "E_COMPONENT_APP_VERSION"],
    ["an artifact listed twice in one component", (m: any) => m.components[0].artifacts.push(structuredClone(m.components[0].artifacts[0])), "E_SCHEMA_INVALID"],
    ["an archive that expands to less than it downloads", (m: any) => (m.components[0].artifacts[0].expandedBytes = 10), "E_SCHEMA_INVALID"]
  ])("%s is refused (%s)", (_name, f, code) => {
    const r = mutate(f as (m: any) => void);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });

  it("a cycle error names the loop", () => {
    const r = mutate((m: any) => (m.components[1].dependsOn = [{ component: "fake-cad" }]));
    expect(r.ok ? "" : r.errors.find((e) => e.code === "E_COMPONENT_CYCLE")!.message).toMatch(/fake-cad -> shared-libs -> fake-cad|shared-libs -> fake-cad -> shared-libs/);
  });

  it.each([null, [], "text", 5])("%j is refused without a crash", (v) => {
    expect(validateManifest(v).ok).toBe(false);
  });
});

describe("choosing what to install", () => {
  it("a core-only install brings the core and the libraries it needs and nothing optional", () => {
    const r = resolveSelection({ manifest: manifest(), installed: [], select: [], platform: linux, appVersion: "1.5.0" });
    expect(ids(r)).toEqual(["install:fakeapp-core"]);
    if (r.ok) expect(r.cost).toEqual({ downloadBytes: 1000, expandedBytes: 3000 });
  });

  it("an add-on pulls its dependencies in, dependencies first, and the cost counts only what is new", () => {
    const r = resolveSelection({ manifest: manifest(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0" });
    expect(ids(r)).toEqual(["keep:fakeapp-core", "install:shared-libs", "install:fake-cad"]);
    if (r.ok) {
      expect(r.cost).toEqual({ downloadBytes: 45000, expandedBytes: 180000 });
      expect(r.steps.map((s) => s.selectedByUser)).toEqual([true, false, true]);
    }
  });

  it("the same selection gives the same plan in any order of the list", () => {
    const a = resolveSelection({ manifest: manifest(), installed: [], select: ["fake-cad", "fake-nodal"], platform: linux, appVersion: "1.5.0" });
    const b = resolveSelection({ manifest: manifest(), installed: [], select: ["fake-nodal", "fake-cad"], platform: linux, appVersion: "1.5.0" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a library cannot be chosen, and an unknown name is refused", () => {
    expect(codes(resolveSelection({ manifest: manifest(), installed: [], select: ["shared-libs"], platform: linux, appVersion: "1.5.0" }))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
    expect(codes(resolveSelection({ manifest: manifest(), installed: [], select: ["nope"], platform: linux, appVersion: "1.5.0" }))).toEqual(["E_COMPONENT_UNKNOWN"]);
    expect(codes(resolveSelection({ manifest: manifest(), installed: [], select: ["constructor"], platform: linux, appVersion: "1.5.0" }))).toEqual(["E_COMPONENT_UNKNOWN"]);
  });

  it("an add-on that is not available for this platform is refused by name; the core still installs without it", () => {
    const mac: Platform = { os: "macos", arch: "arm64" };
    const r = resolveSelection({ manifest: manifest(), installed: [], select: ["fake-cad"], platform: mac, appVersion: "1.5.0" });
    expect(codes(r)).toEqual(["E_COMPONENT_PLATFORM"]);
    if (!r.ok) expect(r.errors[0]!.component).toBe("fake-cad");
    expect(resolveSelection({ manifest: manifest(), installed: [], select: [], platform: mac, appVersion: "1.5.0" }).ok).toBe(true);
  });

  it("the way the app runs matters: a component built for WSL is not offered for a native Windows run", () => {
    const m = raw();
    m.components[2].platforms = [{ os: "windows", arch: "x64", via: "wsl" }];
    const v = validateManifest(m);
    if (!v.ok) throw new Error("fixture");
    expect(codes(resolveSelection({ manifest: v.manifest, installed: [], select: ["fake-cad"], platform: { os: "windows", arch: "x64", via: "native" }, appVersion: "1.5.0" }))).toContain("E_COMPONENT_PLATFORM");
    expect(resolveSelection({ manifest: v.manifest, installed: [], select: ["fake-cad"], platform: win, appVersion: "1.5.0" }).ok).toBe(true);
  });

  it.each([["1.0.0", "E_COMPONENT_APP_VERSION"], ["1.1.0", null], ["1.9.0", null], ["1.9.1", "E_COMPONENT_APP_VERSION"], ["2.0.0", "E_COMPONENT_APP_VERSION"]])("app version %s against 1.1.0 to 1.9.0 gives %s", (appVersion, code) => {
    const r = resolveSelection({ manifest: manifest(), installed: [], select: ["fake-cad"], platform: linux, appVersion });
    if (code === null) expect(r.ok).toBe(true);
    else expect(codes(r)).toContain(code);
  });

  it("conflicting add-ons are refused, whether both are chosen or one is already installed", () => {
    expect(codes(resolveSelection({ manifest: manifest(), installed: [], select: ["fake-nodal", "fake-legacy"], platform: linux, appVersion: "1.5.0" }))).toContain("E_COMPONENT_CONFLICT");
    const have = [...coreOnly, rec("fake-legacy", "0.9.0", { selectedByUser: true })];
    expect(codes(resolveSelection({ manifest: manifest(), installed: have, select: ["fake-nodal"], platform: linux, appVersion: "1.5.0" }))).toContain("E_COMPONENT_CONFLICT");
  });

  it("what is installed at the same or a newer version is kept and costs nothing", () => {
    const have = [...coreOnly, rec("shared-libs", "2.1.0"), rec("fake-cad", "0.3.0", { selectedByUser: true })];
    const r = resolveSelection({ manifest: manifest(), installed: have, select: ["fake-cad"], platform: linux, appVersion: "1.5.0" });
    expect(ids(r)).toEqual(["keep:fakeapp-core", "keep:shared-libs", "keep:fake-cad"]);
    if (r.ok) expect(r.cost).toEqual({ downloadBytes: 0, expandedBytes: 0 });
  });

  it("an older managed version is updated", () => {
    const have = [rec("fakeapp-core", "1.0.0", { selectedByUser: true })];
    const r = resolveSelection({ manifest: manifest(), installed: have, select: [], platform: linux, appVersion: "1.5.0" });
    expect(r.ok && r.steps[0]).toMatchObject({ action: "update", from: "1.0.0", to: "1.2.0" });
  });

  it("an adopted component is never replaced: kept when good enough, refused when a newer one is needed", () => {
    const adopted = (v: string) => [...coreOnly, rec("shared-libs", v, { origin: "adopted" })];
    expect(ids(resolveSelection({ manifest: manifest(), installed: adopted("2.0.0"), select: ["fake-cad"], platform: linux, appVersion: "1.5.0" }))).toContain("keep:shared-libs");
    const older = resolveSelection({ manifest: manifest(), installed: adopted("1.5.0"), select: ["fake-cad"], platform: linux, appVersion: "1.5.0" });
    expect(codes(older)).toEqual(["E_ADOPTED_PROTECTED"]);
  });

  it("an adopted component older than the manifest but with no stated need is kept, not replaced", () => {
    const adopted = [...coreOnly, rec("shared-libs", "1.0.0", { origin: "adopted" })];
    const r = resolveSelection({ manifest: manifest(), installed: adopted, select: ["fake-nodal"], platform: linux, appVersion: "1.5.0" });
    expect(ids(r)).toContain("keep:shared-libs");
  });

  describe("offline and disk", () => {
    const m = () => manifest();
    it("everything cached: no download is needed, and the disk cost is still counted", () => {
      const cache = new Set(["1", "2", "3"].map((d) => d.repeat(64)));
      const r = resolveSelection({ manifest: m(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0", cache, offline: true });
      expect(r.ok && r.cost).toEqual({ downloadBytes: 0, expandedBytes: 180000 });
    });
    it("something missing from the cache while offline is refused and names it", () => {
      const cache = new Set(["2".repeat(64)]);
      const r = resolveSelection({ manifest: m(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0", cache, offline: true });
      expect(codes(r)).toEqual(["E_OFFLINE_MISSING"]);
      if (!r.ok) expect(r.errors[0]!.message).toContain("fake-cad/cad-pack");
    });
    it("online, a missing cache entry is just a download", () => {
      expect(resolveSelection({ manifest: m(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0", cache: new Set() }).ok).toBe(true);
    });
    it("too little free space is refused before anything is staged", () => {
      expect(codes(resolveSelection({ manifest: m(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0", freeBytes: 179999 }))).toEqual(["E_DISK_SPACE"]);
      expect(resolveSelection({ manifest: m(), installed: coreOnly, select: ["fake-cad"], platform: linux, appVersion: "1.5.0", freeBytes: 180000 }).ok).toBe(true);
    });
  });

  it("an unvalidated manifest with a missing dependency is an error, not a crash", () => {
    const m = raw();
    m.components[2].dependsOn[1].component = "nowhere";
    expect(codes(resolveSelection({ manifest: m, installed: [], select: ["fake-cad"], platform: linux, appVersion: "1.5.0" }))).toEqual(["E_COMPONENT_DEPENDENCY"]);
  });
});

describe("removing an add-on", () => {
  const both = [...coreOnly, rec("shared-libs", "2.0.0"), rec("fake-cad", "0.3.0", { selectedByUser: true }), rec("fake-nodal", "0.1.0", { selectedByUser: true })];

  it("removes the add-on, keeps a library another add-on still needs, and says why", () => {
    const r = planRemoval({ manifest: manifest(), installed: both, remove: "fake-cad" });
    expect(r).toEqual({ ok: true, steps: [{ component: "fake-cad", action: "remove" }], kept: [{ component: "shared-libs", neededBy: ["fake-nodal"] }] });
  });

  it("removes a library only SEED added when nothing else needs it any more", () => {
    const only = [...coreOnly, rec("shared-libs", "2.0.0"), rec("fake-cad", "0.3.0", { selectedByUser: true })];
    const r = planRemoval({ manifest: manifest(), installed: only, remove: "fake-cad" });
    expect(r.ok && r.steps).toEqual([{ component: "fake-cad", action: "remove" }, { component: "shared-libs", action: "remove" }]);
  });

  it("keeps a library the user chose to keep or had before", () => {
    const only = [...coreOnly, rec("shared-libs", "2.0.0", { selectedByUser: true }), rec("fake-cad", "0.3.0", { selectedByUser: true })];
    const r = planRemoval({ manifest: manifest(), installed: only, remove: "fake-cad" });
    expect(r.ok && r.steps).toEqual([{ component: "fake-cad", action: "remove" }]);
  });

  it("never deletes an adopted component: it is only unregistered", () => {
    const only = [...coreOnly, rec("shared-libs", "2.0.0", { origin: "adopted" }), rec("fake-cad", "0.3.0", { selectedByUser: true, origin: "adopted" })];
    const r = planRemoval({ manifest: manifest(), installed: only, remove: "fake-cad" });
    expect(r.ok && r.steps).toEqual([{ component: "fake-cad", action: "remove" }].map(() => ({ component: "fake-cad", action: "unregister" })));
  });

  it("refuses to remove what another installed component needs", () => {
    const m = raw();
    m.components.push({ ...structuredClone(m.components[3]), id: "fake-extra", version: "0.1.0", conflicts: [], dependsOn: [{ component: "fake-nodal" }], capabilities: [] });
    const v = validateManifest(m);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    const have = [...both, rec("fake-extra", "0.1.0", { selectedByUser: true })];
    const r = planRemoval({ manifest: v.manifest, installed: have, remove: "fake-nodal" });
    expect(codes(r)).toEqual(["E_COMPONENT_REQUIRED_BY"]);
    if (!r.ok) expect(r.errors[0]!.message).toContain("fake-extra");
  });

  it("is deferred while a launch or job uses the add-on or a library that would go with it", () => {
    expect(codes(planRemoval({ manifest: manifest(), installed: both, remove: "fake-cad", inUse: new Set(["fake-cad"]) }))).toEqual(["E_COMPONENT_IN_USE"]);
    const only = [...coreOnly, rec("shared-libs", "2.0.0"), rec("fake-cad", "0.3.0", { selectedByUser: true })];
    expect(codes(planRemoval({ manifest: manifest(), installed: only, remove: "fake-cad", inUse: new Set(["shared-libs"]) }))).toEqual(["E_COMPONENT_IN_USE"]);
    expect(planRemoval({ manifest: manifest(), installed: both, remove: "fake-cad", inUse: new Set(["fake-nodal"]) }).ok).toBe(true);
  });

  it("the core and a library cannot be removed on their own; an unknown or uninstalled name is refused", () => {
    expect(codes(planRemoval({ manifest: manifest(), installed: both, remove: "fakeapp-core" }))).toEqual(["E_COMPONENT_CORE"]);
    expect(codes(planRemoval({ manifest: manifest(), installed: both, remove: "shared-libs" }))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
    expect(codes(planRemoval({ manifest: manifest(), installed: coreOnly, remove: "fake-cad" }))).toEqual(["E_COMPONENT_UNKNOWN"]);
    expect(codes(planRemoval({ manifest: manifest(), installed: both, remove: "constructor" }))).toEqual(["E_COMPONENT_UNKNOWN"]);
  });

  it("another app's installed component of the same name is not touched", () => {
    const other = [...both, rec("fake-cad", "9.9.9", { app: "otherapp" })];
    const r = planRemoval({ manifest: manifest(), installed: other, remove: "fake-cad" });
    expect(r.ok && r.steps.map((s) => s.component)).toEqual(["fake-cad"]);
  });
});

describe("the transaction states", () => {
  const all: TxState[] = ["queued", "preflight", "staging", "verifying", "activating", "ready", "removing", "removed", "cancelled", "failed", "interrupted"];
  const installEdges = [
    ["queued", "preflight"], ["queued", "cancelled"], ["preflight", "staging"], ["preflight", "failed"], ["preflight", "cancelled"],
    ["staging", "verifying"], ["staging", "failed"], ["staging", "cancelled"], ["staging", "interrupted"],
    ["verifying", "activating"], ["verifying", "failed"], ["verifying", "cancelled"], ["verifying", "interrupted"],
    ["activating", "ready"], ["activating", "failed"], ["activating", "interrupted"]
  ];
  const removeEdges = [["queued", "preflight"], ["queued", "cancelled"], ["preflight", "removing"], ["preflight", "failed"], ["preflight", "cancelled"], ["removing", "removed"], ["removing", "failed"], ["removing", "interrupted"]];

  it("an install or update moves only along its edges: every other pair is refused", () => {
    for (const from of all) for (const to of all) {
      const expected = installEdges.some(([a, b]) => a === from && b === to);
      expect(canTransition("install", from, to), `${from} -> ${to}`).toBe(expected);
      expect(canTransition("update", from, to), `update ${from} -> ${to}`).toBe(expected);
    }
  });

  it("a removal moves only along its edges", () => {
    for (const from of all) for (const to of all) {
      expect(canTransition("remove", from, to), `${from} -> ${to}`).toBe(removeEdges.some(([a, b]) => a === from && b === to));
    }
  });

  it("there is no cancel once the switch of the active version has begun", () => {
    expect(canTransition("install", "activating", "cancelled")).toBe(false);
  });

  it("terminal states have no way out", () => {
    for (const s of ["ready", "removed", "cancelled", "failed", "interrupted"] as TxState[]) {
      expect(isTerminal(s)).toBe(true);
      for (const to of all) expect(canTransition("install", s, to) || canTransition("remove", s, to)).toBe(false);
    }
    for (const s of ["queued", "preflight", "staging", "verifying", "activating", "removing"] as TxState[]) expect(isTerminal(s)).toBe(false);
  });
});

describe("what to make of a transaction found at startup", () => {
  const tx = (state: TxState, over: Partial<Transaction> = {}): Transaction => ({
    id: "a".repeat(32), operation: "update", app: "fakeapp", component: "fake-cad", from: "0.2.0", to: "0.3.0", state, startedAt: "2026-10-07T00:00:00Z", ...over
  });

  it("a live owner is left alone", () => {
    expect(recoverTransaction(tx("staging"), { ownerAlive: true, activeVersion: "0.2.0" })).toEqual({ state: "staging", action: "wait", active: "0.2.0" });
  });
  it.each(["staging", "verifying"] as TxState[])("%s with a dead owner is interrupted, the half-staged version is discarded and the old one stays active", (state) => {
    expect(recoverTransaction(tx(state), { ownerAlive: false, activeVersion: "0.2.0" })).toEqual({ state: "interrupted", action: "discard-staging", active: "0.2.0" });
  });
  it.each(["queued", "preflight"] as TxState[])("%s with a dead owner is interrupted with nothing to clean", (state) => {
    expect(recoverTransaction(tx(state), { ownerAlive: false, activeVersion: "0.2.0" })).toMatchObject({ state: "interrupted", action: "none", active: "0.2.0" });
  });
  it("activating, with the new version already the active one, is ready: the file system decides, not the record", () => {
    expect(recoverTransaction(tx("activating"), { ownerAlive: false, activeVersion: "0.3.0" })).toEqual({ state: "ready", action: "mark-ready", active: "0.3.0" });
  });
  it("activating, with the old version still active, is interrupted and rolled back", () => {
    expect(recoverTransaction(tx("activating"), { ownerAlive: false, activeVersion: "0.2.0" })).toEqual({ state: "interrupted", action: "discard-staging", active: "0.2.0" });
  });
  it("a first install interrupted has no previous version to keep", () => {
    expect(recoverTransaction(tx("staging", { operation: "install", from: undefined }), { ownerAlive: false })).toEqual({ state: "interrupted", action: "discard-staging" });
  });
  it("a removal whose files are gone is removed; one whose files remain is kept installed", () => {
    expect(recoverTransaction(tx("removing", { operation: "remove", to: undefined }), { ownerAlive: false, present: false })).toEqual({ state: "removed", action: "mark-removed" });
    expect(recoverTransaction(tx("removing", { operation: "remove", to: undefined }), { ownerAlive: false, present: true, activeVersion: "0.2.0" })).toEqual({ state: "interrupted", action: "keep-installed", active: "0.2.0" });
  });
  it.each(["ready", "removed", "cancelled", "failed", "interrupted"] as TxState[])("%s is already settled and unchanged", (state) => {
    expect(recoverTransaction(tx(state), { ownerAlive: false }).action).toBe("none");
  });
});

describe("process identity", () => {
  const a = { pid: 4242, startIdentity: "win:133700000000000000" };
  it("acts only on the very process that was recorded", () => {
    expect(mayActOn(a, { ...a })).toBe(true);
  });
  it("a reused pid with another start time authorizes nothing", () => {
    expect(mayActOn(a, { pid: 4242, startIdentity: "win:133800000000000000" })).toBe(false);
  });
  it("a different pid, a gone process, and a missing identity authorize nothing", () => {
    expect(mayActOn(a, { pid: 4243, startIdentity: a.startIdentity })).toBe(false);
    expect(mayActOn(a, null)).toBe(false);
    expect(mayActOn({ pid: 4242, startIdentity: "" }, { pid: 4242, startIdentity: "" })).toBe(false);
  });
});

describe("the install-state and process-owner records", () => {
  const good = () => ({
    schema: "seed.install-state/0.1",
    installs: [{ app: "fakeapp", component: "fakeapp-core", version: "1.2.0", origin: "managed", location: "fakeapp/1.2.0", manifestSha256: "a".repeat(64), selectedByUser: true, installedAt: "2026-10-07T00:00:00Z" }]
  });
  const owner = () => ({
    schema: "seed.process-owner/0.1", launchId: "b".repeat(32), kind: "launch", runtime: { component: "fakeapp-core", version: "1.2.0" }, supervisor: "seed",
    host: { pid: 100, startIdentity: "x" }, worker: { via: "wsl", distro: "Ubuntu", identity: { pid: 7, startIdentity: "y" } },
    endpoint: "http://127.0.0.1:8765/", generation: "c".repeat(32), state: "running", startedAt: "2026-10-07T00:00:00Z"
  });

  it("valid records pass", () => {
    expect(validateInstallState(good()).ok).toBe(true);
    expect(validateProcessOwner(owner()).ok).toBe(true);
  });

  it.each([
    ["a component recorded twice", (s: any) => s.installs.push(structuredClone(s.installs[0])), "E_SCHEMA_INVALID"],
    ["an origin that is neither managed nor adopted", (s: any) => (s.installs[0].origin = "found"), "E_SCHEMA_INVALID"],
    ["a transaction with a state of the other operation", (s: any) => (s.transaction = { id: "d".repeat(32), operation: "remove", app: "fakeapp", component: "fake-cad", from: "0.3.0", state: "staging", startedAt: "2026-10-07T00:00:00Z" }), "E_SCHEMA_INVALID"],
    ["an install with no target version", (s: any) => (s.transaction = { id: "d".repeat(32), operation: "install", app: "fakeapp", component: "fake-cad", state: "staging", startedAt: "2026-10-07T00:00:00Z" }), "E_SCHEMA_INVALID"],
    ["an update with no version it replaces", (s: any) => (s.transaction = { id: "d".repeat(32), operation: "update", app: "fakeapp", component: "fake-cad", to: "0.3.0", state: "staging", startedAt: "2026-10-07T00:00:00Z" }), "E_SCHEMA_INVALID"],
    ["an unknown field", (s: any) => (s.installs[0].command = "x"), "E_SCHEMA_INVALID"]
  ])("%s is refused", (_n, f, code) => {
    const s = good();
    (f as (s: any) => void)(s);
    const r = validateInstallState(s);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });

  it("an owner record without a start identity, or with an endpoint off this machine, is refused", () => {
    const a = owner();
    delete (a.host as any).startIdentity;
    expect(validateProcessOwner(a).ok).toBe(false);
    expect(validateProcessOwner({ ...owner(), endpoint: "http://example.com:80/" }).ok).toBe(false);
    expect(validateProcessOwner({ ...owner(), endpoint: "http://127.0.0.1.evil.example:80/" }).ok).toBe(false);
    expect(validateProcessOwner({ ...owner(), supervisor: "somebody" }).ok).toBe(false);
  });
});
