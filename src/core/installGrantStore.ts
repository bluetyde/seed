import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./canonical";
import { MAX_HOST_FILE, regularFile, safeChild } from "./hostFiles";
import type { GrantEvent } from "./installGrant";
import { withProjectLock } from "./projectStore";

/**
 * The install grants of a host: one hash-chained event log, `install-grants.jsonl`, in the host's state folder (outside every project and
 * study, written only by the admin verbs and by the host when it admits a request). A log that is damaged, cut or edited is refused as a
 * whole: no grant is read from it, and nothing is installed under it. Appending takes the writer lock of the state folder, so a grant issued
 * and a request admitted at the same moment can not both take the same sequence number.
 */

export type GrantRow = { schema: "seed.install-grant-log/0.1"; seq: number; time: string; prev: string | null; event: GrantEvent; hash: string };
const FILE = "install-grants.jsonl";

export function readGrantLog(stateRoot: string): GrantRow[] {
  const file = safeChild(stateRoot, FILE);
  const rows: GrantRow[] = [];
  if (!existsSync(file)) return rows;
  regularFile(file);
  const text = readFileSync(file, "utf8");
  if (text && !text.endsWith("\n")) throw Error("the install grant log has a partial final line");
  let seq = 0;
  let prev: string | null = null;
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    const row = JSON.parse(line) as GrantRow;
    const { hash, ...body } = row;
    if (row.schema !== "seed.install-grant-log/0.1" || row.seq !== seq + 1 || row.prev !== prev || sha256Hex(canonicalJson(body)) !== hash) throw Error("the install grant log hash chain is invalid");
    seq = row.seq;
    prev = row.hash;
    rows.push(row);
  }
  return rows;
}

/** Appends one event; `decide` sees the log as it is under the lock and may refuse by returning an error string (nothing is written). */
export function appendGrantEvent<T>(stateRoot: string, make: (rows: readonly GrantRow[]) => { event: GrantEvent; value: T } | { refuse: string }, now: () => Date = () => new Date()): { ok: true; value: T; row: GrantRow } | { ok: false; message: string } {
  mkdirSync(stateRoot, { recursive: true });
  const locked = withProjectLock(stateRoot, () => {
    const file = safeChild(stateRoot, FILE);
    const rows = readGrantLog(stateRoot);
    const made = make(rows);
    if ("refuse" in made) return { ok: false as const, message: made.refuse };
    const body = { schema: "seed.install-grant-log/0.1" as const, seq: rows.length + 1, time: now().toISOString(), prev: rows.at(-1)?.hash ?? null, event: made.event };
    const row: GrantRow = { ...body, hash: sha256Hex(canonicalJson(body)) };
    const bytes = Buffer.from(JSON.stringify(row) + "\n");
    if (existsSync(file) && lstatSync(file).size + bytes.length > MAX_HOST_FILE) return { ok: false as const, message: "the install grant log is full; archive it through trusted host maintenance" };
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      let off = 0;
      while (off < bytes.length) {
        const n = writeSync(fd, bytes, off, bytes.length - off);
        if (n <= 0) throw Error("the install grant log write made no progress");
        off += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true as const, value: made.value, row };
  }, { waitMs: 5000 });
  if (!locked.ok) return { ok: false, message: locked.errors.map((e) => e.message).join("; ") };
  return locked.value;
}
