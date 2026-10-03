# Plan 11: Managed runtimes and shared acceptance

Updated 2026-10-03. Ownership follows the user's request; mechanisms below are proposed until implemented and verified. This work extends the current shell/installer, not a new physics app or a second installer inside OpenMC.

## Three responsibilities

| Owner | Responsibility | Evidence |
|---|---|---|
| SEED | Install/adopt/update compatible app runtimes and locate data; launch, attach, stop, recover and support offline availability | Installation transaction tests, owned-process tests and per-platform acceptance |
| OpenMC Studio | Native save/open, calculation and export correctness, including slow large-import MCNP export | Native app regression, semantic parity and measured export timing |
| Shared integration | Installed SEED opens OpenMC offline, runs a small case, saves, closes cleanly and reopens the same project | End-to-end evidence pinned to SEED/app/runtime/data versions |

Apps publish versioned engine recipes, compatibility metadata, capability checks and native oracles; SEED performs the installation transaction and user-facing lifecycle. SEED does not infer compatibility or implement nuclear calculations. An app may retain a thin standalone launcher that uses the same runtime entry point. No duplicate updater or competing watchdog.

## Runtime artifact contract: design before implementation

Record artifact ID/version, OS/architecture, supported app/adapter versions, trusted source, content hash, sizes (download and expanded), prerequisite capabilities, engine/dependency manifest, data-library references and digests, license/notices/source obligations and recipe revision. A hash establishes content identity, not publisher authenticity: the catalog/trust source must also be reviewed. Study files cannot supply executable installation instructions.

The existing OpenMC package candidate e4d67df is an input to this spike, not an accepted release. Inventory its manifest, private WSL entry point, setup/launcher, watchdog, dependency locks and acceptance scripts. Decide which recipe components SEED reuses and which launcher responsibilities it replaces. Do not copy a personal environment or change existing shared environments.

Runtime and nuclear-data stores are outside project snapshots and read-only during calculations. Projects record identities/digests and resolve them through local configuration. Record whether a resource is SEED-managed or adopted; never uninstall or mutate an adopted resource implicitly.

## Installation and upgrade transaction

Preflight prerequisites, compatible platform, free disk and existing installations. Distinguish missing WSL capability from a missing app runtime; system-level changes are explicit setup actions, not hidden study actions. A recipe requiring elevation or large downloads uses the normal setup authorization path.

Stage artifacts, validate hash and safe extraction paths (including links), import/build into an isolated versioned location, run health/native smoke checks, then atomically activate the version. Failure/cancellation leaves the active version usable. Persist progress and diagnose interrupted staging on restart. Serialize install/update operations per managed runtime; never update a version with active jobs. Retain rollback references while jobs depend on them; cleanup removes only tracked, unreferenced managed versions after the applicable user action. Preserve licenses and corresponding-source obligations before public redistribution.

Offline has two modes: install from verified cached artifacts with no fetch, and run an already installed compatible app. If a required artifact is absent, explain exactly what is missing. Do not claim first-time offline installation without a complete cache and prerequisites.

## Lifecycle authority

Use one process-ownership record per app launch/job: run/launch ID, runtime ID, host/worker identity, process start identity, endpoint and generation token. A PID alone is insufficient after PID reuse. Health checks must identify the expected app/session; an arbitrary HTTP 200 is not enough for a managed launch.

Managed and attached processes differ: stop/cancel only the owned launch tree/job. Closing a tab cannot kill an adopted server or unrelated calculation. App-tab close, host close and explicit headless job continuation require separate documented policies; no accidental survival or accidental cancellation.

Windows host cleanup and WSL process cleanup are separate boundaries. Evaluate a job object/owned helper and a runtime-side lease/watchdog; killing wsl.exe alone is not evidence that its Linux children ended. Never stop all WSL or terminate a shared distribution. Standalone and SEED modes must select one supervising owner. On restart, reconcile recorded owned jobs using identity checks before cleanup; retain interrupted outcomes and diagnostics.

## Acceptance matrix

| ID | Check | Required outcome |
|---|---|---|
| R1 | Fresh supported setup / missing prerequisite / spaces in path | Successful install or precise prerequisite diagnosis; no existing environment damaged |
| R2 | Corrupt artifact, unsafe archive, cancelled or interrupted install | Refused or recoverable staging; active installation unchanged |
| R3 | Upgrade with active job; failed new-version health check | Update deferred; previous version usable; no mixed-version run |
| R4 | Managed launch/close and forced host termination | Owned Windows and runtime children terminate or explicitly authorized headless job remains tracked |
| R5 | Attach existing server; unrelated sibling; stale PID record | Unowned resources survive; stale identity cannot authorize a kill |
| R6 | Offline cached install / offline installed run / missing cache | First two succeed with complete prerequisites; third gives actionable missing-artifact report |
| R7 | Small native OpenMC run through SEED; save, close and reopen | Native model semantics and material data preserved; results/provenance match direct-app oracle within predefined tolerance |
| R8 | Interrupt calculation before outputs committed | Interrupted/failed state retained; partial artifacts never become successful results |
| R9 | Relocate project and installation where supported | Portable references resolve or explicit repair is offered; no silent substitution of data/runtime |
| R10 | Custom OpenMC-only material through suite envelope | Unknown sets preserved; thermal operation refuses missing properties without changing composition |

R1-R6 can first run against tiny fake artifacts and child processes. Real Windows/WSL R4/R7 require a separately owned test runtime, no MCNP executable and no MCNP gateway for an OpenMC-only case. Native save/load assertions stay owned by OpenMC; SEED proves orchestration. Record exact commands, versions and results. Prior tests on an earlier package commit do not certify the final artifact.

Publish a per-platform/app support matrix. Do not require NODAL on an OS it does not support or describe configuration-only coverage as a verified launch. Do not delay Windows development behind unimplemented platforms; make release claims match actual coverage.

## Work packages and readiness

| Work | Ready now? | Completion condition |
|---|---|---|
| W1: inventory existing SEED and OpenMC package interfaces | Yes, read-only | File/entry-point map, reuse/replacement decisions and gaps; no assumptions of working cleanup |
| W2: runtime metadata/transaction and ownership contracts | Yes, design | Error/state tables and fake test fixtures; transport choices recorded |
| W3: lifecycle hardening against fake processes | After W1/W2 | R4/R5 plus existing process-manager regression; runtime-side ownership exercised |
| W4: staged artifact install/cache/rollback | After W2 | R1-R3/R6 with small local fixtures, no heavy engine needed |
| W5: SEED E0 core/harness contracts and fake adapter | Can progress alongside W1/W2 | Single enforcement path, typed schemas and harness A1-A6 plus replay/idempotency cases |
| W6: OpenMC real recipe and offline integration | After W3/W4 and recipe review | R7-R9 on final versions in isolated runtime; package notices reviewed |
| W7: slow MCNP imported-model export | Separate OpenMC task | Reproducible timing improvement with native export semantic parity; no SEED solver code |

Recommended next Codex work: W1, then W2 and the fake lifecycle/transaction tests. These are bounded and need no PRA/Fuel engine, new UI design or model download. This plan does not dispatch implementation or approve external publication.
