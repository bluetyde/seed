import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson, sha256Hex } from "./canonical";
import {
  checkOracleInputs,
  latestEntries,
  loadOracleEntries,
  pinsOf,
  type PinSet,
  type SetResult,
} from "./oracle";
import { evaluateGate, issueGrant, type Actor, type Decision, type Grant, type PolicyStudy } from "./policy";
import { controlBinding } from "./hostControl";
import { loadOracleAuthority } from "./oracleAuthority";
import { expandSampling, type SamplingDefinition } from "./sampling";
import { approvedSamplings } from "./samplingProposal";
import { expandSweep, type SweepDefinition } from "./sweep";
import { recordRequestInStudy, type LiveContext } from "./studyRecordHost";
import { RunDispatcher, type DispatchRequest, type RegisteredCase } from "./runDispatcher";
import { openProject } from "./projectStore";
import { type RunOutcome } from "./runManager";
import { type AdapterSpec } from "./adapterClient";
import {
  appendAdmission,
  appendRefusal,
  inside,
  readAdmissions,
  readHostJson,
  regularFile,
  withEngineLease,
  writeHostJson,
} from "./hostFiles";

export type HostConfiguration = {
  schema: "seed.host/0.1";
  projectRoot: string;
  stateRoot: string;
  adapter: AdapterSpec & { id: string; version: string };
  actor: Actor;
  study: PolicyStudy;
  cases: Record<string, RegisteredCase>;
  /** Registered sweeps: each one expands to cases of its own (see sweep.ts), ids `<sweepId>-001` and on. */
  sweeps?: Record<string, SweepDefinition>;
  /** Registered sampling studies (see sampling.ts): each point is a case, ids `<samplingId>-001` and on. */
  samplings?: Record<string, SamplingDefinition>;
  runtime: { path: string; sha256: string };
  oracles: {
    repository: string;
    entriesDir: string;
    inputsRoot: string;
    evidenceFile: string;
    evidenceSha256: string;
  };
  acceptedPins: PinSet;
  grants?: Grant[];
};
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, "../../schema/common.schema.json"), "utf8")));
const check = ajv.compile(JSON.parse(readFileSync(join(__dirname, "../../schema/host.schema.json"), "utf8")));
export function validateHostConfiguration(value: unknown): HostConfiguration {
  if (!check(value)) throw Error("invalid seed.host/0.1 configuration: " + ajv.errorsText(check.errors));
  const c = structuredClone(value) as HostConfiguration;
  const absolute = [
    c.projectRoot,
    c.stateRoot,
    c.adapter.command,
    c.runtime.path,
    c.oracles.repository,
    c.oracles.entriesDir,
    c.oracles.inputsRoot,
    c.oracles.evidenceFile,
  ];
  if (absolute.some(p => !isAbsolute(p))) throw Error("host paths and adapter executable must be absolute");
  const seen = new Set<string>();
  for (const bound of c.study.parameters) {
    if (bound.min > bound.max || seen.has(bound.id)) throw Error("invalid or duplicate parameter bound");
    seen.add(bound.id);
  }
  for (const grant of c.grants ?? []) {
    const { approvedBy, revoked, ...body } = grant;
    const checked = issueGrant(approvedBy, body);
    if (!checked.ok) throw Error("invalid persisted grant");
  }
  for (const registered of Object.values(c.cases)) {
    if (
      !registered.inputs.some(
        i => i.path === registered.artifact.path && i.sha256 === registered.artifact.revision.hash,
      )
    )
      throw Error("registered artifact must be among its pinned inputs");
    const ids = new Set<string>();
    for (const p of registered.params) {
      if (ids.has(p.id)) throw Error("duplicate registered parameter");
      ids.add(p.id);
    }
    if (ids.size !== seen.size || [...seen].some(id => !ids.has(id)))
      throw Error("registered case must name every study parameter exactly once");
  }
  for (const [sweepId, def] of Object.entries(c.sweeps ?? {})) {
    const expanded = expandSweep(sweepId, def, c.cases, c.study);
    if (!expanded.ok) throw Error("invalid sweep " + sweepId + ": " + expanded.errors.map(e => e.message).join("; "));
    for (const x of expanded.cases)
      if (Object.hasOwn(c.cases, x.caseId))
        throw Error("sweep " + sweepId + " would reuse the registered case id " + x.caseId);
  }
  const taken = new Set<string>(Object.keys(c.cases));
  for (const [sweepId, def] of Object.entries(c.sweeps ?? {})) {
    const expanded = expandSweep(sweepId, def, c.cases, c.study);
    if (expanded.ok) for (const x of expanded.cases) taken.add(x.caseId);
  }
  for (const [samplingId, def] of Object.entries(c.samplings ?? {})) {
    const expanded = expandSampling(samplingId, def, c.cases, c.study);
    if (!expanded.ok) throw Error("invalid sampling " + samplingId + ": " + expanded.errors.map(e => e.message).join("; "));
    for (const x of expanded.cases) {
      if (taken.has(x.caseId)) throw Error("sampling " + samplingId + " would reuse the case id " + x.caseId);
      taken.add(x.caseId);
    }
  }
  return c;
}
/** Every case a client may name: the registered ones and those of the registered sweeps. */
export function allCases(c: HostConfiguration): Record<string, RegisteredCase> {
  const all: Record<string, RegisteredCase> = { ...c.cases };
  for (const [sweepId, def] of Object.entries(c.sweeps ?? {})) {
    const expanded = expandSweep(sweepId, def, c.cases, c.study);
    if (!expanded.ok) throw Error("invalid sweep " + sweepId);
    for (const x of expanded.cases) all[x.caseId] = x.registered;
  }
  for (const [samplingId, def] of Object.entries(c.samplings ?? {})) {
    const expanded = expandSampling(samplingId, def, c.cases, c.study);
    if (!expanded.ok) throw Error("invalid sampling " + samplingId);
    for (const x of expanded.cases) all[x.caseId] = x.registered;
  }
  // samplings a person approved from an agent's proposal are registered cases too (a damaged proposal log registers none)
  try {
    for (const [samplingId, def] of approvedSamplings(realpathSync(c.stateRoot))) {
      if (Object.hasOwn(all, samplingId)) continue;
      const expanded = expandSampling(samplingId, def, c.cases, c.study);
      if (expanded.ok) for (const x of expanded.cases) if (!Object.hasOwn(all, x.caseId)) all[x.caseId] = x.registered; // never over a case that is already registered
    }
  } catch { /* no approved samplings are registered under a log that can not be read */ }
  return all;
}
/** Called by trusted setup code; the run CLI provides no configuration or approval writer. */
export function saveHostConfiguration(file: string, value: unknown): void {
  const config = validateHostConfiguration(value);
  if (!isAbsolute(file) || inside(realpathSync(config.projectRoot), realpathSync(dirname(file))))
    throw Error("host configuration must live outside the project");
  writeHostJson(file, config);
}
function failed(message: string, code = "E_INTERNAL"): RunOutcome {
  return { ok: false, errors: [{ code, field: "", message, source: "seed" }] };
}

/** Uses only the config selected by the trusted host environment. No client path or actor fields. */
export async function runFromHostFile(file: string, request: unknown, context?: LiveContext): Promise<RunOutcome> {
  try {
    if (!isAbsolute(file)) return failed("SEED_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file);
    const configBytes = readFileSync(file);
    const configHash = sha256Hex(configBytes);
    const c = validateHostConfiguration(JSON.parse(configBytes.toString("utf8")));
    const cases = allCases(c);
    const project = realpathSync(c.projectRoot);
    const state = realpathSync(c.stateRoot);
    if (inside(project, realpathSync(file)) || inside(project, state))
      throw Error("host configuration and state must be outside the project");
    if (inside(project, realpathSync(c.oracles.evidenceFile)))
      throw Error("oracle evidence must be outside the project");
    const p = openProject(project);
    if (!p.ok) return { ok: false, errors: p.errors };
    const runtime = realpathSync(c.runtime.path);
    const engineKey = runtime; // Every config using this executable must share the same state root.
    return await withEngineLease(state, engineKey, async engineRoot => {
      const audit = (phase: string, event: unknown) =>
        appendAdmission(engineRoot, {
          phase,
          actor: c.actor,
          projectId: p.value.manifest.projectId,
          configHash,
          event,
        });
      audit("request", { request, configuration: c });
      const lease = join(engineRoot, "lease");
      const owner = readHostJson(join(lease, "owner.json"));
      if (request && typeof request === "object" && typeof (request as any).requestId === "string") {
        writeHostJson(join(lease, "active.json"), {
          requestId: (request as any).requestId,
          token: owner.token,
          binding: controlBinding(c),
          inputs:
            (Object.hasOwn(cases, (request as any).caseId) ? cases[(request as any).caseId] : undefined)?.inputs.map(i => ({ artifact: i.path, revision: i.sha256 })) ??
            [],
        });
      }
      const unchanged = () => {
        regularFile(file);
        if (sha256Hex(readFileSync(file)) !== configHash)
          throw Error("host configuration changed during admission");
        regularFile(runtime);
        if (sha256Hex(readFileSync(runtime)) !== c.runtime.sha256)
          throw Error("runtime bundle changed since host approval");
      };
      let dispatched: RunOutcome | undefined;
      try {
        unchanged();
        // Fixed host environment for the RAFT adapter, never request content.
        let lastDecision: Decision | undefined;
        const dispatcher = new RunDispatcher({
          manager: {
            projectRoot: project,
            runsFolder: (p.value.manifest.folders as { runs: string }).runs,
            onLaunch: identity => {
              writeHostJson(join(lease, "owner.json"), { ...owner, retain: true });
              const active = readHostJson(join(lease, "active.json"));
              writeHostJson(join(lease, "active.json"), { ...active, ...identity });
            },
            adapter: {
              ...c.adapter,
              ...(c.adapter.id === "raft" ? { env: { SEED_RAFT_HEADLESS: runtime } } : {}),
            },
          },
          actor: c.actor,
          engine: engineKey,
          loadCase: async id => {
            unchanged();
            if (!Object.hasOwn(cases, id)) throw Error("case is not registered");
            return cases[id]!;
          },
          loadAuthority: async () => {
            unchanged();
            const authority = loadOracleAuthority(c.oracles, { id: c.adapter.id, version: c.adapter.version }, state);
            return {
              context: { study: c.study, grants: c.grants },
              currentPins: authority.currentPins,
              acceptedPins: c.acceptedPins,
              oracleResult: authority.oracleResult,
              journalBlocked: authority.journalBlocked,
            };
          },
          audit: async event => {
            unchanged();
            audit("decision", event);
            lastDecision = event.decision;
          },
          // The caller's reply carries only a stage and a failure class; the full cause stays here, in the host's
          // state folder, which clients cannot reach.
          onInternalError: (stage, cause) => {
            try {
              const e = cause as { code?: unknown; name?: unknown; message?: unknown };
              appendFileSync(
                join(engineRoot, "diagnostics.jsonl"),
                JSON.stringify({
                  time: new Date().toISOString(),
                  project: p.value.manifest.projectId,
                  stage,
                  kind: String(e?.code ?? e?.name ?? "Error").slice(0, 80),
                  message: String(e?.message ?? cause).slice(0, 1000),
                }) + "\n",
              );
            } catch {
              // diagnostics are best effort: a failure to write one must not change the refusal
            }
          },
        });
        let busy = false;
        let lastNonce = "";
        let lastFailure = "";
        let attempt: Promise<unknown> | undefined;
        let controlError: unknown;
        const heartbeat = setInterval(() => {
          try {
            if (readHostJson(join(lease, "owner.json")).token === owner.token)
              writeHostJson(join(lease, "heartbeat.json"), {
                token: owner.token,
                pid: owner.pid,
                requestId: (request as any)?.requestId,
                configHash,
                time: Date.now(),
              });
          } catch {
            /* observation becomes stale; no change to calculation ownership */
          }
        }, 1000);
        const timer = setInterval(() => {
          if (busy || !existsSync(join(lease, "cancel.json"))) return;
          try {
            const control = readHostJson(join(lease, "cancel.json"));
            if (typeof control.nonce !== "string" || !/^[0-9a-f]{32}$/.test(control.nonce))
              throw Error("invalid cancellation nonce");
            if (
              control.nonce === lastNonce ||
              control.token !== owner.token ||
              control.requestId !== (request as any)?.requestId
            )
              return;
            const current = validateHostConfiguration(readHostJson(file));
            if (controlBinding(current) !== controlBinding(c))
              throw Error("host recipe changed; cancellation refused");
            const active = readHostJson(join(lease, "active.json"));
            const decision = evaluateGate(
              {
                operation: "cancel",
                actor: current.actor,
                studyId: current.study.studyId,
                inputRevisions: active.inputs,
              },
              { study: current.study, grants: current.grants },
            );
            // Cancellation may arrive before RunManager creates the run. Retry until owner routing exists.
            if (!dispatcher.hasActiveRequest(control.requestId)) return;
            audit("cancel-decision", { requestId: control.requestId, actor: current.actor, decision });
            lastNonce = control.nonce;
            if (!decision.allow) return;
            busy = true;
            attempt = dispatcher
              .cancelRequest(control.requestId)
              ?.then(result => {
                audit("cancel-outcome", result);
              })
              .catch(e => {
                controlError = e;
              })
              .finally(() => {
                busy = false;
              });
          } catch (e) {
            const message = e instanceof Error ? e.message : "cancel refused";
            if (message === lastFailure) return;
            lastFailure = message;
            try {
              audit("cancel-refusal", { message });
            } catch (failure) {
              controlError = failure;
            }
          }
        }, 100);
        let outcome: RunOutcome;
        try {
          outcome = await dispatcher.start(request as DispatchRequest);
          dispatched = outcome;
          // Failed/interrupted records alone cannot prove the native process stopped.
          if (outcome.ok && ["failed", "interrupted"].includes(outcome.state))
            writeHostJson(join(lease, "owner.json"), { ...owner, retain: true });
          await attempt;
          if (controlError) throw controlError;
        } finally {
          clearInterval(timer);
          clearInterval(heartbeat);
        }
        dispatched = outcome;
        let replayOf: string | undefined;
        if (outcome.ok && outcome.replayed) {
          const original = readAdmissions(engineRoot).find(
            (row: any) =>
              row.event.phase === "outcome" &&
              row.event.projectId === p.value.manifest.projectId &&
              row.event.configHash === configHash &&
              row.event.event.ok === true &&
              row.event.event.runId === outcome.runId,
          );
          const evidence = original?.event as any;
          if (
            !original ||
            evidence.event.state !== outcome.state ||
            evidence.event.recordSha256 !== sha256Hex(canonicalJson(outcome.record))
          )
            throw Error("replayed record differs from original audited outcome or lacks a trusted hash");
          replayOf = original.hash;
        }
        audit(
          "outcome",
          outcome.ok
            ? {
                ok: true,
                runId: outcome.runId,
                state: outcome.state,
                recordSha256: sha256Hex(canonicalJson(outcome.record)),
                ...(replayOf ? { replayOf } : {}),
              }
            : outcome,
        );
        if (outcome.ok && ["completed", "cancelled", "terminated-by-trip"].includes(outcome.state))
          writeHostJson(join(lease, "owner.json"), { ...owner, retain: false });
        // The live study record is derived from what the host has just audited. It never changes the outcome: a failure goes to the diagnostics.
        const asked = request as { requestId?: unknown; caseId?: unknown } | null;
        if (asked && typeof asked.requestId === "string" && typeof asked.caseId === "string") {
          recordRequestInStudy({
            c,
            projectRoot: project,
            studiesFolder: (p.value.manifest.folders as { studies: string }).studies,
            projectId: p.value.manifest.projectId as string,
            engineRoot,
            requestId: asked.requestId,
            caseId: asked.caseId,
            decision: lastDecision,
            outcome: outcome.ok ? { ok: true, runId: outcome.runId, state: outcome.state } : { ok: false },
            ...(context ? { context } : {}),
          });
        }
        return outcome;
      } catch (e) {
        const message = e instanceof Error ? e.message : "host dispatch failed";
        const outcome = dispatched?.ok
          ? {
              ...failed("run finished but its outcome could not be recorded: " + message),
              runId: dispatched.runId,
            }
          : failed(message);
        if (dispatched === undefined) audit("outcome", outcome);
        return outcome;
      }
    }, () =>
      appendRefusal(state, {
        phase: "engine-busy",
        actor: c.actor,
        projectId: p.value.manifest.projectId,
        requestId: (request as any)?.requestId,
        caseId: (request as any)?.caseId,
        rule: "one active case per engine",
        budget: (request as any)?.budget,
      }),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "host setup failed";
    return failed(message, message.startsWith("E_ENGINE_BUSY") ? "E_BUDGET_EXCEEDED" : "E_SETUP_REQUIRED");
  }
}
