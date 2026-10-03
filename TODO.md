# SEED: TODO

Launcher and installer are implemented; project coordination and the agent harness remain planned. Milestones refer to [PLAN.md](PLAN.md). The harness design is in the workspace plan `plans/agentic-harness.md` (layers H1-H4, tiers A0-A4, acceptance tests 1-10). Close tasks with evidence (a command and its result), not a plan edit. Items marked "fake adapter" need no real physics code and can start first.

## Done

- [x] E1 (partial): configurable launcher shell: app registry, start/stop/attach, tabs, error pages (docs/shell.md).
- [x] Installer/updater (first version, docs/shell.md): clone, adopt, check, fast-forward update, dependency steps, prerequisite checks, per-app card with output and cancel.
- [x] Platform-aware default launch commands for macOS/Linux and Windows; home/sibling install discovery without machine-specific paths. macOS: all three apps opened, rendered, switched and stopped in SEED; unit suite passes.

## Now: E0 contracts (fake adapter)

- [ ] Inventory each app's entry points and native model, run and result contracts (OpenMC Studio, NODAL, Virtual Reactor first; PRA and Fuel when they have code). Output: a table in docs, one row per verb per app, with what exists and what is missing.
- [ ] Decide adapter transport: local authenticated entry point per app plus one MCP server in SEED; decide MCP only or MCP plus CLI. Record the decision and the rejected options.
- [ ] Write versioned schemas with a migration policy and good/bad fixtures: project manifest, material envelope, adapter describe/validate/run/status/cancel/collect messages, typed error codes (field, unit, range), result index (quantity, units, coordinates, normalization, uncertainty, provenance, hash).
- [ ] Write the study record schema (question, hypothesis, assumptions, bounds, budget, steps with agent identity, linked run IDs, conclusion; append-only) and the oracle entry schema (inputs, expected quantity, tolerance fixed before the run, source of the answer, adapter and version coverage, tag good/bad-input/known-limit).
- [ ] Write the autonomy tier model (A0-A4) as a policy file format and decide where it is enforced (SEED main process or a separate service).
- [ ] Build a fake adapter and fake engine that can succeed, fail validation, crash, hang, leave partial output, trip, and report a stale revision. Settle the transport against it.
- [ ] Harness tests that need only the fake adapter: typed error reaches an agent with field and unit (accept 1); wrong adapter output fails an oracle and blocks the study (3); instruction-like text in a project file starts nothing (4); over-budget request stops at the gate and is recorded (5); stale-revision save is rejected and recorded (6).

## E1: project launcher

- [ ] Project create/open/reopen with portable relative paths; project relocation; Windows/WSL path mapping stated explicitly, not guessed.
- [ ] Attach an existing native model to a project; open or focus its editor without starting a calculation; a missing app gives an actionable message.
- [ ] Import an existing completed run and show its native status and provenance; incomplete or partial output is never shown as a result.
- [ ] Headless mode: the SEED core runs with no window and serves the adapter verbs (needed by the harness; the GUI stays a client of the same core).
- [ ] Project folder layout reserves `studies/` and `oracles/` (empty is fine) so later work does not move files.
- [ ] Run the real-app integration check on Windows and Linux hosts; configuration coverage is not runtime verification.
- [ ] Verify the default start command of each app by a real launch on Windows, macOS and Linux.

## E2: single-app runs

- [ ] First real adapter: PRA through the full verb set (depends on PRA P2). Immutable input snapshot, owned job ID, owned process tree.
- [ ] Oracle registry v1 with the PRA hand oracles (A=0.1, B=0.2: AND 0.02, OR 0.28; A AND A and A OR A both 0.1; (A AND B) OR (A AND C)). PRA through SEED and the direct engine agree (accept 9).
- [ ] MCP server exposing the verbs, with tool descriptions that state limits and refusals; agent-driven run, cancel and crash tested against the real adapter.
- [ ] Verify cancellation, crash, partial output, edit conflict, relocation and stale-result handling on the real adapter (accept 2, 6).
- [ ] Tier enforcement in SEED, tested: an agent cannot raise its own tier, loosen a tolerance or override a refusal (accept 3, 5).
- [ ] Standalone launch of the app is unchanged by the adapter.

## E3: experiments

- [ ] Typed parameter catalog from each adapter; bounded sweeps with explicit budgets (cases, wall-clock, cores, memory, disk); one active case per engine until limits are measured.
- [ ] Study record in use: every agent step recorded with agent identity, reason, produced runs and the oracle set passed; append-only.
- [ ] Comparison of compatible quantities only (same coordinate and time domain), with normalization and uncertainty shown.
- [ ] Report generated from the study record and run graph; every figure links to a run ID; educational-use statement and assumptions section present (accept 8).
- [ ] Replay: same inputs, seeds and versions reproduce the result, or the differences are listed (accept 7). Retries create new attempt records; the cache key includes inputs, material revisions, mapping recipe, versions, settings and seeds.

## E4: reviewed transfer

- [ ] One reviewed offline, one-way transfer: OpenMC heating to Fuel Performance Studio (needs F3 and an OpenMC result adapter). A human approves the mapping recipe (tier A3).
- [ ] Refusals hold: wrong units, stale revision, incomplete spatial coverage; total mapped power conserved within a tolerance declared beforehand (accept 10). Downstream runs are invalidated after an input change.
- [ ] First end-to-end agent demonstration on this transfer, with the full study record and generated report.

## E5: advanced studies

- [ ] Sensitivity and uncertainty studies an agent can drive; Monte Carlo noise reported separately from input uncertainty and deterministic sensitivity.
- [ ] Feedback coupling only after its assumptions, convergence and failure criteria and acceptance gates are written down.

## Installer/updater, still open

- [ ] Install the conda environment and nuclear data for OpenMC Studio.
- [ ] Update SEED itself.
- [ ] Sign-in help beyond the message; offline use of a cached copy; a schedule or notice for available updates.

## Decisions waiting

- [ ] MCP only, or MCP plus CLI.
- [ ] Study record as project files, or an embedded store with files as the export.
- [ ] Oracle registry in the SEED repo, or in each app repo with SEED indexing them.
- [ ] Where tier enforcement runs.
- [ ] One log convention shared by dev agents and engineering agents, without mixing them.
- [ ] UI framework for project, study and report views; packaging; first real adapter if PRA is late.
