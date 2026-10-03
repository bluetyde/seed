# SEED: TODO

Running list. Check items off, add new ones at the bottom of their section, and note the date when something finishes. Close a task with **evidence** (a command and its result, or a recorded decision); a plan edit alone means "documented", not "verified". Status of a contract: proposed, accepted, documented, implemented, verified.
Design lives in [PLAN.md](PLAN.md). Details per area in [docs/plans/](docs/plans/); overall structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Agent split and board: [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md). Suite and harness rationale (workspace): `plans/nuclear-suite-integration.md`, `plans/agentic-harness.md`.

Flags: **[agy]** = a delegation candidate for Antigravity: large, mechanical, contract fixed, strong oracle ([antigravity-task step 0](docs/AGENT-TASKS.md); run step 0 again before dispatching). Unflagged items are Claude's: judgment, safety, contracts, small or precision-critical work. **[codex]** = a Codex review checkpoint; every milestone ends with one. **[fake]** = needs only the fake adapter, no real physics engine. **[A#]** = harness acceptance test number from [plan 05](docs/plans/05-agent-harness.md).

## Next (planned 2026-10-03, after the shell and installer)

Order matters: the contracts (E0) come before anything that reads or writes them, and the harness tests need no physics, so they can run as soon as the fake adapter exists. Owner per antigravity-task step 0 ([board](docs/AGENT-TASKS.md)).

**Track 1: contracts (Claude; judgment, safety)**
1. [ ] App inventory ([plan 03](docs/plans/03-adapters-and-transport.md)): for OpenMC Studio, NODAL Studio and Virtual Reactor, one table row per verb with the real entry point, headless or not, existing manifest and hashing rules; PRA and Fuel marked `not built`. Evidence: `docs/inventory.md`.
2. [ ] Decide the transport against the fake (CLI, local service, or both) and the MCP surface; record rejected options. Evidence: decision record in `docs/plans/03`, and a fake-adapter test run over the chosen transport.
3. [ ] Write the contract text for the five interfaces ([ARCHITECTURE](docs/ARCHITECTURE.md)): adapter messages with typed error codes, results index, project manifest and material envelope, study record, oracle entry. Include the migration policy.
4. [ ] Tier policy and gate semantics ([plan 05](docs/plans/05-agent-harness.md)): the verb-to-tier table, what a gate stop records, where enforcement runs (decision).

**Track 2: tests that need no physics (after Track 1 item 3)**
5. [ ] **[agy]** JSON Schemas with a good and a bad fixture per rule, plus a validator; every error code has a failing bad fixture. Needs item 3 written; brief must carry units, the escaping rule and the unknown-version rule.
6. [ ] **[agy]** **[fake]** Fake adapter (success, each validation error, crash, hang, partial output, trip, stale revision, instruction-like text). Needs items 2 and 5.
7. [ ] **[agy]** **[fake]** Harness tests [A1], [A3], [A4], [A5], [A6] as vitest cases; each must fail against a deliberately broken gate.
8. [ ] **[codex]** Review of schemas, validator, fake adapter and gate (R1).

**Track 3: project core (parallel after item 3)**
9. [ ] Headless core skeleton (no Electron imports) with the project store; the shell becomes a client of it with no behaviour change in the existing tests ([plan 01](docs/plans/01-shell-and-installer.md), [02](docs/plans/02-project-and-materials.md)).
10. [ ] **[agy]** Path conversion function (Windows, WSL, posix, spaces, UNC, traversal) with a table test. Run step 0 first; may be cheaper to write directly.

**Housekeeping**
11. [ ] Run the real-app integration check on Windows and Linux hosts; configuration coverage is not runtime verification.
12. [ ] Verify the default start command of each app by a real launch on Windows, macOS and Linux.
13. [ ] Section 4 of [docs/TOOLING.md](docs/TOOLING.md): survey the candidates and date each verdict before any claim leaves the repo.
14. [ ] Merge the harness docs branch (`claude/agentic-harness`) when the user agrees; fast-forward the shared folder afterward (status clean first).

## Now

- [x] 2026-10-03: Plan, ARCHITECTURE, WORKFLOWS, TOOLING, AGENT-TASKS and plans 01 to 10 written in this structure (documentation only; branch `claude/agentic-harness`).
- [x] 2026-10-03: Shared `experiment-studio` folder fast-forwarded to origin/main (clean tree, Windows git).
- [ ] Decide the open questions in [PLAN.md](PLAN.md#open-questions) that block E0: transport, MCP-only vs plus CLI, record format, tier enforcement location.

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

Depends on PRA's own P2 gate. If PRA is late, a NODAL or Virtual Reactor adapter takes its place.

- [ ] First real adapter (PRA) through all seven verbs; immutable snapshot, owned job ID, owned process tree.
- [ ] Oracle registry v1 with the PRA entries (AND 0.02, OR 0.28, A AND A 0.1, A OR A 0.1, shared-event 0.044, bad probability, cycle, unsupported construct); PRA through SEED, MCP and the direct engine agree [A9].
- [ ] MCP server over the core; tool descriptions state limits and refusals; **[codex]** review (R3).
- [ ] Tier enforcement in the core, tested: an agent cannot raise its own tier, loosen a tolerance or override a refusal [A3], [A5].
- [ ] Cancellation, crash, partial output, edit conflict, relocation and stale-result handling on the real adapter [A2], [A6].
- [ ] Standalone launch of PRA unchanged by its adapter.
- [ ] Measure and record per-adapter resource limits (wall-clock, cores, memory) in `describe`.
- [ ] E2 exit review: **[codex]** (R4).

## E3: experiments ([plan 04](docs/plans/04-runs-and-scheduling.md), [07](docs/plans/07-studies-and-reports.md))

- [ ] Typed parameter catalog from each adapter; bounded sweeps; explicit budgets (cases, wall-clock, cores, memory, disk); one active case per engine until limits are measured.
- [ ] Study record in use: every step with actor, reason, runs and oracle verdict; append-only.
- [ ] Comparison of compatible quantities only, with normalization and uncertainty; failed, cancelled, trip and stale runs visible.
- [ ] **[agy]** Report builder (HTML and Markdown) from a study record fixture; every figure links to a run ID; educational-use statement; injected text escaped [A8].
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

## Decisions waiting (the user's)

- [ ] MCP only, or MCP plus a plain CLI.
- [ ] Study record as project files, or an embedded store with files as the export.
- [ ] Oracle registry in this repo, or in each app's repo with SEED indexing it.
- [ ] Where tier enforcement runs.
- [ ] UI framework for project, study and report views; packaging; first real adapter if PRA is late.
- [ ] Merge `claude/agentic-harness`.

## Done

- [x] 2026-10-01: Shell skeleton (Electron host, tabs, registry, process manager, e2e with fake apps); same-origin windows for the Virtual Reactor operator window; repo `bluetyde/seed` (private, MIT).
- [x] 2026-10-01: Installer/updater (first version, docs/shell.md): clone, adopt, check, fast-forward update, dependency steps, prerequisite checks, per-app card with output and cancel.
- [x] 2026-10-01: Platform-aware default launch commands for macOS/Linux and Windows; home/sibling install discovery without machine-specific paths. macOS: all three apps opened, rendered, switched and stopped in SEED; unit suite passes.
- [x] 2026-10-01: The unsaved-work prompt ("Close anyway / Stay") checked by hand by the user.
