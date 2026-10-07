# E0 and E2 exit reviews, 2026-10-06

Written by Claude Code (the SEED agent) with a Codex review in five passes (security of the tier, approval and transfer code; specification gaps of the gate, oracle, run, project-store and study-record code against the acceptance cases). **The sign-off is the user's**: this record says what is demonstrated, what was found, what was fixed and what remains. Codex's raw findings are quoted by title below; every finding was checked against the code before it was accepted or set aside.

State at the review: SEED main after the NODAL boundary merge plus branch `claude/exit-reviews`; `npm run build` then `npx vitest run`: **49 files, 2271 tests, 0 failed** on a quiet machine. A note on method: several earlier "full suite" runs this session used `npx vitest run` without rebuilding `dist/`, and a few tests (the CLI and MCP processes) spawn `dist/`. The run above is after a fresh build; the final run before each merge from here on uses `npm test`.

## E0: contracts

Exit as written in TODO: open versus run, revisions, material preservation and status semantics documented; harness acceptance cases 1, 3, 4, 5 and 6 pass against the fake adapter (plan 05, "Acceptance tests").

| Case | What must hold | Evidence (test) | Verdict |
|---|---|---|---|
| 1 | An agent validates a bad input and gets the typed error with field and unit | `tests/fake-adapter.test.ts` "validate checks model file and reports exact codes, fields, and flags"; the schema vectors (`schema/vectors`, 1351 checks); the same through five real adapters (`tests/*-adapter.test.ts`) | **Met** |
| 2 (not in the E0 list) | Cancelled, crashed and partial attempts stay diagnostics | `tests/run-lifecycle.test.ts` 3, 4, 5, 7, 8; `tests/fake-adapter.test.ts` crash, hang, partial and NaN output, trip | **Met** |
| 3 | A wrong adapter output fails its oracle set and blocks the study; the agent cannot proceed or edit the tolerance | `tests/oracle.test.ts` (perturbed output, swapped units, dropped refusal; "a flagged change blocks run operations until a human accepts, and an agent cannot accept"; tolerance changed without a new pin does not load); `tests/policy.test.ts` "a failed oracle blocks run operations", `change_tolerance` is a human-only operation; the real oracle sets of five apps | **Met**, with the limits L1 and L2 below |
| 4 | Instruction-like text is data and starts nothing | `tests/fake-adapter.test.ts` "validate injection case returns text unchanged ... app-content"; `tests/raft-adapter.test.ts`, `tests/feed-adapter.test.ts` (the runner's text is returned as app content, never acted on); `tests/report.test.ts` 5 "Injection" | **Met** |
| 5 | An over-budget request stops at the gate and is recorded; accepting a new material property set stops for a human | `tests/policy.test.ts` "an over-budget A1 request stops, one error per field, with the limit as range" and "accept_material_set stops for a human at A2"; the decision is recorded in the run host's hash-chained admission journal (`tests/file-run-host.test.ts`); **new:** an engine-busy refusal is recorded too (`refusals.jsonl`) | **Met for budget**; **partly for material acceptance**: the gate refuses, but no host operation exists yet to accept a material set, so there is nothing to record (limit L3) |
| 6 | The second save with a stale revision is rejected and recorded | `tests/project-store.test.ts` 4 "Second writer conflict"; **new:** the rejection is appended to `.seed/conflicts.jsonl` with the expected and observed revision (same test) | **Met** (the record was missing until this review) |

Other exit items: open versus run (an adapter's `open` is optional and answered `E_VERB_UNKNOWN` by all five; `openProject` only reads), revision semantics (project store tests 4 and 13; the transfer commit rechecks every revision under the writer lock), status semantics (run lifecycle tests 1 to 10; completed means every declared output present, contained, hashed and provenanced), the typed errors, the results index, the schema identifiers and unknown-version refusal: documented in `docs/contracts.md` and exercised. **Material preservation** (the material envelope of plan 02) is not built: it belongs to E1 and the boxes stay open.

## E2: single-app runs

**State (updated 2026-10-06, late):** the four items this review found open are closed or reduced (listed below, with what is left of each). E2 is still **not declared ready to exit**: the TODO's own E2 block carries residuals that this review never weighed (see "Residuals the review has not weighed", after the list). Whether each of those blocks the exit or is accepted as a limit, and the exit itself, are the user's decisions. What the milestone asked for is largely done and better evidenced than when it was written. The four items, as they stood and how they ended:

- Done since the milestone was written: the first real adapter and four more (RAFT, FEED, NODAL, OpenMC Studio, SNEED), each with app-owned oracle entries, a hash-pinned oracle set recorded with the app commit, direct-agreement tests (RAFT `raft-direct-agreement`, parity with the direct runner for the others), guarded CLI and stdio MCP, owner-mediated cancel and human recovery, and report export. The contracts were signed off final on 2026-10-05 (the TODO line that says the user has not said yes is stale).
- **Open 1, closed 2026-10-06:** "standalone launch of the app unchanged by its adapter" is now checked against the real apps: every real oracle run leaves the app's own folder as found (a fingerprint test at the end of each oracle file) and each registered app starts with its own command, without SEED variables, and answers its health path (`tests/standalone-launch.test.ts`).
- **Open 2, closed 2026-10-06:** per-adapter resource figures are measured and reported in `describe.resources` (contracts section 12.3). They are information; the host still enforces only wall time, and memory and disk stay advisory.
- **Open 3, closed or reduced 2026-10-06:** the concurrency limits of the run manager and project store (L4 to L6 below). L5 and L6 are closed (the wall limit is now part of the request payload, at the user's instruction), L4 is reduced and its remaining window is stated; the Codex review of these changes is done and its fixes are merged ("Closed after the sign-off" and "Codex review of the E2 changes").
- **Open 4, closed 2026-10-06:** the study record and report limits L7, L8 and L9. A failed oracle evaluation having no durable transition (L1) is **not** closed: it was accepted as a known limit at the E0 sign-off and stays the first follow-up; it is listed here so it is not read as done.

### Residuals the review has not weighed

The TODO's E2 block (the items marked `[~]` or `[ ]`) names things that remain, and this review did not decide whether they block the exit. They are listed here so the decision is made on the whole picture:

1. **Raw `RunManager` is a low-level primitive** ([A3], [A5]): the guarded host and dispatcher are the safe path; direct use now has the locks above but not the policy, oracle and admission checks.
2. **Recovery gaps** ([A2], [A6]): early launch windows, recovery of failed, interrupted, trip or invalid records, broader partial-output handling, edit conflict, relocation and stale-result handling.
3. **Report workflow:** accepted-study corrections, native history and recovery that stay adapter-specific, general recovered-run export and replay (planned), and the manual human sign-off of reports.
4. **TODO boxes that look stale:** "Oracle index and runner" is still unticked although five apps have pinned oracle sets and the runner is built; four other E2 lines are `[~]`. They need reconciling against evidence, which I have not done.

For each, the choice is: it blocks the E2 exit, or it is an accepted limit for E2 (as with L1 to L10 for E0).

## What Codex found, and what was done

Pass 1, security of the tier, approval and transfer code (policy, transfer, transferHost, oracleAuthority): 5 findings, all confirmed, all fixed in this branch.

| Finding | Disposition |
|---|---|
| Linked ancestors let an agent write outside the project (recipe folder, target path) | **Fixed.** The transfers folder and every read or write of a project file must have a real location inside the project; tests with real junctions (the first versions of these tests passed vacuously because of a missing import swallowed by a catch; found by the mutation run, fixed, now skipped explicitly where links cannot be created) |
| A concurrent apply's rollback can overwrite another apply's successful commit | **Fixed.** One critical section under the project writer lock (`saveProjectHeld`); a rollback can only undo its own write; two concurrent applies: one commits, the other is refused, target and revision agree (test) |
| Source revisions can change during the mapping without invalidating the apply | **Fixed.** At the moment of the commit the whole recipe is evaluated again against fresh state (every pin, the target, the data hashes, the approval's expiry); tests: a source moved during the mapping, an approval that expires during the mapping |
| Request-supplied source pins are not bound to the source run | **Fixed.** Each pin must be one of the source run's own recorded inputs at that hash (`index.inputHashes`); a current revision that the run was not made from is refused; a run produced from a revision the project no longer has can no longer look current (tests, including a real cycle through a second run) |
| A provenance failure after the commit reports a committed transfer as failed | **Fixed.** A committed transfer is reported as such with an explicit `incomplete` list (applied record, journal, lock release) |

Pass 2, specification of the gate and oracle code against cases 3 and 5: 5 findings.

| Finding | Disposition |
|---|---|
| Oracle expectations can change during a run of the set while the file pins stay unchanged | **Fixed.** The whole set is snapshotted before any callback; test |
| Oracle failures have no durable transition that invalidates earlier passing evidence | **Not fixed (L1).** The host consumes a hash-pinned, human-approved evidence file and refuses on a changed app commit, entry or input, but a later failing evaluation of unchanged inputs is not itself persisted. Needs an evaluation journal and a re-evaluation policy: E3 |
| Engine-busy stops bypass durable auditing | **Fixed.** `refusals.jsonl` (host) and the audit callback (in-process dispatcher); test |
| Material acceptance stops have no connected record writer | **Not built (L3).** There is no host operation for accepting a material set (E1, plan 02); the gate rule exists and is tested |
| A human can accept pins that rewrite an existing oracle version | **Fixed.** `acceptPins` refuses changed content under an existing id and version (`E_ORACLE_VERSION`); a changed tolerance is a new version; test. (A durable approval record of the human's identity and reason is still missing: L2) |

Pass 3, specification of the run manager and project store: 7 findings.

| Finding | Disposition |
|---|---|
| Stale saves are rejected but never recorded | **Fixed** (case 6) |
| Output-read failures bypass durable run diagnostics | **Fixed.** An output that exists but cannot be read ends the run failed with the cause in `log/errors.json` (two new fake-adapter modes; the tests fail against the old code) |
| Age-based takeover can remove a live owner's lock (a paused contender, a foreign host after 600 s) | **Not fixed (L4).** Known since the first review; needs fencing tokens or proven owner death |
| Recovery deletes another live manager's reservation | **Not fixed (L5).** Two live managers over one project folder; the host runs one dispatcher per project and engine |
| Idempotency is checked before the reservation is held; the request map is an unlocked read-modify-write | **Not fixed (L6).** The dispatcher's project lock covers every host path; direct `RunManager` use by several processes does not |
| Changed wall limits are accepted under the same request id | **Not fixed (L6).** The wall limit is deliberately outside the payload hash (the retry joins the run that exists); a decision for the user |

Pass 4, specification of the study record and report code: 4 findings.

| Finding | Disposition |
|---|---|
| The exported Markdown is outside the receipt's integrity checks | **Not fixed (L7).** A fix needs a receipt version bump (the receipt format fixes three files); the Markdown is a convenience copy of the registered HTML and can be regenerated from the record |
| The report builder accepts truncated or hash-stripped history | **Not fixed (L8).** A library behaviour; the guarded host export checks the chain, the registered hashes and the evidence before it builds |
| Plotted values are not bound to the displayed data hash | **Not fixed (L8).** Same: the guarded export verifies the bytes first |
| Runs absent from the study still produce figures | **Not fixed (L9).** The builder appends remaining runs on purpose (documented, relied on by report tests); the host passes only the study's run |

Not reviewed in this pass: the run host, hostControl, CLI and MCP surfaces (reviewed on 2026-10-04 and 2026-10-05; nothing in them changed except the refusal record and the transfer verbs, which pass 1 covered).

## Known limits left, for you to accept or send back

- **L1** A failed oracle evaluation of unchanged inputs has no durable transition (see above).
- **L2** Accepting changed oracle pins records no approval (identity, reason).
- **L3** Material acceptance has no host operation and so no record (E1).
- **L4** Lock takeover by age (paused contender; foreign host after 600 s). **Reduced 2026-10-06**: heartbeat, and a writer that lost its lock is refused (see Closed after the sign-off).
- **L5** Recovery can remove a live manager's reservation. **Closed 2026-10-06.**
- **L6** Direct multi-process `RunManager` use: idempotency lookup order, request map, wall limit outside the payload hash. **Order and map closed 2026-10-06; the wall limit stays as it is, pending your decision.**
- **L7** `report.md` is not in the receipt. **Closed 2026-10-06** (receipt 0.2).
- **L8** The report builder library does not itself verify the chain length or the plotted values. **Closed 2026-10-06** (optional anchor and data binding, used by the guarded paths; the points' origin stays the caller's duty).
- **L9** The builder appends runs that no study step references. **Closed 2026-10-06** (refused).
- **L10** Two defensive checks in the transfer host are redundant with each other and so cannot be tested one at a time (reading a project file through a link, and writing it); a failure to release the project lock after a commit is untested (no hook).

## Sign-off (2026-10-06)

**E0 is signed off.** The user, in chat on 2026-10-06 after each limit had been explained one by one: "accept all ten, sign off E0". Limits L1 to L10 are accepted as known limits of E0; they stay listed here and in TODO.md so they are not forgotten (the strongest candidate to close first is L1, the durable oracle-failure transition; L2 is small once a reviewer record exists; L3 is E1 work). Material preservation moves to E1. A change to a contract from here is a new schema version with a migration, as for the v0.1 sign-off of 2026-10-05.

**E2 stays open** (superseded: the four items it names were closed later the same day, and the remaining decision is described in the E2 section above); the user had not decided its order yet at the time. Suggested order, with the reasons given in chat: the standalone-launch check, the resource limits in `describe`, one concurrency task for L4 to L6, then L7.

## Closed after the sign-off

**L4 to L6 (2026-10-06, E2 step 3, tests in `tests/project-store.test.ts` and `tests/concurrency.test.ts`, each fix shown to be needed by a mutation):**

- **L4, lock takeover by age.** A holder that waits asynchronously (`withProjectLockAsync`) now writes a heartbeat (`.seed/lock/beat`, every staleMs / 4, at most 30 s); a lock of another host counts as abandoned only after staleMs of silence, not after staleMs from its acquisition, so a long adapter call is no longer taken over. A writer that did lose its lock is stopped: `saveProjectHeld` looks at the lock's owner token just before it writes and refuses (`E_PROJECT_LOCKED`, "nothing was saved") when the lock is no longer this writer's or was never held. Not closed, and cannot be without operating-system locks: a holder that is silent for staleMs on another host while still alive loses its lock, and a writer that is suspended between its last look and the rename of the manifest can still replace a newer save (the revision was checked before; **this paragraph first said the revision check guards that window, which was wrong, as the Codex review below showed**). Since the review a writer that finds its lock gone right after the write is told so (`E_PROJECT_LOCKED`, "the manifest may have replaced a newer writer's save") instead of being reported as saved.
- **L5, recovery deletes a live reservation.** A request reservation now records its holder (`owner.json`: process, host, time). `recover()` removes only a reservation whose holder is dead on this host, or that has no owner and is older than 5 s; a reservation of another host is never judged abandoned there (a process id says nothing about it).
- **L6, idempotency and request map.** The request log is read again once the reservation is held, so a request that another manager finished in between is replayed (same run) instead of started twice, and a changed payload is still a conflict. Adding to the request log runs under a short lock (`requests.json.lock`: owner recorded, dead owner taken over, waits up to 10 s, then refuses), so two processes cannot overwrite each other's entries (three processes adding 40 entries each lose none).
- **L6, wall limit outside the payload hash: changed on 2026-10-06 at your instruction ("go with L8, L9 and the wall limit"; I had recommended leaving it, and read your instruction as: do it).** The wall limit is now part of the request payload, so a retry with the same request id and another limit is `E_REQUEST_CONFLICT` and starts nothing, and a retry with the same limit is replayed. Only direct use of `RunManager` can set the limit (the guarded host and dispatcher refuse a client-supplied one), so the effect is on the low-level primitive. A request recorded before this change with a limit would conflict on a retry (none exist outside tests). To revert: restore the `k !== "wallLimitMs"` test in `computePayloadHash` (src/core/runManager.ts).

**L7 (2026-10-06, E2 step 4, tests in `tests/report-receipt.test.ts` and the tamper loop of `tests/raft-oracles.test.ts`, each part shown needed by a mutation).** The report receipt is `seed.report-receipt/0.2` and binds `report.md` (a first report: exactly four files; a revised report: `report.md` among its files); `prepareReport` refuses a receipt without it; both readers accept 0.1 and 0.2, and a changed Markdown makes the saved report refuse to display. A 0.1 receipt stays valid and its Markdown stays unprotected until the report is exported again. Details: docs/study-report.md, Receipt versions.

**L8 and L9 (2026-10-06, E2 step 5, tests in `tests/report-limits.test.ts`; eight mutations of the new rules all caught).**

- **L9, unreferenced runs.** `buildReport` refuses a run that no step and no conclusion claim cites (`E_SCHEMA_INVALID`, field `/runs/<id>`, "run is not cited") instead of appending it. No earlier test depended on the appending (an earlier note of mine that report tests relied on it was wrong); a run cited only by a conclusion claim is still shown.
- **L8, truncated or stripped history.** New optional `studyAnchor {seq, hash, last?}`: when set, the study record must be hash-chained (a record whose hashes were all stripped is refused), the line at `seq` must carry `hash` (a record cut short of it is refused), and with `last` that line must be final. The conclusion-review path passes the head its draft was verified against (`sourceHead`). Without an anchor the library still accepts any self-consistent prefix or unchained record; the guarded single-case export builds its own record from the admission journal and passes no anchor.
- **L8, plotted values not bound to the data hash.** `Series.dataSha256` must equal the data hash the results index lists for that quantity (checked whenever given); new `requireBoundSeries` makes it mandatory. Both guarded paths set it, and both read the data file's bytes through a hash check before they build the series. The library still cannot check that the points really come from those bytes; that remains the caller's duty, and it is stated here rather than hidden.
- **Not covered by a unit test:** that the conclusion-review path passes the anchor (the real flow in `tests/raft-oracles.test.ts` exercises it and fails on a wrong one, but not on one that is missing).

L1 to L3 and L10 are unchanged. L4 stays reduced (see above).

## Codex review of the E2 changes (2026-10-06, after L4 to L9)

Two read-only passes over the diff of the E2 work (src/core/projectStore.ts, runManager.ts, reportReceipt.ts, report.ts, studyReportHost.ts, conclusionReview.ts, conclusionDraft.ts): security-boundary-verifier (3 findings) and specification-gap-auditor (6 findings), 9 reported, **7 distinct, all confirmed against the code and fixed or reduced** (tests in `tests/lock-review.test.ts` and `tests/concurrency-review.test.ts`; eight mutations of the fixes all caught). The receipt 0.2 parsing, the Markdown verification, the late replay, the wall-limit hashing and the report-anchor callers were inspected by the security pass with no finding.

| Finding | Disposition |
|---|---|
| The heartbeat file `.seed/lock/beat` is written with `writeFileSync`, which follows a link the project put there and overwrites a file outside the project (both passes' HIGH, security) | **Fixed.** A heartbeat is written to a new file that must not exist (`wx`) and renamed over `beat` (a rename replaces a link, it does not write through it); reading a planted `beat` can only give a wrong time. Test with a hard link (needs no privilege), fails against the old code |
| Two contenders can both judge an abandoned request-log lock dead; one removes it and takes it, the other then removes the live replacement; release deleted unconditionally (security and spec) | **Fixed.** Claims (the request-log lock and request reservations) carry a token in `owner.json`; release only removes the holder's own token; removal of an abandoned claim happens under a takeover guard and is judged again inside it. Stress test: four processes that all start by finding a dead holder's lock, four rounds, no entry lost |
| The fence used one token per project and process: an expired writer could borrow the token of a newer callback of the same process (security and spec) | **Fixed.** Each lock acquisition is an AsyncLocalStorage scope; a save asks the lock about its own callback's token. Test: A taken over, the lock freed, B takes it, A resumes and is still refused |
| Recovery kept a live reservation but still interrupted the run it protected (spec) | **Fixed.** `recover()` skips a run whose request (found through the request log) has a reservation held by a live manager |
| A start paused between making its reservation folder and writing its owner could, after recovery removed the folder and another start made it again, write its owner file into the other start's folder (spec) | **Fixed.** The owner file is written exclusively (`wx`); a start that finds the folder is not its own ends with `E_REQUEST_CONFLICT` and touches nothing; release is by token. Windows briefly refuses `mkdir` (EPERM) while another process deletes the same folder name: claims retry for a moment (found by the stress test) |
| A foreign host that crashes holding the request-log lock blocks it for ever (spec, MEDIUM) | **Fixed.** The request-log lock (milliseconds long) is taken over when its time is older than 30 s; request reservations (as long as a run) are still never judged on a process id of another host |
| The final ownership look does not fence the commit: a writer suspended between the last look and the rename can overwrite a newer save, and the record wrongly said the revision check covers that (spec) | **Reduced, and the record corrected.** No storage-level fencing is possible with files and directories. The writer now looks again right after the write and reports `E_PROJECT_LOCKED` ("may have replaced a newer writer's save") instead of success. The window itself stays and is stated as a known limit (L4) |

## What I ask

- **E0:** accept L1 to L10 as known limits (or name the ones to fix first) and sign off the milestone. Contracts v0.1 are already signed off; material preservation moves to E1.
- **E2 (updated 2026-10-06, late):** the four items are done (see the E2 section). Decide for the four residuals under "Residuals the review has not weighed" whether each blocks the exit or is an accepted limit, then sign off E2 or send items back.
