import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { allCases, runFromHostFile, validateHostConfiguration, type HostConfiguration } from "./fileRunHost";
import { appendReplayRecord, inside, readAdmissions, readHostJson, regularFile, safeChild } from "./hostFiles";
import type { Budget } from "./policy";
import { openProject } from "./projectStore";
import { compareReplay, type ReplayPolicy, type ReplayResult, type ReplayRun } from "./replay";
import { loadRunEvidence } from "./runEvidence";
import { loadReplayPolicy } from "./replayPolicy";
import { recordReplayInStudy } from "./studyRecordHost";
import type { RunOutcome } from "./runManager";
import { validate, type TypedError } from "./validate";

/**
 * The replay verb (docs/replay.md): run a recorded case again and say whether the new run reproduces the old one.
 * Client input: the id of the original request, a new request id for the replay, and a budget. Everything else is the host's.
 */
export type ReplayRequest = { requestId: string; originalRequestId: string; budget: Budget };
export type ReplayOutcome =
  | {
      ok: true;
      requestId: string;
      original: { requestId: string; runId: string };
      replay: { requestId: string; runId: string; state: string };
      adapter: string;
      policy: ReplayPolicy;
      basis: string;
      result: Extract<ReplayResult, { ok: true }>;
      /** Set when the replay ran and was compared but its row in the replay log could not be written. */
      recordingError?: string;
      /** The replay's step in the live study record: how many rows were appended (0 when there is no human header, or the step was already there), or why it could not be. */
      studyRecord: { appended: number } | { failed: string };
    }
  | { ok: false; errors: TypedError[]; replay?: { requestId: string; runId?: string; state?: string } };

const KEYS = ["maxCores", "maxDiskMB", "maxMemoryMB", "maxWallSeconds"];
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^r-[A-Za-z0-9_-]+$/;
const refusal = (message: string, code: string, field = ""): ReplayOutcome => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });

/**
 * Re-runs the registered case of an earlier request through the guarded run path and compares the two runs. Nothing runs unless the original is
 * proven (audit log, saved record, saved files), is completed and current, was admitted under the configuration the host has now (same runtime,
 * adapter, study rules, oracle evidence and case), its case is still registered, and the adapter has a replay policy.
 */
export async function replayFromHostFile(file: string, request: unknown, opts: { adaptersDir?: string } = {}): Promise<ReplayOutcome> {
  const r = request as Partial<ReplayRequest> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Object.keys(r).some((k) => !["requestId", "originalRequestId", "budget"].includes(k)) ||
    typeof r.requestId !== "string" ||
    !REQUEST_ID.test(r.requestId) ||
    typeof r.originalRequestId !== "string" ||
    r.originalRequestId.length < 1 ||
    r.originalRequestId.length > 256 ||
    typeof r.budget !== "object" ||
    r.budget === null ||
    Object.keys(r.budget).sort().join() !== KEYS.join() ||
    Object.values(r.budget).some((v) => !Number.isSafeInteger(v) || (v as number) < 1)
  ) {
    return refusal("invalid replay request; only requestId, originalRequestId and budget are accepted", "E_SCHEMA_INVALID");
  }
  const { requestId, originalRequestId, budget } = r as ReplayRequest;
  if (requestId === originalRequestId) return refusal("the replay needs a request id of its own, not the original's", "E_REQUEST_CONFLICT", "/requestId");
  let state: string | undefined;
  const note = (event: Record<string, unknown>) => { if (state !== undefined) appendReplayRecord(state, { requestId, originalRequestId, ...event }); };
  /** A refusal before anything runs: logged with its reason, then returned. */
  const deny = (message: string, code: string, field = ""): ReplayOutcome => { note({ phase: "refused", reason: message }); return refusal(message, code, field); };
  try {
    if (!isAbsolute(file)) return refusal("SEED_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file);
    const configBytes = readFileSync(file);
    const c: HostConfiguration = validateHostConfiguration(JSON.parse(configBytes.toString("utf8")));
    const projectRoot = realpathSync(c.projectRoot);
    state = realpathSync(c.stateRoot);
    if (inside(projectRoot, realpathSync(file)) || inside(projectRoot, state)) throw Error("host configuration and state must be outside the project");

    // 1. the adapter's policy: without one nothing is run
    const policy = loadReplayPolicy(c.adapter.id, opts.adaptersDir);
    if (!policy.ok) { note({ phase: "refused", reason: policy.errors[0]!.message }); return { ok: false, errors: policy.errors }; }

    // 2. the original, proven from the audit log and the saved files
    const project = openProject(projectRoot);
    if (!project.ok) return { ok: false, errors: project.errors };
    const projectId = project.value.manifest.projectId as string;
    const folders = project.value.manifest.folders as { runs: string };
    const runsRoot = safeChild(projectRoot, folders.runs, true);
    if (!inside(projectRoot, realpathSync(runsRoot))) throw Error("runs folder leaves project");
    const engine = safeChild(safeChild(state, "engines", true), sha256Hex(realpathSync(c.runtime.path)), true);
    const rows = readAdmissions(engine);
    const inProject = (row: any) => row.event.projectId === projectId;
    const admission = [...rows].reverse().find((row: any) => inProject(row) && row.event.phase === "request" && row.event.event.request?.requestId === originalRequestId);
    if (!admission) { return deny("no guarded admission for the original request under this runtime", "E_NOT_FOUND", "/originalRequestId"); }
    const admitted = (admission.event as any).event;
    const caseId = admitted.request?.caseId;
    if (typeof caseId !== "string") throw Error("the original admission names no case");
    // the configuration the original ran under may differ from today's only in other cases and in the sweeps
    // a case made by a sweep is compared by what it is now (its values), never by its name alone
    const registered = (x: any) => { try { return allCases(x)[caseId] ?? null; } catch { return null; } };
    // a case that is gone today is refused below with its own words (not registered), not as a changed configuration
    const gone = registered(c) === null;
    const strip = (x: any) => { const { sweeps: _s, samplings: _m, cases: _c, ...rest } = x; return { ...rest, cases: { [caseId]: gone ? null : registered(x) } }; };
    if (canonicalJson(strip(admitted.configuration)) !== canonicalJson(strip(c))) {
      return deny("the host configuration is not the one the original run was admitted under (the runtime, adapter, study rules, oracle evidence or the case changed): a replay across that change would not test reproduction", "E_REQUEST_CONFLICT", "/originalRequestId");
    }
    const nextRequest = rows.find((row: any) => row.seq > admission.seq && row.event.phase === "request");
    const attempt = rows.filter((row: any) => row.seq >= admission.seq && row.seq < (nextRequest?.seq ?? Infinity) && inProject(row) && row.event.configHash === (admission.event as any).configHash);
    const decision = attempt.find((row: any) => row.event.phase === "decision" && row.event.event.requestId === originalRequestId);
    if (!decision || !(decision.event as any).event.decision?.allow) return deny("the original request was not admitted", "E_NOT_FOUND", "/originalRequestId");
    const requests = readHostJson(safeChild(runsRoot, "requests.json"));
    const originalRunId = requests[originalRequestId]?.runId;
    if (typeof originalRunId !== "string" || !RUN_ID.test(originalRunId)) return deny("no run is bound to the original request", "E_NOT_FOUND", "/originalRequestId");
    const runRoot = safeChild(runsRoot, originalRunId, true);
    const record = readHostJson(safeChild(runRoot, "run-record.json"));
    const outcome = attempt.find((row: any) => row.seq > decision.seq && row.event.phase === "outcome" && row.event.event.runId === originalRunId);
    if (
      !outcome ||
      !(outcome.event as any).event.ok ||
      !validate("run-record", record).ok ||
      sha256Hex(canonicalJson(record)) !== (outcome.event as any).event.recordSha256 ||
      record.state !== (outcome.event as any).event.state ||
      record.extensions?.["seed.dispatch"]?.requestId !== originalRequestId
    ) return deny("the saved original run differs from its audited outcome", "E_REQUEST_CONFLICT", "/originalRequestId");
    if (record.state !== "completed") return deny(`the original run ended ${record.state}; only a completed run can be reproduced`, "E_NOT_PERMITTED", "/originalRequestId");
    const stale = record.inputs.some((i: any) => { try { regularFile(join(projectRoot, i.path)); return sha256Hex(readFileSync(join(projectRoot, i.path))) !== i.sha256; } catch { return true; } });
    if (stale) return deny("the original run is stale: an input has changed since it ran", "E_STALE_REVISION", "/originalRequestId");
    if (!Object.hasOwn(allCases(c), caseId)) return deny(`the case ${caseId} of the original run is no longer registered`, "E_NOT_FOUND", "/originalRequestId");
    const original = loadRunEvidence(projectRoot, runRoot, record);
    note({ phase: "admitted", caseId, originalRunId, adapter: c.adapter.id, policy: policy.policy });

    // 3. the replay: the same registered case through the guarded run path (policy, pins, oracles, lease and audit all apply)
    const ran: RunOutcome = await runFromHostFile(file, { requestId, caseId, budget });
    if (!ran.ok) {
      const runId = typeof ran.runId === "string" ? ran.runId : undefined;
      note({ phase: "refused", reason: ran.errors[0]?.message ?? "refused", ...(runId ? { runId } : {}) });
      return { ok: false, errors: ran.errors, replay: { requestId, ...(runId ? { runId } : {}) } };
    }
    const replayRunRoot = safeChild(runsRoot, ran.runId, true);
    const replayRecord = readHostJson(safeChild(replayRunRoot, "run-record.json"));
    if (replayRecord.runId !== ran.runId || canonicalJson(replayRecord) !== canonicalJson(ran.record)) throw Error("the replay's saved record differs from its outcome");

    // 4. the comparison
    const replay = loadRunEvidence(projectRoot, replayRunRoot, replayRecord);
    const result = compareReplay({ original, replay, policy: policy.policy });
    if (!result.ok) return { ok: false, errors: result.errors, replay: { requestId, runId: ran.runId, state: ran.state } };
    // the verdict becomes a step of the live study record (when the host has a human header); a failure never changes the replay's answer
    const studied = recordReplayInStudy({
      c, projectRoot, studiesFolder: (project.value.manifest.folders as { studies: string }).studies, projectId, engineRoot: engine,
      facts: { requestId, originalRequestId, originalRunId, replayRunId: ran.runId, replayState: ran.state, adapter: c.adapter.id, policy: policy.policy, verdict: result.verdict, differences: result.differences.map((d) => ({ kind: d.kind, field: d.field })) },
    });
    const studyRecord: { appended: number } | { failed: string } = studied.ok ? { appended: studied.appended ?? 0 } : { failed: studied.reason ?? "the study record could not be written" };
    let recordingError: string | undefined;
    try {
      note({ phase: "finished", originalRunId, replayRunId: ran.runId, replayState: ran.state, verdict: result.verdict, differences: result.differences.map((d) => ({ kind: d.kind, field: d.field })), studyRecord });
    } catch (e) {
      recordingError = "the replay ran and was compared, but its row in the replay log could not be written: " + (e instanceof Error ? e.message : "write failed");
    }
    return {
      ok: true, requestId, original: { requestId: originalRequestId, runId: originalRunId }, replay: { requestId, runId: ran.runId, state: ran.state },
      adapter: c.adapter.id, policy: policy.policy, basis: policy.basis, result, studyRecord, ...(recordingError ? { recordingError } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "replay setup failed";
    try { note({ phase: "refused", reason: message }); } catch { /* the log cannot be written: the refusal still goes back */ }
    return refusal(message, "E_SETUP_REQUIRED");
  }
}
