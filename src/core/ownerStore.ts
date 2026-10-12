// One process-owner record per app launch or job (runtime contract, "Process ownership"): a small JSON file in SEED's own store folder, written when the
// process starts and marked stopped when it ends. The records are what lets a restarted host find processes a dead host left behind (acceptance R4) and
// what stops a stale record from authorizing a kill (R5). Files are written to a temporary name and renamed, so a reader never sees half a record.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicFile";
import { validateProcessOwner } from "./components";

export type OwnerState = "starting" | "running" | "stopping" | "stopped" | "orphaned";
export type OwnerIdentity = { pid: number; startIdentity: string; host?: string };
export type OwnerRecord = {
  schema: "seed.process-owner/0.1";
  launchId: string;
  kind: "launch" | "job";
  runtime: { component: string; version: string };
  supervisor: "seed" | "standalone";
  host: OwnerIdentity;
  worker?: { via: "native" | "wsl"; distro?: string; identity: OwnerIdentity };
  endpoint?: string;
  generation: string;
  state: OwnerState;
  startedAt: string;
};

export type OwnerListing = { records: OwnerRecord[]; unreadable: { file: string; reason: string }[] };

const FILE = /^[0-9a-f]{32}\.json$/;

export class OwnerStore {
  constructor(private readonly dir: string) {}

  private file(launchId: string): string {
    if (!/^[0-9a-f]{32}$/.test(launchId)) throw new Error("a launch id is 32 hex characters");
    return join(this.dir, `${launchId}.json`);
  }

  /** Writes (or replaces) a record. A record that does not match the schema is refused: nothing is written. */
  write(record: OwnerRecord): void {
    const ok = validateProcessOwner(record);
    if (!ok.ok) throw new Error(`process-owner record refused: ${ok.errors.map((e) => `${e.code} ${e.message}`).join("; ")}`);
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file(record.launchId), JSON.stringify(record, null, 2) + "\n");
  }

  read(launchId: string): OwnerRecord | null {
    const p = this.file(launchId);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")) as OwnerRecord; } catch { return null; }
  }

  /** Every record in the folder. A file that is not a valid record is reported, never silently dropped and never trusted. */
  list(): OwnerListing {
    const out: OwnerListing = { records: [], unreadable: [] };
    if (!existsSync(this.dir)) return out;
    for (const name of readdirSync(this.dir).sort()) {
      if (!FILE.test(name)) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(join(this.dir, name), "utf8")); } catch (e) { out.unreadable.push({ file: name, reason: `not JSON: ${(e as Error).message}` }); continue; }
      const ok = validateProcessOwner(parsed);
      if (!ok.ok) { out.unreadable.push({ file: name, reason: ok.errors.map((e) => `${e.code} ${e.message}`).join("; ") }); continue; }
      const rec = parsed as OwnerRecord;
      if (`${rec.launchId}.json` !== name) { out.unreadable.push({ file: name, reason: "the launch id does not match the file name" }); continue; }
      out.records.push(rec);
    }
    return out;
  }

  /** Changes the state of a record. A record that is not there stays absent. */
  mark(launchId: string, state: OwnerState): OwnerRecord | null {
    const rec = this.read(launchId);
    if (!rec) return null;
    const next = { ...rec, state };
    this.write(next);
    return next;
  }

  remove(launchId: string): void {
    try { unlinkSync(this.file(launchId)); } catch { /* already gone */ }
  }
}
