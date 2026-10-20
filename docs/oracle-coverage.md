# Oracle coverage: what "verified" means

A quantity in a results index is `verified` when a passed oracle entry of its adapter names that quantity (`coverage.quantities`) and no known-limit entry failed for it. Otherwise it is `unverified`. The code is `unverifiedQuantities` in `src/core/oracle.ts`.

## The limit: matched by name only

SEED compares **names**. It does not check that the model being run resembles the case the oracle ran: its fluid, geometry, regime or any other feature. An example: a NODAL oracle entry for a light-water loop names the output `w_in`; a heavy-water model with an output named `w_in` is counted as covered although no oracle case looked at heavy water ([adapter-nodal.md](adapter-nodal.md) says the same for NODAL: "coverage is by channel name"). The same holds for every adapter.

So **verified means:** the adapter reproduced a reference for a quantity of that name. It does **not** mean that this model is inside the range the oracles checked.

## What reports say (option a, 2026-10-20)

- The badge and the label of a verified quantity read **verified (by name)**; an unverified one still reads UNVERIFIED.
- The verification section and the limits section of every report (HTML and Markdown) carry the fixed note `COVERAGE_BASIS_NOTE` (`src/core/report.ts`).
- Nothing in the data changed: `verification` is still `verified` or `unverified` in the results index, and the counts and the warning are as before. The note is wording, so it can not be lost by a producer.

## What to do as a user

Before relying on a verified quantity, read the oracle entry that covers it (the entry file names its case) and compare the case with your model. If they differ in a way that matters for that quantity, treat the quantity as unverified for your purpose and say so in the study record.

## Later (option b, decided 2026-10-20: "a now, then b later")

An oracle entry would name the model features it applies to (for example fluid, geometry class, a parameter range), and coverage would count only when the model is inside that scope. That closes the gap, but every app's oracle entries would have to be revised and their adapters would have to report the model features, so it needs the app sessions and a contract change (an additive field of the oracle entry schema). It is not started; the decision to do it is recorded in [DECISIONS.md](DECISIONS.md) (D11).
