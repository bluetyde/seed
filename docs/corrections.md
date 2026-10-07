# Corrections log

Defects in SEED that **the checks written beside the code did not catch**, each ending in the test or tool that catches it now. The idea (not the text) comes from a survey of other projects' practice: a record of what went wrong is only useful if it says why the existing checks missed it and what would have caught it. A defect found and fixed in the same sitting by the test that was written for it does not belong here; it belongs in the commit message.

`tests/corrections.test.ts` checks this file: every block has every field, the class and disposition are from the lists below, every commit named exists, and every path named in backticks exists. A claim that cannot be pointed at is not an entry.

## How to add an entry

Append a block at the end, next number, this shape:

```
### C-07 Short title
- **Date:** 2026-10-08
- **Found by:** stress run | surviving mutant | full suite | user | second-model review | own re-read
- **Class:** infrastructure | adapter-behaviour | test-gap | process | documentation
- **What was wrong:** two sentences at most.
- **Why the checks missed it:** what the existing tests assumed or could not see.
- **Catches it now:** `tests/...` or `scripts/...`, or "nothing: practice only" for a process error.
- **Disposition:** regression-test | stress-tool | oracle-bad-input | oracle-known-limit | none
- **Evidence:** commit hashes and the log or record that shows it.
```

**Disposition.** `regression-test` and `stress-tool` cover defects in SEED itself. An oracle entry needs an adapter and a quantity or a refusal, so a defect becomes `oracle-bad-input` only when an adapter **accepted input it should have refused**, and `oracle-known-limit` when it is understood and left unfixed. Under decision D3 the app session writes that entry in its own repository; this log then names the entry's id. `none` is for process and documentation errors that no test can hold.

## Entries

### C-01 Two processes inside the request-log lock; entries lost with every worker exiting 0
- **Date:** 2026-10-07
- **Found by:** stress run (four workers starting on a dead holder's lock, fourteen busy-loop processes on the machine), then traced with timestamped fs calls
- **Class:** infrastructure
- **What was wrong:** a release that failed with EPERM was retried by path after another worker had made a new lock at the same path, so the retry deleted the live lock and a second process entered. Separately, `readRequestsMap` used `existsSync`, which answers false on EPERM or EBUSY, so a log held for a moment was read as empty and overwritten.
- **Why the checks missed it:** the tests and the earlier stress test ran on a quiet machine, where the refusal never happened; the E2 record said "three processes adding 40 entries lose none", which was true only without load. The second-model review of the same code did not find it either.
- **Catches it now:** `tests/claim-safety.test.ts` (injected failures for each rule) and `scripts/stress-request-log.cjs` (run under load after any change to the claims or the project lock)
- **Disposition:** regression-test, stress-tool
- **Evidence:** 530cfce; the section "Defects found in the E2 concurrency work after the sign-off" in `docs/reviews/exit-reviews-e0-e2-2026-10-06.md` (before: 4 of 80 and 1 of 120 rounds lost entries; after: 0 of 240). Open: the project writer lock in `src/core/projectStore.ts` re-reads its token before each removal but has not been stress-traced the same way.

### C-02 Takeover guard folder threw on a Windows refusal
- **Date:** 2026-10-07
- **Found by:** full suite
- **Class:** infrastructure
- **What was wrong:** a folder another process is deleting refuses `mkdir` for a moment with EPERM; the claim folders handled it and the takeover guard folder did not, so a worker died with an exception (no data lost).
- **Why the checks missed it:** the transient refusal was handled in one place and the same call elsewhere was not searched for; the tests did not inject the refusal for the guard.
- **Catches it now:** `tests/claim-guard.test.ts`
- **Disposition:** regression-test
- **Evidence:** 9127fe2

### C-03 Cache key: a seed of 0 was not pinned apart from no seed
- **Date:** 2026-10-07
- **Found by:** surviving mutant
- **Class:** test-gap
- **What was wrong:** nothing in the tests failed when the key treated an unset seed as 0, although a run with seed 0 and a run with no seed are different experiments.
- **Why the checks missed it:** the tests covered each key component changing, not the boundary between "unset" and "zero" within one component.
- **Catches it now:** `tests/cache-key.test.ts`
- **Disposition:** regression-test
- **Evidence:** 9856b01

### C-04 Removal transaction could never validate
- **Date:** 2026-10-07
- **Found by:** surviving mutant
- **Class:** infrastructure
- **What was wrong:** the install-state schema required a target version (`to`) on every transaction, but a removal has none, so a valid removal record was refused.
- **Why the checks missed it:** the tests validated install and update records and built removal records only for the recovery function, never through the schema.
- **Catches it now:** `tests/components.test.ts`
- **Disposition:** regression-test
- **Evidence:** d15d056

### C-05 The E2 record still said "not ready to exit" after its items were closed
- **Date:** 2026-10-06
- **Found by:** user
- **Class:** documentation
- **What was wrong:** the exit-review record kept stale lines (open items already closed, a status that no longer held) beside the new ones, so it did not say what was true when the user was asked to sign off.
- **Why the checks missed it:** no check reads prose; I updated the line I was working on and not the whole section.
- **Catches it now:** nothing: practice only (when a line is pointed out as stale, fix the whole section and say what else was stale)
- **Disposition:** none
- **Evidence:** 6f4948d; the user's message of 2026-10-06 quoting the record

### C-06 A request to the app sessions to edit SEED's TODO.md
- **Date:** 2026-10-07
- **Found by:** user
- **Class:** process
- **What was wrong:** I asked the five app sessions to tick boxes in SEED's TODO.md, which is a write into another repository without the user's say-so. The boxes that mention SEED live in each app's own repository.
- **Why the checks missed it:** the coordination rules cover writing into another repo, but I did not apply them to a request to someone else.
- **Catches it now:** nothing: practice only (a request that makes another session write somewhere needs the same permission as writing there myself)
- **Disposition:** none
- **Evidence:** correction entries of 2026-10-07 07:51 in the five app logs under `messages/` (outside this repository, so not checked by the test)
