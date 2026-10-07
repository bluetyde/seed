# Plan 07: Studies and reports

The study record, comparison, replay and report builder. Milestone E3. This is the harness's layer H3 and the student's "export a report".

## Study

A study is an object that points at runs. It does not replace the run graph.

Header (set by a human at creation): question, hypothesis, assumptions, allowed parameters and bounds, budget, autonomy tier, project and artifact revisions it starts from.

Steps (append-only): number, time, actor (human, or agent name, model and tool version), action, reason, inputs changed (revisions before and after), runs produced, oracle set and verdict, gate stops.

Conclusion: written last; each claim links to a run ID or an oracle verdict.

Rules:
- Earlier steps are never edited. A correction is a new step that names the one it corrects.
- An agent can append steps and draft a conclusion; a human accepts it.
- The record is the source for the report. Nothing in a report is typed freehand unless it is marked as a human note.

## Comparison

- Compare only compatible quantities: same units after conversion, same coordinate and time domain, same normalization. Otherwise refuse with the reason.
- Show normalization and uncertainty on every plot and table.
- Keep three kinds of variation apart: deterministic sensitivity, input uncertainty, and Monte Carlo sampling noise.
- Failed, cancelled, trip-terminated and stale runs appear in the table, marked, never dropped.

## Replay

Same inputs, seeds, data library, adapter and engine versions: the replay reproduces the result within the adapter's declared tolerance, or it lists each difference (version, seed, library, input hash). A replay is a new run record linked to the original. Imported runs without their inputs cannot be replayed and say so.

## Report builder

Generated from the study record and run graph.

Sections: question and hypothesis; assumptions; inputs and revisions; verification (oracle table with coverage and `unverified` flags); results with normalization and uncertainty; failures and refusals; steps and actors; conclusion; limits.

Fixed statements: educational use, not a licensing-grade analysis; which quantities were outside oracle coverage; whether any agent took part and in which steps.

Formats: HTML and Markdown first; PDF later. Each figure carries a run ID and a hash of its data. A figure with no run behind it is not generated.

## Student path

Create a project, attach a model, save a revision, import or run, compare named quantities, export a report with inputs and assumptions. The same record and builder serve a student with no agent involved; steps simply show a human actor.

## Tests

- Append-only: an attempted edit of an earlier step is refused.
- Report from a record with a failed run: the failure is listed, not omitted.
- A figure whose run was invalidated by a later revision is marked stale.
- Replay with a changed engine version lists the difference.
- Comparison refuses mismatched units, normalization and time grids.
- Report generation from a record that contains instruction-like text escapes it.

## Open

- Decided (D2): files. Append-only JSONL study record, atomic writes, optional hash chain; a database index may be added later as a rebuildable cache only. Remaining: the record schema identifier and migration policy.
- Plot library for the report and views.
- Whether a conclusion needs a second human sign-off at A2 and above.
- Study templates for teaching (a student starts from "compare two redundancy designs").

## Implementation checkpoint (2026-10-04)

The first guarded single-case RAFT report is available from CLI, MCP and the desktop welcome lesson panel. It reconstructs hash-chained steps from trusted admission evidence, copies checked input/output snapshots and preserves verification/stale labels. The desktop runs only registered cases with host-selected budget and actor, requests actual cancellation and saves an immutable report. See [workflow setup](../study-report.md).

Live multi-run append is built (2026-10-07, [study-record.md](../study-record.md)): the host keeps the hash-chained record as runs happen and agents add notes only; the report export does not read it yet. Comparison (as a function, [compare-and-cache.md](../compare-and-cache.md)) is built and not wired into the report; execution replay remains planned. Report tabs and shared desktop history/reconnect are implemented. Plan13 now implements drafts, native human decisions and accepted report derivatives; manual sign-off and corrections chained from accepted studies remain. The initial lesson panel does not meet the complete student path or E3 exit criteria.

Next implementation sequence: [report tabs](11-report-tabs.md), [lesson reconnection](12-lesson-reconnection.md), then [human conclusions](13-human-conclusions.md). Each has separate acceptance checks. Successful report saves should open in new SEED tabs.
