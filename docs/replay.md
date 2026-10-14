# Replay (E3, acceptance A7)

Replay means: run a recorded case a second time and say whether the second run **reproduces** the first. It is not the same as the request replay of the run manager (the same request id returns the same outcome without running anything).

## The comparison: `src/core/replay.ts`

`compareReplay({ original, replay, policy })` is a pure function, like [the comparison](compare-and-cache.md): it reads no file and starts no run. The caller passes, for each run, the facts of its record (adapter and version, engine and version, data library, seed, inputs with their hashes, settings, lifecycle state) and its quantities with their data **already read and checked against the hash in the results index**.

**1. The two runs must have been made the same way.** Adapter id and version, engine name and version, data library id and hash, seed (a missing seed is not seed 0), every input by path and hash, and the settings (key order does not matter). Every difference is listed, one entry per field. If there is any, the verdict is **`not-comparable`** and the values are **not compared**: a replay across engine versions, or with another seed or input, is a different experiment, not a test of reproduction.

**2. The original must be something to reproduce:** completed and current. A failed, cancelled, trip-ended, interrupted or stale original gives `not-comparable` with the state named. A **replay** that did not complete **differs** (it did not reproduce).

**3. Each quantity is judged under the adapter's policy:**

| Policy | A number reproduces when | For whom |
|---|---|---|
| `exact` | it is identical, and so is its declared uncertainty | deterministic apps (RAFT, NODAL, FEED) |
| `tolerance` (`abs`, `rel`) | the difference is at most `abs + rel * max(|a|, |b|)` | deterministic apps with platform noise |
| `statistical` (`sigmas`) | the difference is at most `sigmas` combined standard deviations, `sqrt(sa² + sb²)` | Monte Carlo (OpenMC); both runs must declare an uncertainty |

Never invented: a statistical policy with a run that declares no uncertainty is `not-comparable` (`no-uncertainty`). Tables are compared cell by cell under `exact` and `tolerance`, and not at all under `statistical`. A series needs the same grid and axis. Units and normalization must match.

**Verdicts per quantity:** `reproduced` (every number identical), `reproduced-within-tolerance`, `differs`, `not-comparable` (with a code: `kind-mismatch`, `unit-mismatch`, `normalization-mismatch`, `grid-mismatch`, `shape-mismatch`, `table-unsupported`, `no-uncertainty`). **The whole replay takes the worst:** `differs`, then `not-comparable`, then `reproduced-within-tolerance`, then `reproduced`. A quantity in only one run is a difference.

Each quantity reports the largest absolute and relative difference; a statistical one also the largest difference in sigmas and where (series index). With many points and `sigmas: 3`, a few points outside are expected by chance; the policy's number is the adapter's to choose.

`replayMarkdown(result)` writes the table; text that comes from runs is escaped.

## Rules agreed for the part that is not built yet

- A replay **counts as a case**: it is a run, so it is checked by the gate like any other (budget, `maxCases` of the study, tier A1 and above), and it is a step in the study record ("replay of run X by run Y: verdict").
- It runs the **registered case of the original run** (for a sweep case, with its values); a client supplies no inputs, paths or settings. It uses the original's seed.
- The policy is the **adapter's**, not the caller's, and lives in SEED: **`adapters/<id>/replay.json`** (decided by the user, 2026-10-14, option A; no contract change). Format: `{ "schema": "seed.replay-policy/0.1", "adapter": "<id>", "policy": { ... }, "basis": "why" }`, read by `src/core/replayPolicy.ts`, which refuses a missing file (there is **no default policy**: a default would decide what "the same" means for an adapter nobody has looked at), an unknown field, another adapter's id, a bad policy or a missing reason. Shipped: RAFT, NODAL and SNEED exact; FEED a relative bound of 1e-9; OpenMC statistical at 3 sigmas. **These are SEED's judgment, not measured**: each file says so, and the first real replays should be used to check them.
- It never runs across engine versions: if the engine or adapter now installed is not the one in the original record, the replay is refused before anything runs, with the differences listed.

## The host verb: `replayFromHostFile` (`src/core/replayHost.ts`)

Client input: `{ requestId, originalRequestId, budget }` and nothing else (no case, input, path, setting or policy). `requestId` is the replay's own id (not the original's; the same id again returns the same replay run). **Nothing runs unless all of this holds**, and each refusal says why:

1. the adapter has a replay policy (`E_SETUP_REQUIRED`: there is no default);
2. the original request was admitted and its run is **proven from the audit log**: the admission and an allowing decision are in the engine's log under the *current runtime*, the run record validates and its hash is the one in the audited outcome, and the request is bound to that run (`E_NOT_FOUND`, `E_REQUEST_CONFLICT`);
3. the host configuration is **the one the original was admitted under**, except for other cases and the sweeps: the same runtime, adapter, actor, study rules, oracle evidence and the run's own case (`E_REQUEST_CONFLICT`; this is the "never across engine versions" rule, checked before anything runs);
4. the original is completed (`E_NOT_PERMITTED` otherwise) and current (`E_STALE_REVISION` if an input changed since);
5. its case is still registered, and every saved output still matches its hash.

Then the registered case is run again through **the same guarded path as any run** (`runFromHostFile`: tier, budget, pins, oracles, engine lease, audit), so a refusal there (for example `E_BUDGET_EXCEEDED`) is returned as it is. The two runs are compared with the adapter's policy. The answer holds both run ids, the policy and its stated basis, and the comparison. A replay that ends failed or cancelled is a replay that **differs**, and its run stays on record.

Each replay writes `replays.jsonl` in the host's state folder (admitted, finished with the verdict and the list of differences, or refused with the reason); the replay is also a run in the project with its own request, decision and outcome in the audit log. Two of its checks have no test that can reach them, and say so: that the original's admission had an allowing decision (a refused request never gets a run bound to it, so the bound-run check stops it first) and that the record names the original request (the audited hash of the record would already differ). Both stay as defense in depth; reaching them would need a forged entry in the hash-chained audit log. The verification of the original repeats the checks of the report export (`studyReportHost.ts`) in a smaller form; the two should be merged into one shared function when the report gets its replay section.

## The CLI verb and the MCP tool

`node dist/cli/seed.js replay` ([host-cli.md](host-cli.md)) and the MCP tool `seed_replay_run` ([mcp.md](mcp.md)) take exactly `{requestId, originalRequestId, budget}`. The CLI exits 0 when the replay reproduced the original (including within tolerance), 1 when it ran and did not, 2 when it was refused. The MCP tool answers a verdict as a result (`isError: false`) and a refusal as an error; it runs under the same detached supervisor as `seed_run_case`, and `seed_cancel_calculation` stops it by the replay's own `requestId`. The trusted environment may name another policy folder in `SEED_REPLAY_POLICY_DIR` (absolute only); tests use it for the fake adapter. Tests: `tests/replay-wiring.test.ts`.

## Not done

- The study-record step (the replay run is a step like any run, but the replay verdict is not yet written to the record) and the report section. Built: the pure comparison (`tests/replay.test.ts`, 60), the policy files (`tests/replay-policy.test.ts`, 37) and the host verb (`tests/replay-host.test.ts`, 20, with the real fake-adapter host path).
- **Counting a replay as a case:** a single run (`run_case`) is not counted against a study's `maxCases` today (only a sweep's case count is), so a replay is bounded like any run, by the per-case budget, the tier and the engine lease. A study-wide count of runs would be a new rule and is not part of this.
