# Coupling host (slices 1 and 2 built)

2026-10-25. `src/core/couplingHost.ts` runs a registered coupling loop under the gate. It sits between the pure controller ([coupling-controller.md](coupling-controller.md)) and the apps. The decisions behind it are in [coupling-prerequisites.md](coupling-prerequisites.md) section 7.

## What is built (slice 1)

- **The operation `enable_coupling`.** Rule `grant`: no tier opens it, and a human grant must name the loop's exact input revisions and its **registration pin** (`couplingRegistrationPin`: an id `coupling:<loopId>` and the hash of the whole registration, with its pass ceiling and options), so a grant for one loop does not open another and an edited registration needs a new grant. A host whose actor is a human is the person acting and needs none (the gate has always worked so). It obeys the oracle and pin blocks of every run operation. The passes count against the study's `maxCases`: `maxPasses` times the number of apps (a loop of 10 passes of two apps is 20 cases, so the study limit must allow it).
- **The configuration `seed.coupling-host/0.1`** (`schema/coupling-host.schema.json`, written by trusted setup code with `saveCouplingHostConfig`, outside the project): the project, the state folder, the actor, the study, the grants, the apps (adapter, oracle evidence, accepted pins, as in the transfer host) and the registered loops. A loop has a `purpose` (`plumbing-test` or `physics`), a `kind` (which pass builder makes its passes), its `apps`, its `inputs` (the artifact revisions of each app, at least one each), a `definition` (the controller's loop definition) and a `start` iterate.
- **The request** is `{ requestId, loopId }` and nothing else. A request id is used once.
- **The run.** Gate, then the registered pass builder, then the controller. One state-wide lock covers the journal and the run, so a second request while a loop runs, for that loop or another, is refused (`E_PROJECT_LOCKED`), not queued. The host file, the inputs (manifest and file bytes), the oracle sets and the pins are checked before the start and again before every pass, so a revoked grant or an edited project stops a running loop before its next pass. Nothing is written to the project.
- **The journal** `<state>/coupling-journal/admissions.jsonl`, hash-chained like the transfer journal: `refused` (with the gate-stop), `start` (purpose, claim, inputs, definition hash, start iterate, the grant used), one `pass` row per pass as it happens (iterate, calculated values, noise, conservation, the run ids of the apps, or the failure), and `outcome` (state, reason, all pass records, the result only when converged).
- **What every reply says:** `verification: "unverified"` and a `claim`. A `plumbing-test` loop says it checks the exchange and not the physics (section 7 of the prerequisites: the first lumped loop's heating is normalized to a fixed power, so temperature does not change it).

## The passes of the lumped loop (slice 2, built 2026-10-25)

`src/core/couplingLumped.ts`, kind `lumped-power-temperature`: the first loop, OpenMC Studio and FEED. One pass, from the iterate T (the volume-mean fuel temperature, K):

1. **T into the OpenMC project.** A scratch copy of the project gets T as the temperature of the fuel material, by Studio's own transfer command (`fuel-temperature`; `adapters/openmc/transfer.cjs` is the wrapper the host calls, it runs `headless transfer` in WSL on Windows).
2. **OpenMC runs.** Studio's generator makes `model.py` of that project (`adapters/openmc/lib.cjs`, the same code the adapter uses), and the OpenMC adapter runs the eigenvalue case through the run manager. The run's k-eff and its standard deviation are kept in the pass record (`info`), not converged on.
3. **Heating into the FEED case.** The heating mesh of that run becomes the heat rate of a scratch copy of the FEED case, by FEED's transfer command (`heating-to-pin`), normalized to the total power the loop registers (`total-power`, one pin column, the slices and `applyTo` of the registration).
4. **FEED runs.** The FEED adapter runs the case; its `temperature_fuel_mean` is the pass's answer.

**What a registration says** (`options`, part of the registration pin, so the grant covers exactly it): the OpenMC app, artifact, fuel material and the name of the heating mesh quantity (`"<tally>:heating"`); the FEED app, artifact, the pin label, frame, slices (metres), `applyTo`, bin count and the pin's total power in watts. Each app of the configuration also needs a `runner` (its adapter's command line) and a `transfer` command; a loop whose apps lack them is refused before pass 1, naming the field.

**What the recipes are.** The two recipes of a pass are built by this module from the registration; a person does not approve them one by one. The registration is hashed into the grant's pin, and the journal records it, which is what the earlier decision (section 7 of the prerequisites) meant by the loop being the approval of the mapping. The apps check their own side: Studio refuses a temperature outside what its data supports (250 to 2500 K), FEED refuses a heating it cannot map or that does not conserve the power.

**Where files go.** Every copy lives under `<state>/coupling-scratch/<id>/pass-NNN/{openmc,feed}/`. Nothing is written to the project. The scratch folders are kept as evidence of the passes (a pass record names the run ids, and the runs are in them); removing old ones is a person's job for now.

**What it proves.** The pin power is fixed, so FEED's temperature does not depend on what OpenMC was given: the loop converges in three passes (the first moves from the start value to FEED's answer, the next two repeat it). It proves the exchange, the scratch iterates, the gate and the records, not a physical coupling; every record says so. With the real apps on this machine: 90 seconds for three passes, `temperature_fuel_mean` 1039.29 K, k-eff 1.344 +/- 0.006 at 900 K and 1.347 +/- 0.006 at 1039 K (the difference is inside the noise).

**How an agent starts one.** The CLI verb `couple` and the MCP tool `seed_run_coupling` ([host-cli.md](host-cli.md), [mcp.md](mcp.md)); both need `SEED_COUPLING_HOST_CONFIG` and a grant.

## What is not built

1. **A step in the live study record** per loop, and the report's convergence statement.
2. **Writing the converged state back** as one new revision approved by a person.
3. **The coupled oracle entry** (section 4.6): until one exists every quantity stays unverified.
4. **The run host's engine lease.** The coupling host serializes loops under its own lock; a run through `run` on the same engine at the same moment is not excluded by it.
5. **Removing old scratch folders.**

## Tests

- `tests/coupling-host.test.ts` (41 tests): the host with scripted passes whose fixed point is known (x -> 0.5 x + 500): convergence, not-converged with no result, failing and throwing passes, every grant case, the registration pin, per-app inputs, file bytes, re-checks before every pass (a revoked grant, an edited registration, a changed file, a file changed by the builder), the state-wide lock, request shapes, the configuration checks.
- `tests/coupling-lumped.test.ts` (28): the passes with fake apps: the order of the steps, the two recipes as sent, the scratch layout, nine ways of failing, the options checks.
- `tests/coupling-lumped-real.test.ts` (1, skipped when the runtimes are missing): the loop with real OpenMC Studio and real FEED, 90 seconds.
- `tests/coupling-wiring.test.ts` (10): the CLI verb and the MCP tool.
