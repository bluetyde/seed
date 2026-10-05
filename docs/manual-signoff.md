# Manual human sign-off (Plan 13)

The one step no agent can do: a person reads a drafted conclusion in SEED's native review dialog and accepts or rejects it. Automated tests only supply canned dialog answers; they do not count as sign-off.

## Prepare (an agent or a person can do this)

```
npm run build
node scripts/setup-human-signoff.cjs --raft <RAFT repo> --out <new empty folder outside any project> --name "<reviewer name>"
```

It runs the 22 RAFT oracle entries through the adapter (the set must pass), then creates, outside the SEED project: a project, `host.json` (an agent actor at tier A1, one registered case `pulse-lesson`, the runtime and oracle pins), `study-header.json` (a human-set question, assumptions and budget), `reviewer.json` (`seed.reviewer/0.2`, the reviewer's name and the operating-system account allowed to use the file) and `environment.json` listing the three variables below. It never runs the lesson, drafts a conclusion or accepts anything.

## Do (the reviewer, in the desktop)

Start SEED with `SEED_HOST_CONFIG`, `SEED_STUDY_HEADER` and `SEED_REVIEWER_CONFIG` set to those files, from a normal desktop session of the account named in `reviewer.json`.

1. **Welcome > lesson card**: select `pulse-lesson` and **Run**. Wait for it to complete (a few seconds).
2. **Save study report**: a report tab opens. Read it: figures, the oracle-coverage limits, the UNVERIFIED badges.
3. **Draft**: write one claim in the draft box (the host's agent identity is recorded as proposer, not you). It automatically cites the run.
4. **Review conclusion drafts**: choose the draft. The native dialog shows the question, assumptions, proposer, the exact claim and its citations, the source head, any STALE state and the UNVERIFIED quantities. **Cancel is the default.**
5. Choose **Accept these claims and limits** or **Reject draft**. Acceptance opens the derived v2 report in its own tab; rejection records a rejection and creates no accepted report.

## What a sign-off means

It records that this person reviewed these claims, with these limits visible, at this time. It does not verify the physics: the library is synthetic, and an accepted report keeps its UNVERIFIED labels. Nothing in the setup or in SEED lets an agent or a script answer the dialog.

## Record it

The receipt is stored under the host state folder (`conclusion-reviews`, project partition). Tell the agent the outcome (accepted or rejected, and the draft id shown in the report) and it will log it in `messages/experiment-studio.md` and the TODO; it does not log a sign-off that you have not reported.
