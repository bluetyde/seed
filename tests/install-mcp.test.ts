// @covers R-INSTALL-08
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/seed";
import { grantInstallFromHost } from "../src/core/installHost";
import { CAD, CORE, LIBS, cleanWorlds } from "./helpers/installFixture";
import { makeHost, type Host } from "./helpers/installHostFixture";
import { connectSeedMcp } from "./helpers/mcp-client";

// The MCP tools for components (docs/mcp.md): seed_list_components reads, seed_install_component asks. They exist only when the trusted environment names an install host,
// and there is no tool to grant, revoke or remove. These tests start dist/ code: run `npm run build` first.
vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanWorlds);

const input = (v: unknown) => Readable.from([JSON.stringify(v)]);
const host = () => makeHost([CORE(), LIBS(), CAD()]);
const CEIL = { downloadBytes: 10_000_000, expandedBytes: 10_000_000 };
const grant = (h: Host, over: Record<string, unknown> = {}) => {
  const r = grantInstallFromHost(h.humanFile, { actor: { kind: h.bot.kind, name: h.bot.name }, app: "fakeapp", components: ["fake-cad"], ceiling: CEIL, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.grant;
};
const studyHost = (h: Host) => h.write("study-host-placeholder.json", {}); // the study host is not read by these tools
const connect = (h: Host, configured = true) =>
  connectSeedMcp(studyHost(h), configured ? { SEED_INSTALL_HOST_CONFIG: h.agentFile } : {}, configured ? [] : ["SEED_INSTALL_HOST_CONFIG"]);
const names = async (m: Awaited<ReturnType<typeof connect>>) => (await m.client.listTools()).tools.map((t) => t.name);

describe("which tools exist", () => {
  it("both component tools when an install host is named, none otherwise, and never a tool that grants, revokes or removes", async () => {
    const h = host();
    const on = await connect(h);
    try {
      const list = await names(on);
      expect(list).toEqual(expect.arrayContaining(["seed_list_components", "seed_install_component"]));
      expect(list.filter((n) => /grant|revoke|remove|approve/.test(n))).toEqual([]);
      const tools = (await on.client.listTools()).tools;
      for (const n of ["seed_list_components", "seed_install_component"]) expect(tools.find((t) => t.name === n)!.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys((tools.find((t) => t.name === "seed_install_component")!.inputSchema as { properties: object }).properties).sort()).toEqual(["app", "requestId", "select"]);
      expect(tools.find((t) => t.name === "seed_list_components")!.annotations?.readOnlyHint).toBe(true);
    } finally { await on.client.close(); }
    const off = await connect(h, false);
    try {
      expect((await names(off)).filter((n) => /component/.test(n))).toEqual([]);
    } finally { await off.client.close(); }
  });
});

describe("seed_list_components", () => {
  it("lists what each app offers and what is installed, and changes nothing", async () => {
    const h = host();
    const m = await connect(h);
    try {
      const r = await m.client.callTool({ name: "seed_list_components", arguments: {} });
      expect(r.isError).toBe(false);
      const apps = (r.structuredContent as { apps: { app: string; sources: string[]; components: { id: string; kind: string; unavailable: string | null; installed: unknown }[] }[] }).apps;
      expect(apps).toHaveLength(1);
      expect(apps[0]!.app).toBe("fakeapp");
      expect(apps[0]!.sources).toEqual(["local", "cache"]);
      expect(apps[0]!.components.map((c) => [c.id, c.kind, c.installed])).toEqual([["fakeapp-core", "core", null], ["shared-libs", "library", null], ["fake-cad", "addon", null]]);
      expect(apps[0]!.components.every((c) => c.unavailable === null)).toBe(true);
      expect(fs.existsSync(path.join(h.root, ".seed", "components.json"))).toBe(false);
    } finally { await m.client.close(); }
  });
  it("one app, an unknown app, and an argument it does not take", async () => {
    const h = host();
    const m = await connect(h);
    try {
      expect((await m.client.callTool({ name: "seed_list_components", arguments: { app: "fakeapp" } })).isError).toBe(false);
      expect((await m.client.callTool({ name: "seed_list_components", arguments: { app: "otherapp" } })).isError).toBe(true);
      const bad = await m.client.callTool({ name: "seed_list_components", arguments: { url: "https://x" } }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect(bad.isError).toBe(true);
    } finally { await m.client.close(); }
  });
});

describe("seed_install_component", () => {
  it("without a grant it is refused as an error, says what to grant, and creates nothing", async () => {
    const h = host();
    const m = await connect(h);
    try {
      const r = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: ["fake-cad"] } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ schema: "seed.mcp-reply/0.1", ok: false, errors: [{ code: "E_NOT_PERMITTED" }] });
      expect(JSON.stringify(r.structuredContent)).toContain("grant-install");
      expect(fs.existsSync(path.join(h.root, ".seed", "components.json"))).toBe(false);
    } finally { await m.client.close(); }
  });

  it("inside a grant it installs, in a process of its own, and asking again does nothing", async () => {
    const h = host();
    const g = grant(h);
    const m = await connect(h);
    try {
      const r = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: ["fake-cad"], requestId: "mcp-1" } });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({ ok: true, via: "grant", grantId: g.grantId });
      expect(h.state().installs.map((i: { component: string }) => i.component).sort()).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
      // the install ran in the detached supervisor: neither this test process nor the MCP server owns the transaction
      const owner = h.state().transaction.owner.pid as number;
      expect(owner).not.toBe(process.pid);
      expect(owner).not.toBe((m.transport as { pid?: number | null }).pid);
      const again = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: ["fake-cad"] } });
      expect(again.structuredContent).toMatchObject({ ok: true, via: "nothing-to-do" });
      const list = await m.client.callTool({ name: "seed_list_components", arguments: {} });
      expect(JSON.stringify(list.structuredContent)).toContain('"installed":{"version":"0.3.0"');
    } finally { await m.client.close(); }
  });

  it("an add-on outside the grant, and an exhausted ceiling, are errors that say why", async () => {
    const h = host();
    grant(h, { ceiling: { downloadBytes: 10, expandedBytes: 10 } });
    const m = await connect(h);
    try {
      const r = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: ["fake-cad"] } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.structuredContent)).toContain("ceiling");
    } finally { await m.client.close(); }
  });

  it("takes only app, select and requestId: a url, a manifest, a command or a path is refused before it reaches the host", async () => {
    const h = host();
    grant(h);
    const m = await connect(h);
    try {
      for (const extra of [{ url: "https://evil.example/pack" }, { manifest: {} }, { command: "rm -rf /" }, { path: "C:/x" }]) {
        const bad = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: [], ...extra } }).catch((e) => ({ isError: true, thrown: String(e) }));
        expect(bad.isError).toBe(true);
      }
      const badSelect = await m.client.callTool({ name: "seed_install_component", arguments: { app: "fakeapp", select: ["../x"] } }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect(badSelect.isError).toBe(true);
      expect(fs.existsSync(path.join(h.root, ".seed", "components.json"))).toBe(false);
    } finally { await m.client.close(); }
  });
});

describe("the CLI verb list-components", () => {
  it("lists the same, for any actor, with the agent's variable", async () => {
    const h = host();
    const r = await runCli(["list-components"], input({}), undefined, undefined, h.agentFile);
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, apps: [{ app: "fakeapp" }] });
    const none = await runCli(["list-components"], input({}), undefined, undefined, undefined);
    expect(none).toMatchObject({ code: 2, reply: { errors: [{ code: "E_SETUP_REQUIRED" }] } });
  });
});
