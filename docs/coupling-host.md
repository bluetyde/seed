# Coupling host (slice 1 built, slice 2 not)

2026-10-25. `src/core/couplingHost.ts` runs a registered coupling loop under the gate. It sits between the pure controller ([coupling-controller.md](coupling-controller.md)) and the apps. The decisions behind it are in [coupling-prerequisites.md](coupling-prerequisites.md) section 7.

## What is built (slice 1)

- **The operation `enable_coupling`.** Rule `grant`: no tier opens it, and a human grant must name the loop's exact input revisions (the same rule as `enable_transfer`). It obeys the oracle and pin blocks of every run operation. The passes count against the study's `maxCases`: `maxPasses` times the number of apps (a loop of 10 passes of two apps is 20 cases, so the study limit must allow it).
- **The configuration `seed.coupling-host/0.1`** (`schema/coupling-host.schema.json`, written by trusted setup code with `saveCouplingHostConfig`, outside the project): the project, the state folder, the actor, the study, the grants, the apps (adapter, oracle evidence, accepted pins, as in the transfer host) and the registered loops. A loop has a `purpose` (`plumbing-test` or `physics`), a `kind` (which pass builder makes its passes), its `apps`, its `inputs` (artifact revisions), a `definition` (the controller's loop definition) and a `start` iterate.
- **The request** is `{ requestId, loopId }` and nothing else. A request id is used once.
- **The run.** Gate, then the registered pass builder, then the controller. A second request for a loop that is running is refused (`E_PROJECT_LOCKED`), not queued. Nothing is written to the project.
- **The journal** `<state>/coupling-journal/admissions.jsonl`, hash-chained like the transfer journal: `refused` (with the gate-stop), `start` (purpose, claim, inputs, definition hash, start iterate, the grant used), one `pass` row per pass as it happens (iterate, calculated values, noise, conservation, the run ids of the apps, or the failure), and `outcome` (state, reason, all pass records, the result only when converged).
- **What every reply says:** `verification: "unverified"` and a `claim`. A `plumbing-test` loop says it checks the exchange and not the physics (section 7 of the prerequisites: the first lumped loop's heating is normalized to a fixed power, so temperature does not change it).

## What is not built (slice 2 and later)

1. **Passes that run the real apps.** The builder registry `PASS_BUILDERS` is empty, so a loop whose kind has no builder is refused (`E_SETUP_REQUIRED`). The first builder, `lumped-power-temperature`, runs OpenMC with the iterate temperature, passes the heating to FEED, runs FEED and returns `temperature_fuel_mean`. Open design points: the scratch copy of the project each pass works on (decision 2); how the exchange goes through the apps' transfer commands without a per-pass human approval (the loop's registration, hashed in the journal and named by the grant, would be the approval of the mapping); pass 1, which has no FEED run yet and starts from the registered start value.
2. **A CLI verb and an MCP tool** for running a loop. They wait for a real builder, so that no verb exists that always refuses.
3. **A step in the live study record** per loop, and the report's convergence statement.
4. **Writing the converged state back** as one new revision approved by a person.
5. **The coupled oracle entry** (section 4.6): until one exists every quantity stays unverified.

## Tests

`tests/coupling-host.test.ts` (32 tests) uses scripted passes with a known fixed point (x -> 0.5 x + 500, so 1000), real project store, real oracle evidence per app and the real gate: convergence in an exact number of passes, not-converged with no result, a failing and a throwing pass, the grant cases (none, expired, another actor, other revisions, fewer inputs, revoked, another operation), changed pins, a failed oracle set, a stale project, the case limit, request shapes, a reused request id, a second request while one runs, the configuration checks. 14 breakage checks, all caught.
