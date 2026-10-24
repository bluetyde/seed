import { realpathSync } from "node:fs";
import { sha256Hex } from "./canonical";
import { validateHostConfiguration, type HostConfiguration } from "./fileRunHost";
import { appendSamplingRecord, inside, readHostJson, safeChild } from "./hostFiles";
import { loadRunEvidence } from "./runEvidence";
import { recordSamplingInStudy, type SamplingFacts } from "./studyRecordHost";
import { openProject } from "./projectStore";
import type { Budget } from "./policy";
import { expandSampling, outputKey, reduceQuantity, summarizeSampling, SAMPLING_CAVEATS, type OutputSummary, type SampleRun, type SamplingDefinition } from "./sampling";
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
    }
  | { ok: false; errors: TypedError[] };

const SAMPLING_MODE: ListMode = {
  kind: "sampling",
  idKey: "samplingId",
  log: (state, event) => appendSamplingRecord(state, event),
  find: (c: HostConfiguration, id: string) => {
    const def = c.samplings !== undefined && Object.hasOwn(c.samplings, id) ? c.samplings[id] : undefined;
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
  const out = await runCaseList(file, request, SAMPLING_MODE);
  if (!out.ok) return out;
  const { id, ...rest } = out;
  let c: HostConfiguration;
  let def: SamplingDefinition;
  let summary: SamplingSummary;
  let recordingError = rest.recordingError;
  try {
    c = validateHostConfiguration(readHostJson(file));
    def = (c.samplings as Record<string, SamplingDefinition>)[id] as SamplingDefinition;
    summary = readSummary(c, def, rest.results);
  } catch (e) {
    // the cases ran; a summary that cannot be made is said, with nothing invented
    const message = "the runs finished but their summary could not be made: " + (e instanceof Error ? e.message : "read failed");
    recordingError = recordingError ? recordingError + "; " + message : message;
    summary = { planned: rest.results.length, completed: rest.results.filter((r) => r.state === "completed" || r.state === "terminated-by-trip").length, outputs: [], unread: [], caveats: SAMPLING_CAVEATS };
    return { ok: true, samplingId: id, requestId: rest.requestId, results: rest.results, complete: rest.complete, ...(rest.stoppedAt ? { stoppedAt: rest.stoppedAt } : {}), summary, studyRecord: { failed: "no summary was made, so no step was written" }, recordingError };
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
function factsOf(id: string, requestId: string, def: SamplingDefinition, summary: SamplingSummary, results: SweepCaseResult[]): SamplingFacts {
  return {
    samplingId: id, requestId, design: def.design, parameters: def.parameters,
    planned: summary.planned, completed: summary.completed,
    runIds: results.filter((r) => r.state === "completed" && typeof r.runId === "string").map((r) => r.runId as string).slice(0, 100),
    outputs: summary.outputs.map((o) => ({ key: o.key, n: o.n, mean: o.mean, inputSpread: o.inputSpread, noise: { rms: o.noise.rms, reportedRuns: o.noise.reportedRuns }, quantiles: o.quantiles ? { p05: o.quantiles.p05, p50: o.quantiles.p50, p95: o.quantiles.p95 } : null }))
  };
}

function readSummary(c: HostConfiguration, def: SamplingDefinition, results: SweepCaseResult[]): SamplingSummary {
  const projectRoot = realpathSync(c.projectRoot);
  const project = openProject(projectRoot);
  if (!project.ok) throw Error(project.errors[0]?.message ?? "the project cannot be opened");
  const runsRoot = safeChild(projectRoot, (project.value.manifest.folders as { runs: string }).runs, true);
  if (!inside(projectRoot, realpathSync(runsRoot))) throw Error("runs folder leaves project");
  const unread: SamplingSummary["unread"] = [];
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
      const evidence = loadRunEvidence(projectRoot, runRoot, record);
      for (const o of def.outputs) {
        const q = evidence.quantities.find((x) => x.name === o.quantity);
        if (!q) { unread.push({ caseId: row.caseId, output: outputKey(o), reason: `the run has no quantity ${o.quantity}` }); continue; }
        const reduced = reduceQuantity(q.data, o.reduce);
        if (!reduced.ok) { unread.push({ caseId: row.caseId, output: outputKey(o), reason: reduced.reason }); continue; }
        outputs[outputKey(o)] = { value: reduced.value, std: reduced.std };
      }
    } catch (e) {
      for (const o of def.outputs) unread.push({ caseId: row.caseId, output: outputKey(o), reason: e instanceof Error ? e.message : "the run could not be read" });
    }
  }
  return { planned: results.length, completed, outputs: summarizeSampling(def.parameters.map((p) => p.id), def.outputs, runs), unread, caveats: SAMPLING_CAVEATS };
}
