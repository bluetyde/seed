/**
 * The one way an agent adds to the live study record: a free-text note, as the host's registered actor, optionally citing runs of this
 * project. Everything else in the record is written by the host from its own evidence. The note passes the gate (`append_step`, tier A1),
 * is bounded, is data (it is stored and shown, never acted on), and is idempotent under its `noteId`.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sha256Hex } from "./canonical";
import { validateHostConfiguration } from "./fileRunHost";
import { inside, readHostJson, regularFile, safeChild } from "./hostFiles";
import { evaluateGate } from "./policy";
import { openProject } from "./projectStore";
import { appendStudySteps, readStudyRecord, refMarker, studyRecordFile } from "./studyRecord";
import { loadLiveHeader } from "./studyRecordHost";

type Outcome = { ok: true; state: string; seq?: number } | { ok: false; errors: { code: string; field: string; message: string; source: "seed" }[] };
const fail = (code: string, message: string, field = ""): Outcome => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function addStudyNote(file: string, request: unknown): Outcome {
  try {
    const r = request as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["noteId", "text", "runs"].includes(k))) {
      return fail("E_SCHEMA_INVALID", "a note has exactly: noteId, text and optionally runs");
    }
    if (typeof r.noteId !== "string" || !ID.test(r.noteId)) return fail("E_SCHEMA_INVALID", "noteId is 1 to 64 letters, digits, dots, dashes or underscores", "/noteId");
    if (typeof r.text !== "string" || r.text.trim().length < 1 || r.text.length > 1500) return fail("E_SCHEMA_INVALID", "text is 1 to 1500 characters", "/text");
    const runs = r.runs === undefined ? [] : r.runs;
    if (!Array.isArray(runs) || runs.length > 20 || runs.some((x) => typeof x !== "string" || !ID.test(x)) || new Set(runs).size !== runs.length) {
      return fail("E_SCHEMA_INVALID", "runs is a list of at most 20 different run ids", "/runs");
    }
    if (!isAbsolute(file)) return fail("E_SETUP_REQUIRED", "SEED_HOST_CONFIG must be an absolute path");
    regularFile(file);
    const c = validateHostConfiguration(readHostJson(file));
    const projectRoot = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
    if (inside(projectRoot, realpathSync(file)) || inside(projectRoot, state)) throw Error("host configuration and state must be outside the project");
    const p = openProject(projectRoot);
    if (!p.ok) return { ok: false, errors: p.errors.map((e) => ({ ...e, source: "seed" as const })) };
    const folders = p.value.manifest.folders as { runs: string; studies: string };
    const decision = evaluateGate({ operation: "append_step", actor: c.actor, studyId: c.study.studyId }, { study: c.study, grants: c.grants });
    if (!decision.allow) return { ok: false, errors: decision.errors.map((e) => ({ code: e.code, field: e.field, message: e.message, source: "seed" as const })) };
    const header = loadLiveHeader(c, projectRoot, p.value.manifest.projectId as string);
    if (header === null) return fail("E_SETUP_REQUIRED", "no study record is kept: the host has no human study header (SEED_STUDY_HEADER)");
    const runsRoot = safeChild(projectRoot, folders.runs, true);
    for (const id of runs as string[]) {
      if (!existsSync(safeChild(runsRoot, id, true)) || !existsSync(safeChild(safeChild(runsRoot, id, true), "run-record.json"))) {
        return fail("E_NOT_FOUND", `run ${id} is not a run of this project`, "/runs");
      }
      // a note is kept for good and the report later verifies every run the record cites: a run of another study could never be verified here
      let dispatch: { studyId?: unknown } | undefined;
      try {
        dispatch = readHostJson(safeChild(safeChild(runsRoot, id, true), "run-record.json"))?.extensions?.["seed.dispatch"];
      } catch {
        dispatch = undefined;
      }
      if (dispatch?.studyId !== c.study.studyId) return fail("E_NOT_FOUND", `run ${id} is not a run of this study`, "/runs");
    }
    const key = `note:${r.noteId}:${sha256Hex(JSON.stringify([r.text, runs]))}`;
    const out = appendStudySteps(
      studyRecordFile(projectRoot, folders.studies, c.study.studyId, true),
      header,
      [{ action: "note", actor: c.actor, time: new Date().toISOString(), runs: runs as string[], reason: `Note by ${c.actor.kind} ${c.actor.name}: ${r.text}`, key }],
      projectRoot
    );
    if (!out.ok) return { ok: false, errors: out.errors.map((e) => ({ ...e, source: "seed" as const })) };
    // the row of this note: the last one when it was just written, the earlier one when the same note was recorded before
    const after = readStudyRecord(studyRecordFile(projectRoot, folders.studies, c.study.studyId));
    const mine = after.ok ? after.rows.findIndex((row) => typeof row.reason === "string" && row.reason.endsWith(refMarker(key))) : -1;
    return { ok: true, state: out.appended > 0 ? "note-added" : "already-recorded", seq: mine >= 0 ? mine : out.rows - 1 };
  } catch (e) {
    return fail("E_SETUP_REQUIRED", e instanceof Error ? e.message : "note failed");
  }
}

