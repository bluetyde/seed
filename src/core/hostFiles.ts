import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";

export const MAX_HOST_FILE = 8 * 1024 * 1024;
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
export function regularFile(file: string): void {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_HOST_FILE) throw Error("host file must be a bounded regular file");
}
export function readHostJson(file: string): any {
  regularFile(file); return JSON.parse(readFileSync(file, "utf8"));
}
export function safeChild(root: string, name: string, directory = false): string {
  const parent = realpathSync(root);
  const child = join(parent, name);
  if (!inside(parent, child) || child === parent) throw Error("host state path leaves its root");
  let ancestor = parent;
  for (const component of relative(parent, child).split(sep)) {
    ancestor = join(ancestor, component);
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw Error("host state path must not contain linked ancestors");
  }
  if (existsSync(child)) {
    const s = lstatSync(child);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error("host state path must not be a link or have the wrong type");
  }
  return child;
}
/** Flush the contents before rename. Local filesystem; directory metadata durability is OS-dependent. */
export function writeHostJson(file: string, value: unknown): void {
  if (!isAbsolute(file)) throw Error("host path must be absolute");
  const parent = realpathSync(dirname(file)); const target = safeChild(parent, file.slice(dirname(file).length + 1));
  const temporary = target + ".tmp-" + randomBytes(8).toString("hex");
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target);
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) rmSync(temporary); }
}

export type AdmissionRow = { schema: "seed.admission/0.1"; seq: number; time: string; prev: string | null; event: unknown; hash: string };
/** Caller holds the engine lease. A partial/corrupt log blocks further admission; never reset it. */
export function readAdmissions(root: string): AdmissionRow[] {
  const file = safeChild(root, "admissions.jsonl");
  let seq = 0; let prev: string | null = null;
  const rows: AdmissionRow[] = [];
  if (existsSync(file)) {
    regularFile(file); const text = readFileSync(file, "utf8");
    if (text && !text.endsWith("\n")) throw Error("admission log has a partial final line");
    for (const line of text ? text.slice(0, -1).split("\n") : []) {
      const row = JSON.parse(line) as AdmissionRow; const { hash, ...body } = row;
      if (row.schema !== "seed.admission/0.1" || row.seq !== seq + 1 || row.prev !== prev || sha256Hex(canonicalJson(body)) !== hash) throw Error("admission log hash chain is invalid");
      seq = row.seq; prev = row.hash;
      rows.push(row);
    }
  }
  return rows;
}
export function appendAdmission(root: string, event: unknown): AdmissionRow {
  const file = safeChild(root, "admissions.jsonl");
  const rows = readAdmissions(root);
  const seq = rows.length; const prev = rows.at(-1)?.hash ?? null;
  const body = { schema: "seed.admission/0.1" as const, seq: seq + 1, time: new Date().toISOString(), prev, event };
  const row = { ...body, hash: sha256Hex(canonicalJson(body)) };
  const bytes = Buffer.from(JSON.stringify(row) + "\n");
  if (existsSync(file) && lstatSync(file).size + bytes.length > MAX_HOST_FILE) throw Error("admission log is full; archive it through trusted host maintenance");
  if (bytes.length > MAX_HOST_FILE) throw Error("admission event exceeds the log limit");
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try { let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written <= 0) throw Error("admission write made no progress"); offset += written; } fsyncSync(fd); }
  finally { closeSync(fd); }
  return row;
}

/** Crash leaves the lease in place; orphan engine work must be inspected before manual recovery. */
export async function withEngineLease<T>(stateRoot: string, engineKey: string, fn: (engineRoot: string) => Promise<T>): Promise<T> {
  const engines = safeChild(stateRoot, "engines", true); mkdirSync(engines, { recursive: true });
  const engineRoot = safeChild(engines, sha256Hex(engineKey), true); mkdirSync(engineRoot, { recursive: true });
  const lease = safeChild(engineRoot, "lease", true);
  try { mkdirSync(lease); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw Error("E_ENGINE_BUSY: engine lease exists; it may be running or need human recovery"); throw e; }
  const token = randomBytes(16).toString("hex");
  try {
    writeHostJson(join(lease, "owner.json"), { pid: process.pid, token, acquiredAt: new Date().toISOString() });
    return await fn(engineRoot);
  } finally {
    // If owner creation failed, leave the lease for inspection rather than guessing ownership.
    if (existsSync(join(lease, "owner.json")) && readHostJson(join(lease, "owner.json")).token === token &&
      readHostJson(join(lease, "owner.json")).retain !== true) {
      safeChild(engineRoot, "lease", true); rmSync(lease, { recursive: true });
    }
  }
}
