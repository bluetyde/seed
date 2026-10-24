# Sampling studies (E5, first slice)

From [plan 09](plans/09-advanced-studies.md). The user's decision of 2026-10-24: build the sampling study first, with an in-house sampler. A sampling study runs a registered case at many points drawn from distributions a person declared, and says how an output spreads over those inputs, with the sampling noise the adapter reported kept apart. It is a **sweep with drawn values**: the points become cases of their own and run through the same guarded path.

## What it is

A sampling is **registered by the host**, in the host configuration, like a sweep. The client (an agent over the CLI) sends only `{requestId, samplingId, budget}`; it never sends a value, a distribution, a seed or a count.

```json
"samplings": {
  "uq": {
    "base": "approved",
    "design": { "method": "lhs", "n": 50, "seed": 20261024 },
    "parameters": [
      { "id": "delayMs", "distribution": { "kind": "uniform", "min": 10, "max": 90 } }
    ],
    "outputs": [ { "quantity": "peak", "reduce": "max" } ]
  }
}
```

- **`base`**: a registered case. Each point is a copy of it with the sampled values in its `params` and `settings`, id `<samplingId>-001`, `-002` and on.
- **`design`**: `method` is `lhs` (Latin hypercube) or `random` (plain Monte Carlo); `n` the number of points (at least 2); `seed` a whole number from 0 to 4294967295. The same design and seed give the same points on every machine.
- **`parameters`**: study parameters (1 to 8) with human-declared bounds, each with a distribution. Only study parameters can be sampled.
- **`outputs`**: 1 to 8 quantities of the base case's runs and how a series is reduced to one number: `last`, `first`, `min`, `max` or `mean`. A scalar quantity is itself. A table cannot be sampled.

## Distributions

All are **bounded**, and the whole window must lie inside the study's bounds for that parameter, because the bounds are a gate: a point outside them would be refused when its case starts and stop the run. A configuration with a window outside the bounds cannot be saved.

| Kind | Fields |
|---|---|
| `uniform` | `min`, `max` |
| `triangular` | `min`, `mode`, `max` |
| `normal` | `mean`, `sd`, `min`, `max` (a normal cut to the window; the window must hold at least 1e-9 of it) |
| `lognormal` | `mu`, `sigma` (of ln x), `min`, `max` (0 < min; cut to the window) |

Sampled values are rounded to 12 significant digits, so they do not depend on the last bit of `Math.exp` on another JavaScript engine.

## The sampler

`src/core/sampler.ts`, in-house and without a dependency: the generator is xoshiro128** (32-bit integer operations only), seeded through a 32-bit mixer; a real number is made from two 32-bit draws and is never exactly 0 or 1. **Latin hypercube:** each dimension is cut into n strata of equal probability, one point falls in each (at a random place), and the dimensions are paired by independent random permutations. The pairing is random, so two parameters can be correlated by chance by about 1/sqrt(n); the design does not control that. The inverse normal is computed from an accurate distribution function (a series for small arguments, a continued fraction for large) with Newton steps held inside a bracket, to better than 1e-12.

## Limits, all in the core

- **`maxCases`** in the study budget bounds the number of points, like a sweep (default 10, a person raises it; never above 10000). A configuration with more points than the limit cannot be saved.
- Bounds, budget, tier A1, the one-active-case-per-engine rule and the admission record apply to **every point**, exactly as for a sweep case. The gate operation is `run_sweep`.
- Asking again with the same request id replays the points that finished and continues with the rest.
- A failed, cancelled or interrupted point stops the run, as for a sweep. The summary then covers the points that finished, and says how many of the planned points it has.

## What the summary says

After the points have run, each completed run's results are read from its saved, hash-checked files (never from the reply of the adapter). Per output the summary gives:

- **`n`, `planned`**: how many runs gave a number, out of how many points. A run that gave none is listed in `unread` with the reason.
- **`mean`, `standardError`, `min`, `max`, `quantiles`** (5, 25, 50, 75, 95 per cent, the linear "type 7" quantile).
- **`inputSpread`**: the sample standard deviation of the output over the sampled inputs. **It is the spread of what the runs gave, so it contains whatever noise each run carries.**
- **`noise`**: the sampling noise the adapter reported, as the root mean square of the per-run standard deviations over the runs that reported one (`reportedRuns` says how many did). It is `null` when the adapter reports none; **SEED never estimates it**. When the noise is more than half of the spread, the summary says that the spread then says little about the inputs.
- **`convergence`**: the mean and its standard error after a quarter, half, three quarters and all of the runs, in case order (from 8 numbers on). Use it to judge whether n is enough; the first k points of a Latin hypercube are not themselves a hypercube.
- **`correlations`**: per sampled parameter, the Pearson and Spearman correlation with the output. They show linear or monotone trends only; a constant parameter or output gives `null`.

**Noise and spread are two lines and are never added or subtracted.** For the noise of a Monte Carlo engine, rerun the same sampling with another seed (a new `samplings` entry or a new seed) and compare. The plan's other uncertainty kinds are not in this slice: a model uncertainty has no number here, and nuclear-data uncertainty needs the app (for example perturbed library variants that SEED can drive as a sampling).

## Records

`samplings.jsonl` in the host's state folder: `admitted` (cases, budget, design, parameters, outputs), `refused` (why), `finished` (every case's state), `summary` (the numbers per output). Not chained. Each sample point's step in the live study record reads "Sampling `<id>`, point `i` of `n` (`parameter=value`)".

## Running one

`node dist/cli/seed.js sample` with `{"requestId": "...", "samplingId": "...", "budget": {...}}` on stdin. Exit code 0 when every point ran to its end, 1 when the run stopped early, 2 when it was refused.

## Not done

- **No MCP tool**, for the reason sweeps have none (a long call needs a decision on holding it open and cancelling it).
- **No report table.** The summary is in the reply and the sampling log; the study report does not yet show it, and the report builder does not yet refuse a sampling result that lacks the noise line (the summary type always carries it).
- **No sensitivity indices** (Sobol, Morris) and no sampling with correlated inputs. Correlations are descriptive.
- **No surrogate model**, and no sampling of the settings an adapter takes outside the study's parameters.
- **The coupling driver** (the other E5 item) is not started; its prerequisites are in plan 09.
- **A person writes the distributions.** An agent cannot add a sampling or change a seed; nothing checks that a declared distribution is a reasonable description of a real uncertainty. That is the person's responsibility, and the summary says so in its caveats.

## Breakage checks (2026-10-24)

About seventy one-line changes to the sampler, the definition, the statistics and the host were each run against the tests. All are caught, after three first survived: a point that did not complete was skipped without a word, a quantity missing from the runs was ignored without a word, and the exit code for a stopped sampling was untested. Now every planned point either gives a number or is listed in `unread` with the reason ("the run ended terminated-by-trip, not completed", "the point did not start", "the run has no quantity X").

## Tests

`tests/sampler.test.ts` (the generator, the normal distribution against known values, the inverse distributions, the Latin hypercube property), `tests/sampling.test.ts` (the definition, what is refused, the reduction and the statistics against a known linear response and pure noise), `tests/sampling-host.test.ts` (the real host with a fake adapter whose answer is `5 + 0.1 * delayMs`), `tests/sampling-wiring.test.ts` (the CLI verb).
