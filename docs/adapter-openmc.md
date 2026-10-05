# OpenMC Studio adapter (design, 2026-10-05; not built yet)

Status: design plus a proven first piece. Plan of record: `plans/experiment-studio/openmc-seed-adapter.md` (workspace).

## Decision: the script is regenerated, never trusted (option 2)

Studio's model is a generated `model.py` (page function `buildScript`) beside `project.json`. Nothing in Studio ties the two
together, so an adapter that hashed only one could run something other than the recorded model, and "validate" must never execute
project Python. So:

- The adapter's inputs are `project.json` and `model.py`, both hashed in the snapshot.
- `validate` regenerates the script from `project.json` with `studio/tools/regen_script.cjs` (OpenMC repo branch
  `claude/seed-adapter`, a469c3a): the real page, headless, nothing from the project is executed. A different script is refused
  (`E_SCRIPT_MISMATCH`, with the first differing line); error-level Studio problems are refused as the Run button does.
- Measured 2026-10-05: ~0.7 s per regeneration, identical twice, byte-identical to the saved `examples/triso-particle/model.py`.
  The fallback (script as the authoritative input, project informational) is not needed.
- A hand-edited script is refused, not run. Supporting one would be a separate, explicit, lower-trust input kind.

## Where things run

- Regeneration: Windows host (Node + Playwright + Edge/Chromium, as the browser tests).
- Transport: OpenMC and nuclear data live in WSL (`Ubuntu`, env `openmc-mcnp`, data `/root/nuclear_data`), as Studio itself runs.
  The job wrapper starts the run there; ownership and cancel must prove the WSL process is this job's (FEED's solver is the nearest
  precedent: `adapters/feed`).

## First slice (unchanged from the plan)

Fixed-source model, one seeded run, bounded scalar or binned tallies; eigenvalue, sweeps, CAD and MCNP refused. Pin particles,
batches, seed, threads, runtime and data identity. Results: raw per-source quantities with filters, units, normalization, mean and
uncertainty; `verification: unverified` until an oracle passes. Oracle: an independent analytic case (uncollided flux from a point
source in a void or a thin absorber) with tolerances fixed before any run.

## Open points

1. WSL job identity and kill: FEED's answer is that the app owns a runner with its own `run` and `cancel` verbs that handle the distro (manifest written last, hashed files, process-group flag file). Proposed here too: a headless runner in the OpenMC repo, `python -m openmc_studio.headless run MODEL.py --out DIR --seed N --json` plus `cancel`, run inside WSL by the job wrapper, writing a hashed manifest and a results extract from the statepoint. The adapter then repeats the FEED cancel sequence (stop the solver first, then prove ownership of the Windows-side processes).
2. Which tallies and score types the first slice supports.
3. Whether Edge/Playwright is a hard requirement of `validate` on a machine, or SEED bundles a Chromium for it (a missing browser must give a setup error, not a skipped check).
