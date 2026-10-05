# RAFT adapter (first real adapter, D5)

2026-10-03. `adapters/raft/cli.cjs` (on the shared wrapper and flows, no `job.cjs` of its own) implements the seven-verb protocol (transport: CLI per verb, [plan 03](plans/03-adapters-and-transport.md)) over RAFT's headless runner (`docs/headless.md` in the RAFT repo, in RAFT main). Tests: `tests/raft-adapter.test.ts`, `tests/raft-adapter-review.test.ts`, `tests/raft-oracles.test.ts`, `tests/fixtures/raft-stub/` (a scripted stand-in runner).

## Configuration (host environment only, never a project file or a request)

| Variable | Meaning |
|---|---|
| `SEED_RAFT_HEADLESS` | absolute path of RAFT's `web/dist-headless/raft-headless.mjs` (`npm run build:headless`); unset or not absolute or missing gives `E_SETUP_REQUIRED` |
| `SEED_RAFT_ORACLES` | optional, RAFT's `oracles/seed/entries` folder: `describe` reports the coverage claimed by its good entries |
| `SEED_RAFT_REPO` | tests only: the RAFT repo (default a sibling folder `virtual-reactor`); the real-runner tests are skipped, with a warning, when its runner is not built |

## Verbs

- `describe`: engine version from the runner, the five quantities (power W, fuelTemp K, coolantTemp K, energy J, reactivityTotal dk/k), oracle coverage when configured.
- `open`: not supported (`E_VERB_UNKNOWN`); RAFT's editor is its web app.
- `validate`: the artifact is a RAFT case file (golden-vector scenario plus library path). Problems: stale revision hash, library leaving the project, and the runner's own refusals mapped to SEED codes and labelled `app-content` (a refusal with no reason still fails).
- `run`: the snapshot holds the case and the whole library folder; `settings.case` names the case among the inputs (or the single `*case.json`). The request seed must equal the case seed. A detached job wrapper runs the headless runner; the run folder is reserved exclusively, and a failed registration stops the job.
- `status`: lifecycle from the wrapper's status file; a live process whose heartbeat carries the job's token is `running` even when the heartbeat is late.
- `cancel`: kills the job's process tree only after its command line shows it is this adapter's wrapper for that run folder; confirmed dead, then `cancelled`. RAFT's own manifest then still says `running` (an interrupted run by its rules) and nothing is collected.
- `collect`: only for a completed job whose snapshot still hashes as recorded; verifies RAFT's manifest (exactly three files, hashes), results (completed, full step coverage, finite samples), writes one JSON series per quantity and the results index (`verification: "unverified"` until the oracle gate says otherwise).

## Oracles

`scripts/gen-raft-oracles.cjs <RAFT repo>` writes `oracles/seed/` into the RAFT repo (D3: entries live with the app): 18 good entries (final power, fuel temperature and energy of each of the six golden vectors, expected values from the committed vectors) and 4 bad-input entries (outerDt 0, zero steps, future case version, no equilibrium). All 22 pass through the adapter and run manager; deliberately wrong outputs (perturbed power, swapped unit, dropped or wrong refusal) fail the set and block the gate; a changed library input makes every entry invalid before any case runs.

## Known limits

- Not covered by oracles: reactivityTotal and coolantTemp, any library other than the synthetic core, burnup, xenon and iodine.
- Windows has no job object: if the wrapper is killed from outside, the runner is stopped by `cancel` (tree kill) but not by the wrapper itself.
- A process cannot be proven to be this job's wrapper beyond its command line and the heartbeat token; the project files that name it are not trusted.

## E2 direct agreement acceptance

Run `npm run test:e2:raft` with `SEED_RAFT_REPO` pointing to a RAFT checkout containing its built headless runner and `oracles/seed`. This acceptance command fails if those prerequisites are missing; the ordinary unit suite can still skip the integration tests.

`tests/raft-direct-agreement.test.ts` copies hash-checked oracle inputs into temporary projects. It compares all samples and times of power, fuelTemp, coolantTemp, energy and reactivityTotal for the six good cases, directly versus the SEED adapter/RunManager. It checks units, direct-run replay, and the four bad-input refusal mappings. It records the RAFT commit, actual runner bundle hash and oracle file hashes. The existing oracle suite separately checks expected values and fixed tolerances for all 22 entries.

Exact agreement is scoped to the same runtime, runner bundle and synthetic library. Agreement for coolantTemp or reactivityTotal does not supply an independent physics oracle for either quantity. A checkout commit alone does not prove a prebuilt bundle matches its source; the bundle hash records the actual executable used. This is adapter/core acceptance, not the unfinished public SEED CLI/MCP path or policy-to-RunManager wiring.
