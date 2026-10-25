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

export type LiveContext = { sweep?: { sweepId: string; index: number; count: number; values: { id: string; value: number }[]; kind?: "sweep" | "sampling" } };
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

export type DraftArgs = {
  evidenceSha: string;
  actor: Actor;
  requestId: string;
  caseId: string;
  decision: Decision | undefined;
  outcome: { ok: true; runId: string; state: string } | { ok: false };
  context?: LiveContext;
  /** When the decision was made, and (for a backfill) when the outcome was; both default to `time`. */
  time: string;
  outcomeTime?: string;
  /** Put before every reason (a backfill says so). */
  prefix?: string;
};

/**
 * The steps one request produced, from its gate decision and outcome. One function for the live append and for the backfill from the audit log
 * (docs/study-record.md), so a step has the same key, and so is written once, whichever way it arrives.
 */
export function stepDrafts(a: DraftArgs): StepDraft[] {
  const { actor, time } = a;
  const outcomeTime = a.outcomeTime ?? time;
  const pre = a.prefix ?? "";
  const drafts: StepDraft[] = [];
  const via = a.decision && a.decision.allow ? a.decision.via + (a.decision.grantId ? ` (grant ${a.decision.grantId})` : "") : "";
  const sweep = a.context?.sweep
    ? ` ${a.context.sweep.kind === "sampling" ? "Sampling" : "Sweep"} ${a.context.sweep.sweepId}, ${a.context.sweep.kind === "sampling" ? "point" : "case"} ${a.context.sweep.index} of ${a.context.sweep.count} (${a.context.sweep.values.map((v) => `${v.id}=${v.value}`).join(", ")}).`
    : "";
  if (a.decision && !a.decision.allow) {
    const s = gateStopStep(a.decision, actor, 1, time) as { reason: string; gateStop: { request: string; rule: string } };
    drafts.push({ action: "gate-stop", actor, time, reason: `${pre}Request refused at the gate for case ${a.caseId}: ${s.reason}.${sweep}`, runs: [], gateStop: s.gateStop, key: `request:${a.requestId}:gate` });
  } else if (a.decision && a.decision.allow && a.outcome.ok) {
    drafts.push({
      action: "oracle", actor, time, runs: [],
      reason: `${pre}Pinned admission oracle set: ${a.evidenceSha}. Quantities retain their adapter verification labels.`,
      oracle: { set: a.evidenceSha, verdict: "pass" },
      key: `oracle:${a.evidenceSha}`,
    });
    drafts.push({ action: "run", actor, time, runs: [a.outcome.runId], reason: `${pre}Registered case ${a.caseId}; policy admission via ${via}.${sweep}`, key: `request:${a.requestId}:run` });
    drafts.push({
      action: a.outcome.state === "cancelled" ? "cancel" : "note", actor, time: outcomeTime, runs: [a.outcome.runId],
      reason: `${pre}Audited terminal outcome: ${a.outcome.state}. No scientific conclusion has been accepted.`,
      key: `request:${a.requestId}:outcome`,
    });
  }
  return drafts;
}

/** What a replay's step says; every field is in the replay log too (docs/replay.md), so the step can be rebuilt from it. */
export type ReplayFacts = {
  requestId: string;
  originalRequestId: string;
  originalRunId: string;
  replayRunId: string;
  replayState: string;
  adapter: string;
  policy: { mode: string; abs?: number; rel?: number; sigmas?: number };
  verdict: string;
  differences: { kind: string; field: string }[];
};

const policyText = (p: ReplayFacts["policy"]) => (p.mode === "tolerance" ? `tolerance, abs ${p.abs}, rel ${p.rel}` : p.mode === "statistical" ? `statistical, ${p.sigmas} sigmas` : p.mode);

/**
 * The step a replay leaves in the study record: action `compare`, citing the original run and the replay run, saying the verdict, the policy it was judged
 * under and where the runs differ. Keyed by the replay's request id, so the same replay is written once. The replay run's own steps (oracle, run, outcome)
 * are written by the guarded run path before this one. It says plainly that a replay tests reproduction and is no scientific conclusion.
 */
export function replayStepDraft(a: { actor: Actor; time: string; facts: ReplayFacts; prefix?: string }): StepDraft {
  const f = a.facts;
  const shown = f.differences.slice(0, 10).map((d) => `${d.kind} ${d.field}`).join("; ");
  const diffs = f.differences.length === 0 ? "No differences." : `Differences (${f.differences.length}): ${shown}${f.differences.length > 10 ? `; and ${f.differences.length - 10} more` : ""}.`;
  return {
    action: "compare", actor: a.actor, time: a.time, runs: [f.originalRunId, f.replayRunId],
    reason: `${a.prefix ?? ""}Replay of run ${f.originalRunId} (request ${f.originalRequestId}) by run ${f.replayRunId} (request ${f.requestId}, ended ${f.replayState}): ${f.verdict}. Judged under the ${f.adapter} adapter's replay policy (${policyText(f.policy)}). ${diffs} A replay tests reproduction; it is not a scientific conclusion.`,
    key: `replay:${f.requestId}`,
  };
}

/** Appends a replay's step. Never throws: a failure is written to the host diagnostics and returned, and the replay's answer is not changed by it. */
export function recordReplayInStudy(a: { c: Cfg; projectRoot: string; studiesFolder: string; projectId: string; engineRoot: string; facts: ReplayFacts; now?: () => Date }): { ok: boolean; appended?: number; reason?: string } {
  try {
    const header = loadLiveHeader(a.c, a.projectRoot, a.projectId);
    if (header === null) return { ok: true, appended: 0 };
    const time = (a.now ?? (() => new Date()))().toISOString();
    const file = studyRecordFile(a.projectRoot, a.studiesFolder, a.c.study.studyId, true);
    const r = appendStudySteps(file, header, [replayStepDraft({ actor: a.c.actor, time, facts: a.facts })], a.projectRoot);
    if (!r.ok) throw Error(r.errors.map((e) => e.message).join("; "));
    return { ok: true, appended: r.appended };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "study record failed";
    try {
      appendFileSync(
        safeChild(a.engineRoot, "diagnostics.jsonl"),
        JSON.stringify({ time: new Date().toISOString(), project: a.projectId, stage: "study-record", kind: "StudyRecord", message: ("replay step: " + reason).slice(0, 1000) }) + "\n"
      );
    } catch {
      // diagnostics are best effort
    }
    return { ok: false, reason };
  }
}

/** What a sampling's step says; every field is in the sampling reply and the sampling log too. */
export type SamplingFacts = {
  samplingId: string;
  requestId: string;
  design: { method: string; n: number; seed: number };
  parameters: { id: string; distribution: { kind: string; [k: string]: unknown } }[];
  planned: number;
  completed: number;
  /** The runs whose outputs were read (the first 100 are cited by the step). */
  runIds: string[];
  outputs: { key: string; n: number; mean: number | null; inputSpread: number | null; noise: { rms: number | null; reportedRuns: number }; quantiles: { p05: number; p50: number; p95: number } | null; sensitivity?: SensitivityFacts }[];
};
/** The indices or effects of one output as the step and the log keep them (the same figures as the reply). */
export type SensitivityFacts =
  | { method: "sobol"; n: number; d: number; parameters: { id: string; first: number; total: number; firstInterval?: [number, number]; totalInterval?: [number, number] }[]; bootstrap?: { resamples: number; level: number; skipped: number } }
  | { method: "morris"; r: number; d: number; parameters: { id: string; mu: number; muStar: number; sigma: number }[] }
  | { method: "sobol" | "morris"; unavailable: string };
const MAX_CITED_RUNS = 100;
const range = (i: [number, number] | undefined) => (i ? ` [${num(i[0])}, ${num(i[1])}]` : "");
/** One sentence on the indices or effects of an output; it never contains the word that starts the next output block. */
function sensitivityText(s: SensitivityFacts): string {
  if ("unavailable" in s) return ` ${s.method === "sobol" ? "Sobol indices" : "Morris effects"} are not available: ${s.unavailable}.`;
  if (s.method === "sobol") {
    const first = s.parameters.map((p) => `${p.id} ${num(p.first)}${range(p.firstInterval)}`).join(", ");
    const total = s.parameters.map((p) => `${p.id} ${num(p.total)}${range(p.totalInterval)}`).join(", ");
    return ` Sobol first-order: ${first}. Sobol total-order: ${total}${s.bootstrap ? ` (bootstrap ${Math.round(s.bootstrap.level * 100)}% intervals over ${s.bootstrap.resamples} resamples)` : ""}. Estimates, not exact shares; one can fall slightly outside 0 to 1.`;
  }
  const eff = s.parameters.map((p) => `${p.id} mu* ${num(p.muStar)} (mu ${num(p.mu)}, sigma ${num(p.sigma)})`).join(", ");
  return ` Morris effects over ${s.r} trajectories: ${eff}. A ranking of the inputs, not a share of the variance.`;
}
const num = (x: number | null) => (x === null ? "none" : Number(x.toPrecision(6)).toString());
const distText = (d: SamplingFacts["parameters"][number]["distribution"]) =>
  d.kind === "uniform" ? `uniform ${d.min} to ${d.max}` : d.kind === "triangular" ? `triangular ${d.min}, mode ${d.mode}, ${d.max}` : d.kind === "normal" ? `normal mean ${d.mean} sd ${d.sd} cut to ${d.min} to ${d.max}` : `lognormal mu ${d.mu} sigma ${d.sigma} cut to ${d.min} to ${d.max}`;

/**
 * The step a sampling leaves in the study record: action `compare`, citing the runs that were read, giving per output the mean, **the input spread and the
 * sampling noise as two separate figures**, and the quantiles. Keyed by the sampling's request id, so the same request writes it once. The report builder
 * refuses a step of this kind that lacks either figure for an output (plan 09: noise and input uncertainty are never merged).
 */
export function samplingStepDraft(a: { actor: Actor; time: string; facts: SamplingFacts; prefix?: string }): StepDraft {
  const f = a.facts;
  const prefix = a.prefix ?? "";
  const block = (o: SamplingFacts["outputs"][number]) => {
    const noise = o.noise.rms === null ? "not reported by the adapter" : `${num(o.noise.rms)} rms over ${o.noise.reportedRuns} runs`;
    const q = o.quantiles ? `; p05, p50, p95 ${num(o.quantiles.p05)}, ${num(o.quantiles.p50)}, ${num(o.quantiles.p95)}` : "";
    return ` Output ${o.key} (n ${o.n}): mean ${num(o.mean)}; input spread ${num(o.inputSpread)}; sampling noise ${noise}${q}.${o.sensitivity ? sensitivityText(o.sensitivity) : ""}`;
  };
  const tail = " Input spread is the spread of the outputs over the sampled inputs and includes each run's noise; sampling noise is what the adapter reported and is never added to or taken from the spread. This describes the declared inputs only and is not a scientific conclusion.";
  const head = (params: string) => `Sampling summary ${f.samplingId} (request ${f.requestId}): ${f.completed} of ${f.planned} points ran to the end; design ${f.design.method}, n ${f.design.n}, seed ${f.design.seed}; ${params}.`;
  let first = head(f.parameters.map((p) => `${p.id} ${distText(p.distribution)}`).join("; "));
  if (first.length > 700) first = head(f.parameters.map((p) => p.id).join(", "));
  // outputs are added whole while they fit; the ones left out are said, so the step never holds half an output
  let body = "";
  let left = 0;
  for (const o of f.outputs) {
    const b = block(o);
    if (prefix.length + first.length + body.length + b.length + tail.length + 70 > 2000) left++;
    else body += b;
  }
  const more = left > 0 ? ` ${left} more outputs are in the sampling log.` : "";
  const reason = prefix + first + body + more + tail;
  return { action: "compare", actor: a.actor, time: a.time, runs: f.runIds.slice(0, MAX_CITED_RUNS), reason: reason.slice(0, 2000), key: `sampling:${f.samplingId}:${f.requestId}` };
}

/** Appends a sampling's step. Never throws: a failure is written to the host diagnostics and returned, and the sampling's answer is not changed by it. */
export function recordSamplingInStudy(a: { c: Cfg; projectRoot: string; studiesFolder: string; projectId: string; engineRoot: string; facts: SamplingFacts; now?: () => Date }): { ok: boolean; appended?: number; reason?: string } {
  try {
    const header = loadLiveHeader(a.c, a.projectRoot, a.projectId);
    if (header === null) return { ok: true, appended: 0 };
    const time = (a.now ?? (() => new Date()))().toISOString();
    const file = studyRecordFile(a.projectRoot, a.studiesFolder, a.c.study.studyId, true);
    const r = appendStudySteps(file, header, [samplingStepDraft({ actor: a.c.actor, time, facts: a.facts })], a.projectRoot);
    if (!r.ok) throw Error(r.errors.map((e) => e.message).join("; "));
    return { ok: true, appended: r.appended };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "study record failed";
    try {
      appendFileSync(
        safeChild(a.engineRoot, "diagnostics.jsonl"),
        JSON.stringify({ time: new Date().toISOString(), project: a.projectId, stage: "study-record", kind: "StudyRecord", message: ("sampling step: " + reason).slice(0, 1000) }) + "\n"
      );
    } catch {
      // diagnostics are best effort
    }
    return { ok: false, reason };
  }
}

/** Appends the steps one request produced. Never throws: a failure is written to the host diagnostics and returned. */
export function recordRequestInStudy(a: RecordArgs): { ok: boolean; appended?: number; reason?: string } {
  try {
    const header = loadLiveHeader(a.c, a.projectRoot, a.projectId);
    if (header === null) return { ok: true, appended: 0 };
    const time = (a.now ?? (() => new Date()))().toISOString();
    const drafts = stepDrafts({
      evidenceSha: a.c.oracles.evidenceSha256, actor: a.c.actor, requestId: a.requestId, caseId: a.caseId, decision: a.decision, outcome: a.outcome, time,
      ...(a.context ? { context: a.context } : {}),
    });
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
