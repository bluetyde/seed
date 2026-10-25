import { readFileSync, realpathSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./canonical";
import { validateHostConfiguration, type HostConfiguration } from "./fileRunHost";
import { appendSamplingRecord, inside, readAdmissions, readHostJson, safeChild } from "./hostFiles";
import { loadRunEvidence } from "./runEvidence";
import { recordSamplingInStudy, type SamplingFacts } from "./studyRecordHost";
import { openProject } from "./projectStore";
import type { Budget } from "./policy";
import { approvedSampling } from "./samplingProposal";
import { expandSampling, outputKey, reduceQuantity, sensitivityOf, summarizeSampling, summaryRunsOf, SAMPLING_CAVEATS, type OutputSummary, type SampleRun, type SamplingDefinition, type SensitivityResult } from "./sampling";
import { runCaseList, type ListMode, type SweepCaseResult } from "./sweepHost";
import { validate, type TypedError } from "./validate";

/** Client input: a registered sampling and a per-case budget. No values, distributions, seed, paths, actor or policy. */
export type SamplingRequest = { requestId: string; samplingId: string; budget: Budget };
export type SamplingSummary = {
  /** Points that were planned, points that ran to the end, and points whose outputs were read. */
  planned: number;
  completed: number;
  outputs: OutputSummary[];
  /** Why a run that completed gave no number for an output (the file could not be proven, the quantity is absent, the data is not a number). */
  unread: { caseId: string; output: string; reason: string }[];
  /** For a `sobol` or `morris` design: per output, the indices or effects of each parameter (or why there are none). Absent for `lhs` and `random`. */
  sensitivity?: Record<string, SensitivityResult>;
  /** The points that gave at least one number: the runs the statistics stand on (and the only ones the study step cites). */
  used?: string[];
  caveats: string;
};
export type SamplingOutcome =
  | {
      ok: true;
      samplingId: string;
      requestId: string;
      /** Absent only when the host configuration could not be read again after the runs. */
      design?: { method: string; n: number; seed: number };
      parameters?: { id: string; distribution: unknown }[];
      results: SweepCaseResult[];
      complete: boolean;
      stoppedAt?: { caseId: string; reason: string };
      summary: SamplingSummary;
      /** The summary's step in the live study record: how many rows were appended (0 when the host has no human header, or the step was already there), or why it could not be. */
      studyRecord: { appended: number } | { failed: string };
      recordingError?: string;
      /** False when every point ran but the summary could not be made: `summary.outputs` is then empty because nothing was computed, not because nothing was found. */
      summaryAvailable?: false;
    }
  | { ok: false; errors: TypedError[] };

/** The sampling registered under `id`: one the host configuration holds, or else one a person approved from an agent's proposal (the state folder's proposal log). */
function registeredSampling(c: HostConfiguration, id: string): SamplingDefinition | undefined {
  if (c.samplings !== undefined && Object.hasOwn(c.samplings, id)) return c.samplings[id];
  return approvedSampling(realpathSync(c.stateRoot), id);
}

const SAMPLING_MODE: ListMode = {
  kind: "sampling",
  idKey: "samplingId",
  log: (state, event) => appendSamplingRecord(state, event),
  find: (c: HostConfiguration, id: string) => {
    const def = registeredSampling(c, id);
    return def === undefined
      ? undefined
      : { base: def.base, expand: () => expandSampling(id, def, c.cases, c.study), admitted: { design: def.design, parameters: def.parameters.map((p) => p.id), outputs: def.outputs.map(outputKey) } };
  }
};

/**
 * Runs a registered sampling one point after another through the same guarded path as a sweep (policy, pins, oracles, the one-active-case-per-engine
 * limit, the admission record, the study budget `maxCases`), then reads each completed run's outputs from its saved, hash-checked files and summarises
 * them (docs/sampling.md). The summary is built from what the runs hold: a run that did not complete, or whose file cannot be proven, adds no number and
 * is listed. The sampling noise an adapter reports and the spread over the inputs are two separate lines.
 */
export async function runSamplingFromHostFile(file: string, request: unknown): Promise<SamplingOutcome> {
  // the configuration the points were admitted under: if the file is another one when they have run, the summary would describe the runs by a definition they were not made with
  let hashBefore: string | undefined;
  try { hashBefore = sha256Hex(readFileSync(file)); } catch { /* the run path refuses an unreadable file in its own words */ }
  const out = await runCaseList(file, request, SAMPLING_MODE);
  if (!out.ok) return out;
  const { id, ...rest } = out;
  let c: HostConfiguration;
  let def: SamplingDefinition;
  let summary: SamplingSummary;
  let recordingError = rest.recordingError;
  try {
    if (hashBefore !== undefined && sha256Hex(readFileSync(file)) !== hashBefore) throw Error("the host configuration changed while the points ran, so their summary would describe them by another definition");
    c = validateHostConfiguration(readHostJson(file));
    def = registeredSampling(c, id) as SamplingDefinition;
    summary = readSummary(c, def, rest.results);
  } catch (e) {
    // the cases ran; a summary that cannot be made is said, with nothing invented
    const message = "the runs finished but their summary could not be made: " + (e instanceof Error ? e.message : "read failed");
    recordingError = recordingError ? recordingError + "; " + message : message;
    summary = { planned: rest.results.length, completed: rest.results.filter((r) => r.state === "completed" || r.state === "terminated-by-trip").length, outputs: [], unread: [], caveats: SAMPLING_CAVEATS };
    return { ok: true, samplingId: id, requestId: rest.requestId, results: rest.results, complete: rest.complete, ...(rest.stoppedAt ? { stoppedAt: rest.stoppedAt } : {}), summary, studyRecord: { failed: "no summary was made, so no step was written" }, recordingError, summaryAvailable: false };
  }
  let logged: string | undefined;
  try {
    appendSamplingRecord(realpathSync(c.stateRoot), { samplingId: id, requestId: rest.requestId, phase: "summary", planned: summary.planned, completed: summary.completed, outputs: summary.outputs.map((o) => ({ key: o.key, n: o.n, mean: o.mean, inputSpread: o.inputSpread, noise: o.noise })), unread: summary.unread.length, facts: factsOf(id, rest.requestId, def, summary, rest.results) });
  } catch (e) {
    logged = "the sampling ran but its summary row could not be written to the sampling log: " + (e instanceof Error ? e.message : "write failed");
  }
  if (logged) recordingError = recordingError ? recordingError + "; " + logged : logged;
  // the summary becomes a step of the live study record (when the host has a human header); a failure never changes the sampling's answer
  let studyRecord: { appended: number } | { failed: string };
  try {
    const projectRoot = realpathSync(c.projectRoot);
    const project = openProject(projectRoot);
    if (!project.ok) throw Error(project.errors[0]?.message ?? "the project cannot be opened");
    const folders = project.value.manifest.folders as { studies: string };
    const engine = safeChild(safeChild(realpathSync(c.stateRoot), "engines", true), sha256Hex(realpathSync(c.runtime.path)), true);
    const studied = recordSamplingInStudy({
      c, projectRoot, studiesFolder: folders.studies, projectId: project.value.manifest.projectId as string, engineRoot: engine,
      facts: factsOf(id, rest.requestId, def, summary, rest.results)
    });
    studyRecord = studied.ok ? { appended: studied.appended ?? 0 } : { failed: studied.reason ?? "the study record could not be written" };
  } catch (e) {
    studyRecord = { failed: e instanceof Error ? e.message : "the study record could not be written" };
  }
  return {
    ok: true, samplingId: id, requestId: rest.requestId,
    design: def.design, parameters: def.parameters,
    results: rest.results, complete: rest.complete, ...(rest.stoppedAt ? { stoppedAt: rest.stoppedAt } : {}),
    summary, studyRecord, ...(recordingError ? { recordingError } : {})
  };
}

/** What the study-record step says about a sampling; also kept in the sampling log, so that `reconcile-study` can write the step from it. */
export function factsOf(id: string, requestId: string, def: SamplingDefinition, summary: SamplingSummary, results: SweepCaseResult[]): SamplingFacts {
  return {
    samplingId: id, requestId, design: def.design, parameters: def.parameters,
    planned: summary.planned, completed: summary.completed,
    // only runs that gave a number are cited: a completed run whose files could not be read is not evidence for these figures
    runIds: results.filter((r) => r.state === "completed" && typeof r.runId === "string" && (summary.used === undefined || summary.used.includes(r.caseId))).map((r) => r.runId as string).slice(0, 100),
    outputs: summary.outputs.map((o) => ({ key: o.key, n: o.n, mean: o.mean, inputSpread: o.inputSpread, noise: { rms: o.noise.rms, reportedRuns: o.noise.reportedRuns }, quantiles: o.quantiles ? { p05: o.quantiles.p05, p50: o.quantiles.p50, p95: o.quantiles.p95 } : null, ...(summary.sensitivity?.[o.key] ? { sensitivity: summary.sensitivity[o.key] } : {}) }))
  };
}

/**
 * The run record a summary reads must be the one the audit log shows the run ended with: its hash, its state and the request it served, from the guarded path's own
 * `outcome` row. Nothing is read from a run whose saved record was changed after the fact. Null when it matches.
 */
export function auditProblem(rows: readonly any[], record: any, runId: string): string | null {
  const outcome = [...rows].reverse().find((row) => row?.event?.phase === "outcome" && row.event.event?.runId === runId);
  if (!outcome) return "the audit log has no outcome for this run";
  const e = outcome.event.event;
  if (e.ok !== true) return "the audit log shows this run did not end well";
  if (sha256Hex(canonicalJson(record)) !== e.recordSha256) return "the saved run record differs from its audited outcome";
  if (record.state !== e.state) return "the saved run record's state differs from its audited outcome";
  return null;
}

/** Numbers of one output are only combined when every run gave them in the same unit and normalization: the first run read sets the basis, a run that differs is left out with the reason. */
export function basisProblem(basis: Map<string, string>, key: string, q: { unit: string; normalization: string }): string | null {
  const here = `${q.unit} (${q.normalization})`;
  const first = basis.get(key);
  if (first === undefined) { basis.set(key, here); return null; }
  return first === here ? null : `the run gives ${here}, the first run read gave ${first}; numbers in different units or normalizations are not combined`;
}

function readSummary(c: HostConfiguration, def: SamplingDefinition, results: SweepCaseResult[]): SamplingSummary {
  const projectRoot = realpathSync(c.projectRoot);
  const project = openProject(projectRoot);
  if (!project.ok) throw Error(project.errors[0]?.message ?? "the project cannot be opened");
  const engine = safeChild(safeChild(realpathSync(c.stateRoot), "engines", true), sha256Hex(realpathSync(c.runtime.path)), true);
  const audit = readAdmissions(engine);
  const runsRoot = safeChild(projectRoot, (project.value.manifest.folders as { runs: string }).runs, true);
  if (!inside(projectRoot, realpathSync(runsRoot))) throw Error("runs folder leaves project");
  const unread: SamplingSummary["unread"] = [];
  const basis = new Map<string, string>();
  const runs: SampleRun[] = [];
  let completed = 0;
  for (const row of results) {
    const values = def.parameters.map((p) => (row.values.find((v) => v.id === p.id) as { value: number }).value);
    const outputs: SampleRun["outputs"] = Object.fromEntries(def.outputs.map((o) => [outputKey(o), null]));
    runs.push({ caseId: row.caseId, values, outputs });
    // only a completed run has a results index: a point that did not start, or ended another way (a trip, a failure), is listed, never read and never counted
    if (row.state !== "completed" || typeof row.runId !== "string") {
      const why = row.state === "not-started" ? "the point did not start (the run stopped before it)" : `the run ended ${row.state}, not completed`;
      for (const o of def.outputs) unread.push({ caseId: row.caseId, output: outputKey(o), reason: why });
      continue;
    }
    completed++;
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.runId)) throw Error("the run id is not a safe name");
      const runRoot = safeChild(runsRoot, row.runId, true);
      const record = readHostJson(safeChild(runRoot, "run-record.json"));
      if (!validate("run-record", record).ok || record.runId !== row.runId) throw Error("the saved run record does not belong to this run");
      const audited = auditProblem(audit, record, row.runId);
      if (audited) throw Error(audited);
      const evidence = loadRunEvidence(projectRoot, runRoot, record);
      for (const o of def.outputs) {
        // one output at a time: a failure of one never marks another unread, and never leaves a number counted that was also listed as unread
        try {
          const q = evidence.quantities.find((x) => x.name === o.quantity);
          if (!q) { unread.push({ caseId: row.caseId, output: outputKey(o), reason: `the run has no quantity ${o.quantity}` }); continue; }
          const mixed = basisProblem(basis, outputKey(o), q);
          if (mixed) { unread.push({ caseId: row.caseId, output: outputKey(o), reason: mixed }); continue; }
          const reduced = reduceQuantity(q.data, o.reduce);
          if (!reduced.ok) { unread.push({ caseId: row.caseId, output: outputKey(o), reason: reduced.reason }); continue; }
          outputs[outputKey(o)] = { value: reduced.value, std: reduced.std };
        } catch (e) {
          outputs[outputKey(o)] = null;
          unread.push({ caseId: row.caseId, output: outputKey(o), reason: e instanceof Error ? e.message : "the output could not be reduced" });
        }
      }
    } catch (e) {
      for (const o of def.outputs) { outputs[outputKey(o)] = null; unread.push({ caseId: row.caseId, output: outputKey(o), reason: e instanceof Error ? e.message : "the run could not be read" }); }
    }
  }
  const used = runs.filter((r) => Object.values(r.outputs).some((x) => x !== null)).map((r) => r.caseId);
  const outputs = summarizeSampling(def.parameters.map((p) => p.id), def.outputs, summaryRunsOf(def.design, runs));
  if (def.design.method === "morris") for (const o of outputs) o.note = (o.note ? o.note + "; " : "") + "the points are a walk on a grid, not a sample: this spread is over the grid, and the ranking is in the Morris effects";
  const sensitivity = sensitivityOf(def, runs);
  return { planned: results.length, completed, outputs, unread, ...(sensitivity ? { sensitivity } : {}), used, caveats: SAMPLING_CAVEATS };
}
