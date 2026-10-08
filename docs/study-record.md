# The live study record (E3)

From [plan 07](plans/07-studies-and-reports.md). Until now a study had a record only at report export, when the steps were rebuilt from the admission log. Now the host keeps the record **while runs happen**. Code: `src/core/studyRecord.ts` (the file), `studyRecordHost.ts` (what a request becomes), `studyNoteHost.ts` (notes). Tests: `tests/study-record.test.ts` (48).

## The file

`<project>/<studies folder>/<studyId>/study.jsonl`, one JSON object per line, in the `seed.study/0.1` format the report builder already reads:

- Row 1 is the **human header** (question, hypothesis, assumptions, allowed parameters and bounds, budget, tier), exactly as the human wrote it. The host gets it from `SEED_STUDY_HEADER`, the same trusted file the report export uses, and checks it against its own study and project (study id, project id, tier, budget, parameters); a header that does not match, has a chain position of its own, is not an absolute path, or lies inside the project is refused. A record whose first row is another header is never appended to.
- Every later row is a **step**: sequence number, time, actor, action, reason, inputs changed, runs, and where it applies the oracle set or the gate stop. Rows are **hash-chained** (`prev`, `hash`), so an edited, removed or reordered row is detected. The whole file is verified (`verifyStudyLog`) before every append and again after the new rows are added, and is replaced atomically; a record that fails either check is **not repaired and not extended**.
- Appends happen under the project writer lock (the one stress-traced as C-07), so several processes append safely: four processes appending ten steps each at once leave one valid chain with 40 distinct steps.

## What the host writes

For every request the host has audited (`runFromHostFile`, so single runs and every case of a sweep):

| Situation | Steps |
|---|---|
| Admitted, a run exists | `oracle` (the pinned evidence set and verdict, written once per set), `run` (registered case, how it was admitted: tier or a named grant), and the audited terminal outcome: `cancel` if cancelled, otherwise `note` ("Audited terminal outcome: failed. No scientific conclusion has been accepted.") |
| Refused at the gate | one `gate-stop` step with the gate's rule and the reasons |
| A sweep case | the `run` step also says "Sweep t, case 2 of 3 (delayMs=20)" |
| Admitted but the start itself was refused, or the request failed before the gate | nothing; the admission log has it |

A failed, interrupted or tripped run is a step like any other: the record never leaves a failure out.

**A step is written once.** Each step carries a short marker at the end of its reason, `(ref 3fa9c1d27be04a66)`, the first 16 hex digits of the hash of its key (the request id and what it records, or the note id and its content). A replay of the same request finds its markers and writes nothing; a step's own text cannot imitate another step's marker, because the marker is always appended last by the writer.

**Every row of the record is chained** (hash and prev); a record whose rows carry none is refused, although the general log checker accepts an unchained log. A note may cite only a run of this study (its run record names the study), because the report later verifies every run the record cites. Reconciliation writes only requests audited under this study's present rules (tier, budget, parameters); the others are named in `skippedOtherPolicy` and stay in the audit log.

**The record never changes a run.** It is derived from what the host has just audited. If appending fails (a damaged record, a header that does not match, a full file) the run's outcome is unchanged, the reason goes to the host's `diagnostics.jsonl` (stage `study-record`), and the admission log still holds everything. No header configured means no record and no diagnostic: it is simply not kept.

## What an agent may add: notes

The only agent-writable thing is a note: CLI `node dist/cli/seed.js note` or MCP `seed_add_study_note`, with `{noteId, text, runs?}` (text 1 to 1500 characters, at most 20 different run ids, each a run of this project). It passes the gate as `append_step` (tier A1 or a grant), is recorded as the host's registered actor, is **data** (stored and shown, never acted on; reports escape it), and the same note id with the same content is recorded once. There is no verb to edit or delete a row; a correction is a new step.

## Not done

- ~~The report export still rebuilds its own steps~~ **Done 2026-10-08**: see [the report reads the record](#the-report-reads-the-record) below.
- ~~No reconciliation~~ **Done 2026-10-08**: see [Reconciliation](#reconciliation) below.
- **Replay** (re-running a recorded run and comparing), **feeding comparisons into the report**, and **cache reuse as a step** ("reused from run X", [compare-and-cache.md](compare-and-cache.md)) are not built.
- The oracle step is written once per evidence set (by key); a set that is replaced by another and later returns is not written a second time.
- Limits: the record is one file (8 MB); a study that outgrows it needs a new study. Deleting the *last* rows cannot be told from a shorter record by the chain alone (as with the admission log); the project folder is the trust boundary.

Mutations of this code: 33; 29 caught; 3 equivalent (a check the schema makes redundant, twice, and a branch the first branch makes unreachable); 1 untested (the length of the lock wait). `scripts/mutate-study-record.cjs`.

## The report reads the record

`exportStudyReport` ([studyReportHost.ts](../src/core/studyReportHost.ts)) now treats the live record as the study of the report. For the request it is given:

- **A record exists**: its rows go into the report unchanged (the bundle's `study.jsonl` is byte for byte the verified record), so every note and every step shows. The record must pass its chain check, its header row must be the human header the host was given, and it must cite the run of the request to be used; a broken chain or another header is a refusal (`E_NOT_PERMITTED`) and nothing is saved. A record that does not cite the run (the run happened before the host had a header) is not used: the report stays single-case, built from the audit log, and `evidence.json` records `liveRecord.citesThisRun: false`. Reconciliation of such runs into the record is not built.
- **Every run the record cites is in the report**, each proven from the audit log the way the run of the request is (a guarded admission, an allowing decision, an audited terminal outcome whose hash matches the saved run record, the oracle pins, the saved files). A cited run that cannot be proven refuses the whole report, because the report would otherwise say less than the record. A cited run must be the one bound to its own request.
- **Bundle layout**: the run of the request keeps the single-run layout (`inputs/`, `outputs/`); every other cited run is under `runs/<runId>/inputs|outputs/`. `evidence.json` gains `liveRecord` (`rows`, `head`) and `otherRuns` (request, audit references, decision, outcome, run record, stale flag).
- **No record** (the host had no header while the run happened): the report is built from the audit log as before (the three-step study of one request), and its `generatedBy` says single-case.
- A saved bundle is immutable: exporting the same request again is refused, and a note added afterwards does not change the saved report; the next export (another request) has it.

Tests: `tests/study-report-live.test.ts` (17). Mutations: `scripts/mutate-study-report.cjs`, 20; 12 caught at first and 2 more after tests were added (the stale mark, the run bound to its request); 6 left, none a gap in the new logic: the run-id pattern check (the record's schema already refuses a bad id), the request-id type check (a missing one is refused one line later), two race guards that re-read files at the end of the export, and the oracle-pin and export-gate checks carried over from the old code (the pins are also fixed by the host configuration comparison; the real-RAFT test covers the export path).

## Reconciliation

A step can be missing from the record: an append failed (the run was never touched; the failure is in the host diagnostics), or the run happened before the host had a human header. The admission log still holds everything, so a human can have the missing steps written from it.

```
SEED_ADMIN_HOST_CONFIG=<host file whose actor is a human>  SEED_STUDY_HEADER=<the human header>
echo '{"dryRun": true}' | node dist/cli/admin.js reconcile-study     # what would be written
echo '{}'              | node dist/cli/admin.js reconcile-study     # write it
```

- **Human only** (the admin CLI; the agent CLI and the MCP server have no such verb). The human header must be given and match the host, as for the live record. It refuses while a calculation holds the engine, and when the record fails its chain.
- **Only appended, once.** Existing rows are never edited or removed. The steps are built by the same function as the live append (`stepDrafts`), so a step has the same key whichever way it arrives and a step already in the record is skipped; a replayed request adds nothing; a second reconciliation finds nothing to do.
- **Marked and dated by the audit log.** Every step written starts with "Backfilled from the audit log." and carries the time of the audit row (the decision, or the outcome for the outcome step), not the time of the backfill. Its actor is the actor of the request in the log, not the human who ran the backfill. A backfilled step sits after the rows that were there, so the order of rows is the order of writing, and the times show the order of events.
- **Not written:** a request with no audited gate decision, and an allowed one with no audited outcome, are listed under `unfinished` and not written. A request of another study, or of another project in the same engine log, is not scanned. What the log does not hold is not reconstructed: a sweep's case numbers are not in the log, so a backfilled sweep case does not say which case it was.
- After a reconciliation the report export finds the earlier runs in the record, so the report is the multi-run report instead of the single-case fallback.

Tests: `tests/study-reconcile.test.ts` (21). Mutations: `scripts/mutate-study-reconcile.cjs`, 22; 20 caught, 2 equivalent (the outcome row cannot come before its decision inside one attempt; an outcome row with a run id and `ok: false` is never audited).
