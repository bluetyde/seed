# Sensitivity analysis (Sobol and Morris)

Status: the code is in `src/core/sensitivity.ts` with tests in `tests/sensitivity.test.ts`. **Nothing here is wired into the host yet.** No study, route, or screen calls it. This page says what the functions do so that the wiring can be done later without guessing.

## What the two methods answer

A sampling study (docs/sampling.md) changes many inputs at once and looks at an output. Sensitivity analysis asks: which inputs cause the spread in the output?

**Sobol indices** share the output variance among the inputs.

- The first-order index S_i is the part of the variance that input i explains alone.
- The total-order index ST_i is the part of the variance that input i takes part in, alone or together with others.
- ST_i is at least S_i. A large gap means input i works through interactions.
- The S_i add up to 1 or less. A sum well below 1 means interactions matter.

**Morris elementary effects** are a cheap screening tool. They move one input at a time by a fixed step and note how much the output changes.

- mu is the mean change. It can be negative.
- muStar is the mean of the absolute change. It does not cancel when the sign flips. Use it to rank inputs.
- sigma is the spread of the changes. A large sigma means the effect depends on where you stand: a nonlinear effect or an interaction.

Morris says which inputs matter and which do not. It does not say how much of the variance each one explains. For that, use Sobol.

## What they do not mean

- The indices describe the model **over the declared input distributions**. Change the distributions and the indices change.
- Sobol indices assume the inputs are **independent**. The sampler draws independent inputs. If real inputs are correlated, the indices do not mean what they say.
- An index is an **estimate with sampling noise**. It can come out slightly below 0 or above 1. The code does **not** clamp it. A value of -0.02 reads as "zero, within noise". Use the bootstrap interval to see the size of the noise.
- A model that is noisy (the same input gives different outputs) gets a total index near 1 for every input. The estimator cannot tell noise from interaction.
- A constant output has no variance. The indices do not exist, and the function throws. It never returns NaN.
- Morris with a few trajectories is a ranking, not a measurement.

## Everything is in the unit hypercube

The functions make and read points with values between 0 and 1. These are probabilities. The caller turns them into real parameter values with the distribution's `quantile` (from `src/core/sampler.ts`):

    value_j = quantile(distribution_j, openUnit(u_j))

`quantile` needs a probability strictly between 0 and 1. A Morris point can be exactly 0 or exactly 1. **Callers must pass each Morris value through `openUnit` before `quantile`.** `openUnit` maps exactly 0 to 1e-9 and exactly 1 to 1 - 1e-9 and leaves all other values alone. Sobol points come from the sampler's generator and are never exactly 0 or 1, so `openUnit` is harmless there.

## Sobol: the design and the order of runs

`sobolUnitDesign({ n, d, seed, method })` draws one design of n rows and 2d columns with `unitDesign` (method `lhs` or `random`). The first d columns are matrix A. The last d columns are matrix B. For each input i, matrix AB_i is A with column i replaced by column i of B.

Run count: **n * (d + 2)**. Example: n = 1000 and d = 5 gives 7000 runs.

`sobolRows(design)` lists the points to run, in this order:

1. the n rows of A,
2. the n rows of B,
3. the n rows of AB[0], then the n rows of AB[1], and so on up to AB[d-1].

The caller runs the points in this order and gives the outputs back in the same order. `sobolSplit(values, n, d)` cuts the flat list into `fA`, `fB` and `fAB` (`fAB[i][j]` is the output of row j of AB[i]). It throws if the length is not n * (d + 2).

`n` must be 8 or more. A useful n is in the thousands. See the tolerances below.

## Sobol: the formulas

`sobolIndices(fA, fB, fAB, options?)` returns, for each input, `first` and `total`, plus `mean`, `variance` and `n`.

- First order (Saltelli et al. 2010): S_i = (1/n) * sum over j of fB[j] * (fAB_i[j] - fA[j]) / Var.
- Total order (Jansen 1999): ST_i = (1/(2n)) * sum over j of (fA[j] - fAB_i[j])^2 / Var.
- Var is the sample variance, with denominator 2n - 1, of the pooled values of fA and fB. Reason: fA and fB are 2n draws from the same output distribution, so pooling gives the best single estimate of the variance that both formulas divide by.
- The pooled mean is subtracted from every value before the sums. The total-order formula uses differences and does not change. In the first-order formula, the centring removes a large part of the sampling noise.

### Bootstrap intervals

Pass `{ bootstrap: { seed, resamples = 200, level = 0.95 } }`. The code resamples the n row indexes with replacement (the same row index is used for fA, fB and every fAB), using the seeded `Rng`. It recomputes every index on each resample. It returns the percentile interval `[lo, hi]` as `firstInterval` and `totalInterval` for each input. The same seed gives the same interval. A resample whose variance is 0 is skipped and counted in `bootstrap.skipped`.

This is a percentile interval of the estimator, not a guarantee of coverage. It does not capture bias.

### Refusals

The function throws an Error with a message that names the problem when: n is below 8; there is no input (d below 1); a value is not finite; the lengths do not match; or the variance is 0.

## Morris: the design and the order of runs

`morrisUnitDesign({ r, d, levels = 4, seed })` makes r trajectories of d + 1 points (Campolongo, Cariboni and Saltelli 2007).

Run count: **r * (d + 1)**. Example: r = 20 and d = 5 gives 120 runs. `r` must be 2 or more.

- The grid has `levels` values: 0, 1/(levels-1), ..., 1. `levels` must be even.
- The step is delta = levels / (2 * (levels - 1)). For 4 levels, delta = 2/3.
- Each input moves exactly once in a trajectory, in a random order (`Rng.permutation`).
- For each input, a start node s is drawn among the grid nodes that allow a +delta step (0 up to 1 - delta). A random sign then decides whether the input starts at s and moves up, or starts at s + delta and moves down. Without this sign draw every step would be +delta, because a start limited to 0 .. 1 - delta can never move down.
- Points lie on the grid, so they can be exactly 0 or 1 (see `openUnit` above).

The result has `points` (r * (d + 1) rows, trajectory after trajectory, each trajectory in order) and `steps[t][s]`, which gives the input that moved and the signed delta of step s of trajectory t. The caller runs `points` in order and passes the outputs in the same order to `morrisEffects(outputs, design)`.

The elementary effect of a step is EE = (f(next) - f(prev)) / (signed delta), assigned to the input that moved. For each input, `morrisEffects` returns `mu` (mean of EE), `muStar` (mean of |EE|, Campolongo 2007), `sigma` (sample standard deviation of EE, denominator n - 1), `n` (the number of effects, equal to r) and the list `effects`. It throws on a wrong length or a value that is not finite.

## How the code is tested (the oracles)

The tests compare the code to analytic answers. The answers are computed in the test file from the formulas, not typed in as rounded numbers.

| Model | Inputs | Analytic answer |
| --- | --- | --- |
| Linear, y = 1 x1 + 2 x2 + 3 x3 | uniform(0, 1) | S_i = ST_i = a_i^2 / sum a_k^2. Morris: EE_i = a_i exactly, so mu = a_i, muStar = abs(a_i), sigma = 0 (tested to 1e-12). A negative coefficient gives a negative mu and a positive muStar. |
| Ishigami, y = sin x1 + a sin^2 x2 + b x3^4 sin x1, a = 7, b = 0.1 (Ishigami and Homma 1990) | uniform(-pi, pi) | V = a^2/8 + b pi^4/5 + b^2 pi^8/18 + 1/2. V1 = (1 + b pi^4/5)^2 / 2. V2 = a^2/8. V13 = 8 b^2 pi^8 / 225. S = (0.3139, 0.4424, 0). ST = (0.5576, 0.4424, 0.2437). |
| Sobol g-function, y = product of (abs(4 x_i - 2) + c_i) / (1 + c_i), c = (0, 1, 9) (Sobol 1990) | uniform(0, 1) | V_i = 1 / (3 (1 + c_i)^2). V = product of (1 + V_i) minus 1. S_i = V_i / V. ST_i = V_i * product over j not i of (1 + V_j) / V. |
| Interaction only, y = (x1 - 1/2)(x2 - 1/2) | uniform(0, 1) | S = 0 and ST = 1 for both inputs. |
| Constant output | any | The function throws (variance 0). |
| Noise that is new on every run | any | S near 0 and its interval holds 0. ST near 1 (see above). |
| Noise that is the same on every run of one row | any | S = 0 and ST = 0. |

Tolerances and what was seen:

- Ishigami and g-function, n = 16384, six seeds (11, 202, 3003, 40004, 505005, 6060606), both `lhs` and `random` (the g-function only with `lhs` in the test). The test requires the largest error over all first and total indices of a run to be below **0.04** for every seed. The seeds were fixed before the run and none was dropped.
- Largest errors seen (largest absolute error over the six indices, per seed in the order above):
  - Ishigami lhs: 0.0271, 0.0157, 0.0058, 0.0058, 0.0052, 0.0034.
  - Ishigami random: 0.0125, 0.0147, 0.0087, 0.0127, 0.0090, 0.0135.
  - g-function lhs: 0.0069, 0.0222, 0.0041, 0.0059, 0.0105, 0.0068.
  - g-function random: 0.0110, 0.0104, 0.0097, 0.0022, 0.0158, 0.0103 (measured, not part of the test).
- Linear model, n = 8192: error below 0.03. Interaction only: error below 0.05 at n = 8192, five seeds, both methods.
- The estimator checks on 8 rows by hand are exact to 1e-12.
- The bootstrap interval is tested for these properties: the same seed gives the same interval; lo is below hi; the interval holds the point estimate in at least 90 percent of 36 cases (6 seeds, 3 inputs, 2 indices, n = 1024); a wider level gives a wider interval.

## Sources

- Saltelli, A., Annoni, P., Azzini, I., Campolongo, F., Ratto, M., Tarantola, S. (2010). Variance based sensitivity analysis of model output. Design and estimator for the total sensitivity index. Computer Physics Communications 181, 259-270. (First-order estimator and the A, B, AB design.)
- Jansen, M. J. W. (1999). Analysis of variance designs for model output. Computer Physics Communications 117, 35-43. (Total-order estimator.)
- Campolongo, F., Cariboni, J., Saltelli, A. (2007). An effective screening design for sensitivity analysis of large models. Environmental Modelling and Software 22, 1509-1518. (Trajectories, muStar.)
- Morris, M. D. (1991). Factorial sampling plans for preliminary computational experiments. Technometrics 33, 161-174. (Elementary effects.)
- Ishigami, T., Homma, T. (1990). An importance quantification technique in uncertainty analysis for computer models. Proceedings of ISUMA '90, 398-403. (Test function.)
- Sobol, I. M. (1990). On sensitivity estimation for nonlinear mathematical models. Matematicheskoe Modelirovanie 2(1), 112-118. (The g-function and Sobol indices.)
