/**
 * Host side of the live study record (docs/study-record.md). Reads the trusted human header, turns what the host knows about one request
 * (its gate decision and its outcome) into steps, and appends them. The record is DERIVED from the admission evidence: if appending fails the
 * run is not touched, the failure goes to the host diagnostics, and the admission log still holds everything.
 */
import { appendFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./canonical";
import { inside, readHostJson, regularFile, safeChild } from "./hostFiles";
import { gateStopStep, type Actor, type Decision } from "./policy";
import { appendStudySteps, studyRecordFile, type StepDraft } from "./studyRecord";
import { validate } from "./validate";

export type LiveContext = { sweep?: { sweepId: string; index: number; count: number; values: { id: string; value: number }[] } };
type Cfg = { study: { studyId: string; tier: string; budget: unknown; parameters: unknown }; actor: Actor; oracles: { evidenceSha256: string } };

/** The human header the host was given through its trusted environment (SEED_STUDY_HEADER), or null when none was. Throws when it does not match the host. */
export function loadLiveHeader(c: Cfg, projectRoot: string, projectId: string): Record<string, unknown> | null {
  const headerFile = process.env.SEED_STUDY_HEADER;
  if (!headerFile) return null;
  if (!isAbsolute(headerFile)) throw Error("SEED_STUDY_HEADER must be an absolute path");
  regularFile(headerFile);
  if (inside(projectRoot, realpathSync(headerFile))) throw Error("the human header must be outside the project");
  const header = readHostJson(headerFile);
  if (!validate("study", header).ok || header.type !== "header" || header.hash !== undefined || header.prev !== undefined) throw Error("invalid unchained human study header");
  if (
    header.studyId !== c.study.studyId ||
    header.projectId !== projectId ||
    header.tier !== c.study.tier ||
    canonicalJson(header.budget) !== canonicalJson(c.study.budget) ||
    canonicalJson(header.parameters) !== canonicalJson(c.study.parameters)
  )
    throw Error("the human header differs from the host project or study policy");
  return header;
}

export type RecordArgs = {
  c: Cfg;
  projectRoot: string;
  studiesFolder: string;
  projectId: string;
  engineRoot: string;
  requestId: string;
  caseId: string;
  decision: Decision | undefined;
  outcome: { ok: true; runId: string; state: string } | { ok: false };
  context?: LiveContext;
  now?: () => Date;
};

/** Appends the steps one request produced. Never throws: a failure is written to the host diagnostics and returned. */
export function recordRequestInStudy(a: RecordArgs): { ok: boolean; appended?: number; reason?: string } {
  try {
    const header = loadLiveHeader(a.c, a.projectRoot, a.projectId);
    if (header === null) return { ok: true, appended: 0 };
    const time = (a.now ?? (() => new Date()))().toISOString();
    const actor = a.c.actor;
    const drafts: StepDraft[] = [];
    const via = a.decision && a.decision.allow ? a.decision.via + (a.decision.grantId ? ` (grant ${a.decision.grantId})` : "") : "";
    const sweep = a.context?.sweep
      ? ` Sweep ${a.context.sweep.sweepId}, case ${a.context.sweep.index} of ${a.context.sweep.count} (${a.context.sweep.values.map((v) => `${v.id}=${v.value}`).join(", ")}).`
      : "";
    if (a.decision && !a.decision.allow) {
      const s = gateStopStep(a.decision, actor, 1, time) as { reason: string; gateStop: { request: string; rule: string } };
      drafts.push({ action: "gate-stop", actor, time, reason: `Request refused at the gate for case ${a.caseId}: ${s.reason}.${sweep}`, runs: [], gateStop: s.gateStop, key: `request:${a.requestId}:gate` });
    } else if (a.decision && a.decision.allow && a.outcome.ok) {
      drafts.push({
        action: "oracle", actor, time, runs: [],
        reason: `Pinned admission oracle set: ${a.c.oracles.evidenceSha256}. Quantities retain their adapter verification labels.`,
        oracle: { set: a.c.oracles.evidenceSha256, verdict: "pass" },
        key: `oracle:${a.c.oracles.evidenceSha256}`,
      });
      drafts.push({ action: "run", actor, time, runs: [a.outcome.runId], reason: `Registered case ${a.caseId}; policy admission via ${via}.${sweep}`, key: `request:${a.requestId}:run` });
      drafts.push({
        action: a.outcome.state === "cancelled" ? "cancel" : "note", actor, time, runs: [a.outcome.runId],
        reason: `Audited terminal outcome: ${a.outcome.state}. No scientific conclusion has been accepted.`,
        key: `request:${a.requestId}:outcome`,
      });
    }
    if (drafts.length === 0) return { ok: true, appended: 0 };
    const file = studyRecordFile(a.projectRoot, a.studiesFolder, a.c.study.studyId, true);
    const r = appendStudySteps(file, header, drafts, a.projectRoot);
    if (!r.ok) throw Error(r.errors.map((e) => e.message).join("; "));
    return { ok: true, appended: r.appended };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "study record failed";
    try {
      appendFileSync(
        safeChild(a.engineRoot, "diagnostics.jsonl"),
        JSON.stringify({ time: new Date().toISOString(), project: a.projectId, stage: "study-record", kind: "StudyRecord", message: reason.slice(0, 1000) }) + "\n"
      );
    } catch {
      // diagnostics are best effort
    }
    return { ok: false, reason };
  }
}
