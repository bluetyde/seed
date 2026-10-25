import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomicFile";
import { canonicalJson, sha256Hex } from "./canonical";
import { isPortableRelative, resolveInside } from "./paths";
import { isAlive as defaultIsAlive } from "./procTree";
import { checkProject } from "./semantic";
import { validate, type TypedError } from "./validate";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; errors: TypedError[] };
export type Project = { manifest: Record<string, unknown>; revision: string };
export type LockOptions = {
  waitMs?: number;
  staleMs?: number;
  graceMs?: number;
  isAlive?: (pid: number) => boolean;
  host?: string;
  now?: () => Date;
  /** Test hook: runs after a lock was judged stale and before it is renamed away (to force the takeover race). */
  beforeTakeover?: () => void;
  /** Test hook: runs right after the manifest was written and before the writer checks that it still held the lock. */
  afterManifestWrite?: () => void;
  /** Test hook: replaces the recursive delete used for lock folders (to force a failed release). */
  removeTree?: (path: string) => void;
  /** Test hooks: replace the reads, folder creations and owner-file writes of the lock (to force the refusals Windows gives for a moment). */
  io?: {
    readFile?: (path: string) => string;
    mkdir?: (path: string) => void;
    writeOwner?: (path: string, data: string) => void;
    rename?: (from: string, to: string) => void;
  };
  /**
   * withProjectLockAsync only: how often the holder proves it is alive (default staleMs / 4, at most 30 s); 0 turns it off.
   * A lock held by another host (where a process id says nothing) counts as abandoned only once its holder has been silent for staleMs.
   */
  heartbeatMs?: number;
};

export const MANIFEST_FILE = "seed.project.json";

/** When the callback threw and the lock could not be released either, the caller must see both: the lock may still stand and block the next writer. */
function keepReleaseFailure(thrown: unknown, releaseError: TypedError | null): void {
  if (releaseError !== null && thrown instanceof Error) thrown.message += ` (and the lock could not be released: ${releaseError.message})`;
}

function toInternalError(e: unknown): TypedError {
  const nodeErr = e as NodeJS.ErrnoException;
  const code = nodeErr?.code ?? "UNKNOWN";
  const msg = nodeErr?.message ?? String(e);
  return {
    code: "E_INTERNAL",
    field: "",
    message: `${code}: ${msg}`,
    source: "seed",
  };
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const obj = value as Record<string, unknown>;
  const copy = Object.create(Object.getPrototypeOf(obj));
  for (const key of Object.getOwnPropertyNames(obj)) {
    Object.defineProperty(copy, key, {
      value: deepClone(obj[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy as T;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // spin fallback
    }
  }
}

export function projectRevision(manifest: unknown): string {
  return sha256Hex(canonicalJson(manifest));
}

export function createProject(
  dir: string,
  opts: { name: string; seedVersion: string; now?: () => Date; newId?: () => string }
): StoreResult<Project> {
  const nowDate = opts.now ? opts.now() : new Date();
  const timeStr = nowDate.toISOString();
  const projectId = opts.newId ? opts.newId() : `p-${randomBytes(6).toString("hex")}`;

  const manifest: Record<string, unknown> = {
    schema: "seed.project/0.1",
    projectId,
    name: opts.name,
    created: timeStr,
    updated: timeStr,
    seedVersion: opts.seedVersion,
    folders: {
      models: "models",
      runs: "runs",
      studies: "studies",
      oracles: "oracles",
    },
    artifacts: [],
    materials: [],
  };

  const valRes = validate("project", manifest);
  if (!valRes.ok) {
    return valRes;
  }
  const semErrors = checkProject(manifest);
  if (semErrors.length > 0) {
    return { ok: false, errors: semErrors };
  }

  try {
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      if (entries.length > 0) {
        return {
          ok: false,
          errors: [
            {
              code: "E_EXISTS",
              field: "",
              message: `Directory is not empty: ${dir}`,
              source: "seed",
            },
          ],
        };
      }
    }
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "models"), { recursive: true });
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "studies"), { recursive: true });
    mkdirSync(join(dir, "oracles"), { recursive: true });

    const manifestPath = join(dir, MANIFEST_FILE);
    const content = JSON.stringify(manifest, null, 2) + "\n";
    writeFileAtomic(manifestPath, content);
  } catch (err: unknown) {
    return { ok: false, errors: [toInternalError(err)] };
  }

  const revision = projectRevision(manifest);
  return { ok: true, value: { manifest, revision } };
}

export function openProject(dir: string): StoreResult<Project> {
  const manifestPath = join(dir, MANIFEST_FILE);
  let content: string;
  try {
    if (!existsSync(dir) || !existsSync(manifestPath)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_NOT_FOUND",
            field: "",
            message: `Project or manifest not found in ${dir}`,
            source: "seed",
          },
        ],
      };
    }
    content = readFileSync(manifestPath, "utf8");
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr && nodeErr.code === "ENOENT") {
      return {
        ok: false,
        errors: [
          {
            code: "E_NOT_FOUND",
            field: "",
            message: `Project or manifest not found in ${dir}`,
            source: "seed",
          },
        ],
      };
    }
    return { ok: false, errors: [toInternalError(err)] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: "E_SCHEMA_INVALID",
          field: "",
          message: `Invalid JSON in ${MANIFEST_FILE}`,
          source: "seed",
        },
      ],
    };
  }

  const valRes = validate("project", parsed);
  if (!valRes.ok) {
    return valRes;
  }

  const semErrors = checkProject(parsed);
  if (semErrors.length > 0) {
    return { ok: false, errors: semErrors };
  }

  let revision: string;
  try {
    revision = projectRevision(parsed);
  } catch (err: unknown) {
    return { ok: false, errors: [toInternalError(err)] };
  }

  return { ok: true, value: { manifest: parsed as Record<string, unknown>, revision } };
}

type LockAcquireResult =
  | { ok: true; release: () => TypedError | null; beat: () => void; scope: LockScope }
  | { ok: false; errors: TypedError[] };

type LockJudgement =
  | { state: "missing" }
  | { state: "held" }
  | { state: "stale" }
  | { state: "error"; error: TypedError };

function sameDir(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `.seed` must be a real directory directly inside the project: a link would send lock files and deletes elsewhere. */
function checkSeedDir(dir: string, seedDir: string): TypedError | null {
  try {
    if (lstatSync(seedDir).isSymbolicLink()) {
      return {
        code: "E_PATH_TRAVERSAL",
        field: "/.seed",
        message: ".seed is a link; the project's metadata folder must be a real folder inside the project",
        source: "seed",
      };
    }
    const real = realpathSync(seedDir);
    if (!sameDir(dirname(real), realpathSync(dir))) {
      return {
        code: "E_PATH_TRAVERSAL",
        field: "/.seed",
        message: ".seed resolves outside the project",
        source: "seed",
      };
    }
    return null;
  } catch (err: unknown) {
    return toInternalError(err);
  }
}

/**
 * What one acquisition of the writer lock stands for. The callback that holds the lock runs inside its scope (AsyncLocalStorage), so a
 * later save asks the lock about *its own* token: a callback whose lock was taken over stays refused even when another callback of the
 * same process holds the lock by then.
 */
type LockScope = { dir: string; token: string; ownerPath: string };
const lockScope = new AsyncLocalStorage<LockScope>();
const sameProject = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

const BEAT_FILE = "beat";

/**
 * The last sign of life of a lock: its acquisition or the holder's latest heartbeat (a time in the file `beat`), whichever is later. A
 * heartbeat is written to a new file that must not exist yet and renamed over `beat`, so it never writes through a link that the project
 * put at `beat` (a rename replaces the link itself); reading a planted `beat` can only give a wrong time, never harm.
 */
function lastSign(lockDir: string, acquiredMs: number, nowMs: number, staleMs: number): number {
  for (let attempt = 0; ; attempt++) {
    try {
      const beat = Number(readFileSync(join(lockDir, BEAT_FILE), "utf8").trim());
      // The folder is the project's to plant: a time that lies further ahead than a lock may be left alone is no sign of life, or one
      // planted file would keep a dead lock for ever.
      if (!Number.isFinite(beat) || beat > nowMs + staleMs) return acquiredMs;
      return Math.max(acquiredMs, beat);
    } catch (err: unknown) {
      // A beat that its holder is renaming over right now refuses a read for a moment (Windows): that is a live holder, not a stale lock.
      if (TRANSIENT_CODES.has((err as NodeJS.ErrnoException).code ?? "")) {
        if (attempt >= 5) return nowMs;
        sleepSync(10);
        continue;
      }
      return acquiredMs;
    }
  }
}

function judgeLock(
  lockDir: string,
  ownerPath: string,
  o: Required<Pick<LockOptions, "staleMs" | "graceMs" | "isAlive" | "host" | "now">>,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8")
): LockJudgement {
  let owner: { pid: number; host: string; acquiredAt: string } | null = null;
  try {
    let text: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        text = readFile(ownerPath);
        break;
      } catch (err: unknown) {
        // A file that its holder is deleting right now refuses a read for a moment (EPERM, EBUSY, EACCES on Windows). That is a lock in the
        // middle of its release: wait a little, and if it still cannot be read the lock is simply held, not an internal error.
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (!TRANSIENT_CODES.has(code)) throw err;
        if (attempt >= 5) return { state: "held" };
        sleepSync(10);
      }
    }
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      owner = { pid: parsed.pid, host: parsed.host, acquiredAt: parsed.acquiredAt };
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing or half-written owner file is judged below by the age of the lock directory.
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
      return { state: "error", error: toInternalError(err) };
    }
  }
  const nowMs = o.now().getTime();
  if (owner !== null) {
    if (owner.host === o.host) {
      let alive = true;
      try {
        alive = o.isAlive(owner.pid);
      } catch {
        alive = true; // cannot tell: treat the owner as alive
      }
      return alive ? { state: "held" } : { state: "stale" };
    }
    const acquired = new Date(owner.acquiredAt).getTime();
    return !Number.isNaN(acquired) && nowMs - lastSign(lockDir, acquired, nowMs, o.staleMs) > o.staleMs ? { state: "stale" } : { state: "held" };
  }
  try {
    return nowMs - statSync(lockDir).mtimeMs > o.graceMs ? { state: "stale" } : { state: "held" };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "error", error: toInternalError(err) };
  }
}

const RELEASE_RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
/** What Windows answers for a moment while another process holds or deletes a file or folder. */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function acquireLock(dir: string, opts?: LockOptions): LockAcquireResult {
  const seedDir = join(dir, ".seed");
  const lockDir = join(seedDir, "lock");
  const guardDir = join(seedDir, "takeover");
  const ownerPath = join(lockDir, "owner.json");

  try {
    mkdirSync(seedDir, { recursive: true });
  } catch (err: unknown) {
    return { ok: false, errors: [toInternalError(err)] };
  }
  const seedProblem = checkSeedDir(dir, seedDir);
  if (seedProblem !== null) {
    return { ok: false, errors: [seedProblem] };
  }

  const waitMs = opts?.waitMs ?? 0;
  const judging = {
    staleMs: opts?.staleMs ?? 600000,
    graceMs: opts?.graceMs ?? 5000,
    isAlive: opts?.isAlive ?? defaultIsAlive,
    host: opts?.host ?? os.hostname(),
    now: opts?.now ?? (() => new Date()),
  };
  const removeTree = opts?.removeTree ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const makeDir = opts?.io?.mkdir ?? ((p: string) => void mkdirSync(p));
  const readOwnerFile = opts?.io?.readFile;
  const moveAside = opts?.io?.rename ?? ((a: string, b: string) => renameSync(a, b));
  const writeOwner = opts?.io?.writeOwner ?? ((p: string, d: string) => writeFileSync(p, d, { flag: "wx", encoding: "utf8" }));
  const deadline = Date.now() + waitMs;
  const lockedError = (): LockAcquireResult => ({
    ok: false,
    errors: [{ code: "E_PROJECT_LOCKED", field: "", message: `Project is locked: ${dir}`, source: "seed" }],
  });

  for (;;) {
    let acquired = false;
    let refused = false;
    try {
      makeDir(lockDir);
      acquired = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // A folder that its holder is deleting right now refuses mkdir for a moment (EPERM, EBUSY, EACCES on Windows): the lock is being
      // released, so wait and try again instead of reporting an internal error.
      if (TRANSIENT_CODES.has(code)) refused = true;
      else if (code !== "EEXIST") return { ok: false, errors: [toInternalError(err)] };
    }
    if (refused) {
      if (Date.now() >= deadline) return lockedError();
      sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
      continue;
    }

    if (acquired) {
      const token = randomBytes(16).toString("hex");
      const ownerInfo = {
        ownerId: randomBytes(8).toString("hex"),
        pid: process.pid,
        host: judging.host,
        acquiredAt: judging.now().toISOString(),
        token,
      };
      try {
        // "wx": a folder that was removed and made again by somebody else while this process was paused already has their owner file; it
        // is theirs, not ours, and must not be overwritten
        writeOwner(ownerPath, JSON.stringify(ownerInfo, null, 2) + "\n");
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code === "EEXIST" || code === "ENOENT" || TRANSIENT_CODES.has(code)) {
          // not our folder (replaced, removed, or being deleted right now): leave it alone and try again
          if (Date.now() >= deadline) return lockedError();
          sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
          continue;
        }
        try {
          removeTree(lockDir);
        } catch (cleanup: unknown) {
          return {
            ok: false,
            errors: [toInternalError(err), { ...toInternalError(cleanup), message: `lock folder could not be removed after a failed write: ${toInternalError(cleanup).message}` }],
          };
        }
        return { ok: false, errors: [toInternalError(err)] };
      }

      const scope: LockScope = { dir, token, ownerPath };
      const beat = (): void => {
        try {
          const current = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown } | null;
          if (current !== null && current.token === token) {
            const tmp = join(lockDir, BEAT_FILE + "." + randomBytes(6).toString("hex"));
            try {
              writeFileSync(tmp, String(judging.now().getTime()), { flag: "wx" });
              renameSync(tmp, join(lockDir, BEAT_FILE));
            } catch (err) {
              try {
                rmSync(tmp, { force: true });
              } catch {
                // best effort
              }
              throw err;
            }
          }
        } catch {
          // a missed beat is only a smaller margin; the next one or the release tells whether the lock is still ours
        }
      };
      // The lock was taken over while its holder worked: the folder is left alone, but the holder is told, because what it did under the
      // lock may have raced the writer that took over.
      const lostAtRelease = (why: string): TypedError => ({
        code: "E_PROJECT_LOCKED",
        field: "",
        message: `the project lock was no longer this writer's when it was released (${why}); what was done under it may have raced another writer, reopen the project and check it`,
        source: "seed",
      });
      const release = (): TypedError | null => {
        let removing = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const current = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown } | null;
            if (current === null || current.token !== token) return lostAtRelease("another owner holds it"); // leave it alone
            removing = true;
            removeTree(lockDir);
            return null;
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            // gone while this release was deleting it is our own doing; gone before is a takeover
            if (code === "ENOENT" || err instanceof SyntaxError) return removing ? null : lostAtRelease("it is gone or unreadable");
            if (RELEASE_RETRY_CODES.has(code ?? "") && attempt < 3) {
              sleepSync(25);
              continue;
            }
            const e = toInternalError(err);
            return { ...e, message: `the project lock could not be released (run recoverProject once the cause is fixed): ${e.message}` };
          }
        }
        return null;
      };
      return { ok: true, release, beat, scope };
    }

    // The lock exists. Judge it; a stale lock is taken over under the takeover guard.
    const first = judgeLock(lockDir, ownerPath, judging, readOwnerFile);
    if (first.state === "error") {
      return { ok: false, errors: [first.error] };
    }
    if (first.state === "missing") continue;

    if (first.state === "stale") {
      opts?.beforeTakeover?.();
      let guarded = false;
      // The guard is a claim like the lock: its folder holds an owner file with a token only its holder knows, so that a contender that
      // was starved while it held the guard cannot, on its way out, delete the guard of the contender that took over from it.
      const guardToken = randomBytes(8).toString("hex");
      const guardOwnerPath = join(guardDir, "owner.json");
      const readGuardOwner = (): { pid: number; host: string; token: string } | null => {
        try {
          const o = JSON.parse(readFileSync(guardOwnerPath, "utf8")) as Record<string, unknown> | null;
          return o !== null && typeof o === "object" && typeof o.pid === "number" && typeof o.host === "string" && typeof o.token === "string"
            ? { pid: o.pid, host: o.host, token: o.token }
            : null;
        } catch {
          return null;
        }
      };
      // abandoned: its holder's process is gone (same host), or it names no readable holder and is older than graceMs
      const guardAbandoned = (): boolean => {
        const holder = readGuardOwner();
        if (holder !== null && holder.host === judging.host) {
          try {
            return !judging.isAlive(holder.pid);
          } catch {
            return false;
          }
        }
        try {
          return judging.now().getTime() - statSync(guardDir).mtimeMs > judging.graceMs;
        } catch {
          return false; // gone already
        }
      };
      try {
        makeDir(guardDir);
        try {
          writeOwner(guardOwnerPath, JSON.stringify({ pid: process.pid, host: judging.host, token: guardToken }));
          guarded = true;
        } catch (ownerErr: unknown) {
          const c = (ownerErr as NodeJS.ErrnoException).code ?? "";
          // not ours any more, or being deleted right now: somebody else is judging. An owner-less guard of ours expires after graceMs.
          if (c !== "EEXIST" && c !== "ENOENT" && !TRANSIENT_CODES.has(c)) return { ok: false, errors: [toInternalError(ownerErr)] };
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code === "EEXIST") {
          // Another contender holds the guard, unless its holder is gone. An abandoned guard is judged again before every attempt to remove
          // it: one that was removed and made again by a live contender in the meantime is left alone.
          for (let attempt = 0; attempt < 20 && guardAbandoned(); attempt++) {
            try {
              removeTree(guardDir);
              break;
            } catch (guardErr: unknown) {
              const c = (guardErr as NodeJS.ErrnoException).code ?? "";
              if (c === "ENOENT") break;
              if (!TRANSIENT_CODES.has(c)) return { ok: false, errors: [toInternalError(guardErr)] };
              sleepSync(10);
            }
          }
        } else if (!TRANSIENT_CODES.has(code)) {
          // a folder that is being deleted right now refuses mkdir for a moment: somebody else is judging, so not now
          return { ok: false, errors: [toInternalError(err)] };
        }
      }
      if (guarded) {
        try {
          // Judge again under the guard: only a guard holder removes a lock that is not its own, so a lock
          // that is stale now cannot be replaced before the rename below.
          const second = judgeLock(lockDir, ownerPath, judging, readOwnerFile);
          if (second.state === "error") {
            return { ok: false, errors: [second.error] };
          }
          if (second.state === "stale") {
            const staleDir = join(seedDir, `lock.stale-${randomBytes(8).toString("hex")}`);
            try {
              moveAside(lockDir, staleDir);
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException).code ?? "";
              if (code === "ENOENT") continue; // somebody else already moved it
              if (TRANSIENT_CODES.has(code)) {
                // something holds the stale folder for a moment (a scanner, another process reading it): not now, judge again
                if (Date.now() >= deadline) return lockedError();
                sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
                continue;
              }
              return { ok: false, errors: [toInternalError(err)] };
            }
            try {
              removeTree(staleDir);
            } catch (err: unknown) {
              const e = toInternalError(err);
              return { ok: false, errors: [{ ...e, message: `a stale lock was moved aside but not deleted (${staleDir}): ${e.message}` }] };
            }
          }
        } finally {
          // only the holder's own token releases the guard, and the check is repeated before every attempt
          for (let attempt = 0; attempt < 20 && readGuardOwner()?.token === guardToken; attempt++) {
            try {
              removeTree(guardDir);
              break;
            } catch (releaseErr: unknown) {
              if (!TRANSIENT_CODES.has((releaseErr as NodeJS.ErrnoException).code ?? "")) break;
              sleepSync(10);
            }
          }
          // an owner-less or abandoned guard that could not be removed is taken over by the next contender once it is abandoned
        }
        continue;
      }
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        errors: [{ code: "E_PROJECT_LOCKED", field: "", message: `Project is locked: ${dir}`, source: "seed" }],
      };
    }
    sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

function isThenable(v: unknown): boolean {
  return v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";
}

/** Runs a synchronous `fn` under the writer lock. A promise-returning `fn` is refused: use `withProjectLockAsync`. */
export function withProjectLock<T>(dir: string, fn: () => T, opts?: LockOptions): StoreResult<T> {
  const acq = acquireLock(dir, opts);
  if (!acq.ok) {
    return acq;
  }
  let val: T;
  try {
    val = lockScope.run(acq.scope, fn);
  } catch (err: unknown) {
    keepReleaseFailure(err, acq.release());
    throw err;
  }
  const releaseError = acq.release();
  if (isThenable(val)) {
    // The callback's work is not covered by the lock. Keep a rejection from becoming an unhandled one.
    (val as unknown as Promise<unknown>).then(undefined, () => undefined);
    return {
      ok: false,
      errors: [{ code: "E_INTERNAL", field: "", message: "withProjectLock needs a synchronous callback; use withProjectLockAsync for async work", source: "seed" }],
    };
  }
  if (releaseError !== null) {
    return { ok: false, errors: [releaseError] };
  }
  return { ok: true, value: val };
}

/** Holds the writer lock until the promise returned by `fn` settles. */
export async function withProjectLockAsync<T>(dir: string, fn: () => Promise<T>, opts?: LockOptions): Promise<StoreResult<T>> {
  const acq = acquireLock(dir, opts);
  if (!acq.ok) {
    return acq;
  }
  // An asynchronous holder can wait on an adapter for a long time; its heartbeat is what tells a contender on another host that it is alive.
  const beatMs = opts?.heartbeatMs ?? Math.min(30000, Math.floor((opts?.staleMs ?? 600000) / 4));
  const timer = beatMs > 0 ? setInterval(acq.beat, beatMs) : undefined;
  timer?.unref();
  let val: T;
  try {
    val = await lockScope.run(acq.scope, fn);
  } catch (err: unknown) {
    if (timer) clearInterval(timer);
    keepReleaseFailure(err, acq.release());
    throw err;
  }
  if (timer) clearInterval(timer);
  const releaseError = acq.release();
  if (releaseError !== null) {
    return { ok: false, errors: [releaseError] };
  }
  return { ok: true, value: val };
}

export function saveProject(
  dir: string,
  manifest: Record<string, unknown>,
  expectedRevision: string,
  opts?: LockOptions & { now?: () => Date }
): StoreResult<Project> {
  const acq = acquireLock(dir, opts);
  if (!acq.ok) {
    return acq;
  }
  let result: StoreResult<Project>;
  try {
    result = lockScope.run(acq.scope, () => saveLocked(dir, manifest, expectedRevision, opts, lockFence(dir)));
  } catch (err: unknown) {
    keepReleaseFailure(err, acq.release());
    throw err;
  }
  const releaseError = acq.release();
  if (releaseError !== null) {
    // a save that already said the lock was lost says it best; any other refusal is kept and the release problem is added to it
    if (!result.ok) return result.errors.some((e) => e.code === releaseError.code) ? result : { ok: false, errors: [...result.errors, releaseError] };
    return { ok: false, errors: [{ ...releaseError, message: "the project was saved, but " + releaseError.message }] };
  }
  return result;
}

/** The check a save makes against the lock scope it runs in, before the write and again after it. */
function lockFence(dir: string): (after?: boolean) => TypedError | null {
  const fence = (after = false): TypedError | null => {
    const held = lockScope.getStore();
    const lost = (why: string): TypedError => ({
      code: "E_PROJECT_LOCKED",
      field: "",
      message: after
        ? `the project lock was no longer this writer's when the manifest had been written (${why}); the manifest may have replaced a newer writer's save, reopen the project and check it`
        : `the project lock is not this writer's (${why}); nothing was saved`,
      source: "seed",
    });
    if (!held || !sameProject(held.dir, dir)) return lost("this callback does not hold it");
    try {
      const current = JSON.parse(readFileSync(held.ownerPath, "utf8")) as { token?: unknown } | null;
      return current !== null && current.token === held.token ? null : lost("it was taken over");
    } catch {
      return lost("it is gone or unreadable");
    }
  };
  return fence;
}

/** Throws when the callback that calls it no longer holds the writer lock of `dir` (it was taken over, removed, or this code does not run under it). For a holder that writes in several steps and must stop before the next irreversible one. */
export function assertLockHeld(dir: string): void {
  const e = lockFence(dir)(false);
  if (e) throw new Error(e.message);
}

/** Saves while the caller already holds the writer lock (inside withProjectLock or withProjectLockAsync): one critical section for a file change and its revision. */
export function saveProjectHeld(
  dir: string,
  manifest: Record<string, unknown>,
  expectedRevision: string,
  opts?: LockOptions & { now?: () => Date }
): StoreResult<Project> {
  return saveLocked(dir, manifest, expectedRevision, opts, lockFence(dir));
}

function saveLocked(
  dir: string,
  manifest: Record<string, unknown>,
  expectedRevision: string,
  opts?: LockOptions & { now?: () => Date },
  fence?: (after?: boolean) => TypedError | null
): StoreResult<Project> {
  {
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_NOT_FOUND",
            field: "",
            message: `Project manifest not found: ${manifestPath}`,
            source: "seed",
          },
        ],
      };
    }

    let storedRaw: string;
    try {
      storedRaw = readFileSync(manifestPath, "utf8");
    } catch (err: unknown) {
      return { ok: false, errors: [toInternalError(err)] };
    }

    let storedManifest: Record<string, unknown>;
    try {
      storedManifest = JSON.parse(storedRaw);
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_INVALID",
            field: "",
            message: `Invalid JSON in ${MANIFEST_FILE}`,
            source: "seed",
          },
        ],
      };
    }

    const storedRevision = projectRevision(storedManifest);
    if (storedRevision !== expectedRevision) {
      // The refusal is recorded (acceptance case 6): the second writer's attempt, what it expected and what the project held.
      try {
        appendFileSync(
          join(dir, ".seed", "conflicts.jsonl"),
          JSON.stringify({ time: (opts?.now?.() ?? new Date()).toISOString(), code: "E_STALE_REVISION", expectedRevision, observedRevision: storedRevision }) + "\n"
        );
      } catch {
        // the record is best effort; the refusal itself is what protects the manifest
      }
      return {
        ok: false,
        errors: [
          {
            code: "E_STALE_REVISION",
            field: "/revision",
            message: `Expected revision ${expectedRevision} but found ${storedRevision}`,
            source: "seed",
          },
        ],
      };
    }

    const newManifest = deepClone(manifest);

    const valRes = validate("project", newManifest);
    if (!valRes.ok) {
      return valRes;
    }

    const semErrors = checkProject(newManifest);
    if (semErrors.length > 0) {
      return { ok: false, errors: semErrors };
    }

    if (newManifest.projectId !== storedManifest.projectId) {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_INVALID",
            field: "/projectId",
            message: "projectId cannot be changed",
            source: "seed",
          },
        ],
      };
    }

    if (newManifest.created !== storedManifest.created) {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_INVALID",
            field: "/created",
            message: "created timestamp cannot be changed",
            source: "seed",
          },
        ],
      };
    }

    const storedMats = Array.isArray(storedManifest.materials)
      ? (storedManifest.materials as Array<Record<string, unknown>>)
      : [];
    const newMats = Array.isArray(newManifest.materials)
      ? (newManifest.materials as Array<Record<string, unknown>>)
      : [];

    const storedMatMap = new Map<string, Record<string, unknown>>();
    for (const sm of storedMats) {
      if (sm && typeof sm.id === "string") {
        storedMatMap.set(sm.id, sm);
      }
    }

    for (let i = 0; i < newMats.length; i++) {
      const nm = newMats[i];
      if (!nm || typeof nm.id !== "string") continue;
      const sm = storedMatMap.get(nm.id);
      if (sm) {
        const smCanonical = canonicalJson({ name: sm.name, sets: sm.sets });
        const nmCanonical = canonicalJson({ name: nm.name, sets: nm.sets });
        const isUnchanged = smCanonical === nmCanonical;
        const smRev = sm.revision;
        const nmRev = nm.revision;

        if (isUnchanged) {
          if (nmRev !== smRev) {
            return {
              ok: false,
              errors: [
                {
                  code: "E_SCHEMA_INVALID",
                  field: `/materials/${i}/revision`,
                  message: "Material revision must not change when name and sets are unchanged",
                  source: "seed",
                },
              ],
            };
          }
        } else {
          if (typeof nmRev !== "number" || typeof smRev !== "number" || nmRev <= smRev) {
            return {
              ok: false,
              errors: [
                {
                  code: "E_SCHEMA_INVALID",
                  field: `/materials/${i}/revision`,
                  message: "Material revision must strictly increase when content changes",
                  source: "seed",
                },
              ],
            };
          }
        }
      }
    }

    const getNow = opts?.now ?? (() => new Date());
    const nowDate = getNow();
    const nowIso = nowDate.toISOString();
    const storedUpdated = storedManifest.updated as string;
    const storedUpdatedTime = new Date(storedUpdated).getTime();
    const nowTime = nowDate.getTime();

    const effectiveUpdated = nowTime >= storedUpdatedTime ? nowIso : new Date(storedUpdated).toISOString();
    newManifest.updated = effectiveUpdated;

    // the last look before the write: a writer whose lock was taken over while it worked must not save
    const lostLock = fence?.() ?? null;
    if (lostLock !== null) return { ok: false, errors: [lostLock] };
    try {
      const content = JSON.stringify(newManifest, null, 2) + "\n";
      writeFileAtomic(manifestPath, content);
    } catch (err: unknown) {
      return { ok: false, errors: [toInternalError(err)] };
    }
    // Between the last look and the rename nothing can stop a writer whose lock was taken over meanwhile (a process that was suspended,
    // a disk that stalled): the revision was checked before, so the write can replace a newer save. Say so rather than report success.
    opts?.afterManifestWrite?.();
    const lostAfter = fence?.(true) ?? null;
    if (lostAfter !== null) return { ok: false, errors: [lostAfter] };

    const newRev = projectRevision(newManifest);
    return { ok: true, value: { manifest: newManifest, revision: newRev } };
  }
}

export function recoverProject(dir: string, opts?: LockOptions): StoreResult<string[]> {
  const acq = acquireLock(dir, { ...opts, waitMs: 0 });
  if (!acq.ok) {
    return acq;
  }
  let result: StoreResult<string[]>;
  try {
    result = recoverLocked(dir);
  } catch (err: unknown) {
    keepReleaseFailure(err, acq.release());
    throw err;
  }
  const releaseError = acq.release();
  return releaseError !== null ? { ok: false, errors: [releaseError] } : result;
}

function recoverLocked(dir: string): StoreResult<string[]> {
  const removed: string[] = [];
  {
    if (existsSync(dir)) {
      const rootEntries = readdirSync(dir);
      for (const entry of rootEntries) {
        if (/^seed\.project\.json\.tmp-/.test(entry)) {
          const p = join(dir, entry);
          try {
            rmSync(p, { recursive: true, force: true });
            removed.push(entry);
          } catch (err: unknown) {
            return { ok: false, errors: [toInternalError(err)] };
          }
        }
      }
    }

    const seedDir = join(dir, ".seed");
    if (existsSync(seedDir)) {
      const seedEntries = readdirSync(seedDir);
      for (const entry of seedEntries) {
        if (/^lock\.stale-/.test(entry)) {
          const p = join(seedDir, entry);
          try {
            rmSync(p, { recursive: true, force: true });
            removed.push(entry);
          } catch (err: unknown) {
            return { ok: false, errors: [toInternalError(err)] };
          }
        }
      }
    }
  }

  return { ok: true, value: removed };
}

export function resolveArtifact(dir: string, artifactId: string): StoreResult<string> {
  const openRes = openProject(dir);
  if (!openRes.ok) {
    return openRes;
  }

  const manifest = openRes.value.manifest;
  const artifacts = Array.isArray(manifest.artifacts)
    ? (manifest.artifacts as Array<Record<string, unknown>>)
    : [];

  let index = -1;
  for (let i = 0; i < artifacts.length; i++) {
    if (artifacts[i]?.id === artifactId) {
      index = i;
      break;
    }
  }

  if (index === -1) {
    return {
      ok: false,
      errors: [
        {
          code: "E_NOT_FOUND",
          field: "",
          message: `Artifact ${artifactId} not found`,
          source: "seed",
        },
      ],
    };
  }

  const art = artifacts[index]!;
  const relPath = typeof art.path === "string" ? art.path : "";
  const field = `/artifacts/${index}/path`;

  const portRes = isPortableRelative(relPath);
  if (!portRes.ok) {
    return {
      ok: false,
      errors: [
        {
          code: portRes.error.code,
          field,
          message: portRes.error.message,
          source: "seed",
        },
      ],
    };
  }

  const insideRes = resolveInside(dir, relPath);
  if (!insideRes.ok) {
    return {
      ok: false,
      errors: [
        {
          code: insideRes.error.code,
          field,
          message: insideRes.error.message,
          source: "seed",
        },
      ],
    };
  }

  const resolvedTarget = insideRes.value;

  if (!existsSync(resolvedTarget)) {
    return {
      ok: false,
      errors: [
        {
          code: "E_NOT_FOUND",
          field,
          message: `Artifact file does not exist: ${relPath}`,
          source: "seed",
        },
      ],
    };
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(dir);
    realTarget = realpathSync(resolvedTarget);
  } catch (err: unknown) {
    return { ok: false, errors: [toInternalError(err)] };
  }

  const sep = process.platform === "win32" ? "\\" : "/";
  const normRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const isInside =
    process.platform === "win32"
      ? realTarget.toLowerCase().startsWith(normRoot.toLowerCase())
      : realTarget.startsWith(normRoot);

  if (!isInside) {
    return {
      ok: false,
      errors: [
        {
          code: "E_PATH_TRAVERSAL",
          field,
          message: "Artifact resolves outside project root through symlink",
          source: "seed",
        },
      ],
    };
  }

  return { ok: true, value: resolvedTarget };
}

export function listMissingArtifacts(dir: string): StoreResult<string[]> {
  const openRes = openProject(dir);
  if (!openRes.ok) {
    return openRes;
  }

  const manifest = openRes.value.manifest;
  const artifacts = Array.isArray(manifest.artifacts)
    ? (manifest.artifacts as Array<Record<string, unknown>>)
    : [];

  const missing: string[] = [];
  for (const art of artifacts) {
    if (!art || typeof art.id !== "string" || typeof art.path !== "string") continue;
    const insideRes = resolveInside(dir, art.path);
    if (!insideRes.ok || !existsSync(insideRes.value)) {
      missing.push(art.id);
    }
  }

  return { ok: true, value: missing };
}
