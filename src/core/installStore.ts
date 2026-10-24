import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile";
import { validateInstallState, type ComponentError, type InstallState } from "./components";

/**
 * Where the installer keeps things (W4, docs/runtime-contract.md). One install root:
 *
 *   <root>/<app>/<component>/<version>/<artifact id>/...   an installed version (one folder per artifact)
 *   <root>/.seed/components.json                           the install state: what is installed, and the one transaction
 *   <root>/.seed/active/<app>/<component>                  a one-line pointer naming the active version
 *   <root>/.seed/staging/<transaction id>/                 work in progress (deleted when the transaction ends)
 *   <root>/.seed/trash/<transaction id>/                   a version being removed (deleted when the removal ends)
 *   <root>/.seed/cache/<sha256>                            verified artifacts: the offline cache
 *
 * Every id and version that becomes a path is checked against the manifest patterns here too, so a damaged state file can not
 * send a delete or a write outside the root.
 */

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const SHA = /^[0-9a-f]{64}$/;
const TX = /^[0-9a-f]{32}$/;

function id(v: string, what: string): string {
  if (!ID.test(v) || v === "." || v === "..") throw new Error(`${what} ${JSON.stringify(v)} is not a valid id`);
  return v;
}
function version(v: string): string {
  if (!VERSION.test(v)) throw new Error(`${JSON.stringify(v)} is not a valid version`);
  return v;
}

export type StoreLayout = ReturnType<typeof storeLayout>;
export function storeLayout(root: string) {
  const base = path.resolve(root);
  const seed = path.join(base, ".seed");
  return {
    root: base,
    seed,
    stateFile: path.join(seed, "components.json"),
    cacheDir: path.join(seed, "cache"),
    cacheFile: (sha: string) => path.join(seed, "cache", sha.match(SHA) ? sha : (() => { throw new Error("not a sha256"); })()),
    staging: (tx: string) => path.join(seed, "staging", tx.match(TX) ? tx : (() => { throw new Error("not a transaction id"); })()),
    trash: (tx: string) => path.join(seed, "trash", tx.match(TX) ? tx : (() => { throw new Error("not a transaction id"); })()),
    pointer: (app: string, component: string) => path.join(seed, "active", id(app, "app"), id(component, "component")),
    component: (app: string, component: string) => path.join(base, id(app, "app"), id(component, "component")),
    version: (app: string, component: string, v: string) => path.join(base, id(app, "app"), id(component, "component"), version(v))
  };
}

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
/** What Windows answers for a moment while another process (a scanner, an indexer, a reader) holds a file. */
export function retrySync<T>(fn: () => T, attempts = 40): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= attempts || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* a short wait; the callers are not on a hot path */ }
    }
  }
}

export function removeTree(p: string): void {
  retrySync(() => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
}
/** Removes `dir` and then each parent up to (not including) `stop`, as long as they are empty. */
export function removeEmptyParents(dir: string, stop: string): void {
  let d = path.resolve(dir);
  const top = path.resolve(stop);
  while (d !== top && d.startsWith(top + path.sep)) {
    try { fs.rmdirSync(d); } catch { return; }
    d = path.dirname(d);
  }
}
export function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  retrySync(() => fs.renameSync(from, to));
}

export const emptyState = (): InstallState => ({ schema: "seed.install-state/0.1", installs: [] });

/** The state file, or an empty state when there is none. A damaged file is an error: it is never replaced silently. */
export function readInstallState(root: string): { ok: true; state: InstallState } | { ok: false; errors: ComponentError[] } {
  const file = storeLayout(root).stateFile;
  let text: string;
  try {
    text = retrySync(() => fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, state: emptyState() };
    return { ok: false, errors: [{ code: "E_INSTALL_FAILED", message: `the install state ${file} can not be read: ${(e as Error).message}` }] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ code: "E_SCHEMA_INVALID", message: `the install state ${file} is not JSON; it is left as it is (restore it from a backup or remove it to start over)` }] };
  }
  return validateInstallState(json);
}

export function writeInstallState(root: string, state: InstallState): void {
  const checked = validateInstallState(state);
  if (!checked.ok) throw new Error(`refusing to write an install state that does not validate: ${checked.errors.map((e) => e.message).join("; ")}`);
  const file = storeLayout(root).stateFile;
  retrySync(() => writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n"));
}

export function readPointer(root: string, app: string, component: string): string | null {
  try {
    const v = retrySync(() => fs.readFileSync(storeLayout(root).pointer(app, component), "utf8")).trim();
    return VERSION.test(v) ? v : null;
  } catch (e) {
    // no pointer is an answer; a pointer that can not be read is not (it may well name the version being decided about)
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw new Error(`the pointer of ${component} could not be read: ${(e as Error).message}`);
  }
}
/** The one atomic step of an install: the pointer is written to a temporary file and renamed over the old one. */
export function writePointer(root: string, app: string, component: string, v: string): void {
  retrySync(() => writeFileAtomic(storeLayout(root).pointer(app, component), version(v) + "\n"));
}
export function clearPointer(root: string, app: string, component: string): void {
  retrySync(() => fs.rmSync(storeLayout(root).pointer(app, component), { force: true }));
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Names in the cache folder that look like a digest. Their content is checked when they are used, not here. */
export function cachedShas(root: string): Set<string> {
  try {
    return new Set(fs.readdirSync(storeLayout(root).cacheDir).filter((n) => SHA.test(n)));
  } catch {
    return new Set();
  }
}

/** The cache entries whose content really has the digest they are named by (a name alone is not proof; a bad file is paid for again when it is replaced). */
export async function verifiedCachedShas(root: string): Promise<Set<string>> {
  const ok = new Set<string>();
  for (const n of cachedShas(root)) {
    try { if ((await sha256File(storeLayout(root).cacheFile(n))) === n) ok.add(n); } catch { /* unreadable: not a hit */ }
  }
  return ok;
}

/** Free bytes on the volume that holds `p` (or its nearest existing parent). */
export function freeBytesAt(p: string): number {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}
