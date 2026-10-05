# Adapter: Fuel Performance Studio (FEED)

2026-10-05. `adapters/feed/cli.cjs` and `job.cjs` implement the seven-verb protocol (transport: CLI per verb) over FEED's headless runner (`src/cli/headless.ts`, built to `dist/cli/headless.js` in the FEED repo, private repo `bluetyde/feed`). Modelled on [the RAFT adapter](adapter-raft.md). Tests: `tests/feed-adapter.test.ts` (scripted stand-in runner in `tests/fixtures/feed-stub/`, no solver needed), `tests/feed-oracles.test.ts` (real runner and solver, skipped without them).

FEED is a **thermal** calculation only (1D radial steady-state pin: fuel, gap, cladding, coolant film). Every result index carries that statement in `extensions.feed.thermalOnly`. Nothing here says anything about stress, failure or integrity.

## Configuration (host environment, never a project file or a request)

| Variable | Meaning |
|---|---|
| `SEED_FEED_HEADLESS` | Absolute path of FEED's `dist/cli/headless.js`. Unset, relative or missing gives `E_SETUP_REQUIRED`. |
| `SEED_FEED_ORACLES` | Optional. Absolute path of FEED's `oracles/seed/entries`; `describe` reports the quantities and domains of its `good` entries as `oracleCoverage`. |

The solver (OpenFOAM Foundation 9 + OFFBEAT, in the WSL distro `feed-solver`) is reached only through the runner. `run` asks the runner to `describe` first; if the solver is missing the run is refused as `E_SETUP_REQUIRED` and no job is created. `describe` reports a missing solver as warning `W_SOLVER_MISSING`.

## Verbs

- `describe`: engine `feed-headless`, format `feed.case` 0.1, seven quantities, capabilities.
- `open`: `E_VERB_UNKNOWN` (FEED's editor is its web app).
- `validate`: runs the runner's `validate`; its typed errors (`E_UNITS`, `E_BOUNDARY_INCOMPLETE`, `E_PROP_MISSING`, `E_MESH`, `E_GEOMETRY`, `E_UNSUPPORTED`, ...) become problems labelled `source: "app-content"` (the text is data, never acted on); warnings (`W_POWER_RANGE`) come through as warnings. A refusal with no reason is still a refusal.
- `run`: the snapshot must be exactly one file (a FEED case is self-contained). A request `seed` is refused (`E_UNSUPPORTED`): FEED is deterministic. The run folder is reserved exclusively, a detached `job.cjs` wrapper runs `headless run`, keeps a heartbeat and writes `native/status.json`. The budget's wall seconds become the runner's time limit (10 to 86400 s).
- `status`: from `status.json`, heartbeat and the job token; a live process with the token is running even if its heartbeat is late.
- `cancel`: first the runner's own `cancel --out` (stops the solver **inside the WSL distro**, which a Node process-tree kill would not reach), then the wrapper tree, only after the process command line proves it is this job's wrapper. If the runner cannot confirm the solver stopped, nothing is killed and `cancelled: false` is returned: the wrapper still holds the time limit.
- `collect`: re-hashes the snapshot, verifies the runner's manifest (exactly `case.json, derived.json, feed-manifest.json, results.json, run.json`, every hash, the case hash), then refuses a result that is out of domain (`E_OUT_OF_DOMAIN`: a conductivity law used outside its stated range), has a failing check, or has a non-finite value (`E_OUTPUT_INCOMPLETE`). Otherwise it writes per-quantity data files and the `seed.results-index/0.1`.

## Quantities

| Name | Unit | Meaning |
|---|---|---|
| `temperature_radial` | K | cell-centre temperature, `r` in metres from the axis, `region` per cell |
| `temperature_peak` | K | hottest cell centre (first fuel cell, not the axis) |
| `temperature_fuel_surface` | K | last fuel cell centre |
| `temperature_clad_inner` | K | first cladding cell centre |
| `temperature_surface` | K | outer cladding wall (patch value) |
| `heat_flux_outer` | W/m2 | `q'/(2 pi Rco)` |
| `energy_balance_residual` | 1 | relative, flux through the cladding wall against the input linear heat rate |

All are `verification: "unverified"` until an oracle set covers them. The FEED oracle set (19 entries, closed-form expected values, tolerances from the mesh-refinement bound fixed before any run) covers `temperature_peak`, `temperature_surface`, `heat_flux_outer` and `energy_balance_residual`; `temperature_fuel_surface`, `temperature_clad_inner` and `temperature_radial` stay unverified.

## Known gaps

- A cancel that arrives in the instant between the runner starting and the solver run being registered finds no active solver run and kills only the Node processes; the solver would then end at the runner's time limit. Not yet tested.
- Windows only for the real solver (WSL). The stub tests run anywhere.
- Mesh is part of the case; there is no refinement study through SEED yet.
