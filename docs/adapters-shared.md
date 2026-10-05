# Shared adapter module

Status 2026-10-05: all five adapters (RAFT, FEED, NODAL, OpenMC Studio, SNEED/PRA) run on `adapters/shared/`. Before, each adapter carried its own copy of about 800 lines of infrastructure; fixes found in review of one adapter had to be ported to the others by hand, and RAFT and FEED had fallen behind.

## What is shared

| File | Contents |
|---|---|
| `adapters/shared/util.cjs` | The typed-error constructor (bounded, control characters stripped), portable-path and containment checks (`insideRoot`, `containedBelow`, `portableRel`), the job registry (`.seed/jobs/<jobId>.json` -> run folder -> `native/job.json`), job state from the wrapper's status file, heartbeat and token (`jobState`), process helpers (`commandLine`, `killTree`, `waitDead`, `isAlive`), the ownership test (`ownsJobProcess`) and the snapshot re-hash check. |
| `adapters/shared/job.cjs` | The one job wrapper. Spec-driven: `node job.cjs <runDir> <token> <runSpec> <cancelSpec> [outcomeModule]`, a spec being `{command, args, env?, cwd?}` chosen by the adapter from host configuration. Heartbeat, `status.json`, `child.json`, `log.txt` (replaced, never written through a link), `native/out` refused when it is a link, and on any failure to report: ask the app's own cancel (`cancelSpec`) to stop the native run, kill the runner tree, leave `job-error.txt`. |
| `adapters/shared/outcome.cjs` | The default mapping of a runner's last JSON line to a final status: only `completed` with exit code 0 is a success. An adapter may name its own module (NODAL: run-folder issues and its stop-advancement trip). |
| `adapters/shared/flow.cjs` | `serve` (stdin/stdout scaffolding, one reply, verb dispatch), `startJob`, `statusJob`, `cancelJob`. |

## Rules the shared flows enforce for every adapter

- The request id is the idempotency key. It belongs to one run folder: a start for another folder is refused before anything is created there. Two simultaneous starts of one request give one job (the second waits for the first to commit); a launch that failed is rolled back, so the same request can be started again. The job record stores a hash of the snapshot inputs, settings and seed: the same request id with another payload is `E_REQUEST_CONFLICT` (the host compares its whole start request; this is the adapter's own guard for a client that reaches it directly).
- The run folder and the registry entry are reserved exclusively (`wx`) before anything starts. A failed start removes only what that call created; if it cannot show that the job is gone it keeps the records so the job can still be found and cancelled.
- Cancel kills a process only when its command line proves it is this job's: the shared wrapper script, exactly this run folder (not one that merely starts with the same text) and this job's token. When the app has a native run outside the process tree (SCRAM or OpenMC in WSL, FEED's solver), the app's own cancel stops it first, and `cancelled: true` is reported only on confirmation. A runner left behind by a dead wrapper is stopped only when the adapter's `ownsRunner` shows it is this run's; a live wrapper that does not match the job is left alone with everything under it.
- The host's launch binding (`extensions["seed.launch"]`) must match the job's run folder and process ids.

## What an adapter still owns

`describe`, `validate`, the checks of its own run request (settings, snapshot shape), the launch spec of its runner (and of its cancel verb), `stopNative` / `ownsRunner` hooks, an outcome module if the default does not fit, and `collect` (which re-hashes what the app wrote and builds the results index). A new adapter is `cli.cjs` that ends in `serve({describe, validate, run, status, cancel, collect}, "<why open is not supported>")`; see `adapters/pra/cli.cjs` for the shortest real example and `tests/fixtures/shared-adapter/` for the smallest one.

## Tests

- `tests/adapter-shared-util.test.ts`, `adapter-shared-paths.test.ts`: each helper rule on its own (ownership needs the script, the folder and the token independently; links; job states).
- `tests/adapter-shared-flow.test.ts` (12) with `tests/fixtures/shared-adapter/`: the wrapper and flows through a fake adapter with a controllable runner: outcome mapping including "completed but exit 3", the abort path (the app's cancel runs, the runner dies, the reason is left behind), log and `native/out` links, binding before creation, rollback and retry, a leftover index, the launch binding.
- The five adapters' own suites test what is theirs and still run the shared code end to end against real runners.
- Mutation checks (2026-10-05): 14 mutants of the flow and wrapper; 12 caught by the fixture tests and the adapters' suites together, five of them (binding before creation, the launch binding, the wrapper's abort, the exit-code rule, the log link) by the fixture tests alone.

## Known gaps

- A failed start removing another job's registry entry is guarded (it removes only an index it created) but only reachable in a race; there is no test.
- The branch that keeps the records when a failed launch cannot be shown to be gone (a process that refuses to die) has no test.
- A cancel that arrives before the start has recorded the wrapper's pid is refused `E_NOT_OWNED` (safe; retry).
- Windows with WSL is the tested platform; the POSIX branches (process groups) are exercised only by the Linux runs of the earlier suites.
