# Feedback coupling: the prerequisites (proposal, nothing built)

Status 2026-10-24. From [plan 09](plans/09-advanced-studies.md), "Feedback coupling prerequisites (write these down before any code)". This file writes them down for the first loops SEED could run, says what exists and what does not, and lists the decisions only the user can make. **No code follows from it until those are taken.** It was written from SEED's own documents and code; what an app can do is taken from its documents and marked *unknown* where I did not find it. Nothing here was run.

## 1. What a coupling is, in SEED's terms

An iteration between two apps: app A's result becomes an input of app B (a reviewed transfer, as today), B runs, B's result becomes an input of A, A runs again, until the exchanged quantities stop changing within a stated tolerance. SEED owns the loop, the exchange, the records and the stop. The apps own the physics ([D3](DECISIONS.md)): SEED does not map a heating profile onto a pin itself, the target's own `transfer` command does ([transfer-recipe.md](transfer-recipe.md)).

The plan's rules stand: coupling is a **human-approved A3 action**, a tier above A3 is not created, an agent can design and run sampling and sensitivity studies inside A1 bounds but **cannot enable a coupling loop**, and a result that did not converge is **never** shipped as a result.

## 2. What exists today, and what a loop needs that does not

| Piece | Today |
|---|---|
| One-way transfers with approval, conservation checks and provenance | Built: OpenMC heating to FEED (`heating-to-pin`), NODAL coolant bulk temperature and heat transfer coefficient to FEED (`coolant-boundary`), a depletion record's burnup to FEED. A transfer writes a **new revision of the target's input file** through the project store and invalidates what depended on the old one |
| Transfer in the other direction | **None.** FEED reports temperatures and heat flux, but no recipe takes them to OpenMC (a material temperature) or to NODAL (a heat structure's power or wall temperature). Whether Studio and NODAL declare such a transfer field in `describe.transfers` is *unknown*: their adapter documents do not mention one |
| Repeated runs under a bound | Built: sweeps and sampling studies (tier A1, `maxCases`, the one-active-case-per-engine rule) |
| A loop controller, iteration records, a convergence test | **None** |
| Revisions per iteration | A transfer makes a revision each time. A loop of 10 iterations would make 10 revisions of the target's input, each a new input for every study that cites it. This needs a decision (section 7) |

So even the smallest loop needs at least one new transfer field on an app's side (the return direction) before SEED has anything to iterate. That is the first dependency and it is not SEED's to build.

## 3. The candidate first loops

| Loop | Forward (exists) | Return (does not) | Physical reason |
|---|---|---|---|
| **Power-temperature feedback**, OpenMC and FEED | OpenMC heating to FEED pin power | FEED fuel temperature to OpenMC material temperature (or a Doppler-relevant temperature) | Fuel temperature changes cross sections and so the power |
| **Coolant feedback**, NODAL and FEED | NODAL coolant boundary to FEED | FEED surface heat flux to NODAL's heat structure | The wall heat flux changes the coolant state |
| **Triple loop**, all three | both | both | The small-core case the user named: neutronics, thermal and kinetics until they agree |

The first loop is the one whose return transfer the app side can offer soonest. That is a question for the OpenMC Studio session and for FEED, not an assumption of this file.

## 4. The six prerequisites of plan 09, for the first loop

**4.1 What is exchanged, units and normalization each way.** Per loop, fixed in the recipes (so approved by a person) and not in the loop definition: the forward quantity as today (heating, normalized to a stated total power or source rate, per the transfer rules); the return quantity with its unit, its dimension and an explicit statement of what it represents (a volume-mean fuel temperature is not the temperature a cross-section library wants; the receiving app says which it takes). Absolute quantities only on the return unless the receiving app declares otherwise.

**4.2 Synchronisation.** Steady-state loops first: each pass uses the final or the selected time of a steady result (`mapping.time.select`, already built: `last` or `at t`, refused when out of range, never extrapolated). Transient coupling with time steps exchanged inside a transient is **out of scope** until a steady loop works; the loop controller refuses a recipe whose time mapping is a series without a selection, as the transfer does. What happens on a mismatch (a result with no value at the selected time): the pass stops with the failure `engine-failure` below.

**4.3 Convergence criterion, maximum iterations and the action on non-convergence.** A person fixes before the first pass, in the registered loop: the exchanged quantities to compare between passes, a relative tolerance for each (not zero), a consecutive-passes rule (the criterion must hold twice in a row), a maximum number of passes (a hard ceiling of 25 whatever is typed) and an under-relaxation factor between 0 and 1 for the return quantity (`new = old + factor * (calculated - old)`, default 1, no acceleration scheme in the first version). If the maximum is reached without convergence the loop stops, records `not-converged` and **produces no result**: the passes stay in the record as evidence and nothing is written as a final input, an output or a report quantity. The last iterate is never shipped.

**4.4 Conservation at each exchange.** Each transfer keeps its own check (heating: the sum of the pin's bins equals the stated pin power within the recipe's tolerance, fixed before the mapping). The loop adds one check across passes: the total power given to the thermal app is the same quantity the neutronics app reports, within the same tolerance, at every pass. A pass that breaks it stops the loop with `conservation`.

**4.5 Failure taxonomy.** Every ended loop has exactly one state: `converged`; `not-converged` (maximum passes reached while still improving); `diverged` (the change between passes grew for three passes in a row, or a quantity left its physical range or the study bounds); `oscillating` (the change alternates in sign with no decay over four passes); `stalled` (the change is below the tolerance's reach but not converged, for instance a noise floor of a Monte Carlo result); `engine-failure` (a run failed, was interrupted, was refused or left out a value); `conservation` (4.4); `refused` (before any pass: the gate, the oracle sets, the pins). The Monte Carlo noise of the neutronics side sets a floor under any criterion on a quantity it computes: a tolerance below the reported statistical error cannot be met, and the loop says `stalled`, not `converged`.

**4.6 How the oracle gate applies to a coupled result.** A coupled result has **its own oracle entry set** (an entry whose input is the coupled configuration and whose expected value is a reference for the coupled quantity). Until one exists and has passed, every quantity of the loop's final state is `unverified`, whatever the single-app oracles say, and the report says so (the coverage note, [oracle-coverage.md](oracle-coverage.md), applies, and a coupled quantity is matched by name only like any other). Single-app oracle sets must have passed for every app in the loop, as for a transfer. A coupling with no reference at all is allowed to run and is reported `unverified`; it can never be called verified by the sum of its parts.

## 5. Gate, roles and records

- **Operation:** a new `enable_coupling`, rule `human`-issued **grant** (like `enable_transfer`): a grant names the actor, the loop, the exact input revisions of every app in it, an expiry, and a ceiling on passes. An agent can ask to run an approved loop and cannot approve one.
- **Registration:** like a sweep, a loop is registered by the host in the host configuration: the apps and cases, the recipes (already approved), the exchanged quantities, the tolerances, the maximum passes, the relaxation factor. The client sends a loop id and a budget, nothing else.
- **Records:** one line per pass in a `couplings.jsonl` in the state folder (the quantities exchanged, the change from the last pass, the relaxation applied, the run ids of both apps), a hash-chained journal as for transfers, and a step in the live study record per loop (and a short one per pass) citing the runs. The report builder shows the pass history and refuses a coupled result with no convergence statement.
- **Budget:** each pass is a run of each app under the study's per-case budget and counts against `maxCases` (a loop of 25 passes of two apps is 50 cases).

## 6. Tests the first build would need

A scripted fake pair of apps whose exchange has a known fixed point (so convergence, the number of passes and the answer are exact), with: convergence in a stated number of passes; a contraction slower than the maximum (`not-converged`, no result); a diverging map (`diverged`); an alternating map (`oscillating`); a noise floor above the tolerance (`stalled`); a failing engine mid-loop (`engine-failure`, the earlier passes kept as evidence); a conservation break (`conservation`); the same loop twice from the same start giving the same passes; an agent that tries to start an unapproved loop (refused, logged); relaxation factor effects on the fake map; and the report refusing a coupled result without its convergence statement. Then breakage checks as for every module.

## 7. Decisions only the user can take

1. **Which loop first.** Power-temperature (OpenMC and FEED), the coolant loop (NODAL and FEED), or the triple. The choice decides which app session has to offer a return transfer first.
2. **Where the iterates live.** Each pass writing a new revision of the target's input file (as a transfer does now) leaves a trail of revisions in the project; the alternative is a scratch copy of the inputs inside the loop's own record, and only a **converged** state is written back as one new revision (approved by a person, like a transfer). I recommend the second: it keeps the project's revision history to the states a person accepted. It needs the transfer code to be able to apply into a scratch location.
3. **Steady only first?** I recommend yes (4.2).
4. **The ceiling of 25 passes and the default relaxation of 1.** Defaults, changeable by the person who registers a loop.
5. **Who asks the apps.** The return transfer fields are the apps' to add; SEED can post the request to the OpenMC Studio, FEED and NODAL logs on the user's word.

## 8. Not covered

Transient coupling, adaptive or accelerated schemes (Aitken, Anderson), three or more apps iterated in anything but a fixed order, uncertainty propagation through a loop (a sampling study whose base case is a coupled loop), and the physical validity of any coupled result. Each is its own decision after a first loop works.
