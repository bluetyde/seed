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

All are `verification: "unverified"` until an oracle set covers them. The FEED oracle set (33 entries, closed-form expected values, tolerances from the mesh-refinement bound fixed before any run) covers `temperature_peak`, `temperature_surface`, `heat_flux_outer` and `energy_balance_residual`; `temperature_fuel_surface`, `temperature_clad_inner` and `temperature_radial` stay unverified.

## Known gaps

- No cancel race remains by construction: FEED's runner writes `active-run.json` in the same synchronous step as `RunManager.start()`, before the manager's deferred pump can launch anything, and the run script honours a cancel flag that exists before it starts (FEED test `wslLifecycle`: "a cancel flag set before the script starts"). A solver therefore cannot exist without a record the cancel verb can find. Keep that ordering if the runner is edited.
- Windows only for the real solver (WSL). The stub tests run anywhere.
- Mesh is part of the case; there is no refinement study through SEED yet.

## Transient (pulse) results

A case with `assumptions.steadyState: false` and a `transient` section is a thermal pulse: the power history is an input, the step is fixed, the start is a uniform temperature. Its result record is `feed.results/0.2` and the adapter collects these quantities instead of the steady ones:

| Name | Unit | Meaning |
|---|---|---|
| `temperature_peak_history` | K | hottest cell centre at each output time; the time axis `t` (s) is in the data file, coordinates system `time` |
| `temperature_outer_wall_history` | K | outer cladding wall (patch value) at each output time |
| `temperature_peak_max` | K | the hottest cell-centre value over the whole run |
| `time_of_peak` | s | first output time at which that value occurs (reported, not oracle-covered: after a pulse the interior stays flat) |
| `energy_deposited` | J/m | exact integral of the power history |
| `energy_balance_gap` | 1 | largest relative gap over the outputs between the energy deposited and stored plus rejected; it includes the first-order error of the time stepping |

`collect` refuses a transient whose own checks fail (`energyBalance`, `crossCheckFv` against FEED's independent finite-volume solution, `timeStep`, `propertyRange`) or that used a conductivity or heat capacity law outside its stated range (`E_OUT_OF_DOMAIN`), and any series that is missing, the wrong length, not finite or whose times do not increase from 0. `extensions.feed.kind` is `transient`. Everything else (snapshot hashes, manifest, ownership, cancel) is as for steady runs.

FEED's oracle set now has 33 entries. The pulse entries test the adiabatic limit (the fuel interior keeps all the deposited energy, so its temperature is the root of the integral of c dT = E''') for a triangular pulse with constant heat capacity, the same pulse with a linear heat capacity, and a TRIGA-sized pulse built from UT-Austin SAR numbers, plus the energy deposited, a refusal of a heat-capacity law used out of range, and bad-input entries for a time step that does not divide the run and a missing heat capacity. Heat leaving the fuel during a long transient has no oracle entry: FEED checks it against its own independent solution.

## Codex review (2026-10-05)

Two auditors (security-boundary-verifier, silent-failure-hunter) reviewed the adapter. Ten distinct findings, all confirmed by reading the code; all fixed on this branch.

| Finding | Fix |
|---|---|
| `native/series` or an existing `native/log.txt` could be a link, so collect or the wrapper wrote outside the run folder | collect refuses a linked or escaping series folder; the wrapper removes `log.txt` before writing it |
| Ownership by substring: `runs/r-10` passed for `runs/r-1`; the token was only compared between two project files | the process command line must hold this adapter's `job.cjs`, the run folder and this job's token as whole arguments |
| A second launch with an already used request id deleted the first job's registry entry | the index is reserved before spawning; rollback removes only what this invocation created; the clash is `E_REQUEST_CONFLICT` |
| `ok:true, cancelled:false` from the runner was taken as "solver stopped" | with nothing registered, the wrapper and runner are killed and the runner is asked again; that answer must be confirmed too |
| Cancel of a failed or died job inferred `nativeStopped` from two pids | the runner is asked to stop the solver; `nativeStopped` needs its confirmation |
| Rollback removed the records even when the process could not be shown dead | records are kept and the failure says so |
| A result with no check verdicts or no domain verdict passed and was labelled `in-domain` | both are required, else `E_OUTPUT_INCOMPLETE` |
| A reservation without a process id was returned as a running job | `E_REQUEST_CONFLICT`, retry |

Re-checked afterwards: the gap suspected here (runner dies after starting a solver but before the run is recorded) cannot occur, because the record is written before anything is launched; see Known gaps.
