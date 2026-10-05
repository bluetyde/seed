# Adapter: NODAL Studio (second real adapter, E2)

2026-10-05. `adapters/nodal/cli.cjs` and `job.cjs` implement the seven-verb protocol (transport: CLI per verb, [plan 03](plans/03-adapters-and-transport.md)) over NODAL's reference solver, run through its command-line runner `python -m nodal_studio.run` and the machine-readable modes added for this (`--describe`, `--validate`, `--json`; `docs/headless.md` in the NODAL repo, branch `claude/seed-headless`). Modelled on [the RAFT adapter](adapter-raft.md). Tests: `tests/nodal-adapter.test.ts`, `tests/nodal-oracles.test.ts`.

NODAL is a 1D thermal-hydraulic loop solver in educational scope (RELAP5-format models, homogeneous equilibrium two-phase). Nothing here says anything about a real plant; every result index carries `verification: "unverified"` until an oracle verdict says otherwise.

## Configuration (host environment, never a project file or a request)

| Variable | Meaning |
|---|---|
| `SEED_NODAL_PYTHON` | absolute path of a Python with NODAL's solver requirements (`requirements-solver.txt`) |
| `SEED_NODAL_REPO` | absolute path of the nodal-studio checkout (must contain `nodal_studio/run.py`) |
| `SEED_NODAL_ORACLES` | optional: NODAL's `oracles/seed/entries`; `describe` reports the quantities and domains of its good entries |
| `SEED_NODAL_REPO` (tests) | default a sibling folder `pipe-studio`; the real-runner tests are skipped, with a warning, when it is missing or its runner lacks the JSON modes |

Unset, relative or missing values give `E_SETUP_REQUIRED`. The runner is started with the repository as its working folder and `PYTHONDONTWRITEBYTECODE=1`, so a run writes nothing into the repository.

## Verbs

- `describe`: engine `nodal-reference-py`, the capability ids the gate accepts, and the quantity kinds a model output can have with their units (a result carries the outputs the model names).
- `open`: `E_VERB_UNKNOWN` (NODAL's editor is its web app).
- `validate`: the runner's `--validate` (schema validation, capability gate and engine setup, nothing run). Refusals become problems labelled `app-content` with the NODAL code in the message and a mapped SEED code (`E_GATE*`, `*UNSUPPORTED*` to `E_UNSUPPORTED`, otherwise `E_SCHEMA_INVALID`); `W_...` warnings come through as warning problems and do not make a model invalid.
- `run`: the snapshot is one model file (and optionally a commands file, `settings.commands`); `settings.model` names the model (default: the only input); `settings.recordDt` is a positive number of seconds. A request `seed` is refused (`E_UNSUPPORTED`: NODAL is deterministic), as is an unknown setting. A detached `job.cjs` wrapper runs `python -m nodal_studio.run ... --json`, keeps a heartbeat and writes `native/status.json`; start is exclusive, ids cannot collide, a failed registration stops the job, and the wrapper stops the runner if it cannot report.
- `status`: from the wrapper's status file, heartbeat and token. The model's own stop-advancement trip is `terminated-by-trip`; a failed run is `failed` with the solver's reason.
- `cancel`: kills the job's process tree (the venv's Python launcher and the interpreter under it) only after the process command line shows it is this adapter's wrapper for that run folder.
- `collect`: only for a completed job. Re-hashes the snapshot, verifies the runner's manifest (exactly `model.json`, `results.json`, `session.json`, every hash), that the run folder's model equals the snapshot's model (canonical compare), that the time series is strictly increasing and reaches the model's last `endTime`, and that every channel is finite, unique and as long as the time series. Each channel becomes a quantity with one JSON series file (time, values, kind, and the min/max envelope when NODAL thinned the record). NODAL warnings (for example `W_HEM_APPROXIMATION`) are returned as reply warnings and listed in `extensions.nodal.messages`.

## Oracles

NODAL owns its entries (D3): `oracles/seed/` in the NODAL repo, with `tools/gen_seed_oracles.py` there producing cases and models and `scripts/gen-nodal-oracles.cjs` here producing the hashed entries. 24 entries:

- **4 analytic (good):** hydrostatic column at rest, turbulent pipe flow (Darcy-Weisbach with Colebrook), laminar flow (Hagen-Poiseuille), vertical drain. The expected value comes from a formula or integral that does not use the solver (iapws properties only), with the tolerances NODAL's NUMERICS section 9 fixed before any solver result was seen. These are the independent ones.
- **16 regression (good):** the last sample of two output channels of each of eight golden vectors, with docs/GOLDEN.md's cross-implementation bound. Two implementations agree (Python reference, TypeScript port); a defect they share would pass.
- **4 bad input:** a heat-structure placeholder, no time steps, a negative area, a wet start in a model that declares only single-phase hydraulics.

## Known limits

- Coverage is by channel name of those models; a model with other output names is unverified even for the same physics.
- Not covered by any oracle: two-phase accuracy against anything outside NODAL, heat-structure behaviour beyond the golden cases, kinetics (not built), real decks.
- NODAL writes its run folder only after the run ends: a process killed mid-run leaves no folder (the wrapper reports `failed`).
- Python start-up costs about a second per call; fine for these runs.
- On Windows there is no job object: a wrapper killed from outside leaves its runner until `cancel`.
- The adapter duplicates the RAFT and FEED adapters' infrastructure (about 400 lines); a shared module is a follow-up.

## Review fixes (Codex, 2026-10-05)

- A request id already bound to another run folder is refused (`E_REQUEST_CONFLICT`) before anything is reserved; the first job keeps its registry entry.
- Cancel after the wrapper died stops the surviving runner only when its command line provably belongs to this run (exact arguments); otherwise `E_NOT_OWNED`. The reply reports `nativeStopped`.
- Rejected commands in the runner's messages come back as `W_NODAL_*` warnings carrying the app's code and text.
- Collect refuses results whose channels differ from the model's outputs, or whose history does not start at time 0.
- A linked `native/series` or `native/out` folder is refused; the job never writes through it.
- Not covered by tests (no stub runner): trip with folder issues in `job.cjs`, and a validate result with only warnings.
