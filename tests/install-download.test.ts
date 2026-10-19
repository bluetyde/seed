// @covers R-INSTALL-07
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantInstallFromHost, installFromHost, listComponentsFromHost, type InstallHostOpts } from "../src/core/installHost";
import { CAD, CORE, LIBS, cleanWorlds, type Spec } from "./helpers/installFixture";
import { makeHost, type Host } from "./helpers/installHostFixture";

// The https source as the install host wires it: `downloads.hosts` in the host configuration allows the urls of the pinned manifest, from those hosts only;
// a file in the artifacts folder is used before any download. A real TLS server on 127.0.0.1 stands in for the publisher.
const key = fs.readFileSync(path.join(__dirname, "fixtures", "tls", "test-key.pem"));
const cert = fs.readFileSync(path.join(__dirname, "fixtures", "tls", "test-cert.pem"));
const lookup = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never;
const NOW = new Date("2026-10-19T12:00:00.000Z");

let server: https.Server;
let port = 0;
let served: Map<string, Buffer>;
let requests: string[];
let sockets: Set<Socket>;
let override: ((req: IncomingMessage, res: ServerResponse) => void) | null;
beforeEach(async () => {
  requests = [];
  sockets = new Set();
  override = null;
  served = new Map();
  server = https.createServer({ key, cert }, (req, res) => {
    requests.push(req.url ?? "");
    if (override) return override(req, res);
    const body = served.get((req.url ?? "").replace(/^\//, ""));
    if (!body) { res.writeHead(404); res.end(); return; }
    res.end(body);
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
  cleanWorlds();
});

const withUrl = (s: Spec, hostName = "files.example.test"): Spec => ({ ...s, url: `https://${hostName}:${port}/{id}` });
/** A host whose manifest has urls and whose app entry allows downloads from the given hosts (and, optionally, still has a local artifacts folder). */
function downloadHost(hosts: string[] = ["files.example.test"], opt: { local?: boolean; specs?: Spec[] } = {}) {
  const h = makeHost((opt.specs ?? [CORE(), LIBS(), CAD()]).map((s) => withUrl(s)));
  for (const [id, bytes] of h.served) served.set(id, bytes);
  const base = h.config(h.bot);
  const app = { ...base.apps.fakeapp, downloads: { hosts } } as Record<string, unknown>;
  if (!opt.local) delete app.artifactsDir;
  const agent = h.write("dl-agent.json", { ...base, apps: { fakeapp: app } });
  const human = h.write("dl-human.json", { ...h.config({ kind: "human", name: "the user" }), apps: { fakeapp: app } });
  return { h, agent, human };
}
const opts = (over: Partial<NonNullable<InstallHostOpts["https"]>> = {}): InstallHostOpts => ({ now: () => NOW, https: { ca: cert, lookup, allowPrivateAddresses: true, ...over } });
const grant = (h: Host, human: string) => {
  const r = grantInstallFromHost(human, { actor: { kind: h.bot.kind, name: h.bot.name }, app: "fakeapp", components: ["fake-cad"], ceiling: { downloadBytes: 1e7, expandedBytes: 1e7 } }, { now: () => NOW });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
};
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const msg = (r: { ok: boolean; errors?: { message: string }[] }) => (r.ok ? "" : r.errors!.map((e) => e.message).join("; "));

describe("an install that downloads", () => {
  it("fetches the artifacts of the manifest over https, inside a grant, and installs them", async () => {
    const { h, agent, human } = downloadHost();
    grant(h, human);
    const r = await installFromHost(agent, { app: "fakeapp", select: ["fake-cad"] }, opts());
    expect(r.ok && r.via).toBe("grant");
    expect(requests.sort()).toEqual(["fake-cad-0.3.0", "fakeapp-core-1.2.0", "shared-libs-2.0.0"].map((x) => "/" + x).sort());
    expect(h.state().installs.map((i: { component: string }) => i.component).sort()).toEqual(["fake-cad", "fakeapp-core", "shared-libs"]);
    expect(h.leftovers()).toEqual([]);
  });
  it("a file in the artifacts folder is used before any download; what is not there is downloaded", async () => {
    const { h, agent, human } = downloadHost(["files.example.test"], { local: true });
    fs.rmSync(path.join(h.artifactsDir, "fake-cad-0.3.0"));
    grant(h, human);
    const r = await installFromHost(agent, { app: "fakeapp", select: ["fake-cad"] }, opts());
    expect(r.ok).toBe(true);
    expect(requests).toEqual(["/fake-cad-0.3.0"]);
  });
  it("what is cached is not downloaded again", async () => {
    const { h, agent, human } = downloadHost();
    await installFromHost(human, { app: "fakeapp", select: ["fake-cad"] }, opts());
    fs.rmSync(path.join(h.root, "fakeapp"), { recursive: true });
    fs.rmSync(path.join(h.root, ".seed", "components.json"));
    fs.rmSync(path.join(h.root, ".seed", "active"), { recursive: true });
    requests.length = 0;
    expect((await installFromHost(human, { app: "fakeapp", select: ["fake-cad"] }, opts())).ok).toBe(true);
    expect(requests).toEqual([]);
    void agent;
  });
});

describe("what the configuration lets through", () => {
  it("a url whose host is not in downloads.hosts is not fetched", async () => {
    const { h, agent, human } = downloadHost(["cdn.example.test"]);
    grant(h, human);
    const r = await installFromHost(agent, { app: "fakeapp", select: ["fake-cad"] }, opts());
    expect(codes(r)).toEqual(["E_INSTALL_FAILED"]);
    expect(msg(r)).toContain("not in the list of hosts");
    expect(requests).toEqual([]);
    expect(h.state().installs).toEqual([]);
  });
  it("no downloads and no artifacts folder: only the cache, and the missing artifact is named", async () => {
    const h = makeHost([CORE(), LIBS(), CAD()].map((s) => withUrl(s)));
    const base = h.config(h.bot);
    const app = { ...base.apps.fakeapp } as Record<string, unknown>;
    delete app.artifactsDir;
    const f = h.write("offline.json", { ...base, apps: { fakeapp: app } });
    const r = await installFromHost(f, { app: "fakeapp", select: [] }, opts());
    expect(codes(r)).toEqual(["E_OFFLINE_MISSING"]); // the plan is made first: an agent is told what is missing before it is told it needs a grant
    expect(msg(r)).toContain("fakeapp-core/fakeapp-core-1.2.0");
    const human = h.write("offline-human.json", { ...h.config({ kind: "human", name: "the user" }), apps: { fakeapp: app } });
    expect(codes(await installFromHost(human, { app: "fakeapp", select: [] }, opts()))).toEqual(["E_OFFLINE_MISSING"]);
    expect(requests).toEqual([]);
  });
  it("a certificate that is not trusted stops the install and leaves nothing", async () => {
    const { h, human } = downloadHost();
    const r = await installFromHost(human, { app: "fakeapp", select: [] }, { now: () => NOW, https: { lookup, allowPrivateAddresses: true } });
    expect(codes(r)).toEqual(["E_INSTALL_FAILED"]);
    expect(msg(r)).toMatch(/self[- ]signed|certificate/i);
    expect(h.state ? fs.existsSync(path.join(h.root, ".seed", "components.json")) : false).toBe(true); // the failed transaction is recorded
    expect(h.state().installs).toEqual([]);
    expect(h.leftovers()).toEqual([]);
  });
  it("a server that gives other bytes is refused by the hash, and nothing is cached", async () => {
    const { h, human } = downloadHost();
    override = (_req, res) => { res.end(Buffer.alloc(served.get("fakeapp-core-1.2.0")!.length, 3)); };
    const r = await installFromHost(human, { app: "fakeapp", select: [] }, opts());
    expect(codes(r)).toEqual(["E_HASH_MISMATCH"]);
    expect(fs.existsSync(path.join(h.root, ".seed", "cache"))).toBe(false);
    expect(h.leftovers()).toEqual([]);
  });
  it("the default checks refuse a name that resolves to a private address", async () => {
    const { human } = downloadHost();
    const internal = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "192.168.1.5", family: 4 }]) : cb(null, "192.168.1.5", 4))) as never;
    const r = await installFromHost(human, { app: "fakeapp", select: [] }, { now: () => NOW, https: { ca: cert, lookup: internal } });
    expect(msg(r)).toContain("not a public address");
    expect(requests).toEqual([]);
  });
});

describe("the configuration of downloads", () => {
  it("lists the sources an app has", () => {
    const { agent } = downloadHost(["files.example.test"], { local: true });
    const l = listComponentsFromHost(agent);
    expect(l.ok && l.apps[0]!.sources).toEqual(["local", "https", "cache"]);
    const { agent: a2 } = downloadHost();
    const l2 = listComponentsFromHost(a2);
    expect(l2.ok && l2.apps[0]!.sources).toEqual(["https", "cache"]);
  });
  it.each([
    ["no hosts", []],
    ["a url instead of a host name", ["https://files.example.test"]],
    ["an upper-case name", ["Files.Example.Test"]],
    ["a name with a port", ["files.example.test:443"]],
    ["a path", ["files.example.test/x"]],
    ["the same host twice", ["a.example.test", "a.example.test"]],
    ["nine hosts", Array.from({ length: 9 }, (_, i) => `h${i}.example.test`)]
  ])("%s is refused when the configuration is read", async (_n, hosts) => {
    const { h, human } = downloadHost(["files.example.test"]);
    const bad = h.write("bad-hosts.json", { ...h.config({ kind: "human", name: "the user" }), apps: { fakeapp: { ...h.config(h.bot).apps.fakeapp, downloads: { hosts } } } });
    const r = await installFromHost(bad, { app: "fakeapp", select: [] }, opts());
    expect(msg(r)).toContain("invalid seed.install-host/0.1");
    void human;
  });
  it("an extra field inside downloads is refused", async () => {
    const { h } = downloadHost();
    const bad = h.write("bad-dl.json", { ...h.config({ kind: "human", name: "the user" }), apps: { fakeapp: { ...h.config(h.bot).apps.fakeapp, downloads: { hosts: ["files.example.test"], verifyCertificates: false } } } });
    expect(msg(await installFromHost(bad, { app: "fakeapp", select: [] }, opts()))).toContain("invalid seed.install-host/0.1");
  });
});
