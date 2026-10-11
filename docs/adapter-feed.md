# Adapter: Fuel Performance Studio (FEED)

2026-10-05. `adapters/feed/cli.cjs` (on the shared wrapper and flows, no `job.cjs` of its own) implements the seven-verb protocol (transport: CLI per verb) over FEED's headless runner (`src/cli/headless.ts`, built to `dist/cli/headless.js` in the FEED repo, private repo `bluetyde/feed`). Modelled on [the RAFT adapter](adapter-raft.md). Tests: `tests/feed-adapter.test.ts` (scripted stand-in runner in `tests/fixtures/feed-stub/`, no solver needed), `tests/feed-oracles.test.ts` (real runner and solver, skipped without them).

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
- `collect`: re-hashes the snapshot, verifies the runner's manifest (exactly `case.json, derived.json, feed-manifest.json, results.json, run.json`, every hash, the case hash), then refuses a result that is out of domain (`E_OUT_OF_DOMAIN`: a conductivity law used outside its stated range), has a failing check other than a temperature limit check, or has a non-finite value (`E_OUTPUT_INCOMPLETE`). Otherwise it writes per-quantity data files and the `seed.results-index/0.1`.

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

All are `verification: "unverified"` until an oracle set covers them. The FEED oracle set (53 entries: 34 good, 17 bad-input, 2 known-limit, closed-form expected values, tolerances from the mesh-refinement bound fixed before any run) covers `temperature_peak`, `temperature_surface`, `heat_flux_outer` and `energy_balance_residual`; `temperature_fuel_surface`, `temperature_clad_inner` and `temperature_radial` stay unverified.

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

FEED's oracle set now has 53 entries (49 until its `claude/limit-oracles` branch added four refusal entries for the property-model limits: `E_PROP_MISSING`, `E_OUT_OF_RANGE`, `E_SCHEMA_INVALID` for a duplicate name, `E_UNITS`; the 49 earlier entries are byte-identical). The pulse entries test the adiabatic limit (the fuel interior keeps all the deposited energy, so its temperature is the root of the integral of c dT = E''') for a triangular pulse with constant heat capacity, the same pulse with a linear heat capacity, and a TRIGA-sized pulse built from UT-Austin SAR numbers, a quadratic heat capacity, plus the energy deposited, a refusal of a heat-capacity law used out of range, and bad-input entries for a time step that does not divide the run and a missing heat capacity. Since 2026-10-06 it also has: steady pins with a cubic and a tabulated fuel conductivity (closed form by bisection and exact interpolation); a pulse from a steady operating start held at power (the hottest cell stays at the closed-form steady temperature); two pulses generated by point kinetics (Nordheim-Fuchs, exact; and the $3 example with six delayed groups against an independent Python integration); and bad-input entries for `E_FIT` (conductivity and heat capacity tables), a start given two ways, and a generated pulse outside the window. Heat leaving the fuel during a long transient has no oracle entry: FEED checks it against its own independent solution.

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

## Temperature limits (2026-10-07)

A case may state limits (FEED `docs/temperature-limits.md`); FEED then reports one check per rule, `temperatureLimit1`, `temperatureLimit2`, ..., whose value is the smallest margin in kelvin (limit minus the hottest cell; negative when exceeded) and has no value when the rule's cladding condition never held. The adapter:

- **A failed limit check is a failed check on a COMPLETED run.** It does not make `collect` refuse; the run stays `completed`, the result index carries the margin, and `extensions.feed.checks` shows the verdict `fail`. (Decision taken with FEED's request; any other failed check still stops the collection.) A limit check that contradicts itself (a `fail` with a margin of zero or more, a `pass` with a negative margin, a fail with no margin, a margin that is not a number) is refused as `E_OUTPUT_INCOMPLETE`.
- **Quantity `temperature_limit_margin`** (K): the smallest margin over the rules that applied. Present only when at least one rule applied; a case without limits, or with none in force, has no such quantity. Each rule's own margin is in `extensions.feed.limits` (`id`, `verdict`, `marginK`, null when not in force) so an oracle entry can also pin a single rule from the check list.
- A margin is not an integrity assessment: FEED computes no stress, and the note on the data file says so.
- Values FEED would pin first: K-State hot element 639.4 K to the 1150 C rule; UT $4.40 pulse 325.7 K.

## Oracle count while FEED merges its limit-margin oracles (2026-10-08)

FEED main has **78 entries (52 good, 24 bad-input, 2 known-limit)** since 2026-10-10 (`972ddbf`): the 74 of 2026-10-08 (`6165412`: the 72 before it plus two that pin `temperature_limit_margin`) plus four from General Atomic report GA-7882, Table VII, the first with source kind `published` (two pulse cases, each pinning `energy_deposited` and `temperature_peak_max`; the expected values are the report's printed numbers, with tolerances of 0.5 % fixed first). `tests/feed-oracles.test.ts` accepts exactly this set, so a silent addition or removal fails it, and the adapter's oracle coverage lists `temperature_limit_margin`. Run against a FEED checkout at main (`SEED_FEED_REPO`, `npm run build`), the whole 78-entry set passes through the adapter with the real solver.

The test helper `tests/helpers/oracleRequest.ts` makes the request id of an oracle run: `req-<oracleId>`, or a hash of it when that would pass the 64-character id limit (one new FEED entry id is 62 characters). It is used by the FEED, NODAL, OpenMC, SNEED and RAFT oracle tests.

## Thermo-elastic results (mechanics), 2026-10-10

FEED's plan 09 (mechanics, M0 to M6) adds a `mechanics` record to `results.json` for a case with `assumptions.thermalOnly: false`: small strain, linear elastic, one radial slice, with the contact at the gap. The adapter reads it when it is there and refuses a malformed one; the request is FEED's `docs/seed-mechanics-request.md`.

| Quantity | Unit | Read from |
|---|---|---|
| `displacement_radial_fuel_last_cell` | m | `mechanics.points[fuelCells - 1].ur` |
| `displacement_radial_clad_last_cell` | m | `mechanics.points[last].ur` |
| `stress_axial_fuel_min` | Pa | `mechanics.summary.fuel.axial[0]` (tension positive) |
| `stress_hoop_clad_first_cell` | Pa | `mechanics.points[fuelCells].sigmaTheta` |
| `contact_pressure` | Pa | `mechanics.summary.contactPressure` (0 when the gap is open) |
| `gas_pressure` | Pa | `mechanics.internalPressure` |
| `stress_limit_margin` | Pa | the smallest `value` of the checks `stressLimit:<name>` that gave one (strength minus von Mises; negative when exceeded) |

All are cell-centre values of the case's own mesh (FEED's mechanics entries use 20 fuel and 8 cladding cells). `fuelCells` and `claddingCells` come from `derived.json`; the points must be exactly that many cells, each with finite `ur` and `sigmaTheta`.

- **A failed stress limit is a failed check on a completed run**, as for the temperature limits: the run is kept, the margin goes out as `stress_limit_margin`, and every limit is listed in `extensions.feed.stressLimits` (`id`, `verdict`, `marginPa`). A limit also fails when cells lie outside the strength table (nothing is extrapolated), with the margin of the cells that could be judged or none. Incoherent limits are refused: a pass with a negative margin, a margin that is not a number. A stress limit without a mechanics result is refused.
- **Every other failed check still refuses collection** (`mechanicsDisplacement`, `mechanicsStress`, `mechanicsEquilibrium`, `mechanicsContact`, `mechanicsFields`, and the thermal ones). A transient result with mechanics is refused (not supported).
- **What the result is:** `extensions.feed.thermalOnly` carries FEED's own thermo-elastic statement unchanged (it must start `Thermo-elastic result:`) and `extensions.feed.thermoElastic` is `true`; a thermal-only result keeps the thermal statement. Neither says that anything fails or holds: a stress is compared with a strength only when a limit is stated.
- **The mechanics oracle entries** (FEED branch `claude/mechanics-m6`, 92 entries: 59 good, 30 bad-input, 3 known-limit) expect closed forms computed in FEED's generator with no FEED code. One of them is a **known-limit with a number**: a closing gap with a fuel a quarter as stiff as its cladding, where FEED's penalty contact is known to be 2.7 to 3.1 % low and the entry's tolerance of 2 % is below that on purpose. It is expected to miss. Under contract v0.1.2 ([contracts.md](contracts.md) section 12 item 9) this is a failed known-limit entry: the set still passes, and **`contact_pressure` is unverified in every report** (the user's decision, 2026-10-10), also for cases where the contact is right.

