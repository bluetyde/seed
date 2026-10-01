# Experiment & Analysis Studio: initial plan

Status: draft, 2026-09-30. The three-app scope and materials behavior follow the user request; implementation choices below remain proposals.

Provide one project workspace that opens the five engineering apps, coordinates calculations and compares reproducible results. The apps remain independently usable.

## First student workflow

Create a project, attach an existing native model, open its editor in a tab/window, save a revision, import a completed run, compare named quantities, and export a report with inputs and assumptions. Later, select a supported parameter, specify several values and run a bounded sweep without opening every editor.

## Product boundaries

This workspace owns project references, run scheduling, comparisons and reports. Individual apps own their native models, validation and physics. Opening an editor and executing a calculation are different operations. The workspace does not require every app to be installed, does not rewrite all native formats and does not invent solver compatibility.
Materials are project data with app-specific property sets, not a library application. See the shared integration draft for preservation and revision rules.

## Implementation milestones

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| E0: contracts | Inventory current formats; decide adapter transport and project manifest; create a fake adapter fixture | Open vs run distinction, revisions, material preservation and status semantics documented |
| E1: project launcher | Discover configured apps, attach native models, open/focus editors, import completed runs | Reopen project; missing app is actionable; paths with spaces and Windows/WSL mapping work; no physics required |
| E2: single-app runs | One real adapter, validate/run/status/cancel/collect, immutable inputs | GUI/direct/workspace results agree; cancellation, crash and stale edit handled; standalone launch unaffected |
| E3: experiments | Typed parameter catalog, bounded sweeps, resource budgets, results comparison and report | Failed cases remain visible; same seed/input replay; each result traces to its exact case |
| E4: reviewed pipeline | One-way DAG of verified transfers between two apps | Unit/mesh/time/normalization checks pass; incompatible edge blocked; downstream runs invalidated after input change |
| E5: advanced studies | Sensitivity, sampling and selected feedback coupling | Correlations, sampling assumptions, Monte Carlo noise and convergence behavior documented and tested |

## Architecture draft

Use a thin local coordinator with adapters around the existing apps. Keep engine execution off the UI thread. Use configurable app locations and launch arguments; do not reserve fixed ports until the implementation plan checks existing allocations.
A project manifest references versioned native model artifacts and material records. A run copies exact inputs to its own directory and records checksums, app/engine versions, settings, seeds, statuses, diagnostic logs and result references. Large result arrays stay in native files; a results index supplies quantities, units, coordinates and provenance.
Do not permit two editors to overwrite the same revision: save with expected revision, reject conflicts, offer reload or a new revision. Experiments run snapshots and cannot edit the live source model. A workspace manifest can wrap native manifests without changing their hashing rules.
Draft adapter verbs: describe, open, validate, run, status, cancel, collect. These are semantic operations, not promised HTTP endpoints. Decide CLI versus local service after examining existing entry points; authenticate any local service and restrict file access to configured project/run roots. Do not execute arbitrary commands from project files.

## Scheduling and failures

Default to one active case per engine until measured resource limits exist. Distinguish queued, running, completed, failed, cancelled, interrupted and terminated-by-trip; preserve the native status and diagnostic detail. A trip is not silently treated as successful completion of an intended experiment. Track process ownership; cancel only the job's own process tree. Resume never trusts a partial output merely because it exists.
Retries create a new attempt record. Cache keys include inputs, material revisions, mapping recipe, adapter/engine versions, settings and seeds. GUI-only layout changes can be excluded only under the native format's documented hashing rules.

## Analysis rules

Compare only compatible quantities and coordinate/time domains. Show normalization and uncertainty. Distinguish deterministic sensitivity, input uncertainty and Monte Carlo sampling noise. Sweep parameters come from each adapter's typed catalog, not arbitrary string replacement in model files. Feedback loops are excluded from the first DAG release.

## Verification

Start with a fake engine to exercise launcher/run lifecycle without heavy dependencies; then use one small real-engine case. Cover project relocation, unknown material-set preservation, edit conflicts, crash mid-write, cancellation, partial result rejection, stale cache, unit mismatch and repeatability. Define numerical tolerances per real adapter before tests.
Open decisions: UI framework, transport, packaging, canonical material-envelope format and first real adapter. Proposed first adapter is PRA once its P2 gate passes; launcher work can start with existing apps sooner.
