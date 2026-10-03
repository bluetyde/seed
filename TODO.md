# SEED: TODO

Running list. Check items off, add new ones at the bottom of their section, and note the date when something finishes. Close a task with **evidence** (a command and its result, or a recorded decision); a plan edit alone means "documented", not "verified". Status of a contract: proposed, accepted, documented, implemented, verified.
Design lives in [PLAN.md](PLAN.md). Details per area in [docs/plans/](docs/plans/); overall structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Agent split and board: [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md). Suite and harness rationale (workspace): `plans/nuclear-suite-integration.md`, `plans/agentic-harness.md`.

Flags: **[agy]** = a delegation candidate for Antigravity: large, mechanical, contract fixed, strong oracle ([antigravity-task step 0](docs/AGENT-TASKS.md); run step 0 again before dispatching). Unflagged items are Claude's: judgment, safety, contracts, small or precision-critical work. **[codex]** = a Codex review checkpoint; every milestone ends with one. **[fake]** = needs only the fake adapter, no real physics engine. **[A#]** = harness acceptance test number from [plan 05](docs/plans/05-agent-harness.md).

## Next (planned 2026-10-03, after the shell and installer)

Order matters: the contracts (E0) come before anything that reads or writes them, and the harness tests need no physics, so they can run as soon as the fake adapter exists. Owner per antigravity-task step 0 ([board](docs/AGENT-TASKS.md)).

**Track 1: contracts (Claude; judgment, safety)**
1. [ ] App inventory ([plan 03](docs/plans/03-adapters-and-transport.md)): for OpenMC Studio, NODAL Studio and Virtual Reactor, one table row per verb with the real entry point, headless or not, existing manifest and hashing rules; PRA and Fuel marked `not built`. Evidence: `docs/inventory.md`.
2. [ ] Settle the transport details: CLI-per-verb (request on stdin, one reply on stdout, exit 0 = reply produced) now works end to end against the fake adapter on Windows and Linux (`src/core/adapterClient.ts`, tests/fake-adapter.test.ts) and is provisional. Still open: MCP over the same command set (decision D1); how real apps are reached (CLI, local service or both) once the inventory (item 1) is done. Evidence so far: 31 fake-adapter tests, 2026-10-03.
3. [x] 2026-10-03: Contract text v0.1 written: [docs/contracts.md](docs/contracts.md) (adapter request and reply, results index, run record, project manifest, study record, oracle entry, typed errors, semantic checks, paths). Status: proposed; not yet reviewed by Codex or the user.
4. [ ] Tier policy and gate semantics ([plan 05](docs/plans/05-agent-harness.md)): the verb-to-tier table, what a gate stop records, grant scope (study, actor, operation, input revisions, expiry), pluggable approval (GUI dialog or human-run CLI command; no client surface can approve). Enforcement is in the core library (decision D4).

**Track 2: tests that need no physics (after Track 1 item 3)**
5. [x] 2026-10-03 **[agy]** JSON Schemas (8 families + error codes), validator with typed errors (`src/core/validate.ts`), canonical JSON and hashing, semantic checks and study-log chain verification (`src/core/semantic.ts`). 177 example fixtures plus 1344 generated per-property cases transcribed independently from the contract (tests/schema-contract.test.ts). Mutation sweep of the schemas (517 single-constraint loosenings): 403 caught, up from 120 before the generated tests; the remaining 114 are mostly redundant duplicate constraints, enum-extension mutants and string-length bounds the contract does not specify. Open: decide those length bounds in the contract.
6. [x] 2026-10-03 **[agy]** **[fake]** Fake adapter (`tests/fixtures/fake-adapter/cli.cjs`, `job.cjs`: all seven verbs; scenarios success, slow, crash, hang, partial and NaN output, trip, silent exit; adapter-level modes crash, hang, garbage, wrong id or verb, schema-invalid, huge reply, injection text) and the adapter client (`src/core/adapterClient.ts`, `src/core/procTree.ts`). 31 tests; pass on Windows 11 and Ubuntu (WSL), no orphan processes left.
7. [~] 2026-10-03 Harness tests, partly done: [A1] typed error with field and unit reaches the caller; [A2] crash, hang, partial output and trip end failed or terminated-by-trip with no accepted results (tests/run-lifecycle.test.ts); [A4] instruction-like text is stored and shown as data and starts nothing (fake adapter and report tests); [A5] over-budget request stops at the gate and is logged (`gate-stops.jsonl`); [A6] stale input revision refused. Not yet: [A3] (needs the oracle runner), A2-tier approval stop, [A6] second-writer save (needs the project store).
8. [ ] **[codex]** Review of schemas, validator, fake adapter and gate (R1).

**Track 3: project core (parallel after item 3)**
9. [~] 2026-10-03 Headless core started: `src/core/` (validate, semantic, canonical, paths, adapterClient, procTree, runManager, atomicFile, report) has no Electron imports. Not yet: project store, policy/tier gate, scheduler beyond one run, and making the shell a client of it.
10. [x] 2026-10-03 **[agy]** Path conversion (`src/core/paths.ts`): Windows, WSL, POSIX and UNC mapping, portable relative paths, inside-root check; 61 table and property tests plus 2 dispatcher edge cases. Verified on Windows and Linux only lexically (no real WSL mount or share).

**Housekeeping**
11. [ ] Run the real-app integration check on Windows and Linux hosts; configuration coverage is not runtime verification.
12. [ ] Verify the default start command of each app by a real launch on Windows, macOS and Linux.
13. [ ] Section 4 of [docs/TOOLING.md](docs/TOOLING.md): survey the candidates and date each verdict before any claim leaves the repo.
14. [x] 2026-10-03: Harness docs branch `claude/agentic-harness` merged to main (4c1e6f7) and the shared folder fast-forwarded (clean tree first).
15. [ ] Align with the PRA and Fuel plans written 2026-10-03 (`pra-studio/`, `fuel-performance-studio/`): their oracle entries use this repo's oracle-entry format and their adapters follow plan 03; reconcile the schemas when E0 task 3 lands.

## Now

- [x] 2026-10-03: Codex review (silent-failure-hunter and security-boundary-verifier) of the E0 branch: 15 distinct findings, all confirmed against the code and fixed with tests (docs/contracts.md section 10). Known limits left: path checks are not race-free (check then use); on Windows `killTree` cannot verify descendants that outlive their parent; reservation directories rely on `recover()` after a crash; recorded below as follow-ups.
- [ ] Follow-ups from the review: a project-wide lock instead of per-request reservations; Windows job objects for tree kills; open files by handle after containment checks.

- [x] 2026-10-03: Plan, ARCHITECTURE, WORKFLOWS, TOOLING, AGENT-TASKS and plans 01 to 10 written in this structure (documentation only; branch `claude/agentic-harness`).
- [x] 2026-10-03: Shared `experiment-studio` folder fast-forwarded to origin/main (clean tree, Windows git).
- [x] 2026-10-03: Decisions D1 to D6 recorded in [docs/DECISIONS.md](docs/DECISIONS.md) (MCP and CLI both; project files; app-owned oracles; enforcement in the core library; Virtual Reactor first adapter; UI framework deferred to E3).

## Contracts (before E0 code) · from the [workspace integration draft](../plans/nuclear-suite-integration.md) and [harness plan](../plans/agentic-harness.md)

Everything below is **proposed**, none implemented. Status moves proposed, accepted, documented, implemented, verified.

- [ ] Open vs run: opening an editor never starts a calculation, and each has its own gate. Evidence: schema plus a fake-adapter test.
- [ ] Revision semantics: native hash plus counter; expected-revision check on save; stale dependents marked. Evidence: conflict test [A6].
- [ ] Material envelope: IDs, immutable revisions, namespaced sets; unknown sets preserved; no expression evaluated; no name matching ([plan 02](docs/plans/02-project-and-materials.md)). Evidence: the cross-app acceptance case on the fake.
- [ ] Typed errors: `{code, field, message, unit?, range?, source}` with escaped app content. Evidence: [A1], [A4].
- [ ] Results index: quantity, units, normalization, coordinates, time, uncertainty, provenance, hash; a result without a complete index is refused.
- [ ] Run lifecycle states and the rule "completed means all declared outputs present and hashed"; trip kept as native status ([plan 04](docs/plans/04-runs-and-scheduling.md)). Evidence: state-machine tests, [A2].
- [ ] Oracle entry: tolerance hashed before the run; changing it makes a new version by a human ([plan 06](docs/plans/06-oracles-and-verification.md)). Evidence: [A3].
- [ ] Study record: append-only; actor on every step; report only from the record ([plan 07](docs/plans/07-studies-and-reports.md)). Evidence: append-only and report tests.
- [ ] Tier model A0 to A4 and budgets; nothing in an adapter reply or app content can change them. Evidence: [A4], [A5].
- [ ] Schema identifiers, version policy and unknown-version refusal.
- [ ] Reserved project folders (`models/`, `runs/`, `studies/`, `oracles/`) so later work does not move files.

## E0: contracts ([plan 03](docs/plans/03-adapters-and-transport.md), [05](docs/plans/05-agent-harness.md))

Exit: open vs run, revisions, material preservation and status semantics documented; [A1], [A3], [A4], [A5], [A6] pass against the fake adapter. Tasks are Next items 1 to 8.

- [ ] E0 exit review: **[codex]** (R1) and the user's sign-off on the contracts.

## E1: project launcher ([plan 01](docs/plans/01-shell-and-installer.md), [02](docs/plans/02-project-and-materials.md), [04](docs/plans/04-runs-and-scheduling.md))

- [x] 2026-10-01 to 2026-10-03: Configurable launcher shell (app registry, start/stop/attach, tabs, error pages) and installer/updater (clone, adopt, check, fast-forward, dependency steps, prerequisite checks); platform-aware default launch commands. Evidence: docs/shell.md, vitest, e2e, macOS run.
- [ ] Project create, open, reopen; relocate and reopen resolves every reference.
- [ ] Attach a native model; open or focus its editor without starting a calculation; a missing app gives an actionable message.
- [ ] Windows and WSL path mapping stated explicitly; table test (Next 10).
- [ ] Import an existing completed run; show its native status and provenance; partial output never shown as a result; label `imported`.
- [ ] Headless mode: the core serves the adapter verbs with no window; the GUI is a client.
- [ ] Atomic manifest writes (temp file and rename); crash mid-write detected and the previous manifest kept.
- [ ] E1 exit review: **[codex]** (R2, core gate and policy).

## E2: single-app runs ([plan 03](docs/plans/03-adapters-and-transport.md), [04](docs/plans/04-runs-and-scheduling.md), [05](docs/plans/05-agent-harness.md), [06](docs/plans/06-oracles-and-verification.md))

Depends on the E0 inventory confirming that Virtual Reactor has a usable headless entry point (decision D5); if it does not, fall back to PRA (needs its P2 gate) or NODAL and record a new decision.

- [ ] First real adapter (Virtual Reactor) through all seven verbs; immutable snapshot, owned job ID, owned process tree. CLI and MCP front-ends over one core.
- [ ] Oracle index and runner: entries live in the RAFT repo (D3); SEED records the oracle file hash and app commit on every run and flags a changed pin. First set: RAFT analytic cases (for example inhour, prompt jump, replay) chosen from its validation docs; the first real adapter through SEED, CLI/MCP and direct agree on every oracle [A9]. PRA's entries (AND 0.02, OR 0.28, A AND A 0.1, A OR A 0.1, shared-event 0.044) are added when PRA's P2 passes.
- [ ] MCP server over the core; tool descriptions state limits and refusals; **[codex]** review (R3).
- [ ] Tier enforcement in the core, tested: an agent cannot raise its own tier, loosen a tolerance or override a refusal [A3], [A5].
- [ ] Cancellation, crash, partial output, edit conflict, relocation and stale-result handling on the real adapter [A2], [A6].
- [ ] Standalone launch of the app unchanged by its adapter.
- [ ] Measure and record per-adapter resource limits (wall-clock, cores, memory) in `describe`.
- [ ] E2 exit review: **[codex]** (R4).

## E3: experiments ([plan 04](docs/plans/04-runs-and-scheduling.md), [07](docs/plans/07-studies-and-reports.md))

- [ ] Typed parameter catalog from each adapter; bounded sweeps; explicit budgets (cases, wall-clock, cores, memory, disk); one active case per engine until limits are measured.
- [ ] Study record in use: every step with actor, reason, runs and oracle verdict; append-only.
- [ ] Comparison of compatible quantities only, with normalization and uncertainty; failed, cancelled, trip and stale runs visible.
- [~] 2026-10-03 **[agy]** Report builder done (`src/core/report.ts`, 14 tests: deterministic HTML and Markdown, escaping fuzzed over every free-text field, failed attempts listed, UNVERIFIED and STALE badges, educational-use statement); still to do: wire it to real study and run files, and view it in a browser. Original item: Report builder (HTML and Markdown) from a study record fixture; every figure links to a run ID; educational-use statement; injected text escaped [A8].
- [ ] Replay: reproduces within tolerance or lists each difference (version, seed, library, input hash) [A7].
- [ ] Cache key includes inputs, material revisions, mapping recipe, versions, settings, seeds; one test per component.
- [ ] E3 exit review: **[codex]**.

## E4: reviewed transfer ([plan 08](docs/plans/08-transfers-and-pipelines.md))

Depends on Fuel Performance Studio F3 and an OpenMC result adapter (those apps' own plans).

- [ ] Transfer recipe format and approval record (tier A3).
- [ ] OpenMC heating to Fuel Performance Studio, one way, offline: refusals for wrong units, missing normalization, incomplete coverage, stale revision; conservation within a tolerance declared beforehand [A10].
- [ ] Pipeline DAG: cycles refused at definition; downstream invalidated after an input change.
- [ ] First end-to-end agent demonstration with the full study record and generated report.
- [ ] E4 exit review: **[codex]** (R5).

## E5: advanced studies ([plan 09](docs/plans/09-advanced-studies.md))

- [ ] Sensitivity and sampling studies an agent can drive; noise, input uncertainty and deterministic sensitivity reported separately (the report builder rejects a result without them).
- [ ] Feedback coupling: write the exchange list, synchronization, convergence and failure criteria and the oracle plan **before** any code; coupling stays an A3 human-approved action.

## Installer/updater, still open ([plan 01](docs/plans/01-shell-and-installer.md))

- [ ] Install the conda environment and nuclear data for OpenMC Studio.
- [ ] Update SEED itself.
- [ ] Sign-in help beyond the message; offline use of a cached copy; a schedule or notice for available updates.
- [ ] Servers the host started can outlive a killed host (no job object): fix and test.

## Release ([plan 10](docs/plans/10-release-and-packaging.md))

- [ ] Choose a distribution model; check licenses and redistribution terms before bundling any engine.
- [ ] Pre-release checklist; adapter authoring guide; make the repo public only when the user says so.

## Ideas / later

- Study templates for teaching (a student starts from "compare two redundancy designs").
- A second human sign-off on conclusions at A2 and above.
- Per-agent tokens and budgets.
- Surrogate models as engine stand-ins, only with their own oracle coverage and `unverified` outside their training domain.
- A common mesh and coordinate convention across OpenMC, NODAL and the fuel case, if the per-recipe declarations prove repetitive.
- One log convention shared by dev agents and engineering agents without mixing them.

## Decisions

Decided 2026-10-03 (see [docs/DECISIONS.md](docs/DECISIONS.md)): D1 MCP and CLI both; D2 project files; D3 app-owned oracles; D4 enforcement in the core library; D5 Virtual Reactor first adapter; D6 UI framework deferred to E3.

Still waiting (the user's):
- [ ] UI framework for project, study and report views (decide at E3); packaging.
- [ ] Policy file format and who may sign it.

## Done

- [x] 2026-10-01: Shell skeleton (Electron host, tabs, registry, process manager, e2e with fake apps); same-origin windows for the Virtual Reactor operator window; repo `bluetyde/seed` (private, MIT).
- [x] 2026-10-01: Installer/updater (first version, docs/shell.md): clone, adopt, check, fast-forward update, dependency steps, prerequisite checks, per-app card with output and cancel.
- [x] 2026-10-01: Platform-aware default launch commands for macOS/Linux and Windows; home/sibling install discovery without machine-specific paths. macOS: all three apps opened, rendered, switched and stopped in SEED; unit suite passes.
- [x] 2026-10-01: The unsaved-work prompt ("Close anyway / Stay") checked by hand by the user.
