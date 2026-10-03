# Policy gate and oracle runner (E0, fake-only)

2026-10-03. Implements the core side of decisions D3 and D4 ([DECISIONS](DECISIONS.md)): `src/core/policy.ts` and `src/core/oracle.ts`, tested in `tests/policy.test.ts` and `tests/oracle.test.ts`. Not yet wired to a transport, a study file or an app; both are pure library code a host calls.

## Gate (`evaluateGate`)

One enforcement path for GUI, CLI and MCP. Input: the request (operation, actor, study id, input revisions, requested budget, parameter values, engine) and the context (the study's tier, budget and bounds; grants; oracle and pin state). Output: `allow` (with `via: "tier"` or `"grant"`) or a refusal: typed errors plus the `{request, rule}` to record as a `gate-stop` step (`gateStopStep` builds a line valid under `seed.study/0.1`).

Order of checks: unknown operation (`E_VERB_UNKNOWN`, own-property lookup so `constructor` is unknown) -> wrong study -> human-only operation -> pins changed or oracle failed (run operations only) -> tier or grant -> budget fields, parameter bounds -> one active case per engine.

| Class | Operations | Rule |
|---|---|---|
| tier A0 | describe, validate, read, collect | any study tier |
| tier A1 | status, cancel, run_oracles, run_case, run_sweep, append_step, draft_conclusion | study tier A1 or higher |
| tier A2 | new_revision, propose_transfer | study tier A2 or higher |
| grant | accept_material_set, enable_transfer | a human grant, even at tier A3 |
| human | change_tier, change_budget, change_bounds, change_tolerance, override_refusal, write_outside_roots, run_command_from_content, install_runtime | only an actor of kind `human`; never grantable; an agent or system actor is refused at every tier |

An operation above the study tier may still be allowed to an agent by a **grant** for that one operation. A grant names study, actor (kind and name), operation, the exact set of input revisions, issue and expiry time and the approving human. It is unusable when expired, revoked, issued to another actor, approved by a non-human, or when the request's input revisions differ in any way (a changed input invalidates it). `issueGrant` refuses a non-human approver and any human-only operation; no MCP or CLI tool wraps it (D4: no client-facing approve action).

Budget and bounds bind everyone, including a human GUI request: each over-limit field is its own `E_BUDGET_EXCEEDED` error (`/budget/<name>`, `range.max` = the limit); each parameter that is undeclared, non-finite or outside `[min, max]` is `E_BOUNDS_EXCEEDED` (`/params/<i>/...`, range and unit). A failed oracle set, or pins changed since a human accepted them, blocks `run_case`, `run_sweep`, `new_revision` and `propose_transfer` for every actor.

## Oracle runner

- `loadOracleEntries(dir)`: reads `*.json`, validates `seed.oracle/0.1`, checks the tolerance pin (`checkOracleHash`), refuses duplicate `oracleId@entryVersion`, and records each file's sha256. A tolerance edited without a new pin never loads.
- `runOracleSet`: runs the newest `entryVersion` of each entry of one adapter. An entry that does not cover the adapter version is `not-run`; a bad pin or input hash makes it `invalid` (fails the set, adapter never called); a thrown adapter call is a `fail`. `evaluateOracle` compares: value (quantity, unit, `|obs - exp| <= abs + rel*|exp|`, finite), refusal code, or verdict, exactly.
- The set is `fail` on any failed or invalid good/bad-input entry, `not-run` if nothing ran, and `blocked` unless it passed with at least one `good` entry passing. A failed `known-limit` entry does not block the set; it marks that entry's quantities unverified (`blockedQuantities`, `unverifiedQuantities`).
- Pins: `pinsOf` records the app commit and every oracle file hash with each set result. `comparePins` lists what changed (commit, edited file, new version, added or removed entry); `acceptPins` is human-only. The host passes `pinsChanged` to the gate.

## Tests of the gate itself

The suite includes the deliberately wrong adapter cases of plan 06 (perturbed output, swapped units, dropped refusal, wrong refusal code, throwing adapter, stale pin, changed tolerance) and a mutation sweep: 23 targeted breaks of the rules, 21 caught on the first run; the two survivors were an inclusive-boundary case (test added) and an equivalent mutant (a NaN or infinite value fails the tolerance comparison anyway).

## Not done

Policy file format and who may sign it (still open in PLAN); persistence of grants (in memory only); the study-record writer that appends `gateStopStep` lines (E3); per-agent budgets and tokens; wiring to the run manager (the gate is called by the host before `RunManager.start`, not inside it).
