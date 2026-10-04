# Guarded run dispatch (E2)

`RunDispatcher` in `src/core/runDispatcher.ts` connects the existing policy gate and oracle verdicts to `RunManager.start`. It is a host library entry point. The public CLI calls it through FileRunHost; see [host setup](host-cli.md). The [stdio MCP server](mcp.md) uses the same FileRunHost.

## Authority boundary

Client input contains only `requestId`, a registered `caseId`, and a positive integer budget. Extra fields are refused, including actor, tier, grants, oracle state, arbitrary paths/settings, commands and wall-limit overrides. The host supplies the actor, adapter, engine identity, and callbacks that resolve a registered immutable case, fresh study policy, accepted/current pins and an actual `runOracleSet` result. These callbacks must never read authority from the client's request or model text. `loadCase` must supply the complete parameter values represented by the registered case, so the gate can enforce study bounds; this first slice does not expose parameter editing.

The dispatcher clones client data before awaiting anything and snapshots host case/policy data before evaluation. It refuses missing/failed oracle evidence, unverified oracle inputs, mismatched adapter/version, unknown app commit, missing verdict entries, and changed accepted or evaluated pins. A changed policy is loaded on the next call. Admission uses one policy snapshot; host policy changes must obey the same project lock.

The host's required `audit` callback records the decision before launch. An audit failure blocks launch. The allowed run record retains actor, study, case, pins and gate route under `extensions["seed.dispatch"]`. This is admission evidence, not a complete study log or a claim that every result quantity has independent oracle coverage. Malformed requests, busy-engine refusals and loader failures return typed errors before gate evaluation; transport-level logging of those remains a host responsibility.

## Ownership and limits

The project writer lock is held during admission and the run, so other cooperating project writers receive a conflict until it finishes. An in-process reservation covers admission and execution across dispatcher instances sharing a canonical engine identity. It releases on refusal or completion. FileRunHost adds an external shared-state engine lease for separate processes and projects; configurations must share the same state root. Existing project-store local-disk/check-then-use limits apply.

`RunManager` stays a low-level primitive for oracle/bootstrap and lifecycle tests. GUI handlers must reuse the guarded host rather than construct a raw manager. The CLI now uses persisted host authority/grants and admission records. Owner-mediated cancellation and bounded human recovery now use the guarded host; see [supported cases](cancellation-recovery.md). GUI wiring and general crash-window recovery remain follow-ups. Resource requests are checked against policy; CPU/memory/disk enforcement is not supplied by this gate.

## Verification

`tests/run-dispatcher.test.ts` exercises a real fake-adapter subprocess, refusal-before-run behavior, spoofed authority, mutable input, changed policy, failed audit and simultaneous admission. `tests/raft-oracles.test.ts` now runs a registered real RAFT case through the dispatcher after the real oracle set passes, and compares it with the existing adapter path. Run with `SEED_RAFT_REPO` pointing to a built RAFT checkout; `npm run test:e2:raft` requires that dependency and fails if missing.
