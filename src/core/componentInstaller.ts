import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractArchive } from "./archive";
import {
  canTransition, eligible, isTerminal, mayActOn, planRemoval, recoverTransaction, resolveSelection,
  type Artifact, type Component, type ComponentError, type InstallState, type Installed, type Manifest, type ProcessIdentity, type Platform, type Transaction, type TxState
} from "./components";
import {
  assertUnderRoot, cachedShas, clearPointer, freeBytesAt, moveDir, readInstallState, readPointer, removeEmptyParents, removeTree, sha256File, storeLayout, writeInstallState, writePointer
} from "./installStore";
import { identityOf } from "./processIdentity";
import { assertLockHeld, withProjectLockAsync, type LockOptions } from "./projectStore";

/**
 * The staged install (W4, docs/runtime-contract.md, acceptance R1-R3 and R6). Every change to an install root is a **transaction** on
 * the one slot of the install state: queued, preflight, staging, verifying, activating, ready (an install or update), or queued,
 * preflight, removing, removed. The whole of it runs under the writer lock of the install root, so two installers (two hosts, two
 * processes) never work on one root at once: the second one is told `E_INSTALL_BUSY`.
 *
 * The rules the tests prove:
 *  - nothing is ever unpacked into the place a version will live: an artifact is fetched into the cache (hash and size checked),
 *    unpacked into a staging folder with the safe extractor, checked by the app's health check, and only then moved into place;
 *  - the **active version changes in one step**: the one-line pointer file is written to a temporary file and renamed. Before that
 *    step the old version is the one in use, after it the new one is; there is nothing in between;
 *  - a failure or a cancel before that step leaves the active version, the install record and the cache as they were, and no staging
 *    folder behind. The version being replaced is kept (`previous`) so that `rollbackComponent` can switch back;
 *  - a host that died at any point is settled by `recoverInstalls` from the record and from what is on disk (the pointer decides);
 *  - offline, only the cache is used, and a missing artifact is named; a cached copy whose hash no longer matches is deleted, never used;
 *  - what SEED did not install (`adopted`) is never replaced or deleted.
 * It fetches nothing by itself: the `source` it is given writes an artifact to a file. A source for real downloads (https, a size cap
 * and a time limit) is a separate piece; the tests use local files.
 */

export type ArtifactSource = (artifact: Artifact, destFile: string, signal?: AbortSignal) => Promise<void>;

export type InstallEnv = {
  root: string;
  platform: Platform;
  appVersion: string;
  /** Where artifacts come from. Absent: offline, only the cache is used. */
  source?: ArtifactSource;
  /** Free bytes on the install volume. Default: asked of the file system. */
  freeBytes?: () => number | Promise<number>;
  /** A message when a prerequisite of the component is missing (for example the WSL distro), or null. */
  prerequisites?: (c: Component) => string | null | Promise<string | null>;
  /** The app's own check of a staged version, before it is switched on. A message when it fails, or null. */
  healthCheck?: (dir: string, c: Component) => string | null | Promise<string | null>;
  /** Component ids that a running launch or job uses (from the process-owner records). */
  inUse?: () => ReadonlySet<string>;
  /** Who is installing. Default: this process with its start identity. */
  owner?: ProcessIdentity;
  /** Whether the recorded owner of an unfinished transaction is still running. Default: its pid and start identity are asked of the system. */
  ownerAlive?: (owner: ProcessIdentity | undefined) => boolean | Promise<boolean>;
  now?: () => Date;
  /** How long to wait for the lock (default: not at all, then `E_INSTALL_BUSY`), and the other lock options. */
  lock?: LockOptions;
  /** Test seam: called before each step, by name. Throw `SimulatedCrash` to stop the install dead, as a killed host would. */
  hooks?: { step?: (step: string, tx: Transaction) => void | Promise<void> };
};

/** Thrown by a test hook to stop dead: nothing is cleaned up, as if the host had been killed at that moment. */
export class SimulatedCrash extends Error {}

class Failure extends Error {
  constructor(readonly error: ComponentError) {
    super(error.message);
  }
}
const failure = (code: ComponentError["code"], message: string, component?: string) => new Failure({ code, message, ...(component ? { component } : {}) });

export type InstallStepResult = { component: string; action: "install" | "update" | "keep"; version: string };
export type InstallOutcome =
  | { ok: true; steps: InstallStepResult[]; cost: { downloadBytes: number; expandedBytes: number } }
  | { ok: false; errors: ComponentError[]; completed: InstallStepResult[] };
export type RemoveOutcome = { ok: true; removed: string[]; unregistered: string[]; kept: { component: string; neededBy: string[] }[] } | { ok: false; errors: ComponentError[] };
export type RecoveryReport = { transaction?: string; component?: string; was?: TxState; now?: TxState; action?: string };

const MAX_REASON = 500;

class Ctx {
  state: InstallState;
  readonly store;
  readonly now: () => Date;
  constructor(readonly env: InstallEnv, state: InstallState) {
    this.state = state;
    this.store = storeLayout(env.root);
    this.now = env.now ?? (() => new Date());
  }
  /** Stops before an irreversible step when the install root's lock was taken over: a holder that lost it must not write over the new holder's work. */
  fence() {
    assertLockHeld(this.env.root);
  }
  /** Stops when `p` is not really under the install root (a link among its parents). */
  inside(p: string) {
    assertUnderRoot(this.env.root, p);
  }
  save() {
    this.fence();
    writeInstallState(this.env.root, this.state);
  }
  find(app: string, component: string): Installed | undefined {
    return this.state.installs.find((i) => i.app === app && i.component === component);
  }
  put(rec: Installed) {
    this.state.installs = [...this.state.installs.filter((i) => !(i.app === rec.app && i.component === rec.component)), rec].sort((a, b) => (a.app + a.component < b.app + b.component ? -1 : 1));
  }
  drop(app: string, component: string) {
    this.state.installs = this.state.installs.filter((i) => !(i.app === app && i.component === component));
  }
  async phase(tx: Transaction, to: TxState) {
    await this.env.hooks?.step?.(to, tx);
    if (!canTransition(tx.operation, tx.state, to)) throw new Error(`internal: a ${tx.operation} can not go from ${tx.state} to ${to}`);
    tx.state = to;
    this.save();
  }
  /** Ends a transaction that did not complete, with the reason. */
  end(tx: Transaction, to: "failed" | "cancelled" | "interrupted", reason: string) {
    tx.state = to;
    tx.reason = reason.slice(0, MAX_REASON);
    this.save();
  }
  async newTx(operation: Transaction["operation"], app: string, component: string, from?: string, to?: string): Promise<Transaction> {
    const owner = this.env.owner ?? (await ownIdentity());
    const tx: Transaction = {
      id: randomBytes(16).toString("hex"), operation, app, component,
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      state: "queued", startedAt: this.now().toISOString(), ...(owner ? { owner } : {})
    };
    this.state.transaction = tx;
    this.save();
    return tx;
  }
}

let ownCache: ProcessIdentity | null | undefined;
async function ownIdentity(): Promise<ProcessIdentity | null> {
  if (ownCache === undefined) ownCache = await identityOf(process.pid);
  return ownCache;
}

async function ownerAliveDefault(owner: ProcessIdentity | undefined): Promise<boolean> {
  return owner ? mayActOn(owner, await identityOf(owner.pid)) : false;
}

/** Runs `fn` with the state read and settled, under the writer lock of the install root. */
async function locked<T>(env: InstallEnv, fn: (c: Ctx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; errors: ComponentError[] }> {
  fs.mkdirSync(env.root, { recursive: true });
  const got = await withProjectLockAsync(env.root, async () => {
    const read = readInstallState(env.root);
    if (!read.ok) return { ok: false as const, errors: read.errors };
    const c = new Ctx(env, read.state);
    const rec = await settle(c);
    if (rec.errors) return { ok: false as const, errors: rec.errors };
    return { ok: true as const, value: await fn(c) };
  }, { waitMs: 0, ...env.lock });
  if (!got.ok) {
    const locked = got.errors.some((e) => e.code === "E_PROJECT_LOCKED");
    return { ok: false, errors: locked
      ? [{ code: "E_INSTALL_BUSY", message: `another install, update or removal is running on ${env.root}; try again when it has finished` }]
      : got.errors.map((e) => ({ code: "E_INSTALL_FAILED" as const, message: e.message })) };
  }
  return got.value;
}

// ---- recovery ----------------------------------------------------------------------------------------------------------

/** Deletes a version folder, and the component and app folders above it when that leaves them empty. */
function dropVersion(c: Ctx, app: string, component: string, v: string) {
  const dir = c.store.version(app, component, v);
  removeTree(dir);
  removeEmptyParents(path.dirname(dir), c.store.root);
}

/** Where a same-version update sets the replaced folder aside (inside the transaction's staging folder). */
const replacedDir = (c: Ctx, tx: Transaction) => path.join(c.store.staging(tx.id), "replaced");

/** Puts a folder set aside by an interrupted same-version update back in place, over whatever the switch left there. */
function restoreReplaced(c: Ctx, tx: Transaction) {
  if (!tx.to) return;
  const aside = replacedDir(c, tx);
  if (!fs.existsSync(aside)) return;
  const final = c.store.version(tx.app, tx.component, tx.to);
  removeTree(final);
  moveDir(aside, final);
}

function referenced(c: Ctx, app: string, component: string, v: string) {
  const r = c.find(app, component);
  return r?.version === v || r?.previous?.version === v;
}

function readPending(c: Ctx, tx: Transaction): Installed | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(c.store.staging(tx.id), "installed.json"), "utf8")) as Installed;
  } catch {
    return null;
  }
}

/** Settles the transaction a previous run left unfinished, and deletes staging and trash folders that belong to nothing. Under the lock. */
async function settle(c: Ctx, report?: RecoveryReport): Promise<{ errors?: ComponentError[] }> {
  const tx = c.state.transaction;
  if (tx && !isTerminal(tx.state)) {
    const alive = await (c.env.ownerAlive ?? ownerAliveDefault)(tx.owner);
    let active: string | undefined;
    try { active = readPointer(c.env.root, tx.app, tx.component) ?? undefined; } catch (e) {
      return { errors: [{ code: "E_INSTALL_FAILED", component: tx.component, message: `${(e as Error).message}; the unfinished ${tx.operation} is left as it is until the pointer can be read` }] };
    }
    const rec = c.find(tx.app, tx.component);
    const present = tx.operation === "remove" ? rec !== undefined && fs.existsSync(rec.location) : undefined;
    const r = recoverTransaction(tx, { ownerAlive: alive, ...(active ? { activeVersion: active } : {}), ...(present !== undefined ? { present } : {}) });
    if (report) Object.assign(report, { transaction: tx.id, component: tx.component, was: tx.state, now: r.state, action: r.action });
    if (r.action === "wait") {
      return { errors: [{ code: "E_INSTALL_BUSY", component: tx.component, message: `a ${tx.operation} of ${tx.component} started by process ${tx.owner?.pid} is still running` }] };
    }
    if (r.action === "mark-ready") {
      const pending = readPending(c, tx);
      if (pending && active === tx.to) {
        c.put(pending);
        tx.state = "ready";
        c.save();
      } else {
        // the switch happened but what to record about it is lost: put the previous version back, never leave a record that disagrees with the pointer
        // the pointer first: a failure or a crash here leaves the transaction open, so the next start tries again
        if (tx.from) writePointer(c.env.root, tx.app, tx.component, tx.from); else clearPointer(c.env.root, tx.app, tx.component);
        restoreReplaced(c, tx);
        c.end(tx, "interrupted", "the host stopped while a version was switched on, and its record was lost; the previous version was kept");
        if (tx.to && !referenced(c, tx.app, tx.component, tx.to)) dropVersion(c, tx.app, tx.component, tx.to);
      }
    } else if (r.action === "mark-removed") {
      c.drop(tx.app, tx.component);
      clearPointer(c.env.root, tx.app, tx.component);
      tx.state = "removed";
      c.save();
    } else if (r.action === "discard-staging" || r.action === "none" || r.action === "keep-installed") {
      restoreReplaced(c, tx);
      c.end(tx, "interrupted", `the host stopped while the ${tx.operation} was ${tx.state}; the active version is unchanged`);
      if (tx.operation !== "remove" && tx.to && active !== tx.to && !referenced(c, tx.app, tx.component, tx.to)) {
        dropVersion(c, tx.app, tx.component, tx.to);
      }
    }
  }
  // folders that no transaction owns (the lock is held, so none is in use)
  for (const dir of [path.join(c.store.seed, "staging"), path.join(c.store.seed, "trash")]) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { /* none yet */ }
    for (const n of names) removeTree(path.join(dir, n));
  }
  // version folders that no record refers to (a prune that failed after an update): the record names the active and the previous version, nothing else is kept
  for (const rec of c.state.installs) {
    if (rec.origin !== "managed") continue;
    const dir = c.store.component(rec.app, rec.component);
    let versions: string[] = [];
    try { versions = fs.readdirSync(dir); } catch { continue; }
    for (const n of versions) {
      if (!/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(n)) continue;
      if (n === rec.version || n === rec.previous?.version) continue;
      removeTree(path.join(dir, n));
    }
  }
  return {};
}

/** At startup: settles a transaction a previous host left unfinished. Returns what was done. */
export async function recoverInstalls(env: InstallEnv): Promise<{ ok: true; report: RecoveryReport } | { ok: false; errors: ComponentError[] }> {
  const report: RecoveryReport = {};
  fs.mkdirSync(env.root, { recursive: true });
  const got = await withProjectLockAsync(env.root, async () => {
    const read = readInstallState(env.root);
    if (!read.ok) return { errors: read.errors };
    return settle(new Ctx(env, read.state), report);
  }, { waitMs: 0, ...env.lock });
  if (!got.ok) return { ok: false, errors: [{ code: "E_INSTALL_BUSY", message: `another install is running on ${env.root}` }] };
  return got.value.errors ? { ok: false, errors: got.value.errors } : { ok: true, report };
}

// ---- install and update ------------------------------------------------------------------------------------------------

async function obtain(c: Ctx, tx: Transaction, comp: Component, a: Artifact, signal?: AbortSignal): Promise<string> {
  const file = c.store.cacheFile(a.sha256);
  const label = `${comp.id}/${a.id}`;
  if (fs.existsSync(file)) {
    if ((await sha256File(file)) === a.sha256) return file;
    removeTree(file);
    if (!c.env.source) throw failure("E_HASH_MISMATCH", `the cached copy of ${label} did not match its hash and was deleted; it is needed again and nothing can be fetched offline`, comp.id);
  }
  if (!c.env.source) throw failure("E_OFFLINE_MISSING", `${label} is not in the offline cache`, comp.id);
  const part = path.join(c.store.staging(tx.id), "download", a.id + ".part");
  fs.mkdirSync(path.dirname(part), { recursive: true });
  await c.env.source(a, part, signal);
  if (signal?.aborted) throw failure("E_INSTALL_CANCELLED", "cancelled while downloading", comp.id);
  let size: number;
  try { size = fs.statSync(part).size; } catch { throw failure("E_ARTIFACT_MISSING", `the source did not deliver ${label}`, comp.id); }
  if (size !== a.downloadBytes) throw failure("E_HASH_MISMATCH", `${label} is ${size} bytes; the manifest says ${a.downloadBytes}`, comp.id);
  const got = await sha256File(part);
  if (got !== a.sha256) throw failure("E_HASH_MISMATCH", `${label} has the hash ${got}; the manifest pins ${a.sha256}`, comp.id);
  c.inside(c.store.cacheDir);
  fs.mkdirSync(c.store.cacheDir, { recursive: true });
  moveDir(part, file);
  return file;
}

async function stage(c: Ctx, tx: Transaction, comp: Component, signal?: AbortSignal): Promise<string> {
  const staged = path.join(c.store.staging(tx.id), "version");
  c.inside(staged);
  fs.mkdirSync(staged, { recursive: true });
  for (const a of comp.artifacts) {
    if (signal?.aborted) throw failure("E_INSTALL_CANCELLED", "cancelled", comp.id);
    const inCache = await obtain(c, tx, comp, a, signal);
    await c.env.hooks?.step?.(`obtained:${a.id}`, tx);
    // the bytes that are unpacked are a copy the transaction owns, hashed after it was copied: a cache file swapped after its check changes nothing
    const cached = path.join(c.store.staging(tx.id), "verified", a.id);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(inCache, cached, fs.constants.COPYFILE_EXCL);
    const got = await sha256File(cached);
    if (got !== a.sha256) throw failure("E_HASH_MISMATCH", `${comp.id}/${a.id} changed in the cache after it was checked (hash ${got}, pinned ${a.sha256})`, comp.id);
    const into = path.join(staged, a.id);
    if (a.archive === "none") {
      if (fs.statSync(cached).size > a.expandedBytes) throw failure("E_ARCHIVE_TOO_LARGE", `${comp.id}/${a.id} is larger than the ${a.expandedBytes} bytes the manifest declares`, comp.id);
      fs.mkdirSync(into, { recursive: true });
      fs.copyFileSync(cached, path.join(into, a.id), fs.constants.COPYFILE_EXCL);
    } else {
      const r = await extractArchive(cached, a.archive, into, { maxBytes: a.expandedBytes });
      if (!r.ok) throw new Failure({ ...r.error, component: comp.id, message: `${comp.id}/${a.id}: ${r.error.message}` });
    }
    await c.env.hooks?.step?.(`staged:${a.id}`, tx);
  }
  return staged;
}

function newRecord(c: Ctx, comp: Component, manifest: Manifest, manifestSha256: string, selectedByUser: boolean, old: Installed | undefined, location: string): Installed {
  return {
    app: manifest.app, component: comp.id, version: comp.version, origin: "managed", location, manifestSha256,
    artifactSha256: comp.artifacts.map((a) => a.sha256), selectedByUser, installedAt: c.now().toISOString(),
    ...(old ? { previous: { version: old.version, location: old.location, manifestSha256: old.manifestSha256, ...(old.artifactSha256 ? { artifactSha256: old.artifactSha256 } : {}), installedAt: old.installedAt } } : {})
  };
}

/** The switch: move the staged version into place, flip the pointer, record it. Undone completely if it fails before the record is written. */
async function activate(c: Ctx, tx: Transaction, app: string, comp: string, to: string, staged: string | null, rec: Installed, old: Installed | undefined) {
  const final = c.store.version(app, comp, to);
  const oldPointer = readPointer(c.env.root, app, comp);
  let moved = false, flipped = false, aside: string | null = null;
  try {
    if (staged) {
      // a changed pin under the same version number: the old folder is the active one until the switch, so it is set aside, never deleted first
      c.fence();
      c.inside(final);
      if (fs.existsSync(final)) { aside = replacedDir(c, tx); moveDir(final, aside); }
      moveDir(staged, final);
      moved = true;
    }
    await c.env.hooks?.step?.("activating:moved", tx);
    c.fence();
    c.inside(c.store.pointer(app, comp));
    writePointer(c.env.root, app, comp, to);
    flipped = true;
    await c.env.hooks?.step?.("activating:pointer", tx);
    c.put(rec);
    tx.state = "ready";
    await c.env.hooks?.step?.("activating:record", tx);
    c.save();
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    // put everything back exactly: the old version stays the active one
    tx.state = "activating";
    if (old) c.put(old); else c.drop(app, comp);
    if (flipped) { if (oldPointer) writePointer(c.env.root, app, comp, oldPointer); else clearPointer(c.env.root, app, comp); }
    if (moved) dropVersion(c, app, comp, to);
    if (aside) moveDir(aside, final);
    throw e;
  }
}

function pruneOlder(c: Ctx, old: Installed | undefined, keep: Installed) {
  const dead = old?.previous;
  if (dead && old && dead.version !== keep.version && dead.version !== keep.previous?.version) removeTree(c.store.version(old.app, old.component, dead.version));
}

async function installOne(c: Ctx, manifest: Manifest, manifestSha256: string, comp: Component, action: "install" | "update", selectedByUser: boolean, signal?: AbortSignal): Promise<void> {
  const old = c.find(manifest.app, comp.id);
  const tx = await c.newTx(action, manifest.app, comp.id, old?.version, comp.version);
  try {
    await c.phase(tx, "preflight");
    const bad = eligible(comp, c.env.platform, c.env.appVersion);
    if (bad) throw new Failure(bad);
    if (action === "update" && c.env.inUse?.().has(comp.id)) throw failure("E_COMPONENT_IN_USE", `${comp.id} is used by a running launch or job; update it when that has finished`, comp.id);
    const missing = await c.env.prerequisites?.(comp);
    if (missing) throw failure("E_PREREQUISITE", missing, comp.id);
    const need = comp.artifacts.reduce((n, a) => n + a.expandedBytes, 0);
    const free = await (c.env.freeBytes ?? (() => freeBytesAt(c.env.root)))();
    if (need > free) throw failure("E_DISK_SPACE", `${comp.id} needs ${need} bytes on disk, ${free} are free`, comp.id);
    if (signal?.aborted) throw failure("E_INSTALL_CANCELLED", "cancelled", comp.id);

    await c.phase(tx, "staging");
    const staged = await stage(c, tx, comp, signal);
    if (signal?.aborted) throw failure("E_INSTALL_CANCELLED", "cancelled", comp.id);

    await c.phase(tx, "verifying");
    const rec = newRecord(c, comp, manifest, manifestSha256, selectedByUser || (old?.selectedByUser ?? false), old, c.store.version(manifest.app, comp.id, comp.version));
    fs.writeFileSync(path.join(c.store.staging(tx.id), "installed.json"), JSON.stringify(rec));
    const sick = await c.env.healthCheck?.(staged, comp);
    if (sick) throw failure("E_HEALTH_CHECK", `${comp.id} ${comp.version} failed its health check, so it was not switched on: ${sick}`, comp.id);
    if (signal?.aborted) throw failure("E_INSTALL_CANCELLED", "cancelled", comp.id);

    await c.phase(tx, "activating");
    await activate(c, tx, manifest.app, comp.id, comp.version, staged, rec, old);
    // the version is on: what is left over is tidied, and if that fails the next start does it
    try { removeTree(c.store.staging(tx.id)); pruneOlder(c, old, rec); } catch { /* swept at the next start */ }
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    // a source that was stopped by the cancel fails in its own words: it is still a cancel
    const aborted = signal?.aborted === true && tx.state !== "activating";
    const f: ComponentError = aborted ? { code: "E_INSTALL_CANCELLED", component: comp.id, message: "cancelled" }
      : e instanceof Failure ? e.error : { code: "E_INSTALL_FAILED", component: comp.id, message: `${comp.id}: ${(e as Error).message}` };
    const cancelled = f.code === "E_INSTALL_CANCELLED";
    try { removeTree(c.store.staging(tx.id)); } catch { /* the next start deletes it */ }
    if (!isTerminal(tx.state)) c.end(tx, cancelled && canTransition("install", tx.state, "cancelled") ? "cancelled" : "failed", f.message);
    throw new Failure(f);
  }
}

/**
 * Installs the core components and the chosen add-ons (with their libraries) of `manifest`, one transaction each, dependencies first.
 * `manifestSha256` is the pin the catalog holds for the manifest; it is recorded with every component. The first failure stops the run:
 * what was completed before it stays installed and is listed in `completed`.
 */
export async function installSelection(env: InstallEnv, manifest: Manifest, manifestSha256: string, select: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<InstallOutcome> {
  const completed: InstallStepResult[] = [];
  const got = await locked(env, async (c) => {
    const plan = resolveSelection({
      manifest, installed: c.state.installs, select, platform: env.platform, appVersion: env.appVersion,
      cache: cachedShas(env.root), offline: !env.source,
      freeBytes: await (env.freeBytes ?? (() => freeBytesAt(env.root)))()
    });
    if (!plan.ok) return { ok: false as const, errors: plan.errors };
    const byId = new Map(manifest.components.map((x) => [x.id, x]));
    for (const s of plan.steps) {
      const comp = byId.get(s.component)!;
      if (s.action === "keep") {
        const have = c.find(manifest.app, s.component);
        if (have && s.selectedByUser && !have.selectedByUser) { c.put({ ...have, selectedByUser: true }); c.save(); }
        completed.push({ component: s.component, action: "keep", version: s.to });
        continue;
      }
      try {
        await installOne(c, manifest, manifestSha256, comp, s.action, s.selectedByUser, opts.signal);
      } catch (e) {
        if (e instanceof Failure) return { ok: false as const, errors: [e.error] };
        throw e;
      }
      completed.push({ component: s.component, action: s.action, version: s.to });
    }
    return { ok: true as const, plan };
  });
  if (!got.ok) return { ok: false, errors: got.errors, completed };
  if (!got.value.ok) return { ok: false, errors: got.value.errors, completed };
  return { ok: true, steps: completed, cost: got.value.plan.cost };
}

// ---- rollback ----------------------------------------------------------------------------------------------------------

/** Switches a component back to the version it replaced (kept as `previous`). Rolling back again goes forward again. */
export async function rollbackComponent(env: InstallEnv, manifest: Manifest, componentId: string): Promise<{ ok: true; version: string } | { ok: false; errors: ComponentError[] }> {
  const got = await locked(env, async (c) => {
    const old = c.find(manifest.app, componentId);
    const comp = manifest.components.find((x) => x.id === componentId);
    if (!old || !comp) throw failure("E_COMPONENT_UNKNOWN", `${componentId} is not installed`, componentId);
    if (old.origin === "adopted") throw failure("E_ADOPTED_PROTECTED", `${componentId} was adopted, not installed by SEED; SEED will not switch it`, componentId);
    const prev = old.previous;
    if (!prev || !fs.existsSync(prev.location)) throw failure("E_ARTIFACT_MISSING", `no earlier version of ${componentId} is kept`, componentId);
    const tx = await c.newTx("update", manifest.app, componentId, old.version, prev.version);
    try {
      await c.phase(tx, "preflight");
      if (env.inUse?.().has(componentId)) throw failure("E_COMPONENT_IN_USE", `${componentId} is used by a running launch or job; switch it when that has finished`, componentId);
      await c.phase(tx, "staging");
      await c.phase(tx, "verifying");
      const rec: Installed = {
        ...old, version: prev.version, location: prev.location,
        manifestSha256: prev.manifestSha256 ?? old.manifestSha256,
        ...(prev.artifactSha256 ? { artifactSha256: prev.artifactSha256 } : {}),
        installedAt: prev.installedAt ?? old.installedAt,
        previous: { version: old.version, location: old.location, manifestSha256: old.manifestSha256, ...(old.artifactSha256 ? { artifactSha256: old.artifactSha256 } : {}), installedAt: old.installedAt }
      };
      fs.mkdirSync(c.store.staging(tx.id), { recursive: true });
      fs.writeFileSync(path.join(c.store.staging(tx.id), "installed.json"), JSON.stringify(rec));
      const sick = await env.healthCheck?.(prev.location, comp);
      if (sick) throw failure("E_HEALTH_CHECK", `${componentId} ${prev.version} failed its health check, so it was not switched back on: ${sick}`, componentId);
      await c.phase(tx, "activating");
      await activate(c, tx, manifest.app, componentId, prev.version, null, rec, old);
      try { removeTree(c.store.staging(tx.id)); } catch { /* swept at the next start */ }
      return prev.version;
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      const f = e instanceof Failure ? e.error : { code: "E_INSTALL_FAILED" as const, component: componentId, message: (e as Error).message };
      try { removeTree(c.store.staging(tx.id)); } catch { /* the next start deletes it */ }
      if (!isTerminal(tx.state)) c.end(tx, "failed", f.message);
      throw new Failure(f);
    }
  }).catch((e: unknown) => {
    if (e instanceof Failure) return { ok: false as const, errors: [e.error] };
    throw e;
  });
  if (!got.ok) return got;
  return { ok: true, version: got.value };
}

// ---- removal -----------------------------------------------------------------------------------------------------------

/**
 * Removes an add-on, with the libraries that were installed only for it (`planRemoval` decides; it refuses while another component
 * needs it or a job uses it). Files go to a trash folder in one rename and are deleted after the record is written, so a host that
 * dies is settled by `recoverInstalls`. An adopted component is unregistered and its files are left. Project folders, models,
 * results and custom materials are never below a component's folder, so nothing of them is touched.
 */
export async function removeComponent(env: InstallEnv, manifests: Manifest | readonly Manifest[], app: string, componentId: string): Promise<RemoveOutcome> {
  const all = Array.isArray(manifests) ? (manifests as readonly Manifest[]) : [manifests as Manifest];
  const manifest = all.find((m) => m.app === app);
  if (!manifest) return { ok: false, errors: [{ code: "E_COMPONENT_UNKNOWN", message: `no manifest for ${app}` }] };
  const got = await locked(env, async (c) => {
    const plan = planRemoval({ manifest, manifests: all, installed: c.state.installs, remove: componentId, ...(env.inUse ? { inUse: env.inUse() } : {}) });
    if (!plan.ok) throw new Failure(plan.errors[0]!);
    const removed: string[] = [], unregistered: string[] = [];
    for (const s of plan.steps) {
      const have = c.find(app, s.component);
      if (!have) continue;
      const tx = await c.newTx("remove", app, s.component, have.version);
      let trashed = false, saved = false;
      try {
        await c.phase(tx, "preflight");
        await c.phase(tx, "removing");
        if (s.action === "remove" && have.origin === "managed") {
          const dir = c.store.component(app, s.component);
          c.fence();
          c.inside(dir);
          c.inside(c.store.trash(tx.id));
          if (fs.existsSync(dir)) { moveDir(dir, c.store.trash(tx.id)); trashed = true; }
          await env.hooks?.step?.("removing:moved", tx);
          c.fence();
          clearPointer(env.root, app, s.component);
        }
        c.drop(app, s.component);
        tx.state = "removed";
        await env.hooks?.step?.("removing:record", tx);
        c.save();
        saved = true;
        removeTree(c.store.trash(tx.id));
        (s.action === "remove" && have.origin === "managed" ? removed : unregistered).push(s.component);
      } catch (e) {
        if (e instanceof SimulatedCrash) throw e;
        let restored = "";
        if (!saved) {
          // the removal did not reach the state file: the files, the pointer and the record go back as they were
          c.put(have);
          try {
            if (trashed && fs.existsSync(c.store.trash(tx.id))) moveDir(c.store.trash(tx.id), c.store.component(app, s.component));
            if (have.origin === "managed") writePointer(env.root, app, s.component, have.version);
          } catch (r) { restored = `; putting it back also failed (${(r as Error).message}), the files are in ${c.store.trash(tx.id)}`; }
        }
        if (!isTerminal(tx.state) || (tx.state === "removed" && !saved)) { tx.state = "removing"; c.end(tx, "failed", (e as Error).message + restored); }
        throw new Failure({ code: "E_INSTALL_FAILED", component: s.component, message: `removing ${s.component}: ${(e as Error).message}` });
      }
    }
    return { removed, unregistered, kept: plan.kept };
  }).catch((e: unknown) => {
    if (e instanceof Failure) return { ok: false as const, errors: [e.error] };
    throw e;
  });
  if (!got.ok) return got;
  return { ok: true, ...got.value };
}

/** What is recorded as installed, for the shell (a read; it takes no lock). */
export function listInstalled(root: string): { ok: true; installs: Installed[]; transaction?: Transaction } | { ok: false; errors: ComponentError[] } {
  const r = readInstallState(root);
  if (!r.ok) return r;
  return { ok: true, installs: r.state.installs, ...(r.state.transaction ? { transaction: r.state.transaction } : {}) };
}
