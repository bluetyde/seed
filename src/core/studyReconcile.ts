/**
 * Reconciliation of the live study record with the admission log (docs/study-record.md). The record is derived from what the host audited, and a
 * step can be missing: an append failed (the run was never touched, the failure went to the diagnostics), or the run happened before the host had
 * a human header. The admission log still holds everything, so a human can ask for the missing steps to be written from it.
 *
 * Rules: human host identity only; the human header must be given (SEED_STUDY_HEADER) and match the host; nothing is edited or removed, only
 * appended; a step already in the record is skipped (the same keys as the live append, so a request is written once whichever way); every step
 * written says it was backfilled and takes the time of the audit row, not the time of the backfill; a request with no decision, or an allowed
 * one with no outcome yet, is reported and not written; a dry run writes nothing.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sha256Hex } from "./canonical";
import { validateHostConfiguration } from "./fileRunHost";
import { inside, readAdmissions, readHostJson, regularFile, safeChild } from "./hostFiles";
import { openProject } from "./projectStore";
import { appendStudySteps, readStudyRecord, refMarker, studyRecordFile, type StepDraft } from "./studyRecord";
import { loadLiveHeader, stepDrafts } from "./studyRecordHost";

type Outcome = { ok: true; [k: string]: unknown } | { ok: false; errors: { code: string; field: string; message: string; source: "seed" }[] };
const fail = (message: string, code = "E_NOT_PERMITTED"): Outcome => ({ ok: false, errors: [{ code, field: "", message, source: "seed" }] });

export const BACKFILL_PREFIX = "Backfilled from the audit log. ";

export function reconcileStudyRecord(file: string, request: unknown): Outcome {
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request)) return fail("the request is an object with an optional dryRun", "E_SCHEMA_INVALID");
    const keys = Object.keys(request);
    if (keys.some((k) => k !== "dryRun") || ((request as { dryRun?: unknown }).dryRun !== undefined && typeof (request as { dryRun?: unknown }).dryRun !== "boolean"))
      return fail("the request has only dryRun (true or false)", "E_SCHEMA_INVALID");
    const dryRun = (request as { dryRun?: boolean }).dryRun === true;
    if (!isAbsolute(file)) return fail("SEED_ADMIN_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file);
    const c = validateHostConfiguration(readHostJson(file));
    if (c.actor.kind !== "human") return fail("the study record is reconciled only by a human host identity");
    const projectRoot = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
    if (inside(projectRoot, realpathSync(file)) || inside(projectRoot, state)) return fail("host files must be outside the project");
    const project = openProject(projectRoot);
    if (!project.ok) return fail(project.errors.map((e) => e.message).join("; "));
    const projectId = project.value.manifest.projectId as string;
    const header = loadLiveHeader(c, projectRoot, projectId);
    if (header === null) return fail("set SEED_STUDY_HEADER to the human study header, as the host does when it records", "E_SETUP_REQUIRED");
    const engine = safeChild(safeChild(state, "engines", true), sha256Hex(realpathSync(c.runtime.path)), true);
    if (existsSync(join(engine, "lease"))) return fail("an active or abandoned calculation holds the engine; finish or recover it before reconciling");
    const rows = readAdmissions(engine);

    const drafts: StepDraft[] = [];
    const unfinished: { requestId: string; why: string }[] = [];
    let requests = 0;
    const requestRows = rows.filter((r) => (r.event as { phase?: unknown }).phase === "request");
    for (const [i, row] of requestRows.entries()) {
      const ev = row.event as { projectId?: unknown; configHash?: unknown; event?: { request?: { requestId?: unknown; caseId?: unknown }; configuration?: { study?: { studyId?: unknown }; oracles?: { evidenceSha256?: unknown } } } };
      if (ev.projectId !== projectId) continue;
      const cfg = ev.event?.configuration;
      if (cfg?.study?.studyId !== c.study.studyId) continue;
      const requestId = ev.event?.request?.requestId, caseId = ev.event?.request?.caseId;
      if (typeof requestId !== "string" || typeof caseId !== "string" || typeof cfg?.oracles?.evidenceSha256 !== "string") continue;
      requests++;
      const next = requestRows[i + 1]?.seq ?? Infinity;
      const attempt = rows.filter((r) => r.seq >= row.seq && r.seq < next && (r.event as { configHash?: unknown }).configHash === ev.configHash);
      const decisionRow = attempt.find((r) => {
        const e = r.event as { phase?: unknown; event?: { requestId?: unknown } };
        return e.phase === "decision" && e.event?.requestId === requestId;
      });
      if (!decisionRow) {
        unfinished.push({ requestId, why: "no gate decision was audited" });
        continue;
      }
      const gate = (decisionRow.event as { event: { decision: any; actor?: any } }).event;
      const allowed = gate.decision?.allow === true;
      const outcomeRow = attempt.find((r) => {
        const e = r.event as { phase?: unknown; event?: { runId?: unknown } };
        return r.seq > decisionRow.seq && e.phase === "outcome" && typeof e.event?.runId === "string";
      });
      if (allowed && !outcomeRow) {
        unfinished.push({ requestId, why: "allowed, but no outcome was audited" });
        continue;
      }
      const outcomeEvent = outcomeRow ? (outcomeRow.event as { event: { ok?: unknown; runId: string; state: string } }).event : undefined;
      const outcome = outcomeEvent && outcomeEvent.ok === true ? { ok: true as const, runId: outcomeEvent.runId, state: outcomeEvent.state } : { ok: false as const };
      drafts.push(
        ...stepDrafts({
          evidenceSha: cfg.oracles.evidenceSha256, actor: gate.actor ?? c.actor, requestId, caseId, decision: gate.decision, outcome,
          time: decisionRow.time, ...(outcomeRow ? { outcomeTime: outcomeRow.time } : {}), prefix: BACKFILL_PREFIX,
        }),
      );
    }

    const recordFile = studyRecordFile(projectRoot, (project.value.manifest.folders as { studies: string }).studies, c.study.studyId, !dryRun);
    const existing = readStudyRecord(recordFile);
    if (!existing.ok) return fail(existing.errors.map((e) => e.message).join("; "));
    const missing = drafts.filter((d) => !existing.rows.some((r) => typeof r.reason === "string" && r.reason.endsWith(refMarker(d.key))));
    const summary = { requestsScanned: requests, stepsFromLog: drafts.length, stepsMissing: missing.length, unfinished };
    if (dryRun) return { ok: true, state: "dry-run", ...summary, would: missing.map((d) => ({ key: d.key, action: d.action, runs: d.runs ?? [] })) };
    if (missing.length === 0) return { ok: true, state: "nothing-to-do", ...summary, appended: 0 };
    const r = appendStudySteps(recordFile, header, missing, projectRoot);
    if (!r.ok) return fail(r.errors.map((e) => e.message).join("; "));
    return { ok: true, state: "reconciled", ...summary, appended: r.appended, head: r.head };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return fail(e instanceof Error ? e.message : "reconciliation failed", typeof code === "string" && /^E_[A-Z_]+$/.test(code) ? code : "E_NOT_PERMITTED");
  }
}
