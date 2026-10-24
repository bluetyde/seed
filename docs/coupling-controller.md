# The coupling loop controller (first slice, pure core)

From [plan 09](plans/09-advanced-studies.md) and [coupling-prerequisites.md](coupling-prerequisites.md), sections 4.3 and 4.5. This is the part of a feedback coupling that decides when to stop, and keeps the records. It is a **pure core**: `src/core/coupling.ts`. It reads no file, uses no clock, and knows nothing about OpenMC, FEED, NODAL, gates or grants. It is tested only with **scripted fake passes** whose fixed point is known (`tests/coupling.test.ts`). It has never run with a real app.

## What it does and does not do

It does:

- call one **pass** function again and again, with the current iterate and the pass number;
- compare what the pass returns with what it was given;
- decide after each pass: stop with one state, or go on;
- keep one record per pass.

It does not:

- run an app, make a transfer, or read a file. The host will inject one function. One call of that function is one pass of the real loop: run app A with the iterate, transfer, run app B, transfer back.
- check a gate, a grant or a budget. Those belong to the host (see "What is not built").
- write anything as a result unless the loop converged.

## Terms

- **Exchanged quantity**: a number the two apps pass to each other and that must stop changing. Each has an `id`, a relative `tolerance`, and optional `floor`, `min` and `max`.
- **Iterate**: the current value of every exchanged quantity. Pass 1 starts from the **initial** iterate.
- **Calc**: what the apps compute for each quantity when they start from the iterate.
- **Residual**: `calc - iterate`, with its sign.
- **Change**: the relative size of the residual, defined below.
- **Relaxation**: a factor above 0 and at most 1 that takes only part of the step to the calc.
- **Noise**: a standard deviation per quantity that an app reports for a result it computes by Monte Carlo.

## The definition

```ts
{ exchanged: [{ id, tolerance, floor?, min?, max? }], maxPasses, relaxation, consecutive }
```

- `tolerance`: above 0 and below 1 (relative). Zero is refused.
- `floor`: the absolute scale used when a value is tiny. Default `1e-12`. Above 0.
- `min`, `max`: the physical range of the calc. A calc outside it is `diverged`. `min` must not be above `max`.
- `maxPasses`: a whole number from 1 to 25. The ceiling of 25 is hard: more is refused, whatever is typed.
- `relaxation`: above 0, at most 1. Default 1 when omitted.
- `consecutive`: a whole number of at least 2. Default 2 when omitted.
- Ids are unique. Keys not listed here are refused. `validateLoop` lists every problem it finds and returns a normalised copy with the defaults filled in.

## The two formulas

For pass k, for each quantity i:

```
change_i = |calc_i - iterate_i| / max(|calc_i|, floor_i)
next_i   = iterate_i + relaxation * (calc_i - iterate_i)
```

With relaxation 1, `next` is the calc. With relaxation 0.5 the loop takes half of each step. For a linear map `calc = a*x + b` the effective contraction becomes `1 - relaxation * (1 - a)`.

## The states

Every ended loop has exactly one state.

| State | Exact rule |
|---|---|
| `converged` | `change_i <= tolerance_i` for every quantity, on `consecutive` passes in a row. `result` is `{ iterate: the calc of the last pass, passes: number of passes }`. |
| `not-converged` | `maxPasses` passes are done and none of the other states applies. |
| `diverged` | Any calc (or next iterate) is not finite; or a calc is outside its `[min, max]`; or the **scaled residual** `R_k` grew strictly on 3 passes in a row (`R_{k-3} < R_{k-2} < R_{k-1} < R_k`; three increases need four passes). `R_k` is the largest over the quantities of `|calc_i - iterate_i| / (tolerance_i * scale_i)`. The scale is `scale_i = max(|calc_i of pass 1|, floor_i)`, fixed once at pass 1. Dividing by the tolerance makes quantities with different tolerances comparable. |
| `oscillating` | In the last 4 passes, for some quantity, the residual changes sign on every pass (none is zero), and its size on pass j is at least 0.9 times its size on pass j-2 (no decay). Checked only when the pass is not inside every tolerance. |
| `stalled` | Noise is reported, and for `consecutive` passes in a row both of these hold: every quantity has `|residual_i| <= max(tolerance_i * max(\|calc_i\|, floor_i), 2 * noise_i)`, and at least one quantity is inside the noise clause (`<= 2 * noise_i`) but not inside the tolerance. A quantity with no reported noise has noise 0. The state is `stalled`, never `converged`. |
| `engine-failure` | The pass returned `{ ok: false }`, threw, returned something that is not a pass result, left out the value of an exchanged quantity, or reported a noise that is negative or not finite. The reason is recorded (for a throw, the message). The earlier passes stay in `passes`. The failing pass has no record, because it returned nothing to record. |
| `conservation` | A pass returned `conservation: { ok: false }`. The loop stops at once, the reason is the message, and the failing pass **is** recorded. |
| `refused` | The definition is invalid, or the initial iterate lacks a quantity or holds a value that is not a finite number. No pass runs and `passes` is empty. The reason says which. |

## The order of checks

After each pass, in this order. The first that applies ends the loop.

1. engine-failure
2. conservation
3. not finite, or outside the range (`diverged`)
4. converged
5. stalled
6. diverged by growth
7. oscillating

If none applies, the next pass starts from `next`. After pass `maxPasses`, the state is `not-converged`.

The order matters. A pass that breaks conservation is `conservation` even if its change is zero. A value outside its range is `diverged` even if it did not move. Convergence is tested before the stall, so a loop that meets its tolerance is never called stalled.

## The noise floor

A Monte Carlo result cannot be more exact than its statistical error. If a person asks for a tolerance below that error, the loop can never converge. The controller says so: `stalled`. It does not say `converged`, and it does not run to the maximum. The factor 2 in the rule is two standard deviations.

The noise only excuses a failure to meet the tolerance. It never replaces the tolerance test: a loop whose changes are inside the tolerance converges, noise or not.

## Why the last iterate is never shipped

Only a `converged` outcome has a `result`. In every other state the key is absent. The passes stay in the record as evidence, but a loop that did not converge produced no answer, and its last iterate is not one. This follows the rule of the plan: a result that did not converge is never shipped as a result. The `result.iterate` of a converged loop is the **calc** of the last pass, not the relaxed `next`.

## The records

`outcome.passes` has one `PassRecord` per pass:

- `index`: starts at 1.
- `iterate`: what the pass was given.
- `calc`: what it returned, for the exchanged quantities only.
- `change`: per quantity, by the formula above.
- `relaxation`: the factor used.
- `next`: `iterate + relaxation * (calc - iterate)`. The next record's `iterate` is exactly this.
- `noise`, `conservation`: copied from the pass, when it gave them.

For a `diverged` pass caused by a value that is not finite, `change` and `next` hold that value or `NaN`; the record is kept as it is. The outcome shares no object with the inputs, with the pass function's return value, or with the object the pass function receives (it gets a fresh copy each time). The inputs are never changed.

## Choices the specification left open

- `validateLoop` fills `relaxation = 1` and `consecutive = 2` when they are omitted; `maxPasses` and `exchanged` are required.
- A value outside the range is checked on the **calc**, not on the initial iterate.
- A calc that is a number but not finite (`NaN`, infinity) is `diverged`. A calc that is missing or not a number is `engine-failure`.
- The growth rule uses the **absolute residual** on a fixed scale, not the relative change. The relative change divides by `|calc|`, and `|calc|` grows when the loop runs away, so the change levels off or even falls while the residual explodes. Example: `calc = -1.2 x + 1` from 0 has a relative change of about 1000, 6000, 1161, 3540 tolerances (no growth three times in a row) but residuals 1, 1.2, 1.44, 1.73. With the fixed scale it is `diverged` at pass 4. Convergence still uses the relative change.
- Because growth is checked before oscillation, an alternation that grows is `diverged`. An alternation of constant size (a = -1) or slow decay (a = -0.95) is `oscillating`.
- Oscillation is not checked on a pass that is inside every tolerance.
- `consecutive` larger than `maxPasses` is accepted; such a loop can only end `not-converged` or in another state.
- The stall rule counts a pass only if some quantity is inside the noise but outside the tolerance. A pass inside every tolerance restarts the count.

## What is NOT built

These wait for the decisions in [coupling-prerequisites.md](coupling-prerequisites.md), section 7:

- registration of a loop in the host configuration, and the `enable_coupling` operation with its human grant;
- the oracle gate for a coupled result, the `couplings.jsonl` journal, the study record step, and the report that refuses a coupled result without a convergence statement;
- the pass function itself: the apps' **return transfers** (FEED temperature to OpenMC, FEED heat flux to NODAL) do not exist yet, and they are the apps' to add;
- the cross-pass conservation check (the controller only stops on a result the pass reports);
- transient coupling, and acceleration schemes (Aitken, Anderson);
- where the iterates live (a revision per pass, or a scratch copy) and the budget count of the passes.
