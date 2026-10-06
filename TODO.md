# SEED: TODO

Running list. Check items off, add new ones at the bottom of their section, and note the date when something finishes. Close a task with **evidence** (a command and its result, or a recorded decision); a plan edit alone means "documented", not "verified". Status of a contract: proposed, accepted, documented, implemented, verified.
Design lives in [PLAN.md](PLAN.md). Details per area in [docs/plans/](docs/plans/); overall structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Agent split and board: [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md). Suite and harness rationale (workspace): `plans/nuclear-suite-integration.md`, `plans/agentic-harness.md`.

Flags: **[agy]** = a delegation candidate for Antigravity: large, mechanical, contract fixed, strong oracle ([antigravity-task step 0](docs/AGENT-TASKS.md); run step 0 again before dispatching). Unflagged items are Claude's: judgment, safety, contracts, small or precision-critical work. **[codex]** = a Codex review checkpoint; every milestone ends with one. **[fake]** = needs only the fake adapter, no real physics engine. **[A#]** = harness acceptance test number from [plan 05](docs/plans/05-agent-harness.md).

## Next priorities (updated 2026-10-03 after E0 merge)

Current baseline: main `ccab92f` includes the E0 schemas, fake adapter/client, run lifecycle, report builder and review fixes. The previous verification recorded 1,593 unit tests passing on Windows; the launcher repair reran the desktop suite (10 passed, 3 existing skips). These are scoped results, not proof that E0 exit criteria or real-app integration are complete.

1. [~] **Make first launch reliable.** 2026-10-03: Windows launcher checks Node 24+/npm, offers locked dependency setup when build/Electron commands are missing, and keeps failures visible. Regression cases cover a path containing spaces, missing tools, declined/failed install, normal reuse without installation, and startup failure (`node --test scripts/test-windows-launcher.cjs`). 2026-10-05 (branch claude/launcher-deps): the Windows launcher now records a hash of package.json and package-lock.json after each install (`scripts/deps-stamp.cjs`, stored in node_modules) and asks to reinstall when it differs or was never recorded (older installs are asked once); 16 launcher tests, 4 of 4 launcher breaks caught; the macOS launcher only prints a hint (untested on macOS). Remaining: verify full disconnected desktop use; launcher command reuse alone is not suite-wide offline acceptance.
2. [x] **Integrate the pending runtime foundation** (done 2026-10-03 on claude/runtime-integrate: merged cleanly, 1599 tests pass, plan 05 item 9 aligned to D5; desktop e2e 10 passed, 3 existing skips). Review/reconcile `codex/runtime-foundation` (`4ee09c9`, including plan commit `6c3bb85`) with current main and decisions D1-D6 before merging. It contains the runtime inventory, runtime/shared-acceptance plan and pending-start cancellation fixes; it is not in main. Preserve current E0 review fixes. Rerun startup race/process tests and desktop tests after integration; verify closing during startup leaves no owned process and keeps attached servers alive. Do not merge the older duplicate planning branch as well.
3. [~] **Build the project store (E1).** 2026-10-03: core library merged and Codex-reviewed (`src/core/projectStore.ts`, contract section 11, 22 tests; create/open/save/recover/relocate, revision-checked saves, crash-safe writer lock with serialized takeover, preservation of unknown material sets). Remaining: make the shell a client of it (GUI) and exercise second-writer conflict through the GUI. Original text: Create/open/save/reopen/relocate projects using the existing schema and atomic-write helper. Add a project-wide writer lock with crash recovery and expected-revision conflicts. Preserve custom material sets under their app namespaces, including unknown sets; material compatibility remains app-owned, with no separate materials app. Accept with save/reopen, second-writer conflict, interrupted write and relocation tests.
4. [~] **Finish the fake-only E0 gates.** Merged 2026-10-03 after Codex review (11 distinct findings fixed). Details: `src/core/policy.ts` (tier table, grants, budget/bounds/engine limit, oracle and pin blocks, gate-stop step) and `src/core/oracle.ts` (loader, set runner, pins), 155 tests, see docs/policy-and-oracles.md; remaining: wiring to the run manager, policy file format, grants persistence, E0 exit review and the user's contract sign-off; the second-writer (A6) case now exists in the store tests. Original text: Implement the core tier/approval policy and oracle runner/index; prove A3, approval stops and the remaining A6 conflict case. Budget request checks already exist but do not prove resource containment or tier enforcement. Pin oracle hash and app commit; changed tolerances require a new human-approved version. Complete the E0 exit review and contract sign-off after these gaps close.
5. [~] **Confirm the first real adapter, then implement E2.** 2026-10-03: first real adapter built and Codex-reviewed: RAFT (`adapters/raft/`, docs/adapter-raft.md): all seven verbs (open unsupported), six golden vectors through the run manager match the direct run bit for bit and the committed vectors within tolerance, 22 oracle entries (RAFT branch claude/seed-oracles) pass, wrong outputs block the gate. Remaining for E2: broader crash-window recovery, the first agent demonstration with study record and report, the NODAL adapter, real-app failure cases beyond these tests, E2 exit review. Older text: 2026-10-03: inventory done; RAFT headless runner built and merged into RAFT main (570d2e1), which supports D5 (RAFT first, NODAL second). Next: the SEED-side RAFT adapter (CLI per verb over the core), oracle entries from the golden vectors, direct-versus-SEED agreement. Original text: Complete the per-verb inventory, using the pending runtime inventory as a starting point rather than a substitute. Confirm Virtual Reactor's headless entry point, then implement SEED-side CLI and MCP access over the same core, with direct-versus-SEED oracle agreement. Companion app changes require their own coordinated work; this task claims SEED only. PRA follows its P2 gate.
6. [ ] **Finish runtime installation and shared acceptance.** Add a versioned runtime manifest, checksums, staged install, cached offline reuse and rollback, first with fake artifacts. Then verify launch/cleanup, offline operation, save/reopen and interruption with actual installed apps on a recorded build. SEED owns integration/runtime lifecycle; each app owns its native correctness and performance, including large-model MCNP export in OpenMC Studio.

Keep the report browser check and review hardening below in scope before release. Do not start advanced coupling or replace the UI framework before these foundations are verified.

## E0 implementation checklist


Order matters: the contracts (E0) come before anything that reads or writes them, and the harness tests need no physics, so they can run as soon as the fake adapter exists. Owner per antigravity-task step 0 ([board](docs/AGENT-TASKS.md)).

**Track 1: contracts (Claude; judgment, safety)**
1. [x] App inventory, 2026-10-03, `docs/inventory.md` (read-only; finding: NODAL has a headless CLI today, RAFT has none, so D5 needs the user's confirmation). ([plan 03](docs/plans/03-adapters-and-transport.md)): for OpenMC Studio, NODAL Studio and Virtual Reactor, one table row per verb with the real entry point, headless or not, existing manifest and hashing rules; PRA and Fuel marked `not built`. Evidence: `docs/inventory.md`.
2. [x] Settle the transport details: CLI-per-verb (request on stdin, one reply on stdout, exit 0 = reply produced) is the transport of the fake adapter and of all five real adapters (RAFT, FEED, NODAL, OpenMC Studio, SNEED), each reaching its app through the app's own headless runner (a local process; in WSL where the app lives there). Signed off with contracts v0.1 on 2026-10-05. MCP over the same command set is the guarded MCP server (E2 items above). Evidence: tests/fake-adapter.test.ts and the five adapter suites.
3. [x] 2026-10-03: Contract text v0.1 written: [docs/contracts.md](docs/contracts.md) (adapter request and reply, results index, run record, project manifest, study record, oracle entry, typed errors, semantic checks, paths). Status: v0.1 proposed; implementation reviewed by Codex and fixes merged (72867a8). User contract sign-off and remaining E0 acceptance are still pending.
4. [ ] Tier policy and gate semantics ([plan 05](docs/plans/05-agent-harness.md)): the verb-to-tier table, what a gate stop records, grant scope (study, actor, operation, input revisions, expiry), pluggable approval (GUI dialog or human-run CLI command; no client surface can approve). Enforcement is in the core library (decision D4).

**Track 2: tests that need no physics (after Track 1 item 3)**
5. [x] 2026-10-03 **[agy]** JSON Schemas (8 families + error codes), validator with typed errors (`src/core/validate.ts`), canonical JSON and hashing, semantic checks and study-log chain verification (`src/core/semantic.ts`). 177 example fixtures plus 1344 generated per-property cases transcribed independently from the contract (tests/schema-contract.test.ts). Mutation sweep of the schemas (517 single-constraint loosenings): 403 caught, up from 120 before the generated tests; the remaining 114 are mostly redundant duplicate constraints, enum-extension mutants and string-length bounds the contract does not specify. Open: decide those length bounds in the contract.
6. [x] 2026-10-03 **[agy]** **[fake]** Fake adapter (`tests/fixtures/fake-adapter/cli.cjs`, `job.cjs`: all seven verbs; scenarios success, slow, crash, hang, partial and NaN output, trip, silent exit; adapter-level modes crash, hang, garbage, wrong id or verb, schema-invalid, huge reply, injection text) and the adapter client (`src/core/adapterClient.ts`, `src/core/procTree.ts`). 31 tests; pass on Windows 11 and Ubuntu (WSL), no orphan processes left.
7. [~] 2026-10-03 Harness tests, partly done: [A1] typed error with field and unit reaches the caller; [A2] crash, hang, partial output and trip end failed or terminated-by-trip with no accepted results (tests/run-lifecycle.test.ts); [A4] instruction-like text is stored and shown as data and starts nothing (fake adapter and report tests); [A5] over-budget request stops at the gate and is logged (`gate-stops.jsonl`); [A6] stale input revision refused. Not yet: [A3] (needs the oracle runner), A2-tier approval stop, [A6] second-writer save (needs the project store).
8. [x] 2026-10-03 **[codex]** Review of implemented E0 schemas, validator, fake adapter and budget/revision gates (R1): 13 distinct findings fixed and merged (72867a8); see Now. Future tier/approval and oracle code still needs review.

**Track 3: project core (parallel after item 3)**
9. [~] 2026-10-03 Headless core started: `src/core/` (validate, semantic, canonical, paths, adapterClient, procTree, runManager, atomicFile, report) has no Electron imports. Not yet: project store, policy/tier gate, scheduler beyond one run, and making the shell a client of it.
10. [x] 2026-10-03 **[agy]** Path conversion (`src/core/paths.ts`): Windows, WSL, POSIX and UNC mapping, portable relative paths, inside-root check; 61 table and property tests plus 2 dispatcher edge cases. Verified on Windows and Linux only lexically (no real WSL mount or share).

**Housekeeping**
11. [ ] Run the real-app integration check on Windows and Linux hosts; configuration coverage is not runtime verification.
12. [ ] Verify the default start command of each app by a real launch on Windows, macOS and Linux.
13. [ ] Section 4 of [docs/TOOLING.md](docs/TOOLING.md): survey the candidates and date each verdict before any claim leaves the repo.
14. [x] 2026-10-03: Harness docs branch `claude/agentic-harness` merged to main (4c1e6f7) and the shared folder fast-forwarded (clean tree first).
15. [ ] Align with the PRA and Fuel plans written 2026-10-03 (`pra-studio/`, `fuel-performance-studio/`): their oracle entries use this repo's oracle-entry format and their adapters follow plan 03; reconcile against the now-implemented v0.1 schemas; coordinate changes through each app owner.

## Now

- [x] 2026-10-03: Codex review (silent-failure-hunter and security-boundary-verifier) of the E0 branch: 15 findings reported (13 distinct), all confirmed against the code and fixed with tests (docs/contracts.md section 10). Known limits left: path checks are not race-free (check then use); on Windows `killTree` cannot verify descendants that outlive their parent; reservation directories rely on `recover()` after a crash; recorded below as follow-ups.
- [ ] Follow-ups from the review: a project-wide lock instead of per-request reservations; Windows job objects for tree kills; open files by handle after containment checks.

- [x] 2026-10-03: Plan, ARCHITECTURE, WORKFLOWS, TOOLING, AGENT-TASKS and plans 01 to 10 written in this structure (documentation only; branch `claude/agentic-harness`).
- [x] 2026-10-03: Shared `experiment-studio` folder fast-forwarded to origin/main (clean tree, Windows git).
- [x] 2026-10-03: Decisions D1 to D6 recorded in [docs/DECISIONS.md](docs/DECISIONS.md) (MCP and CLI both; project files; app-owned oracles; enforcement in the core library; Virtual Reactor first adapter; UI framework deferred to E3).

## Contracts (before E0 code) · from the [workspace integration draft](../plans/nuclear-suite-integration.md) and [harness plan](../plans/agentic-harness.md)

The v0.1 contract is documented and partly implemented. Checkboxes below track the full behavior, not schema presence alone. Implementation review is complete for the merged E0 slice; user contract acceptance and the remaining integration checks are pending.

- [ ] Open vs run: opening an editor never starts a calculation, and each has its own gate. Evidence: schema plus a fake-adapter test.
- [ ] Revision semantics: native hash plus counter; expected-revision check on save; stale dependents marked. Evidence: conflict test [A6].
- [ ] Material envelope: IDs, immutable revisions, namespaced sets; unknown sets preserved; no expression evaluated; no name matching ([plan 02](docs/plans/02-project-and-materials.md)). Evidence: the cross-app acceptance case on the fake.
- [x] 2026-10-03: Typed errors (validator, fake-adapter and report tests): `{code, field, message, unit?, range?, source}` with escaped app content. Evidence: [A1], [A4].
- [x] 2026-10-03: Results index (run-lifecycle and review-fixes tests): quantity, units, normalization, coordinates, time, uncertainty, provenance, hash; a result without a complete index is refused.
- [x] 2026-10-03: Run lifecycle states (fake-adapter lifecycle tests) and the rule "completed means all declared outputs present and hashed"; trip kept as native status ([plan 04](docs/plans/04-runs-and-scheduling.md)). Evidence: state-machine tests, [A2].
- [ ] Oracle entry: tolerance hashed before the run; changing it makes a new version by a human ([plan 06](docs/plans/06-oracles-and-verification.md)). Evidence: [A3].
- [ ] Study record: append-only; actor on every step; report only from the record ([plan 07](docs/plans/07-studies-and-reports.md)). Evidence: append-only and report tests.
- [ ] Tier model A0 to A4 and budgets; nothing in an adapter reply or app content can change them. Evidence: [A4], [A5].
- [x] 2026-10-03: Schema identifiers, version policy and unknown-version refusal implemented in validate.ts and covered by schema-contract tests.
- [ ] Reserved project folders (`models/`, `runs/`, `studies/`, `oracles/`) so later work does not move files.

## E0: contracts ([plan 03](docs/plans/03-adapters-and-transport.md), [05](docs/plans/05-agent-harness.md))

Exit: open vs run, revisions, material preservation and status semantics documented; [A1], [A3], [A4], [A5], [A6] pass against the fake adapter. Tasks are Next items 1 to 8.

- [~] E0 exit review: implementation R1 is complete and the gates, store and second-writer cases are built and Codex-reviewed. **2026-10-05: the user signed off contracts v0.1 as final** (after RAFT, FEED, NODAL, OpenMC Studio and SNEED implemented it on the shared adapter module; with the v0.1.1 clarifications, contracts.md section 12; a change needs a new version and a migration; v0.2 candidates in docs/contracts-v0.2-candidates.md). Remaining: an independent design review of the contract against the other apps' plans (optional), the formal E0 exit review.

## E1: project launcher ([plan 01](docs/plans/01-shell-and-installer.md), [02](docs/plans/02-project-and-materials.md), [04](docs/plans/04-runs-and-scheduling.md))

- [x] 2026-10-01 to 2026-10-03: Configurable launcher shell (app registry, start/stop/attach, tabs, error pages) and installer/updater (clone, adopt, check, fast-forward, dependency steps, prerequisite checks); platform-aware default launch commands. Evidence: docs/shell.md, vitest, e2e, macOS run.
- [ ] Project create, open, reopen; relocate and reopen resolves every reference.
- [ ] Attach a native model; open or focus its editor without starting a calculation; a missing app gives an actionable message.
- [~] Windows and WSL path mapping implemented with lexical tests (E0 item 10); actual WSL mount/share and relocated-project verification remain.
- [ ] Import an existing completed run; show its native status and provenance; partial output never shown as a result; label `imported`.
- [ ] Headless mode: the core serves the adapter verbs with no window; the GUI is a client.
- [~] Atomic-write helper exists (src/core/atomicFile.ts); wire it into project manifest saves and verify interrupted-write recovery keeps the previous manifest.
- [ ] E1 exit review: **[codex]** (R2, core gate and policy).

## E2: single-app runs ([plan 03](docs/plans/03-adapters-and-transport.md), [04](docs/plans/04-runs-and-scheduling.md), [05](docs/plans/05-agent-harness.md), [06](docs/plans/06-oracles-and-verification.md))

Virtual Reactor now has a merged headless entry point and app-owned oracle entries (decision D5). E2 uses the synthetic library only; guarded CLI, MCP and policy wiring now work; owner-mediated cancellation and bounded human recovery now work; general host-death cleanup remains unfinished.

- [~] First real adapter (Virtual Reactor) implemented; headless `open` explicitly unsupported. Immutable snapshots, job ownership and adapter tests exist. E2 direct-agreement acceptance added (`npm run test:e2:raft`); guarded CLI and stdio MCP are implemented.
- [ ] Oracle index and runner: entries live in the RAFT repo (D3); SEED records the oracle file hash and app commit on every run and flags a changed pin. First set: RAFT analytic cases (for example inhour, prompt jump, replay) chosen from its validation docs; the first real adapter through SEED, CLI/MCP and direct agree on every oracle [A9]. PRA's entries (AND 0.02, OR 0.28, A AND A 0.1, A OR A 0.1, shared-event 0.044) are added when PRA's P2 passes.
- [x] 2026-10-04: first stdio MCP server exposes seed_run_case through FileRunHost; strict schema, host-owned authority, persistent policy reload, shared lease and admission records. SDK-client subprocess tests and real RAFT CLI/MCP agreement pass. [Setup and lifecycle limits](docs/mcp.md). R3 independent security-boundary review found one shutdown-lifetime issue, fixed with a detached per-call host supervisor; follow-up review found no issues. Final Windows regression: 1901 passed. Owner-mediated cancellation and bounded human recovery added below; broader recovery remains.
- [~] Core dispatch now connects policy and oracle checks (`src/core/runDispatcher.ts`, [boundary and limits](docs/run-dispatcher.md)): host-owned identity/registered cases, fresh policy, accepted/evaluated pins, audit before launch, project lock and in-process engine reservation. Fake-process refusal tests and a real RAFT guarded run cover this path. 2026-10-04: external host configuration/grants, durable admission journal, shared-state engine lease and guarded CLI are implemented ([setup and limits](docs/host-cli.md)). Stdio MCP now reuses this host. Desktop lesson wiring and guarded cancellation/bounded recovery are now implemented below; broader recovery remains; raw RunManager is still a low-level primitive [A3], [A5].
- [~] 2026-10-04: owner-mediated actual cancellation through CLI/MCP and conservative human CLI recovery of abandoned nonterminal jobs; durable control audit, fresh cancel grants, no client PID/job ID, stop confirmation before lease removal. Real RAFT owner-crash acceptance passes: live-owner refusal, blocked admission, human CLI stop, both native processes dead, cancelled evidence/journal preserved and subsequent calculation completed. Finished native jobs with saved running records now support validated collection after explicit stopped-process evidence; real RAFT corrupt-output refusal and successful retry pass. [Supported cases and limits](docs/cancellation-recovery.md). Saved completed/cancelled records now support audit/lease-release recovery with unchanged record bytes, native-outcome agreement and saved-output verification. Remaining: early launch windows, failed/interrupted/trip or invalid record recovery, broader partial-output handling, edit conflict, relocation and stale-result handling [A2], [A6].
- [ ] Standalone launch of the app unchanged by its adapter.
- [ ] Measure and record per-adapter resource limits (wall-clock, cores, memory) in `describe`.
- [~] 2026-10-04: real RAFT bounded run and guarded report export through CLI and MCP; external human header, hash-chained evidence-derived study steps, audited run record hash, scoped admission/oracle evidence, offline input/output copies and HTML/Markdown reports. [Setup and limits](docs/study-report.md). 2026-10-04: desktop welcome lesson panel now runs registered cases, requests guarded cancellation and saves reports through the same host; actual Electron-to-RAFT run/save acceptance passes. Remaining: manual human sign-off, accepted-study corrections and E2 exit review; shared desktop reconnect/history now implemented, native history/recovery remains adapter-specific; general recovered-run export/replay remains planned.
- [ ] E2 exit review: **[codex]** (R4).

- [ ] 2026-10-05 **Contracts follow-ups** (decisions in [contracts-v0.2-candidates.md](docs/contracts-v0.2-candidates.md), text in [contracts.md section 12](docs/contracts.md)): final sign-off of v0.1 (the user has not said yes yet); v0.2 schema work for items 1 to 4 and 7 (validate takes the run's inputs and settings, oracle entries carry settings, standard result data shapes with units, input roles) with a migration; `describe.oraclePin` revisited for v0.3.
- [ ] 2026-10-05 Host checks run settings against `describe.parameters` (type, bounds, enum) so adapters need not each re-implement it (contracts.md 12.4).
- [ ] 2026-10-05 Host-side enforcement of `maxDiskMB` (watch the run folder's size and cancel over the limit) and, later, `maxMemoryMB`; both are advisory today (contracts.md 12.3).
- [x] 2026-10-05 OpenMC oracle entries: 5 analytic good + 3 bad-input in the Studio repo (`oracles/seed`), tolerances fixed before the first run, all pass through the adapter ([adapter-openmc.md](docs/adapter-openmc.md)).
- [ ] 2026-10-05 OpenMC adapter: more oracle coverage (current, heating, reaction rates, energy bins, mesh tallies); mesh and dose tallies in collect; use `E_SCRIPT_MISMATCH` instead of `E_STALE_REVISION` for a script that differs from the regeneration.
- [ ] 2026-10-05 Cross-app links, not started: OpenMC heating into FEED, NODAL coolant into FEED.

## Next desktop lesson work (in order)

- [x] 2026-10-04 [Plan 11: report tabs](docs/plans/11-report-tabs.md): auto-open successful exports in isolated SEED tabs; trusted report receipts, safe offline viewing and independent tab lifecycle.
- [x] 2026-10-04 [Plan 12: restart reconnection](docs/plans/12-lesson-reconnection.md): persist trusted request intent, reconcile guarded status/history and reopen report tabs without redispatch.
- [~] 2026-10-05 review hardening (merged): host/CLI/MCP/review sources reformatted (no behaviour change, compiled output equal), dispatcher refusals carry stage plus an allowlisted failure class (host hook `onInternalError` for the full cause, written by the host to `diagnostics.jsonl` in the engine state folder), reviewer setup `seed.reviewer/0.2` bound to the OS account with POSIX owner/permission checks, human-only `recover` and `release-intent-reservation` moved to `dist/cli/admin.js` with `SEED_ADMIN_HOST_CONFIG`, full suite on Linux (1941) and Windows (1942), Codex review (1 finding fixed). Manual human sign-off: done 2026-10-05 by the user (reviewer name John) in the real desktop review dialog on the RAFT pulse lesson: accepted, receipt hash verified, accepted study chain valid (original prefix preserved, one human conclusion). See [docs/manual-signoff.md](docs/manual-signoff.md) and the log.
- [~] [Plan 13: human conclusions](docs/plans/13-human-conclusions.md): protected cited CLI/desktop drafts, separate trusted human setup/native confirmation, rejection and immutable accepted v2 report tabs implemented. [Record contract and setup](docs/conclusion-review.md). Remaining: manual human sign-off, corrections chained from accepted studies, reviewer setup UI and platform acceptance; E2 exit remains open.

## E3: experiments ([plan 04](docs/plans/04-runs-and-scheduling.md), [07](docs/plans/07-studies-and-reports.md))

- [ ] Typed parameter catalog from each adapter; bounded sweeps; explicit budgets (cases, wall-clock, cores, memory, disk); one active case per engine until limits are measured.
- [~] Single-case exports now reconstruct hash-chained steps with actor, reason, run and oracle verdict from guarded admission evidence; immutable bundle publication. Live append-only multi-run study recording remains.
- [ ] Comparison of compatible quantities only, with normalization and uncertainty; failed, cancelled, trip and stale runs visible.
- [~] 2026-10-03 **[agy]** Report builder done (`src/core/report.ts`, 14 tests: deterministic HTML and Markdown, escaping fuzzed over every free-text field, failed attempts listed, UNVERIFIED and STALE badges, educational-use statement); 2026-10-04: now wired to real guarded RAFT CLI/MCP run files through study/report export with checked offline snapshots; saved HTML report inspected in the browser with readable plots and provenance; desktop lesson run/save accepted against real RAFT; report tabs now implemented; shared restart reconnection now implemented; manual human sign-off, accepted-study corrections and native per-app history remain. Original item: Report builder (HTML and Markdown) from a study record fixture; every figure links to a run ID; educational-use statement; injected text escaped [A8].
- [ ] Replay: reproduces within tolerance or lists each difference (version, seed, library, input hash) [A7].
- [ ] Cache key includes inputs, material revisions, mapping recipe, versions, settings, seeds; one test per component.
- [ ] E3 exit review: **[codex]**.

## E4: reviewed transfer ([plan 08](docs/plans/08-transfers-and-pipelines.md))

Depends on Fuel Performance Studio F3 and an OpenMC result adapter (those apps' own plans).

2026-10-05 note: not urgent (every single-app workflow works without it), but it is what makes the five apps a suite, and where silent scientific errors are most likely (OpenMC heating per source particle is not watts). The OpenMC result adapter now exists. Suggested order:
- [ ] 1. Contracts v0.2 data shapes and units (candidates 3 and 4 in [contracts-v0.2-candidates.md](docs/contracts-v0.2-candidates.md)): a transfer reads result data generically, and today each adapter's data file differs. Proposal: [contracts-v0.2-data-shapes.md](docs/contracts-v0.2-data-shapes.md) (2026-10-06, decided; schema, units and reader built; oracle observers and adapters still to move).
- [ ] 2. OpenMC heating: a source-strength or power normalization the adapter can carry (the Studio project has a `sourceRate` setting) and an oracle for the heating score; heating by cell is mapped to eV per source particle today, with no oracle coverage.
- [x] 3. FEED F3 (reviewed heating and boundary mappings): done 2026-10-05 (transfer intake, 81 tests, Codex reviewed). Its recipe and source shapes are provisional (FEED decision 0003) until step 4 here; FEED waits for SEED to define the recipe format and the OpenMC and NODAL readers.
- [ ] 4. Transfer recipe schema, approval record (tier A3) and the refusal table of plan 08, built and tested against fake apps first, as the plan says. Proposal: [transfer-recipe.md](docs/transfer-recipe.md) (2026-10-06, awaiting the user).
- [ ] 5. The real OpenMC-to-FEED transfer, then NODAL coolant into FEED (a time series mapped onto FEED's boundary condition: time mapping and the explicit boundary choice of plan 08).

- [ ] Transfer recipe format and approval record (tier A3).
- [ ] OpenMC heating to Fuel Performance Studio, one way, offline: refusals for wrong units, missing normalization, incomplete coverage, stale revision; conservation within a tolerance declared beforehand [A10].
- [ ] Pipeline DAG: cycles refused at definition; downstream invalidated after an input change.
- [ ] Cross-app agent demonstration with the full study record and generated report (the first single-app demonstration belongs to E2).
- [ ] E4 exit review: **[codex]** (R5).

## E5: advanced studies ([plan 09](docs/plans/09-advanced-studies.md))

- [ ] Sensitivity and sampling studies an agent can drive; noise, input uncertainty and deterministic sensitivity reported separately (the report builder rejects a result without them).
- [ ] Feedback coupling: write the exchange list, synchronization, convergence and failure criteria and the oracle plan **before** any code; coupling stays an A3 human-approved action.

## Installer/updater, still open ([plan 01](docs/plans/01-shell-and-installer.md))

- [ ] **Optional add-ons and component-selective installation (2026-10-04, user request).** SEED manages core app and optional feature packages separately: show dependencies, download/disk size and installed capabilities; let users install, add later, update or remove add-ons. First example: install OpenMC Studio without GEOUNED/FreeCAD CAD support; only CAD import/conversion requires that add-on. Apps own component recipes and feature requirements; SEED owns installation/lifecycle. Do not download an unselected optional component or install it silently during a study. Preserve projects/custom materials and shared dependencies when removing add-ons. Split artifacts/environments where necessary, then verify core-only launch/run, later add/remove, offline behavior and interrupted update rollback. See [plan 11](docs/plans/11-runtime-and-shared-acceptance.md#optional-add-ons-and-component-selection).
- [ ] Install the conda environment and nuclear data for OpenMC Studio.
- [ ] Update SEED itself.
- [ ] Sign-in help beyond the message; offline use of a cached copy; a schedule or notice for available updates.
- [ ] Servers the host started can outlive a killed host (no job object): fix and test, including WSL-side ownership/cleanup. Graceful cancellation fixes on the pending branch do not prove forced-host-death cleanup.

## Release ([plan 10](docs/plans/10-release-and-packaging.md))

- [ ] Choose a distribution model; check licenses and redistribution terms before bundling any engine.
- [ ] Pre-release checklist; adapter authoring guide; make the repo public only when the user says so.

## Remote and cloud agent sessions (idea, 2026-10-05)

Question from the user: could a Claude cloud session be started with SEED and use this workflow to develop something novel or test things? Yes in principle (everything runs headless: files, a CLI and an MCP server over one core, each app reached through its own runner process, the runtimes are Linux); what stands in the way, in the order I would do it. What a cloud environment provides has not been checked.

- [ ] A Linux container that runs the real-runner suites (OpenMC with its nuclear data, SCRAM, FEED's OFFBEAT solver, NODAL's Python, RAFT). Useful on its own as a regression check, and it exercises the adapters' non-Windows branches, which are untested today.
- [ ] A way to regenerate an OpenMC script without Windows Electron (a virtual display for Electron, or the Playwright and Chromium variant the first version used).
- [ ] **Trust boundary:** SEED's gates assume the agent reaches it only through the CLI and MCP and cannot edit host policy, oracle pins or tiers (decision D4 does not defend against an agent with shell access). A cloud session has a shell, so the host must run outside the sandbox with only MCP tools exposed: a remote MCP host (the MCP server is stdio only today).
- [ ] Memory and disk budgets are advisory today (contracts.md 12.3): host-side enforcement before an agent is given a shared machine.
- [ ] A review channel for the human conclusion (accepting a conclusion is a native click on the local desktop today).
- [ ] E3 sweeps, replay and cache: without them an agent can run bounded single-app cases and verification campaigns, not parameter studies; transfers (E4) for coupled work.

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

- [x] 2026-10-03: Repaired this Windows checkout's startup by installing locked dependencies with `npm ci --no-audit --no-fund`. `npm run e2e`: 10 passed, 3 existing skips (real companion apps and two unsaved-dialog cases). Exact `Start SEED.cmd` opened a window titled SEED. No launcher source fix yet.

- [x] 2026-10-01: Shell skeleton (Electron host, tabs, registry, process manager, e2e with fake apps); same-origin windows for the Virtual Reactor operator window; repo `bluetyde/seed` (private, MIT).
- [x] 2026-10-01: Installer/updater (first version, docs/shell.md): clone, adopt, check, fast-forward update, dependency steps, prerequisite checks, per-app card with output and cancel.
- [x] 2026-10-01: Platform-aware default launch commands for macOS/Linux and Windows; home/sibling install discovery without machine-specific paths. macOS: all three apps opened, rendered, switched and stopped in SEED; unit suite passes.
- [x] 2026-10-01: The unsaved-work prompt ("Close anyway / Stay") checked by hand by the user.

## Runtime ownership and shared acceptance (2026-10-03)

See [plan 11](docs/plans/11-runtime-and-shared-acceptance.md). SEED owns managed runtime installation and launch/cleanup/offline availability. Apps own native save/open, solver and export correctness; slow MCNP export remains OpenMC work. Shared acceptance proves an offline SEED-to-OpenMC run, save, clean close and reopen. Existing packaging recipes are reused; no second full OpenMC installer/updater or competing watchdog is planned. This is planned scope, not current implementation.

- [ ] W1: inventory SEED process/installer entry points and OpenMC portable candidate e4d67df; document recipe reuse and lifecycle ownership.
- [ ] W2: specify runtime metadata, staged install/rollback, offline cache, managed/adopted resources and process identities before code.
- [ ] W3: fake-process lifecycle tests R4/R5, including forced host termination, WSL-side cleanup and unowned-process survival; then implement fixes.
- [ ] W4: local fake-artifact install, corruption, interruption, upgrade and rollback tests R1-R3/R6; no real engine needed.
- [ ] W5: complete E0 contracts/fake adapter with the corrected harness semantics below; no app private-port bypass.
- [ ] W6: integrate the reviewed OpenMC runtime recipe and run R7-R9 on the final artifact, plus material preservation R10.
- [ ] Coordinate W7 (large-import MCNP export) in OpenMC's own repo; SEED only records relevant integration/version effects.
- [ ] Keep implementation and verification states separate; sign off each platform/app combination actually tested.

## Runtime foundation progress (2026-10-03, Codex)

- [x] SEED-only entry-point inventory: docs/runtime-inventory.md. App-package inspection remains outside this claim.
- [x] Startup cancellation generation: pending attach/port/readiness work cannot revive a closed app; concurrent reopen waits for cleanup; HTTP 2xx required for readiness.
- [x] Regression evidence: 72 full-suite tests passed before the last added real-child test; targeted final lifecycle suite 16/16; build passed; Electron e2e 10 passed/3 existing skips. Four new race/readiness checks fail on the previous source.
- [ ] Runtime manifest/activation transaction implementation and fake-artifact R1-R3/R6.
- [ ] Forced host-death cleanup, WSL-side leases, process-start identity and authenticated health remain unimplemented; do not mark all W3 done.
