import { comparePins, type PinSet, type SetResult } from "./oracle";
import { evaluateGate, type Actor, type Budget, type Decision, type GateContext } from "./policy";
import { withProjectLockAsync } from "./projectStore";
import { RunManager, type RunManagerOptions, type RunOutcome, type StartRequest } from "./runManager";

/** Client input has no actor, command, policy, grant, oracle verdict, settings or path. */
export type DispatchRequest = { requestId: string; caseId: string; budget: Budget };
/** Registered immutable case, resolved by host code, never supplied by the client. */
export type RegisteredCase = Pick<StartRequest, "artifact" | "inputs" | "settings" | "seed"> & {
  params: { id: string; value: number }[];
};
export type DispatchAuthority = {
  context: Omit<GateContext, "oracleBlocked" | "pinsChanged">;
  currentPins: PinSet;
  acceptedPins?: PinSet;
  oracleResult?: SetResult;
};
export type DispatchAudit = { requestId: string; caseId: string; actor: Actor; decision: Decision; pins?: PinSet };
export type DispatcherOptions = {
  manager: RunManagerOptions;
  actor: Actor;
  /** Host-wide canonical engine identity; share across every project using this engine. */
  engine: string;
  loadCase: (caseId: string) => Promise<RegisteredCase>;
  loadAuthority: () => Promise<DispatchAuthority>;
  /** Must durably record the decision before resolving. Failure blocks launch. */
  audit: (event: DispatchAudit) => Promise<void>;
};

// One process hosts the dispatcher. Separate hosts need a shared engine lease before transports ship.
const occupied = new Set<string>();
function refusal(message: string, code = "E_NOT_PERMITTED"): RunOutcome {
  return { ok: false, errors: [{ code, field: "", message, source: "seed" }] };
}

/** The host's run entry point. RunManager remains a low-level lifecycle primitive for oracle/bootstrap tests. */
export class RunDispatcher {
  readonly #options: DispatcherOptions;
  readonly #manager: RunManager;
  constructor(options: DispatcherOptions) {
    this.#options = { ...options, actor: structuredClone(options.actor), manager: structuredClone({
      projectRoot: options.manager.projectRoot, runsFolder: options.manager.runsFolder, adapter: options.manager.adapter,
    }) };
    this.#manager = new RunManager({ ...options.manager, adapter: structuredClone(options.manager.adapter) });
  }

  /** Called only by the trusted host after its cancellation gate and durable audit. */
  hasActiveRequest(requestId: string): boolean { return this.#manager.hasActiveRequest(requestId); }
  cancelRequest(requestId: string): Promise<RunOutcome> | undefined { return this.#manager.cancelRequest(requestId); }

  async start(input: DispatchRequest): Promise<RunOutcome> {
    const o = this.#options;
    let request: DispatchRequest;
    try {
      request = structuredClone(input);
      if (!request || Object.keys(request).some(k => !["requestId", "caseId", "budget"].includes(k)) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.caseId) || typeof request.caseId !== "string" ||
          typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 256 || !request.budget ||
          Object.keys(request.budget).sort().join() !== "maxCores,maxDiskMB,maxMemoryMB,maxWallSeconds" ||
          Object.values(request.budget).some(v => !Number.isSafeInteger(v) || v < 1)) {
        return refusal("invalid run request; only requestId, registered caseId and budget are accepted", "E_SCHEMA_INVALID");
      }
    } catch { return refusal("run request must be cloneable data", "E_SCHEMA_INVALID"); }

    // Reserve before awaiting loaders or audit, so two dispatchers cannot both pass the gate.
    if (occupied.has(o.engine)) return refusal("one active case per engine", "E_BUDGET_EXCEEDED");
    occupied.add(o.engine);
    try {
      const locked = await withProjectLockAsync(o.manager.projectRoot, async (): Promise<RunOutcome> => {
        const registered = structuredClone(await o.loadCase(request.caseId));
        const authority = await o.loadAuthority();
        // Preserve the trusted clock callback; all mutable policy/pin data gets a private snapshot.
        const now = authority.context.now;
        const a = structuredClone({ ...authority, context: { ...authority.context, now: undefined } });
        if (!["A0", "A1", "A2", "A3"].includes(a.context.study.tier) ||
            !Array.isArray(registered.params) || !Array.isArray(a.context.study.parameters) ||
            ["maxWallSeconds", "maxCores", "maxMemoryMB", "maxDiskMB"].some(k => {
              const v = a.context.study.budget[k as keyof Budget]; return !Number.isSafeInteger(v) || v < 1;
            })) return refusal("invalid host policy or registered parameters", "E_SCHEMA_INVALID");
        const result = a.oracleResult;
        const pinsChanged = !a.acceptedPins || comparePins(a.acceptedPins, a.currentPins).length > 0 ||
          !result || comparePins(result.pins, a.currentPins).length > 0;
        const oracleBlocked = !/^[0-9a-f]{40}$/.test(a.currentPins.appCommit) ||
          a.currentPins.oracleFiles.some(pin => !/^[0-9a-f]{64}$/.test(pin.sha256) ||
            !result?.results.some(r => r.oracleId === pin.oracleId && r.entryVersion === pin.entryVersion)) || !result || result.blocked !== false || result.verdict !== "pass" ||
          result.inputsVerified !== true || result.adapter !== o.manager.adapter.id ||
          result.adapterVersion !== o.manager.adapter.version || !result.results.some(r => r.tag === "good" && r.verdict === "pass") ||
          result.results.some(r => r.tag !== "known-limit" && r.verdict !== "pass") || a.currentPins.oracleFiles.length === 0;
        const decision = evaluateGate({ operation: "run_case", actor: o.actor, studyId: a.context.study.studyId,
          budget: request.budget, params: registered.params, engine: o.engine, activeOnEngine: 0,
          inputRevisions: registered.inputs.map(i => ({ artifact: i.path, revision: i.sha256 })),
        }, { ...a.context, now, pinsChanged, oracleBlocked });
        await o.audit(structuredClone({ requestId: request.requestId, caseId: request.caseId, actor: o.actor, decision, pins: a.currentPins }));
        if (!decision.allow) return { ok: false, errors: decision.errors };
        return this.#manager.start({ requestId: request.requestId, actor: structuredClone(o.actor),
          artifact: registered.artifact, inputs: registered.inputs, settings: registered.settings, seed: registered.seed,
          budget: request.budget, studyBudget: a.context.study.budget,
          extensions: { "seed.dispatch": { requestId: request.requestId, studyId: a.context.study.studyId, actor: o.actor, caseId: request.caseId, pins: a.currentPins, via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {}) } },
        });
      });
      return locked.ok ? locked.value : { ok: false, errors: locked.errors };
    } catch { return refusal("could not load authority, record the gate decision, or dispatch the run", "E_INTERNAL"); }
    finally { occupied.delete(o.engine); }
  }
}
