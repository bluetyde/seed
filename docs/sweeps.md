# Bounded sweeps (E3, step 3)

From [plan 04](plans/04-runs-and-scheduling.md) ("Sweeps"). The user's decisions of 2026-10-07 (recommendations accepted): a generic sweep first, `maxCases` in the study budget with a small default, cases one after another, the host (not an agent) decides every value.

## What a sweep is

A sweep is **registered by the host**, in the host configuration, like a case. It names a **base case** (already registered) and 1 to 4 **axes**. An axis is a **study parameter** (a parameter the human declared, with bounds, in the study) and a list of values. Every combination of the axes' values is a case of its own, in a fixed order (the first axis changes slowest), with the id `<sweepId>-001`, `-002` and on. The cases are copies of the base case with the value written into the case's `params` (so the gate checks it against the study bounds before each case) and into its `settings` under the parameter's id (so the adapter gets it).

```json
"sweeps": { "delay": { "base": "approved", "axes": [ { "id": "delayMs", "values": [10, 20, 30] } ] } }
```

The client (an agent over MCP or the CLI) sends **only** `{requestId, sweepId, budget}`; it never sends a value, a case, an actor or a path. A sweep it names must be registered; a request with any other field is refused.

## Limits, all in the core

- **`maxCases`** in the study budget (optional, a positive integer; **default 10**). The product of the axes' value counts may not exceed it. It is checked three times: when the host configuration is saved or loaded (an invalid sweep makes the configuration invalid), when the sweep is expanded, and by the gate (`run_sweep` with `cases`), which a human request must pass as well.
- **Bounds** come from the study. A value outside its parameter's bounds does not make the configuration invalid; the gate refuses **that case** before it starts, and the sweep stops there.
- **Budget** (per case: wall time, cores, memory, disk) is checked for the sweep before the first case, and again by the run path before each case.
- **One case at a time**, through the same guarded path as a single run: policy, oracle and pin checks, the one-active-case-per-engine limit, the admission record (`request`, `decision`, `outcome` for every case).
- Tier: `run_sweep` needs A1, like `run_case`.

## Running one

`node dist/cli/seed.js sweep` with `{"requestId": "...", "sweepId": "...", "budget": {...}}` on stdin. Exit code 0 when every case ran to its end, 1 when the sweep stopped early, 2 when it was refused. The reply lists every case with its values, run id and state.

Each case's request id is `<requestId>.<caseId>` (so the sweep's request id must leave room: 64 characters in all). Asking again with the same request id **replays** the cases that finished and continues with the rest; no finished case is run twice.

The state folder gets one line per decision in `sweeps.jsonl`: `admitted` (cases, budget, how it was allowed), `refused` (why), `finished` (every case's state).

## When a sweep stops

A case that **completed**, or that **ended by a trip** (a result of the experiment), lets the next one start. Anything else stops the sweep and the cases not started stay in the table as `not-started`: a refusal by the gate (bounds, budget, oracle, pins), a run that **failed** or was **interrupted** or **cancelled**, or a host configuration that changed during the sweep. A failed run keeps the engine lease until a human has looked (its record alone cannot prove the native process stopped), so the next case would only be refused.

## Tests

`tests/sweep.test.ts` (expansion, the refusals, the gate and `maxCases`) and `tests/sweep-host.test.ts` (the fake adapter through the real host: order, records, replay, stops, what a client cannot send, the configuration checks, the CLI). Mutations: 32 of 32 caught by `scripts/mutate-sweep.cjs`, except one equivalent (the sweep is expanded twice, at load and at run, so the second error branch cannot be reached); three first survived and their tests were tightened.

## Not done

- **No MCP tool.** The CLI has `sweep`; an MCP `seed_run_sweep` needs a decision on how a long call (cases times the wall budget) is held open and cancelled. Cancelling a case works by its case request id (`seed_cancel_calculation`); there is no cancel for the whole sweep yet.
- **Settings and model parameters beyond the study's parameters.** An axis must be a study parameter. Sweeping an adapter's declared parameter that the study does not bound, or a model parameter through RAFT (the adapter applies a typed override to a copy of the input), is a contract change and comes next.
- **No study steps.** The host does not yet write one study step per case (the live study record is the next E3 item); the admission and sweep records are the evidence for now.
- **Failed cases end the sweep.** Continuing past a failed case needs a policy for the retained engine lease (a human recovery today).
- **No comparison in the sweep reply.** `compareQuantity` is not fed by the sweep; that is the host function that reads a study's runs.
