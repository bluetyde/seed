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

E2 is **not ready to exit**. What the milestone asked for is largely done and better evidenced than when it was written, but four items are open:

- Done since the milestone was written: the first real adapter and four more (RAFT, FEED, NODAL, OpenMC Studio, SNEED), each with app-owned oracle entries, a hash-pinned oracle set recorded with the app commit, direct-agreement tests (RAFT `raft-direct-agreement`, parity with the direct runner for the others), guarded CLI and stdio MCP, owner-mediated cancel and human recovery, and report export. The contracts were signed off final on 2026-10-05 (the TODO line that says the user has not said yes is stale).
- **Open 1, closed 2026-10-06:** "standalone launch of the app unchanged by its adapter" is now checked against the real apps: every real oracle run leaves the app's own folder as found (a fingerprint test at the end of each oracle file) and each registered app starts with its own command, without SEED variables, and answers its health path (`tests/standalone-launch.test.ts`).
- **Open 2, closed 2026-10-06:** per-adapter resource figures are measured and reported in `describe.resources` (contracts section 12.3). They are information; the host still enforces only wall time, and memory and disk stay advisory.
- **Open 3:** the concurrency limits of the run manager and project store that Codex found again (L4 to L6 below) were already known after the first review and are not yet closed.
- **Open 4:** the study record and report limits (L7 to L9), and a failed oracle evaluation having no durable transition (L1).

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
- **L4** Lock takeover by age (paused contender; foreign host after 600 s).
- **L5** Recovery can remove a live manager's reservation.
- **L6** Direct multi-process `RunManager` use: idempotency lookup order, request map, wall limit outside the payload hash.
- **L7** `report.md` is not in the receipt.
- **L8** The report builder library does not itself verify the chain length or the plotted values.
- **L9** The builder appends runs that no study step references.
- **L10** Two defensive checks in the transfer host are redundant with each other and so cannot be tested one at a time (reading a project file through a link, and writing it); a failure to release the project lock after a commit is untested (no hook).

## Sign-off (2026-10-06)

**E0 is signed off.** The user, in chat on 2026-10-06 after each limit had been explained one by one: "accept all ten, sign off E0". Limits L1 to L10 are accepted as known limits of E0; they stay listed here and in TODO.md so they are not forgotten (the strongest candidate to close first is L1, the durable oracle-failure transition; L2 is small once a reviewer record exists; L3 is E1 work). Material preservation moves to E1. A change to a contract from here is a new schema version with a migration, as for the v0.1 sign-off of 2026-10-05.

**E2 stays open** (the four open items above); the user has not decided its order yet. Suggested order, with the reasons given in chat: the standalone-launch check, the resource limits in `describe`, one concurrency task for L4 to L6, then L7.

## What I ask

- **E0:** accept L1 to L10 as known limits (or name the ones to fix first) and sign off the milestone. Contracts v0.1 are already signed off; material preservation moves to E1.
- **E2:** keep it open; the four open items above close it. Order I suggest: standalone launch check, the resource limits in `describe`, then L4 to L6 as one concurrency task (a project-wide lock design), then L7.
