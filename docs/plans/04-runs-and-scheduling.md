# Plan 04: Runs and scheduling

How a calculation becomes a run record, how runs are scheduled and cancelled, and when a result is valid. Milestones E1 (import), E2 (real runs), E3 (sweeps).

## Run record

See the layout in [ARCHITECTURE](../ARCHITECTURE.md). A run records: input hashes, material and model revisions, mapping recipe (if any), settings, seeds, data-library identity, adapter and engine versions, budget used, coordinator state, native status, output hashes, and logs.

## Rules

- A run **copies** its inputs into its own directory and never shares a mutable directory with another run, agent or app.
- **Completed means complete.** Every declared output is present and hashed. Partial output with a zero exit code is `failed` and is kept for inspection, never indexed.
- **Native status is kept.** A trip, abort or app-level failure is shown beside the coordinator state. A trip is not a successful completion of an intended experiment.
- **Resume never trusts a partial output because it exists.** A retry is a new attempt record.
- **Ownership:** SEED tracks the process tree of each run it started. It cancels only that tree, and never kills a process it did not start.
- **Invalidation:** a new input revision (model, material, mapping) marks dependent runs stale; stale results stay readable but are labelled and never silently reused.
- **Cache key:** input hashes, material revisions, mapping recipe, adapter and engine versions, settings and seeds. A cache hit is shown as one, with the original run ID.
- **GUI-only edits** (layout, colours) are excluded from the key only where the native format's own hashing rules exclude them. SEED does not decide that itself.

## Scheduling

- Default: **one active case per engine** until measured limits exist. Measuring is a task: record wall-clock, cores and memory of a typical case per adapter and write the limits into `describe`.
- Queue is FIFO with explicit priority only for the human's own interactive run.
- Budgets (cases, wall-clock, cores, memory, disk) belong to the study; the scheduler refuses at the limit rather than degrading silently. Default budgets are small.
- Engine execution stays off the UI thread. The scheduler survives the GUI closing when started headless; it records `interrupted` for runs it finds orphaned on restart.
- Shared machine: SEED does not touch other agents' ports, run directories, shared nuclear data or WSL lifecycle. Long runs and thread counts are announced in the coordination log by the agent that starts them (`messages/INSTRUCTIONS.md`).

## Import of existing runs (E1)

Show an existing completed run with its **actual native status and provenance**. If provenance is missing, say so; SEED does not fill it in. An imported run is labelled `imported`, not `run by SEED`, and cannot be replayed unless its inputs are present.

## Sweeps (E3)

- Parameters come from each adapter's typed catalog in `describe`, never from string replacement in a model file.
- A sweep is a list of cases, each a full run with its own record. Failed cases stay visible in the table and the report.
- Bounds and budget are checked before the first case starts and again before each.
- Monte Carlo cases record seeds; a replay with the same seed reproduces within the adapter's declared tolerance.

## Tests

- State machine: every transition from the diagram in ARCHITECTURE, including interrupted after host kill.
- Partial output, zero exit code: `failed`, not indexed.
- Cancel kills the owned tree; a sibling survives.
- Stale input: dependents marked stale; cache key changes with each key component (one test per component).
- Budget: the case that would exceed any single limit is refused and recorded.
- Orphan recovery after a simulated host crash.
- Same snapshot, settings and seed: same run ID or an explicit non-idempotence statement.

## Open

- Measured per-adapter resource limits (needs real adapters).
- Whether the scheduler is a library inside the core or a separate process (affects headless survival of GUI close).
- Retention and cleanup policy for run directories (disk budget).
