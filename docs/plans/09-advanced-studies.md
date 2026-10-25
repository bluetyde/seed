# Plan 09: Advanced studies

Sensitivity, sampling, uncertainty and feedback coupling. Milestone E5. Nothing here starts until the single-app, sweep and transfer gates (plans 04 to 08) are verified.

**Built 2026-10-24 (first slice):** the sampling study, with an in-house sampler: [sampling.md](../sampling.md). The coupling driver is not started.

## Rules that carry over

- Sweeps and samples draw parameters from each adapter's typed catalog, not from string edits.
- Deterministic sensitivity, input uncertainty and Monte Carlo sampling noise are reported separately and never summed silently.
- Every study states its sampling design, seed, count and the assumptions about input distributions.
- Budgets and bounds are enforced by the core, as for any sweep.

## Studies

| Study | Needs | Reports |
|---|---|---|
| One-at-a-time sensitivity | Sweep (plan 04) | Local slope with the step size and range used; notes where the response is non-linear |
| Sampling (for example Latin hypercube) | Distributions from the user, seeds | Output distribution, sample count, convergence; correlations with the method's limits |
| Monte Carlo noise handling | Adapters that report statistical error | Separate noise bar from input uncertainty; a rerun with another seed |
| Feedback coupling (two apps) | Verified one-way transfers both ways; a convergence criterion | Iteration history, convergence and failure criteria, conservation, synchronization |

## Feedback coupling prerequisites (write these down before any code)

**Written down 2026-10-24 for the first loops: [coupling-prerequisites.md](../coupling-prerequisites.md) (a proposal; its decisions wait for the user). The list below is the plan's own.**

- Which quantities are exchanged, units and normalization each way.
- Time or iteration synchronization and what happens on a mismatch.
- Convergence criterion, maximum iterations and the action on non-convergence (stop and record, never ship the last iterate as a result).
- Conservation checks and tolerances at each exchange.
- A failure taxonomy: diverged, oscillating, stalled, engine failure.
- How the oracle gate applies to a coupled result (oracle coverage for the coupled case is its own entry set).
- A tier above A3 is not created; coupling stays a human-approved A3 action.

## Agent role

Agents can propose sensitivity and sampling studies inside A1 bounds, and run them once a person has approved the exact proposal (D12, [sampling.md](../sampling.md)). They cannot enable a coupling loop. They must report noise and uncertainty as separate lines; the report builder rejects a result that lacks them.

## Tests

- Known linear response: sensitivity recovers the slope within the step-size error.
- A response with pure Monte Carlo noise: the noise bar is reported as noise, not as input uncertainty.
- Non-convergent coupling (scripted fake): stops, records the failure and produces no result.
- Seeds: the same seed repeats the sample; another seed gives a different sample.

## Open

- Choice of sampling library or in-house implementation (survey in TOOLING).
- Whether a surrogate model is ever allowed as a stand-in for an engine; if so it carries its own oracle coverage and an `unverified` outside its training domain.
