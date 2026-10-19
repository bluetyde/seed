import { createWriteStream, rmSync } from "node:fs";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactSource } from "./componentInstaller";

/**
 * The download source of the installer (W4 follow-up, docs/runtime-contract.md "Downloading"): an `ArtifactSource` that fetches the `https://` url of an
 * artifact of a pinned manifest. The url comes from the manifest, never from a request; the hash and size in the manifest decide whether the bytes are
 * accepted (the installer checks both), so the source's job is to stop things that a hash can not stop:
 *
 *  - **https only**, no credentials in the url, no other scheme, also after a redirect (a redirect to `http://`, `file:` or `ftp:` is refused);
 *  - **only the hosts the host configuration lists**, for the url and for every redirect target (a CDN host has to be listed too);
 *  - **no private, loopback, link-local or reserved address**, checked on the address the name resolves to when the connection is made (so a
 *    name that resolves to an internal address, or a rebinding, is refused) and on a literal ip address in the url;
 *  - **the size is the manifest's size**: a `Content-Length` that differs is refused before a byte is read, a body that grows past it is cut off, a
 *    body that stops short is an error; a compressed transfer (`Content-Encoding`) is refused, so the bytes are the file's bytes;
 *  - **time limits**: until the headers arrive, between two chunks, and for the whole transfer; and the caller's `AbortSignal`;
 *  - **at most 5 redirects**; no proxy from the environment; certificate checks are Node's defaults (extra trust roots only through `ca`, never a switch that
 *    turns the checks off);
 *  - a file that was started and failed is deleted.
 */

export type HttpsSourceOptions = {
  /** Lower-case host names (no port) the url and every redirect may use. */
  allowedHosts: readonly string[];
  maxRedirects?: number;
  /** Until the response headers arrive, per request (default 30 s). */
  connectTimeoutMs?: number;
  /** Between two chunks of the body (default 60 s). */
  idleTimeoutMs?: number;
  /** For the whole transfer (default 1 hour). */
  totalTimeoutMs?: number;
  /** Extra trust roots (a company proxy's root, a test certificate). */
  ca?: string | Buffer | (string | Buffer)[];
  /** Tests only: accept loopback and private addresses. */
  allowPrivateAddresses?: boolean;
  /** Tests only: replaces the name lookup. */
  lookup?: typeof dns.lookup;
  onProgress?: (received: number, expected: number) => void;
};

export const DEFAULT_MAX_REDIRECTS = 5;

/** True for an address a download must never talk to: loopback, private, link-local, shared, documentation, multicast and other reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const hexMapped = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return (
      lower === "::" || lower === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")
    );
  }
  return true;
}

class SourceError extends Error {}

function checkUrl(raw: string, allowed: ReadonlySet<string>, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(`the url ${JSON.stringify(raw.slice(0, 100))} is not a url`);
  }
  if (url.protocol !== "https:") throw new SourceError(`only https urls are downloaded; ${url.protocol} is refused`);
  if (url.username || url.password) throw new SourceError("a url with a user name or password is refused");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowed.has(host)) throw new SourceError(`the host ${host} is not in the list of hosts this installer may download from`);
  if (net.isIP(host) !== 0 && !allowPrivate && isPrivateAddress(host)) throw new SourceError(`the address ${host} is not a public address`);
  return url;
}

/** The artifact's `url`, fetched under the rules at the top of this file. */
export function httpsSource(opts: HttpsSourceOptions): ArtifactSource {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const connectMs = opts.connectTimeoutMs ?? 30_000;
  const idleMs = opts.idleTimeoutMs ?? 60_000;
  const totalMs = opts.totalTimeoutMs ?? 3_600_000;
  const resolve = opts.lookup ?? dns.lookup;
  const safeLookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    resolve(hostname, { ...options, all: true }, (err: Error | null, addresses: dns.LookupAddress[]) => {
      if (err) return cb(err);
      if (!opts.allowPrivateAddresses) {
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(new SourceError(`${hostname} resolves to ${bad.address}, which is not a public address`));
      }
      if (options.all) return cb(null, addresses);
      const first = addresses[0];
      return first ? cb(null, first.address, first.family) : cb(new SourceError(`${hostname} did not resolve`));
    });
  }) as unknown as typeof dns.lookup;

  return async (artifact, destFile, signal) => {
    if (!artifact.url) throw new SourceError(`${artifact.id} has no url in its manifest`);
    const expected = artifact.downloadBytes;
    const started = Date.now();
    let url = checkUrl(artifact.url, allowed, opts.allowPrivateAddresses === true);
    let partial = false;
    try {
      for (let hop = 0; ; hop++) {
        if (signal?.aborted) throw new SourceError("cancelled");
        const left = totalMs - (Date.now() - started);
        if (left <= 0) throw new SourceError(`the download took longer than ${totalMs} ms`);
        const res = await new Promise<import("node:http").IncomingMessage>((ok, bad) => {
          const req = https.request(url, {
            method: "GET", agent: false, lookup: safeLookup, ...(opts.ca ? { ca: opts.ca } : {}),
            headers: { "Accept-Encoding": "identity", "User-Agent": "seed-installer/0.1", Accept: "application/octet-stream" }
          }, ok);
          const timer = setTimeout(() => req.destroy(new SourceError(`no answer from ${url.hostname} within ${connectMs} ms`)), Math.min(connectMs, left));
          const onAbort = () => req.destroy(new SourceError("cancelled"));
          signal?.addEventListener("abort", onAbort, { once: true });
          req.once("response", () => clearTimeout(timer));
          req.once("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); bad(e); });
          req.end();
        });

        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location;
          if (!location) throw new SourceError(`HTTP ${status} without a Location`);
          if (hop >= maxRedirects) throw new SourceError(`more than ${maxRedirects} redirects`);
          url = checkUrl(new URL(location, url).toString(), allowed, opts.allowPrivateAddresses === true);
          continue;
        }
        if (status !== 200) {
          res.resume();
          throw new SourceError(`${url.hostname} answered HTTP ${status}`);
        }
        const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
        if (encoding !== "identity") {
          res.destroy();
          throw new SourceError(`the server sent the file with Content-Encoding ${encoding}; the bytes of the file are needed as they are`);
        }
        const length = res.headers["content-length"];
        if (length !== undefined && Number(length) !== expected) {
          res.destroy();
          throw new SourceError(`the server says the file is ${length} bytes; the manifest says ${expected}`);
        }
        let received = 0;
        const guard = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            if (received > expected) return cb(new SourceError(`the file is longer than the ${expected} bytes the manifest says`));
            opts.onProgress?.(received, expected);
            cb(null, chunk);
          }
        });
        let idle: NodeJS.Timeout | undefined;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => res.destroy(new SourceError(`no data for ${idleMs} ms`)), idleMs);
        };
        const total = setTimeout(() => res.destroy(new SourceError(`the download took longer than ${totalMs} ms`)), Math.max(1, totalMs - (Date.now() - started)));
        const onAbort = () => res.destroy(new SourceError("cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        res.on("data", arm);
        arm();
        // the file is ours to delete only once it was created by this download: a file that was already there ("wx" refuses it) is left alone
        const out = createWriteStream(destFile, { flags: "wx", mode: 0o600 });
        out.once("open", () => { partial = true; });
        try {
          await pipeline(res, guard, out);
        } finally {
          clearTimeout(idle);
          clearTimeout(total);
          signal?.removeEventListener("abort", onAbort);
        }
        if (received !== expected) throw new SourceError(`the file stopped after ${received} bytes; the manifest says ${expected}`);
        return;
      }
    } catch (e) {
      if (partial) { try { rmSync(destFile, { force: true }); } catch { /* the installer deletes its staging folder */ } }
      throw e;
    }
  };
}
