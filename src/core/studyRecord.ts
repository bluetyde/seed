/**
 * The live study record (E3, docs/study-record.md): the append-only, hash-chained JSONL file of one study that the HOST writes as runs happen,
 * so a study has a record while it is going on and not only at report export. One file per study in the project's studies folder:
 * `<project>/<studies>/<studyId>/study.jsonl`. Row 1 is the human header; every later row is a step. Agents never write rows: the host
 * appends the steps it knows from its own admission evidence, and a note verb adds `note` steps of a registered actor. A row is never
 * edited; a correction is a new step.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomicFile";
import { canonicalJson, sha256Hex } from "./canonical";
import { inside, MAX_HOST_FILE, safeChild } from "./hostFiles";
import { withProjectLock } from "./projectStore";
import { verifyStudyLog } from "./semantic";
import type { Actor } from "./policy";
import type { TypedError } from "./validate";

export type StepDraft = {
  action: "validate" | "run" | "oracle" | "edit" | "compare" | "collect" | "cancel" | "note" | "gate-stop";
  actor: Actor;
  reason: string;
  time: string;
  inputsChanged?: { artifact: string; before: string; after: string }[];
  runs?: string[];
  oracle?: { set: string; verdict: "pass" | "fail" | "not-run" };
  gateStop?: { request: string; rule: string };
  /** Identifies what this step records (a request, a note), so appending it twice appends it once. Never stored in the row text itself. */
  key: string;
};
export type AppendResult =
  | { ok: true; appended: number; skipped: number; rows: number; head: string }
  | { ok: false; errors: TypedError[] };

const err = (code: string, message: string): { ok: false; errors: TypedError[] } => ({ ok: false, errors: [{ code, field: "", message, source: "seed" }] });

/** A short, fixed-length marker of a key, written at the end of a step's reason: "(ref 3fa9c1d27be04a66)". A client cannot forge another key's marker. */
export const refMarker = (key: string): string => `(ref ${createHash("sha256").update(key).digest("hex").slice(0, 16)})`;

export function studyRecordFile(projectRoot: string, studiesFolder: string, studyId: string, create = false): string {
  const root = realpathSync(projectRoot);
  const studies = safeChild(root, studiesFolder, true);
  if (!existsSync(studies)) {
    if (!create) return join(studies, studyId, "study.jsonl");
    mkdirSync(studies, { recursive: true });
  }
  if (!inside(root, realpathSync(studies))) throw Error("the studies folder leaves the project");
  const dir = safeChild(studies, studyId, true);
  if (!existsSync(dir)) {
    if (!create) return join(dir, "study.jsonl");
    mkdirSync(dir);
  }
  return safeChild(dir, "study.jsonl");
}

/** Reads and verifies a record. A missing file is an empty record; a broken chain, a partial last line or a bad row is an error. */
export function readStudyRecord(file: string): { ok: true; lines: string[]; rows: Record<string, any>[] } | { ok: false; errors: TypedError[] } {
  if (!existsSync(file)) return { ok: true, lines: [], rows: [] };
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_HOST_FILE) return err("E_SCHEMA_INVALID", "the study record must be a bounded regular file");
  const text = readFileSync(file, "utf8");
  if (text === "") return { ok: true, lines: [], rows: [] };
  if (!text.endsWith("\n")) return err("E_SCHEMA_INVALID", "the study record has a partial last line");
  const lines = text.slice(0, -1).split("\n");
  const problems = verifyStudyLog(lines);
  if (problems.length) return { ok: false, errors: problems };
  return { ok: true, lines, rows: lines.map((l) => JSON.parse(l) as Record<string, any>) };
}

const chain = (body: Record<string, unknown>, prev: string | null): string => {
  const withPrev = { ...body, prev };
  const hash = sha256Hex(canonicalJson(withPrev));
  return JSON.stringify({ ...withPrev, hash });
};

/**
 * Appends steps under the project writer lock. Creates the record with the human `header` (already validated by the caller against the
 * host's study and project) when there is none; refuses when an existing record has another header, or fails its chain. A step whose key is
 * already in the record is skipped, so a replayed request does not write twice. The file is replaced atomically with the new rows.
 */
export function appendStudySteps(file: string, header: Record<string, unknown>, drafts: StepDraft[], projectRoot: string): AppendResult {
  const locked = withProjectLock(
    projectRoot,
    () => {
      const read = readStudyRecord(file);
      if (!read.ok) return read;
      let lines = read.lines;
      let rows = read.rows;
      if (lines.length === 0) {
        lines = [chain(header, null)];
        rows = [JSON.parse(lines[0]!)];
      } else {
        const have = rows[0]!;
        const { prev: _p, hash: _h, ...bare } = have;
        if (canonicalJson(bare) !== canonicalJson(header)) return err("E_SCHEMA_INVALID", "the record has another human header than the one the host was given");
      }
      let appended = 0, skipped = 0;
      let prev = rows[rows.length - 1]!.hash as string;
      let seq = rows.length; // header is seq 0; the next step is rows.length
      for (const d of drafts) {
        const marker = refMarker(d.key);
        if (rows.some((r) => typeof r.reason === "string" && r.reason.endsWith(marker))) {
          skipped++;
          continue;
        }
        const reason = `${d.reason.slice(0, 2000 - marker.length - 1)} ${marker}`;
        const step: Record<string, unknown> = {
          schema: "seed.study/0.1",
          type: "step",
          seq,
          time: d.time,
          actor: d.actor,
          action: d.action,
          reason,
          inputsChanged: d.inputsChanged ?? [],
          runs: d.runs ?? [],
          ...(d.oracle ? { oracle: d.oracle } : {}),
          ...(d.gateStop ? { gateStop: d.gateStop } : {}),
        };
        const line = chain(step, prev);
        const parsed = JSON.parse(line) as Record<string, any>;
        lines.push(line);
        rows.push(parsed);
        prev = parsed.hash as string;
        seq++;
        appended++;
      }
      if (appended === 0) return { ok: true as const, appended, skipped, rows: rows.length, head: prev };
      const problems = verifyStudyLog(lines);
      if (problems.length) return { ok: false as const, errors: problems }; // never write a record that would not verify
      const text = lines.join("\n") + "\n";
      if (Buffer.byteLength(text) > MAX_HOST_FILE) return err("E_SCHEMA_INVALID", "the study record is full; start a new study");
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, text);
      return { ok: true as const, appended, skipped, rows: rows.length, head: prev };
    },
    { waitMs: 15000 }
  );
  if (!locked.ok) return { ok: false, errors: locked.errors };
  return locked.value;
}
