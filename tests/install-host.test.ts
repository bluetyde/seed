// @covers R-INSTALL-05
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantInstallFromHost, installFromHost, listInstallGrantsFromHost, removeFromHost, revokeInstallGrantFromHost } from "../src/core/installHost";
import { appendGrantEvent } from "../src/core/installGrantStore";
import { OwnerStore } from "../src/core/ownerStore";
import { CAD, CORE, LIBS, cleanWorlds } from "./helpers/installFixture";
import { makeHost, type Host } from "./helpers/installHostFixture";

// The install gate on a host: who may ask, what a grant allows, what is counted against its ceiling, what is logged, and that nothing a request says
// can name a manifest, a url, a command or a path.
afterEach(cleanWorlds);

const NOW = new Date("2026-10-18T12:00:00.000Z");
const opts = { now: () => NOW };
const NODAL = { id: "fake-nodal", version: "0.1.0", kind: "addon" as const, dependsOn: [{ component: "fakeapp-core", min: "1.2.0" }] };
const host = (over: Parameters<typeof makeHost>[1] = {}) => makeHost([CORE(), LIBS(), CAD(), NODAL], over);
const CEIL = { downloadBytes: 10_000_000, expandedBytes: 10_000_000 };
const grantBody = (h: Host, over: Record<string, unknown> = {}) => ({ actor: { kind: h.bot.kind, name: h.bot.name }, app: "fakeapp", components: ["fake-cad"], ceiling: CEIL, ...over });
const issue = (h: Host, over: Record<string, unknown> = {}) => {
  const r = grantInstallFromHost(h.humanFile, grantBody(h, over), opts);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.grant;
};
const ask = (h: Host, select: string[] = [], file = h.agentFile, extra: Record<string, unknown> = {}) => installFromHost(file, { app: "fakeapp", select, ...extra }, opts);
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const msg = (r: { ok: boolean; errors?: { message: string }[] }) => (r.ok ? "" : r.errors!.map((e) => e.message).join("; "));
const installedIds = (h: Host) => (fs.existsSync(path.join(h.root, ".seed", "components.json")) ? h.state().installs.map((i: { component: string }) => i.component).sort() : []);

describe("issuing, listing and revoking grants (a human)", () => {
  it("a human host identity issues a grant: 24 hours by default, recorded in the chained log and the install record", () => {
    const h = host();
    const g = issue(h);
    expect(g).toMatchObject({ app: "fakeapp", components: ["fake-cad"], actor: { kind: h.bot.kind, name: h.bot.name }, approvedBy: { kind: "human", name: "the user" }, ceiling: CEIL });
    expect(g.grantId).toMatch(/^[0-9a-f]{32}$/);
    expect(g.issuedAt).toBe(NOW.toISOString());
    expect(g.expires).toBe(new Date(NOW.getTime() + 24 * 3600_000).toISOString());
    const rows = h.grantLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, prev: null, event: { type: "issued", grant: { grantId: g.grantId } } });
    expect(h.installsLog().at(-1)).toMatchObject({ operation: "grant-install", grantId: g.grantId, app: "fakeapp" });
  });
  it("hours, a note, and a core-only grant", () => {
    const h = host();
    const g = issue(h, { hours: 2, components: [], note: "cloud setup" });
    expect(Date.parse(g.expires) - Date.parse(g.issuedAt)).toBe(2 * 3600_000);
    expect(g.components).toEqual([]);
    expect(g.note).toBe("cloud setup");
  });
  it("an agent or system host identity can not issue, list or revoke", () => {
    const h = host();
    const g = issue(h);
    const sys = h.write("system.json", h.config({ kind: "system", name: "seed" }));
    for (const f of [h.agentFile, sys]) {
      expect(codes(grantInstallFromHost(f, grantBody(h), opts))).toEqual(["E_NOT_PERMITTED"]);
      expect(codes(revokeInstallGrantFromHost(f, { grantId: g.grantId }, opts))).toEqual(["E_NOT_PERMITTED"]);
      expect(codes(listInstallGrantsFromHost(f, opts))).toEqual(["E_NOT_PERMITTED"]);
    }
    expect(h.grantLog()).toHaveLength(1);
  });
  it("refuses a component that is not in the pinned manifest, and one that is not an add-on", () => {
    const h = host();
    expect(codes(grantInstallFromHost(h.humanFile, grantBody(h, { components: ["nope"] }), opts))).toEqual(["E_COMPONENT_UNKNOWN"]);
    expect(codes(grantInstallFromHost(h.humanFile, grantBody(h, { components: ["shared-libs"] }), opts))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
    expect(codes(grantInstallFromHost(h.humanFile, grantBody(h, { components: ["fakeapp-core"] }), opts))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
    expect(h.grantLog()).toEqual([]);
  });
  it("refuses bad hours, a bad ceiling, an actor that is a human, an extra field and an unknown app", () => {
    const h = host();
    for (const bad of [{ hours: 0 }, { hours: 745 }, { hours: "5" }, { ceiling: { downloadBytes: -1, expandedBytes: 1 } }, { actor: { kind: "human", name: "me" } }, { shell: "rm -rf /" }, { components: "fake-cad" }]) {
      expect(grantInstallFromHost(h.humanFile, grantBody(h, bad), opts).ok).toBe(false);
    }
    expect(grantInstallFromHost(h.humanFile, grantBody(h, { app: "otherapp" }), opts).ok).toBe(false);
    expect(h.grantLog()).toEqual([]);
  });
  it("lists every grant with its state and what is spent; revoking ends one, once", async () => {
    const h = host();
    const a = issue(h);
    const b = issue(h, { hours: 1, components: ["fake-nodal"] });
    await ask(h, ["fake-cad"]);
    let list = listInstallGrantsFromHost(h.humanFile, opts);
    expect(list.ok && list.grants.map((g) => [g.grantId === a.grantId ? "a" : "b", g.state])).toEqual([["a", "active"], ["b", "active"]]);
    expect(list.ok && list.grants[0]!.spent.downloadBytes).toBeGreaterThan(0);
    expect(list.ok && list.grants[1]!.spent).toEqual({ downloadBytes: 0, expandedBytes: 0 });
    expect(revokeInstallGrantFromHost(h.humanFile, { grantId: b.grantId, reason: "not needed" }, opts)).toEqual({ ok: true, grantId: b.grantId });
    expect(codes(revokeInstallGrantFromHost(h.humanFile, { grantId: b.grantId }, opts))).toEqual(["E_NOT_PERMITTED"]);
    expect(codes(revokeInstallGrantFromHost(h.humanFile, { grantId: "f".repeat(32) }, opts))).toEqual(["E_NOT_PERMITTED"]);
    expect(codes(revokeInstallGrantFromHost(h.humanFile, { grantId: "short" }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    list = listInstallGrantsFromHost(h.humanFile, { now: () => new Date(NOW.getTime() + 2 * 3600_000) });
    expect(list.ok && list.grants.map((g) => g.state)).toEqual(["active", "revoked"]);
    list = listInstallGrantsFromHost(h.humanFile, { now: () => new Date(NOW.getTime() + 25 * 3600_000) });
    expect(list.ok && list.grants.map((g) => g.state)).toEqual(["expired", "revoked"]);
  });
});

describe("an agent asking for an install", () => {
  it("without a grant: refused with what to grant, the refusal is logged with its gate stop, and nothing is fetched or created", async () => {
    const h = host();
    const r = await ask(h, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(msg(r)).toContain("grant-install");
    expect(msg(r)).toContain("fake-cad");
    expect(h.downloads).toEqual([]);
    expect(fs.existsSync(path.join(h.root, ".seed", "components.json"))).toBe(false);
    expect(h.installsLog().at(-1)).toMatchObject({ operation: "install_component", phase: "refused", gateStop: { rule: "grant-required" }, actor: h.bot, app: "fakeapp", select: ["fake-cad"] });
  });
  it("with a grant: the core, the libraries and the add-on are installed; the cost is counted against the grant before anything is fetched", async () => {
    const h = host();
    const g = issue(h);
    const r = await ask(h, ["fake-cad"]);
    expect(r.ok && r.via).toBe("grant");
    expect(r.ok && r.grantId).toBe(g.grantId);
    expect(installedIds(h)).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
    const events = h.grantLog().map((x) => x.event);
    expect(events.map((e) => e.type)).toEqual(["issued", "used"]);
    const cost = events[1].cost;
    const wanted = ["fakeapp-core", "shared-libs", "fake-cad"].flatMap((id) => h.manifest.components.find((c) => c.id === id)!.artifacts);
    expect(cost).toEqual({ downloadBytes: wanted.reduce((n, a) => n + a.downloadBytes, 0), expandedBytes: wanted.reduce((n, a) => n + a.expandedBytes, 0) });
    expect(h.installsLog().filter((e) => e.operation === "install_component").map((e) => e.phase)).toEqual(["admitted", "finished"]);
  });
  it("what is cached or installed already costs nothing against the ceiling", async () => {
    const h = host();
    issue(h);
    await ask(h, ["fake-cad"]);
    issue(h, { components: ["fake-nodal"] });
    const r = await ask(h, ["fake-nodal"]);
    expect(r.ok).toBe(true);
    const used = h.grantLog().map((x) => x.event).filter((e) => e.type === "used");
    const nodal = h.manifest.components.find((c) => c.id === "fake-nodal")!.artifacts[0]!;
    expect(used[1].cost).toEqual({ downloadBytes: nodal.downloadBytes, expandedBytes: nodal.expandedBytes });
  });
  it("asking again for what is installed does nothing, costs nothing and needs no grant", async () => {
    const h = host();
    issue(h);
    await ask(h, ["fake-cad"]);
    const before = h.grantLog().length;
    h.downloads.length = 0;
    const again = await ask(h, ["fake-cad"], h.write("agent2.json", h.config({ kind: "agent", name: "another-bot", model: "m" })));
    expect(again.ok && again.via).toBe("nothing-to-do");
    expect(h.grantLog()).toHaveLength(before);
    expect(h.downloads).toEqual([]);
    expect(h.installsLog().at(-1)).toMatchObject({ phase: "nothing-to-do" });
  });
  it("the ceiling is spent across requests: a second add-on that no longer fits is refused", async () => {
    const h = host();
    const cad = ["fakeapp-core", "shared-libs", "fake-cad"].flatMap((id) => h.manifest.components.find((c) => c.id === id)!.artifacts);
    const nodal = h.manifest.components.find((c) => c.id === "fake-nodal")!.artifacts[0]!;
    const down = cad.reduce((n, a) => n + a.downloadBytes, 0), disk = cad.reduce((n, a) => n + a.expandedBytes, 0);
    issue(h, { components: ["fake-cad", "fake-nodal"], ceiling: { downloadBytes: down + nodal.downloadBytes - 1, expandedBytes: disk + nodal.expandedBytes } });
    expect((await ask(h, ["fake-cad"])).ok).toBe(true);
    const r = await ask(h, ["fake-nodal"]);
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(msg(r)).toContain("ceiling");
    expect(installedIds(h)).not.toContain("fake-nodal");
    expect(h.grantLog().filter((x) => x.event.type === "used")).toHaveLength(1);
  });
  it("a ceiling too small for the first request refuses it before anything is fetched or counted", async () => {
    const h = host();
    issue(h, { ceiling: { downloadBytes: 10, expandedBytes: 10_000_000 } });
    const r = await ask(h, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(h.downloads).toEqual([]);
    expect(h.grantLog().map((x) => x.event.type)).toEqual(["issued"]);
  });
  it("two requests at the same moment for a ceiling that fits one: exactly one gets in", async () => {
    const h = host();
    const cad = ["fakeapp-core", "shared-libs", "fake-cad"].flatMap((id) => h.manifest.components.find((c) => c.id === id)!.artifacts);
    issue(h, { ceiling: { downloadBytes: cad.reduce((n, a) => n + a.downloadBytes, 0), expandedBytes: cad.reduce((n, a) => n + a.expandedBytes, 0) } });
    const second = h.write("agent-b.json", h.config(h.bot));
    const both = await Promise.all([ask(h, ["fake-cad"]), ask(h, ["fake-cad"], second, { requestId: "second" })]);
    expect(both.filter((r) => r.ok && r.via === "grant")).toHaveLength(1);
    expect(h.grantLog().filter((x) => x.event.type === "used")).toHaveLength(1);
    expect(installedIds(h)).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
  });
  it("another request that spends the ceiling between the first look and the count is seen: the ceiling is checked again under the lock", async () => {
    const h = host();
    const g = issue(h);
    const cad = ["fakeapp-core", "shared-libs", "fake-cad"].flatMap((id) => h.manifest.components.find((c) => c.id === id)!.artifacts);
    const r = await installFromHost(h.agentFile, { app: "fakeapp", select: ["fake-cad"] }, {
      ...opts,
      beforeAdmit: () => {
        // what a second process would have done in that gap: use up the whole ceiling
        const used = appendGrantEvent(h.stateRoot, () => ({ event: { type: "used", grantId: g.grantId, requestId: "other", actor: { kind: "agent", name: "setup-bot", model: "m" }, app: "fakeapp", components: ["fake-cad"], cost: CEIL }, value: 1 }));
        expect(used.ok).toBe(true);
        expect(cad.length).toBe(3);
      }
    });
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(msg(r)).toContain("ceiling");
    expect(installedIds(h)).toEqual([]);
    expect(h.downloads).toEqual([]);
  });
  it("a grant does not cover an add-on it does not name", async () => {
    const h = host();
    issue(h);
    const r = await ask(h, ["fake-nodal"]);
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(msg(r)).toContain("does not cover fake-nodal");
  });
  it("a core-only grant installs the core and nothing else", async () => {
    const h = host();
    issue(h, { components: [] });
    expect((await ask(h, [])).ok).toBe(true);
    expect(installedIds(h)).toEqual(["fakeapp-core"]);
    expect(codes(await ask(h, ["fake-cad"]))).toEqual(["E_NOT_PERMITTED"]);
  });
  it("an expired grant, a revoked grant, and a grant for another actor are refused", async () => {
    const h = host();
    const g = issue(h);
    expect(msg(await installFromHost(h.agentFile, { app: "fakeapp", select: ["fake-cad"] }, { now: () => new Date(NOW.getTime() + 25 * 3600_000) }))).toContain("expired");
    expect(msg(await ask(h, ["fake-cad"], h.write("other.json", h.config({ kind: "agent", name: "other-bot", model: "m" }))))).toContain("another actor");
    revokeInstallGrantFromHost(h.humanFile, { grantId: g.grantId }, opts);
    expect(msg(await ask(h, ["fake-cad"]))).toContain("revoked");
    expect(installedIds(h)).toEqual([]);
  });
  it("a human needs no grant", async () => {
    const h = host();
    const r = await ask(h, ["fake-cad"], h.humanFile);
    expect(r.ok && r.via).toBe("human");
    expect(h.grantLog()).toEqual([]);
    expect(installedIds(h)).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
  });
  it("a failed install still counts against the grant, and says what failed", async () => {
    const h = host();
    issue(h);
    const id = "fake-cad-0.3.0";
    fs.writeFileSync(path.join(h.artifactsDir, id), Buffer.alloc(h.served.get(id)!.length, 7));
    const r = await ask(h, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_HASH_MISMATCH"]);
    expect(!r.ok && r.completed?.map((c) => c.component)).toEqual(["fakeapp-core", "shared-libs"]);
    expect(h.grantLog().filter((x) => x.event.type === "used")).toHaveLength(1);
    expect(h.installsLog().at(-1)).toMatchObject({ phase: "finished", ok: false, errors: ["E_HASH_MISMATCH"] });
  });
});

describe("what a request can not say", () => {
  it.each(["manifest", "manifestFile", "url", "command", "path", "installRoot", "sha256", "artifacts"])("a request with %s is refused as it stands", async (key) => {
    const h = host();
    issue(h);
    const r = await installFromHost(h.agentFile, { app: "fakeapp", select: ["fake-cad"], [key]: "https://evil.example/pack.tgz" }, opts);
    expect(codes(r)).toEqual(["E_SCHEMA_INVALID"]);
    expect(msg(r)).toContain(key);
    expect(h.downloads).toEqual([]);
    expect(installedIds(h)).toEqual([]);
  });
  it("an app that is not in the host configuration, a bad id, too many add-ons, a repeated add-on, a bad request id", async () => {
    const h = host();
    expect((await installFromHost(h.agentFile, { app: "otherapp", select: [] }, opts)).ok).toBe(false);
    expect(codes(await installFromHost(h.agentFile, { app: "../x", select: [] }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect(codes(await installFromHost(h.agentFile, { app: "fakeapp", select: ["../x"] }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect(codes(await installFromHost(h.agentFile, { app: "fakeapp", select: ["a", "a"] }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect(codes(await installFromHost(h.agentFile, { app: "fakeapp", select: [], requestId: "bad id" }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect(codes(await installFromHost(h.agentFile, "install everything" as never, opts))).toEqual(["E_SCHEMA_INVALID"]);
  });
  it("the plan's refusals reach the agent unchanged and are logged: an unknown add-on, a library, a platform", async () => {
    const h = host();
    issue(h);
    expect(codes(await ask(h, ["nope"]))).toEqual(["E_COMPONENT_UNKNOWN"]);
    expect(codes(await ask(h, ["shared-libs"]))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
    const mac = h.write("mac.json", { ...h.config(h.bot), platform: { os: "macos", arch: "arm64" } });
    expect(new Set(codes(await ask(h, ["fake-cad"], mac)))).toEqual(new Set(["E_COMPONENT_PLATFORM"]));
    expect(h.installsLog().filter((e) => e.phase === "refused")).toHaveLength(3);
    expect(h.grantLog().map((x) => x.event.type)).toEqual(["issued"]);
  });
  it("offline (no artifacts folder) and nothing cached: the missing artifact is named and nothing is counted", async () => {
    const h = host();
    issue(h);
    const offline = h.write("offline.json", { ...h.config(h.bot), apps: { fakeapp: { ...h.config(h.bot).apps.fakeapp, artifactsDir: undefined } } });
    const r = await ask(h, ["fake-cad"], offline);
    expect(codes(r)).toEqual(["E_OFFLINE_MISSING"]);
    expect(h.grantLog().map((x) => x.event.type)).toEqual(["issued"]);
  });
});

describe("the trust anchors", () => {
  it("a manifest whose bytes differ from the pin is not used", async () => {
    const h = host();
    issue(h);
    fs.appendFileSync(h.manifestFile, " ");
    const r = await ask(h, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_SETUP_REQUIRED"]);
    expect(msg(r)).toContain("does not match its pin");
    expect(h.downloads).toEqual([]);
    expect(codes(grantInstallFromHost(h.humanFile, grantBody(h), opts))).toEqual(["E_SETUP_REQUIRED"]);
  });
  it("a manifest for another app than its entry", async () => {
    const h = host();
    const cfg = h.config(h.bot);
    const wrong = { ...cfg, apps: { other: cfg.apps.fakeapp } };
    expect(msg(await installFromHost(h.write("w.json", wrong), { app: "other", select: [] }, opts))).toContain("is for the app fakeapp");
  });
  it("an edited grant log is refused as a whole: nothing is installed under it", async () => {
    const h = host();
    issue(h, { ceiling: { downloadBytes: 1000, expandedBytes: 1000 } });
    const f = path.join(h.stateRoot, "install-grants.jsonl");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"downloadBytes":1000', '"downloadBytes":99999999'));
    const r = await ask(h, ["fake-cad"]);
    expect(codes(r)).toEqual(["E_SETUP_REQUIRED"]);
    expect(msg(r)).toContain("hash chain");
    expect(installedIds(h)).toEqual([]);
    expect(codes(grantInstallFromHost(h.humanFile, grantBody(h), opts))).toEqual(["E_SETUP_REQUIRED"]);
  });
  it("a grant log cut in the middle of a line is refused", async () => {
    const h = host();
    issue(h);
    const f = path.join(h.stateRoot, "install-grants.jsonl");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, -20));
    expect(msg(await ask(h, ["fake-cad"]))).toContain("partial");
  });
  it("a host configuration inside the install root or the state folder is refused", async () => {
    const h = host();
    fs.mkdirSync(h.root, { recursive: true });
    for (const dir of [h.root, h.stateRoot]) {
      const f = path.join(dir, "cfg.json");
      fs.writeFileSync(f, JSON.stringify(h.config(h.bot)));
      expect(msg(await installFromHost(f, { app: "fakeapp", select: [] }, opts))).toContain("outside the install root and the state folder");
    }
  });
  it("a grant log with its first line removed is refused (the chain no longer starts at 1)", async () => {
    const h = host();
    issue(h);
    issue(h, { components: ["fake-nodal"] });
    const f = path.join(h.stateRoot, "install-grants.jsonl");
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(f, lines.slice(1).join("\n") + "\n");
    const r = await ask(h, ["fake-nodal"]);
    expect(msg(r)).toContain("hash chain");
    expect(installedIds(h)).toEqual([]);
  });
  it("an artifact file larger than the manifest says is not copied", async () => {
    const h = host();
    fs.writeFileSync(path.join(h.artifactsDir, "fakeapp-core-1.2.0"), Buffer.alloc(h.served.get("fakeapp-core-1.2.0")!.length + 10));
    const r = await ask(h, [], h.humanFile);
    expect(codes(r)).toEqual(["E_INSTALL_FAILED"]);
    expect(msg(r)).toContain("larger than the manifest says");
    expect(installedIds(h)).toEqual([]);
  });
  it("host configurations that put things in the wrong place are refused", async () => {
    const h = host();
    const bad = (cfg: Record<string, unknown>) => installFromHost(h.write("bad.json", cfg), { app: "fakeapp", select: [] }, opts);
    const base = h.config(h.bot);
    expect(msg(await bad({ ...base, stateRoot: path.join(h.root, "state") }))).toContain("separate folders");
    expect(msg(await bad({ ...base, installRoot: path.join(h.stateRoot, "apps") }))).toContain("separate folders");
    expect(msg(await bad({ ...base, installRoot: "relative/apps" }))).toContain("absolute");
    expect(msg(await bad({ ...base, extra: 1 }))).toContain("invalid seed.install-host/0.1");
    expect(msg(await bad({ ...base, apps: {} }))).toContain("invalid seed.install-host/0.1");
    expect(msg(await bad({ ...base, apps: { fakeapp: { ...base.apps.fakeapp, manifestFile: path.join(h.root, "m.json") } } }))).toContain("outside the install root");
    expect(codes(await installFromHost("relative.json", { app: "fakeapp", select: [] }, opts))).toEqual(["E_SETUP_REQUIRED"]);
    expect(codes(await installFromHost(path.join(h.base, "missing.json"), { app: "fakeapp", select: [] }, opts))).toEqual(["E_SETUP_REQUIRED"]);
  });
});

describe("removal is a person's", () => {
  async function withCad() {
    const h = host();
    issue(h);
    await ask(h, ["fake-cad"]);
    return h;
  }
  it("a human removes the add-on and the libraries that came only with it; recorded", async () => {
    const h = await withCad();
    const r = await removeFromHost(h.humanFile, { app: "fakeapp", component: "fake-cad" }, opts);
    expect(r.ok && r.removed.sort()).toEqual(["fake-cad", "shared-libs"]);
    expect(installedIds(h)).toEqual(["fakeapp-core"]);
    expect(h.installsLog().filter((e) => e.operation === "remove_component").map((e) => e.phase)).toEqual(["admitted", "finished"]);
  });
  it("an agent is refused whatever grants exist, the refusal is logged, and nothing is removed", async () => {
    const h = await withCad();
    const r = await removeFromHost(h.agentFile, { app: "fakeapp", component: "fake-cad" }, opts);
    expect(codes(r)).toEqual(["E_NOT_PERMITTED"]);
    expect(msg(r)).toContain("human action");
    expect(installedIds(h)).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
    expect(h.installsLog().at(-1)).toMatchObject({ operation: "remove_component", phase: "refused", gateStop: { rule: "human-only" } });
  });
  it("is refused while a launch or job uses the component (the shell's process-owner records)", async () => {
    const h = await withCad();
    new OwnerStore(h.ownersFolder).write({
      schema: "seed.process-owner/0.1", launchId: "1".repeat(32), kind: "job", runtime: { component: "fake-cad", version: "0.3.0" }, supervisor: "seed",
      host: { pid: process.pid, startIdentity: "x" }, generation: "2".repeat(32), state: "running", startedAt: NOW.toISOString()
    });
    expect(codes(await removeFromHost(h.humanFile, { app: "fakeapp", component: "fake-cad" }, opts))).toEqual(["E_COMPONENT_IN_USE"]);
    expect(installedIds(h)).toContain("fake-cad");
    // a stopped record does not hold it
    new OwnerStore(h.ownersFolder).write({
      schema: "seed.process-owner/0.1", launchId: "1".repeat(32), kind: "job", runtime: { component: "fake-cad", version: "0.3.0" }, supervisor: "seed",
      host: { pid: process.pid, startIdentity: "x" }, generation: "2".repeat(32), state: "stopped", startedAt: NOW.toISOString()
    });
    expect((await removeFromHost(h.humanFile, { app: "fakeapp", component: "fake-cad" }, opts)).ok).toBe(true);
  });
  it("bad requests are refused", async () => {
    const h = await withCad();
    expect(codes(await removeFromHost(h.humanFile, { app: "fakeapp" }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect(codes(await removeFromHost(h.humanFile, { app: "fakeapp", component: "fake-cad", force: true }, opts))).toEqual(["E_SCHEMA_INVALID"]);
    expect((await removeFromHost(h.humanFile, { app: "fakeapp", component: "nope" }, opts)).ok).toBe(false);
    expect(installedIds(h)).toContain("fake-cad");
  });
});
