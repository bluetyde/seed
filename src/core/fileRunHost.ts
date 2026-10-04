import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020";
import { sha256Hex } from "./canonical";
import { checkOracleInputs, latestEntries, loadOracleEntries, pinsOf, type PinSet, type SetResult } from "./oracle";
import { issueGrant, type Actor, type Grant, type PolicyStudy } from "./policy";
import { RunDispatcher, type DispatchRequest, type RegisteredCase } from "./runDispatcher";
import { openProject } from "./projectStore";
import { type RunOutcome } from "./runManager";
import { type AdapterSpec } from "./adapterClient";
import { appendAdmission, inside, readHostJson, regularFile, withEngineLease, writeHostJson } from "./hostFiles";

export type HostConfiguration = {
  schema: "seed.host/0.1"; projectRoot: string; stateRoot: string;
  adapter: AdapterSpec & { id: string; version: string }; actor: Actor; study: PolicyStudy;
  cases: Record<string, RegisteredCase>; runtime: { path: string; sha256: string };
  oracles: { repository: string; entriesDir: string; inputsRoot: string; evidenceFile: string; evidenceSha256: string };
  acceptedPins: PinSet; grants?: Grant[];
};
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, "../../schema/common.schema.json"), "utf8")));
const check = ajv.compile(JSON.parse(readFileSync(join(__dirname, "../../schema/host.schema.json"), "utf8")));
export function validateHostConfiguration(value: unknown): HostConfiguration {
  if (!check(value)) throw Error("invalid seed.host/0.1 configuration: " + ajv.errorsText(check.errors));
  const c = structuredClone(value) as HostConfiguration;
  const absolute = [c.projectRoot, c.stateRoot, c.adapter.command, c.runtime.path, c.oracles.repository, c.oracles.entriesDir, c.oracles.inputsRoot, c.oracles.evidenceFile];
  if (absolute.some(p => !isAbsolute(p))) throw Error("host paths and adapter executable must be absolute");
  const seen = new Set<string>();
  for (const bound of c.study.parameters) {
    if (bound.min > bound.max || seen.has(bound.id)) throw Error("invalid or duplicate parameter bound"); seen.add(bound.id);
  }
  for (const grant of c.grants ?? []) {
    const { approvedBy, revoked, ...body } = grant;
    const checked = issueGrant(approvedBy, body);
    if (!checked.ok) throw Error("invalid persisted grant");
  }
  for (const registered of Object.values(c.cases)) {
    if (!registered.inputs.some(i => i.path === registered.artifact.path && i.sha256 === registered.artifact.revision.hash)) throw Error("registered artifact must be among its pinned inputs");
    const ids = new Set<string>();
    for (const p of registered.params) { if (ids.has(p.id)) throw Error("duplicate registered parameter"); ids.add(p.id); }
    if (ids.size !== seen.size || [...seen].some(id => !ids.has(id))) throw Error("registered case must name every study parameter exactly once");
  }
  return c;
}
/** Called by trusted setup code; the run CLI provides no configuration or approval writer. */
export function saveHostConfiguration(file: string, value: unknown): void {
  const config = validateHostConfiguration(value);
  if (!isAbsolute(file) || inside(realpathSync(config.projectRoot), realpathSync(dirname(file)))) throw Error("host configuration must live outside the project");
  writeHostJson(file, config);
}
function failed(message: string, code = "E_INTERNAL"): RunOutcome {
  return { ok: false, errors: [{ code, field: "", message, source: "seed" }] };
}

/** Uses only the config selected by the trusted host environment. No client path or actor fields. */
export async function runFromHostFile(file: string, request: unknown): Promise<RunOutcome> {
  try {
    if (!isAbsolute(file)) return failed("SEED_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file); const configBytes = readFileSync(file); const configHash = sha256Hex(configBytes);
    const c = validateHostConfiguration(JSON.parse(configBytes.toString("utf8")));
    const project = realpathSync(c.projectRoot); const state = realpathSync(c.stateRoot);
    if (inside(project, realpathSync(file)) || inside(project, state)) throw Error("host configuration and state must be outside the project");
    if (inside(project, realpathSync(c.oracles.evidenceFile))) throw Error("oracle evidence must be outside the project");
    const p = openProject(project); if (!p.ok) return { ok: false, errors: p.errors };
    const runtime = realpathSync(c.runtime.path);
    const engineKey = runtime; // Every config using this executable must share the same state root.
    return await withEngineLease(state, engineKey, async engineRoot => {
      const audit = (phase: string, event: unknown) => appendAdmission(engineRoot, { phase, actor: c.actor, projectId: p.value.manifest.projectId, configHash, event });
      audit("request", { request, configuration: c });
      const unchanged = () => {
        regularFile(file);
        if (sha256Hex(readFileSync(file)) !== configHash) throw Error("host configuration changed during admission");
        regularFile(runtime);
        if (sha256Hex(readFileSync(runtime)) !== c.runtime.sha256) throw Error("runtime bundle changed since host approval");
      };
      let dispatched: RunOutcome | undefined;
      try {
        unchanged();
        // Fixed host environment for the RAFT adapter, never request content.
        const dispatcher = new RunDispatcher({ manager: { projectRoot: project, runsFolder: (p.value.manifest.folders as { runs: string }).runs, adapter: { ...c.adapter, ...(c.adapter.id === "raft" ? { env: { SEED_RAFT_HEADLESS: runtime } } : {}) } }, actor: c.actor, engine: engineKey,
          loadCase: async id => {
            unchanged(); if (!Object.hasOwn(c.cases, id)) throw Error("case is not registered"); return c.cases[id]!;
          },
          loadAuthority: async () => {
            unchanged(); regularFile(c.oracles.evidenceFile);
            const bytes = readFileSync(c.oracles.evidenceFile);
            if (sha256Hex(bytes) !== c.oracles.evidenceSha256) throw Error("oracle evidence changed since host approval");
            const result = JSON.parse(bytes.toString("utf8")) as SetResult;
            const entries = loadOracleEntries(c.oracles.entriesDir);
            if (entries.errors.length) throw Error("oracle entry could not be verified");
            const currentEntries = latestEntries(entries.entries, c.adapter.id);
            for (const item of currentEntries) if (checkOracleInputs(item.entry, c.oracles.inputsRoot).length) throw Error("oracle inputs changed");
            const git = spawnSync("git", ["-C", c.oracles.repository, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 });
            if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim())) throw Error("could not determine app commit");
            return { context: { study: c.study, grants: c.grants }, currentPins: pinsOf(currentEntries, git.stdout.trim()), acceptedPins: c.acceptedPins, oracleResult: result };
          },
          audit: async event => { unchanged(); audit("decision", event); },
        });
        const outcome = await dispatcher.start(request as DispatchRequest);
        dispatched = outcome;
        audit("outcome", outcome.ok ? { ok: true, runId: outcome.runId, state: outcome.state } : outcome);
        return outcome;
      } catch (e) {
        const message = e instanceof Error ? e.message : "host dispatch failed";
        const outcome = dispatched?.ok ? { ...failed("run finished but its outcome could not be recorded: " + message), runId: dispatched.runId } : failed(message);
        if (dispatched === undefined) audit("outcome", outcome);
        return outcome;
      }
    });
  } catch (e) { const message = e instanceof Error ? e.message : "host setup failed"; return failed(message, message.startsWith("E_ENGINE_BUSY") ? "E_BUDGET_EXCEEDED" : "E_SETUP_REQUIRED"); }
}
