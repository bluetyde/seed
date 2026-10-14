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
- The policy is the **adapter's**, not the caller's: exact for the deterministic apps, statistical for OpenMC. Where it is stored is open (an adapter file beside `resources.json`, or a contract field); it is decided with the host verb.
- It never runs across engine versions: if the engine or adapter now installed is not the one in the original record, the replay is refused before anything runs, with the differences listed.

## Not done

- The host verb (`replay` through the gate, CLI and MCP), the study-record step, the per-adapter policy and the report section. The pure comparison above is built and tested (`tests/replay.test.ts`, 60 tests).
