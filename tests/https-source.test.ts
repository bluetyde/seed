// @covers R-INSTALL-07
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "../src/core/components";
import { installSelection } from "../src/core/componentInstaller";
import { httpsSource, isPrivateAddress, type HttpsSourceOptions } from "../src/core/httpsSource";
import { CORE, makeWorld, cleanWorlds, fixtureManifest } from "./helpers/installFixture";

// The https download source (W4 follow-up): a real TLS server on 127.0.0.1 stands in for the publisher and its CDN; names are mapped to it by a lookup.
const key = fs.readFileSync(path.join(__dirname, "fixtures", "tls", "test-key.pem"));
const cert = fs.readFileSync(path.join(__dirname, "fixtures", "tls", "test-cert.pem"));
const BODY = Buffer.from("the bytes of a component artifact ".repeat(200));

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: https.Server;
let port: number;
let hits: { url: string; headers: IncomingMessage["headers"] }[];
let handler: Handler;
let sockets: Set<Socket>;
let work: string;
beforeEach(async () => {
  hits = [];
  sockets = new Set();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "seed-https-"));
  handler = (_req, res) => { res.end(BODY); };
  server = https.createServer({ key, cert }, (req, res) => { hits.push({ url: req.url ?? "", headers: req.headers }); handler(req, res); });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
  fs.rmSync(work, { recursive: true, force: true });
  cleanWorlds();
});

const lookup = ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
  if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
  else cb(null, "127.0.0.1", 4);
}) as unknown as NonNullable<HttpsSourceOptions["lookup"]>;
const src = (over: Partial<HttpsSourceOptions> = {}) => httpsSource({ allowedHosts: ["files.example.test", "cdn.example.test"], ca: cert, lookup, allowPrivateAddresses: true, ...over });
const art = (over: Partial<Artifact> = {}): Artifact => ({ id: "pack", url: `https://files.example.test:${port}/pack`, sha256: "a".repeat(64), downloadBytes: BODY.length, expandedBytes: BODY.length, archive: "none", ...over });
const dest = () => path.join(work, "pack.part");
const fails = async (p: Promise<unknown>, text: string | RegExp) => {
  const e = await p.then(() => null, (x: Error) => x);
  expect(e, "the download should have failed").not.toBeNull();
  expect(e!.message).toMatch(text);
};

describe("a download", () => {
  it("writes exactly the bytes, asks for them as they are, and reports progress", async () => {
    const seen: number[] = [];
    await src({ onProgress: (n) => seen.push(n) })(art(), dest());
    expect(fs.readFileSync(dest()).equals(BODY)).toBe(true);
    expect(hits[0]!.headers["accept-encoding"]).toBe("identity");
    expect(hits[0]!.headers["user-agent"]).toContain("seed-installer");
    expect(seen.at(-1)).toBe(BODY.length);
  });
  it("follows redirects between the listed hosts, absolute and relative", async () => {
    handler = (req, res) => {
      if (req.url === "/pack") { res.writeHead(302, { Location: `https://cdn.example.test:${port}/mirror/pack` }); res.end(); }
      else if (req.url === "/mirror/pack") { res.writeHead(307, { Location: "../final" }); res.end(); }
      else res.end(BODY);
    };
    await src()(art(), dest());
    expect(hits.map((h) => h.url)).toEqual(["/pack", "/mirror/pack", "/final"]);
    expect(fs.readFileSync(dest()).equals(BODY)).toBe(true);
  });
  it("does not overwrite a file that is there", async () => {
    fs.writeFileSync(dest(), "mine");
    await fails(src()(art(), dest()), /EEXIST/);
    expect(fs.readFileSync(dest(), "utf8")).toBe("mine");
  });
});

describe("what is refused before a connection is made", () => {
  it.each([
    ["an http url", "http://files.example.test/pack", /only https/],
    ["a file url", "file:///etc/passwd", /only https/],
    ["an ftp url", "ftp://files.example.test/pack", /only https/],
    ["a url with a password", "https://user:secret@files.example.test/pack", /user name or password/],
    ["a host that is not listed", "https://evil.example.test/pack", /not in the list of hosts/],
    ["something that is not a url", "not a url", /not a url/],
    ["a loopback address in the url", "https://127.0.0.1/pack", /not in the list/],
    ["an empty url", "", /no url/]
  ])("%s", async (_n, url, re) => {
    await fails(src({ allowPrivateAddresses: false })(art({ url }), dest()), re);
    expect(hits).toEqual([]);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("an artifact without a url", async () => {
    await fails(src()({ ...art(), url: undefined }, dest()), /no url/);
  });
  it("a literal address is refused when it is listed but not public", async () => {
    await fails(httpsSource({ allowedHosts: ["10.1.2.3"] })(art({ url: "https://10.1.2.3/pack" }), dest()), /not a public address/);
    await fails(httpsSource({ allowedHosts: ["::1"] })(art({ url: "https://[::1]/pack" }), dest()), /not a public address/);
  });
});

describe("redirects", () => {
  it("to a host that is not listed", async () => {
    handler = (_req, res) => { res.writeHead(302, { Location: `https://evil.example.test:${port}/steal` }); res.end(); };
    await fails(src()(art(), dest()), /evil.example.test is not in the list/);
    expect(hits).toHaveLength(1);
  });
  it("to http or to another scheme", async () => {
    for (const location of ["http://cdn.example.test/pack", "file:///etc/passwd", "ftp://cdn.example.test/pack"]) {
      handler = (_req, res) => { res.writeHead(301, { Location: location }); res.end(); };
      await fails(src()(art(), dest()), /only https/);
    }
  });
  it("to an address that is not public, found when the name is resolved", async () => {
    handler = (_req, res) => { res.writeHead(302, { Location: `https://cdn.example.test:${port}/pack` }); res.end(); };
    const internal = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "10.0.0.5", family: 4 }]) : cb(null, "10.0.0.5", 4))) as unknown as NonNullable<HttpsSourceOptions["lookup"]>;
    await fails(httpsSource({ allowedHosts: ["files.example.test", "cdn.example.test"], ca: cert, lookup: internal })(art(), dest()), /resolves to 10.0.0.5, which is not a public address/);
    expect(hits).toEqual([]);
  });
  it("more than five in a row, and a redirect without a Location", async () => {
    handler = (_req, res) => { res.writeHead(302, { Location: `https://files.example.test:${port}/again` }); res.end(); };
    await fails(src()(art(), dest()), /more than 5 redirects/);
    expect(hits).toHaveLength(6);
    handler = (_req, res) => { res.writeHead(302); res.end(); };
    await fails(src()(art(), dest()), /without a Location/);
  });
  it("the limit can be lowered", async () => {
    let n = 0;
    handler = (_req, res) => { if (n++ < 2) { res.writeHead(302, { Location: `https://files.example.test:${port}/x` }); res.end(); } else res.end(BODY); };
    await fails(src({ maxRedirects: 1 })(art(), dest()), /more than 1 redirects/);
  });
});

describe("what the server sends", () => {
  it.each([404, 403, 500, 204])("HTTP %s is an error and leaves no file", async (status) => {
    handler = (_req, res) => { res.writeHead(status); res.end(); };
    await fails(src()(art(), dest()), new RegExp(`HTTP ${status}`));
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a Content-Length that is not the manifest's size is refused before the body is read", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Content-Length": String(BODY.length + 1) }); res.write(BODY); };
    await fails(src()(art(), dest()), /says the file is \d+ bytes; the manifest says/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a body that grows past the manifest's size is cut off and deleted", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Transfer-Encoding": "chunked" }); res.write(BODY); res.end(Buffer.alloc(100, 1)); };
    await fails(src()(art(), dest()), /longer than the \d+ bytes/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a body that stops short is an error and is deleted", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Transfer-Encoding": "chunked" }); res.end(BODY.subarray(0, 100)); };
    await fails(src()(art(), dest()), /stopped after 100 bytes/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a compressed transfer is refused: the bytes of the file are needed as they are", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(BODY); };
    await fails(src()(art(), dest()), /Content-Encoding gzip/);
  });
});

describe("time limits and cancel", () => {
  it("a server that never answers", async () => {
    handler = () => { /* no answer */ };
    await fails(src({ connectTimeoutMs: 150 })(art(), dest()), /no answer from files.example.test within 150 ms/);
  });
  it("a server that stalls in the middle of the body", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Content-Length": String(BODY.length) }); res.write(BODY.subarray(0, 100)); };
    await fails(src({ idleTimeoutMs: 200 })(art(), dest()), /no data for 200 ms/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a server that drips for ever stops at the total time", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      const t = setInterval(() => res.write("x"), 40);
      res.on("close", () => clearInterval(t));
    };
    await fails(src({ totalTimeoutMs: 400, idleTimeoutMs: 5000 })(art(), dest()), /took longer than 400 ms/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("the caller's cancel stops a download in progress", async () => {
    handler = (_req, res) => { res.writeHead(200, { "Content-Length": String(BODY.length) }); res.write(BODY.subarray(0, 10)); };
    const ac = new AbortController();
    const p = src()(art(), dest(), ac.signal);
    setTimeout(() => ac.abort(), 150);
    await fails(p, /cancelled/);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("the caller's cancel stops a request the server never answers", async () => {
    handler = () => { /* no answer */ };
    const ac = new AbortController();
    const p = src({ connectTimeoutMs: 30_000 })(art(), dest(), ac.signal);
    setTimeout(() => ac.abort(), 150);
    await fails(p, /cancelled/);
  });
  it("a cancel before the start does nothing at all", async () => {
    const ac = new AbortController();
    ac.abort();
    await fails(src()(art(), dest(), ac.signal), /cancelled/);
    expect(hits).toEqual([]);
  });
});

describe("the certificate is checked", () => {
  it("a certificate that is not trusted is refused (no switch turns the check off)", async () => {
    await fails(httpsSource({ allowedHosts: ["files.example.test"], lookup, allowPrivateAddresses: true })(art(), dest()), /self[- ]signed|unable to verify|certificate/i);
    expect(fs.existsSync(dest())).toBe(false);
  });
  it("a certificate for another name is refused", async () => {
    await fails(httpsSource({ allowedHosts: ["other.example.test"], ca: cert, lookup, allowPrivateAddresses: true })(art({ url: `https://other.example.test:${port}/pack` }), dest()), /altnames|does not match|Hostname/i);
  });
});

describe("addresses a download must never talk to", () => {
  it.each(["0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "not an address"])("%s is refused", (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "192.169.0.1", "198.17.0.1", "198.20.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"])("%s is public", (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe("with the installer", () => {
  it("installs a component whose artifact is fetched over https, and refuses one whose bytes are not the pinned ones", async () => {
    const w = makeWorld({ source: undefined });
    const m = fixtureManifest([CORE()], w.served);
    const a = m.manifest.components[0]!.artifacts[0]!;
    const real = w.served.get(a.id)!;
    a.url = `https://files.example.test:${port}/${a.id}`;
    handler = (_req, res) => { res.end(real); };
    const env = w.with({ source: src() });
    const ok = await installSelection(env, m.manifest, m.sha, []);
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(w.versionDir("fakeapp-core", "1.2.0"))).toBe(true);

    const w2 = makeWorld({ source: undefined });
    const m2 = fixtureManifest([CORE()], w2.served);
    const a2 = m2.manifest.components[0]!.artifacts[0]!;
    a2.url = `https://files.example.test:${port}/${a2.id}`;
    handler = (_req, res) => { res.end(Buffer.alloc(a2.downloadBytes, 9)); };
    const bad = await installSelection(w2.with({ source: src() }), m2.manifest, m2.sha, []);
    expect(!bad.ok && bad.errors.map((e) => e.code)).toEqual(["E_HASH_MISMATCH"]);
    expect(fs.existsSync(path.join(w2.root, ".seed", "cache"))).toBe(false);
    expect(w2.leftovers()).toEqual([]);
  });
});
