import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";
import { validateHostConfiguration, type HostConfiguration } from "./fileRunHost";
import { appendAdmission, inside, readHostJson, safeChild, writeHostJson } from "./hostFiles";
import { evaluateGate } from "./policy";
import { isAlive } from "./procTree";
import { callAdapter } from "./adapterClient";
import { appendLine } from "./atomicFile";
import { openProject, withProjectLockAsync } from "./projectStore";
import { validate } from "./validate";

export function controlBinding(c: HostConfiguration): string {
  return sha256Hex(canonicalJson({ project: realpathSync(c.projectRoot), adapter: c.adapter,
    runtime: { path: realpathSync(c.runtime.path), sha256: c.runtime.sha256 }, studyId: c.study.studyId }));
}
export function loadControlHost(file: string) {
  const c = validateHostConfiguration(readHostJson(file));
  const project = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
  if (inside(project, realpathSync(file)) || inside(project, state)) throw Error("host files must be outside project");
  const engines = safeChild(state, "engines", true);
  const engine = safeChild(engines, sha256Hex(realpathSync(c.runtime.path)), true);
  const lease = safeChild(engine, "lease", true);
  return { c, project, engine, lease };
}
function activeControl(file: string, request: unknown) {
  if (!request || typeof request !== "object" || Object.keys(request).join() !== "requestId" ||
    typeof (request as any).requestId !== "string" || !(request as any).requestId || (request as any).requestId.length > 256) throw Error("only the original requestId is accepted");
  const h = loadControlHost(file);
  const owner = readHostJson(safeChild(h.lease, "owner.json"));
  const active = readHostJson(safeChild(h.lease, "active.json"));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 2 || typeof owner.token !== "string" ||
    active.token !== owner.token || active.binding !== controlBinding(h.c) || active.requestId !== (request as any).requestId) throw Error("request does not match the owned active calculation");
  return { ...h, owner, active };
}
const errorReply = (e: unknown) => ({ ok: false as const, errors: [{ code: "E_NOT_PERMITTED", field: "", message: e instanceof Error ? e.message : "host control refused", source: "seed" }] });

/** Queue only: the live calculation owner reloads authority and audits before stopping its adapter. */
export function requestHostCancellation(file: string, request: unknown) {
  try {
    const h = activeControl(file, request);
    if (!isAlive(h.owner.pid)) throw Error("calculation owner is gone; use human recovery");
    const decision = evaluateGate({ operation: "cancel", actor: h.c.actor, studyId: h.c.study.studyId,
      inputRevisions: h.active.inputs }, { study: h.c.study, grants: h.c.grants });
    if (!decision.allow) return { ok: false as const, errors: decision.errors };
    writeHostJson(join(h.lease, "cancel.json"), { schema: "seed.cancel/0.1", requestId: h.active.requestId,
      token: h.owner.token, nonce: randomBytes(16).toString("hex") });
    return { ok: true as const, state: "cancellation-requested" };
  } catch (e) { return errorReply(e); }
}

/** Conservative recovery: human host, dead owner, same recipe, validated run and confirmed adapter stop. */
export async function recoverHostCalculation(file: string, request: unknown) {
  let guard: string | undefined;
  let guarded = false;
  try {
    const h = activeControl(file, request);
    if (h.c.actor.kind !== "human") throw Error("recovery requires a human host identity");
    if (isAlive(h.owner.pid)) throw Error("owner is alive or its identity is ambiguous; recovery refused");
    guard = safeChild(h.engine, "recovery", true); mkdirSync(guard); guarded = true;
    const fresh = activeControl(file, request);
    if (fresh.owner.token !== h.owner.token || isAlive(fresh.owner.pid)) throw Error("ownership changed during recovery");
    if (sha256Hex(readFileSync(realpathSync(h.c.runtime.path))) !== h.c.runtime.sha256) throw Error("runtime changed; inspect manually");
    const project = openProject(h.project); if (!project.ok) return { ok: false as const, errors: project.errors };
    const runs = safeChild(h.project, (project.value.manifest.folders as { runs: string }).runs, true);
    const requests = readHostJson(safeChild(runs, "requests.json"));
    const runId = requests[h.active.requestId]?.runId;
    if (typeof runId !== "string" || !/^r-[A-Za-z0-9_-]+$/.test(runId) || h.active.runId !== runId || typeof h.active.jobId !== "string") throw Error("no authoritative launch binding; inspect launch evidence manually");
    const dir = safeChild(runs, runId, true);
    const record = readHostJson(safeChild(dir, "run-record.json"));
    if (!validate("run-record", record).ok || record.runId !== runId || record.extensions?.["seed.dispatch"]?.requestId !== h.active.requestId ||
      !["queued", "running"].includes(record.state) || record.jobId !== h.active.jobId) throw Error("run is terminal, invalid or differs from authoritative job identity; inspect manually");
    const dispatch = record.extensions?.["seed.dispatch"];
    if (dispatch?.studyId !== h.c.study.studyId || record.adapter?.id !== h.c.adapter.id || record.adapter?.version !== h.c.adapter.version) throw Error("run study/adapter does not match host");
    const locked = await withProjectLockAsync(h.project, async () => {
      if (canonicalJson(readHostJson(safeChild(dir, "run-record.json"))) !== canonicalJson(record)) throw Error("run record changed during recovery");
      appendAdmission(h.engine, { phase: "recovery-request", actor: h.c.actor, requestId: h.active.requestId, runId, owner: h.owner });
      // Select the native target only from external host launch evidence, never a reread project record.
      const stopped = await callAdapter({ ...h.c.adapter, ...(h.c.adapter.id === "raft" ? { env: { SEED_RAFT_HEADLESS: realpathSync(h.c.runtime.path) } } : {}) },
        { schema: "seed.adapter-request/0.1", verb: "cancel", requestId: "recover-" + randomBytes(12).toString("hex"), actor: h.c.actor, jobId: h.active.jobId },
        { projectRoot: h.project, timeoutMs: 15000 });
      const reply = stopped.ok ? stopped.reply as any : undefined;
      const confirmed = reply?.ok === true && reply.result?.jobId === h.active.jobId && reply.result?.cancelled === true && reply.result?.lifecycle === "cancelled";
      appendAdmission(h.engine, { phase: "recovery-stop", actor: h.c.actor, runId, jobId: h.active.jobId, confirmed });
      if (!confirmed) throw Error("adapter stop not confirmed; lease retained for inspection");
      if (canonicalJson(readHostJson(safeChild(dir, "run-record.json"))) !== canonicalJson(record)) throw Error("run record changed during stop; job stopped but lease retained for inspection");
      const finalRecord = { ...record, state: "cancelled", native: { status: "cancelled" }, finishedAt: new Date().toISOString() };
      if (!validate("run-record", finalRecord).ok) throw Error("recovered record invalid; lease retained");
      appendLine(join(safeChild(dir, "log", true), "transitions.jsonl"), JSON.stringify({ time: finalRecord.finishedAt, from: record.state, to: "cancelled", reason: "human recovery: bound adapter stop confirmed" }));
      writeHostJson(join(dir, "run-record.json"), finalRecord);
      appendAdmission(h.engine, { phase: "recovery-outcome", actor: h.c.actor, runId, state: "cancelled" });
      const owner = readHostJson(safeChild(h.lease, "owner.json"));
      if (owner.token !== h.owner.token || isAlive(owner.pid)) throw Error("ownership changed; lease retained");
      rmSync(safeChild(h.engine, "lease", true), { recursive: true });
      return { ok: true as const, state: "recovered-cancelled", runId };
    });
    return locked.ok ? locked.value : { ok: false as const, errors: locked.errors };
  } catch (e) { return errorReply(e); }
  finally { if (guarded && guard && existsSync(guard)) rmdirSync(guard); }
}
