import { randomBytes } from "node:crypto";
import {
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
import os from "node:os";
import { dirname, join } from "node:path";
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
  /** Test hook: replaces the recursive delete used for lock folders (to force a failed release). */
  removeTree?: (path: string) => void;
};

export const MANIFEST_FILE = "seed.project.json";

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
  | { ok: true; release: () => TypedError | null }
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

function judgeLock(lockDir: string, ownerPath: string, o: Required<Pick<LockOptions, "staleMs" | "graceMs" | "isAlive" | "host" | "now">>): LockJudgement {
  let owner: { pid: number; host: string; acquiredAt: string } | null = null;
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown> | null;
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
    return !Number.isNaN(acquired) && nowMs - acquired > o.staleMs ? { state: "stale" } : { state: "held" };
  }
  try {
    return nowMs - statSync(lockDir).mtimeMs > o.graceMs ? { state: "stale" } : { state: "held" };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "error", error: toInternalError(err) };
  }
}

const RELEASE_RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

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
  const deadline = Date.now() + waitMs;

  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockDir);
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, errors: [toInternalError(err)] };
      }
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
        writeFileSync(ownerPath, JSON.stringify(ownerInfo, null, 2) + "\n", "utf8");
      } catch (err: unknown) {
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

      const release = (): TypedError | null => {
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const current = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown } | null;
            if (current === null || current.token !== token) return null; // not ours any more: leave it alone
            removeTree(lockDir);
            return null;
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || err instanceof SyntaxError) return null; // already gone, or replaced by another owner
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
      return { ok: true, release };
    }

    // The lock exists. Judge it; a stale lock is taken over under the takeover guard.
    const first = judgeLock(lockDir, ownerPath, judging);
    if (first.state === "error") {
      return { ok: false, errors: [first.error] };
    }
    if (first.state === "missing") continue;

    if (first.state === "stale") {
      opts?.beforeTakeover?.();
      let guarded = false;
      try {
        mkdirSync(guardDir);
        guarded = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          return { ok: false, errors: [toInternalError(err)] };
        }
        // Another contender holds the guard. A guard that old was abandoned by a crashed contender.
        try {
          if (judging.now().getTime() - statSync(guardDir).mtimeMs > judging.graceMs) removeTree(guardDir);
        } catch (guardErr: unknown) {
          if ((guardErr as NodeJS.ErrnoException).code !== "ENOENT") {
            return { ok: false, errors: [toInternalError(guardErr)] };
          }
        }
      }
      if (guarded) {
        try {
          // Judge again under the guard: only a guard holder removes a lock that is not its own, so a lock
          // that is stale now cannot be replaced before the rename below.
          const second = judgeLock(lockDir, ownerPath, judging);
          if (second.state === "error") {
            return { ok: false, errors: [second.error] };
          }
          if (second.state === "stale") {
            const staleDir = join(seedDir, `lock.stale-${randomBytes(8).toString("hex")}`);
            try {
              renameSync(lockDir, staleDir);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                return { ok: false, errors: [toInternalError(err)] };
              }
              continue;
            }
            try {
              removeTree(staleDir);
            } catch (err: unknown) {
              const e = toInternalError(err);
              return { ok: false, errors: [{ ...e, message: `a stale lock was moved aside but not deleted (${staleDir}): ${e.message}` }] };
            }
          }
        } finally {
          try {
            removeTree(guardDir);
          } catch {
            // an abandoned guard is removed by the next contender once it is older than graceMs
          }
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
    val = fn();
  } catch (err: unknown) {
    acq.release();
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
  let val: T;
  try {
    val = await fn();
  } catch (err: unknown) {
    acq.release();
    throw err;
  }
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
    result = saveLocked(dir, manifest, expectedRevision, opts);
  } catch (err: unknown) {
    acq.release();
    throw err;
  }
  const releaseError = acq.release();
  if (releaseError !== null) {
    return { ok: false, errors: [{ ...releaseError, message: (result.ok ? "the project was saved, but " : "") + releaseError.message }] };
  }
  return result;
}

function saveLocked(
  dir: string,
  manifest: Record<string, unknown>,
  expectedRevision: string,
  opts?: LockOptions & { now?: () => Date }
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

    try {
      const content = JSON.stringify(newManifest, null, 2) + "\n";
      writeFileAtomic(manifestPath, content);
    } catch (err: unknown) {
      return { ok: false, errors: [toInternalError(err)] };
    }

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
    acq.release();
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
