# Conclusion drafts and review records

## Implemented: proposal contract

`draft-conclusion` accepts exactly `{ reportId, claims }` on CLI stdin, using the host-selected `SEED_HOST_CONFIG`. Each claim has exactly `text`, `runs` and `oracles`. There are 1–20 claims, at most 2000 characters per claim and at most 20 unique citations of each kind per claim. Each claim needs at least one citation. Run citations refer to the source report's run; oracle citations use the oracle-set identifier recorded in the source study. No paths, actor, time, acceptance flag or approval fields are accepted.

The host validates the protected report receipt and source bytes, the study hash chain, source admission configuration and current proposal policy. Proposals are stored outside the project, under a project/root partition, while holding the project lock. Duplicate exact proposals return the original draft identity; different claims create a new immutable draft. The partition holds at most 1000 drafts before trusted archival is required. A corrupt existing draft blocks reuse rather than replacing it.

The persisted `seed.conclusion-draft/0.1` record contains:

- `status: "draft"`, opaque `draftId` and host-generated `time`.
- Canonical project root, project/study/report IDs, exact source study `sourceHead` and the original receipt's three `sourceFiles` paths/hashes.
- Exact `configHash`, host-configured proposing `actor`, normalized `claims` and canonical `claimsHash`.
- `hash`: SHA-256 of canonical JSON of the entire record excluding `hash`.

The filename hashes the canonical proposal identity excluding generated draft ID/time/hash. Identical retries do not change provenance. Drafts do not alter the finalized study or original report, issue approval, accept a claim, or launch calculations. Citations establish traceability; they do not prove the claim. Current input staleness and scientific coverage must be rechecked and displayed when reviewing.

## Desktop authoring and human review

The Welcome lesson card offers a single-claim draft text box for the selected saved report. It automatically cites that report's run. Multiple claims and oracle citations remain available through the proposal CLI. The host-configured study actor is recorded as proposer; accepting reviewer identity is separate. Drafts can be selected in pages of ten through **Review conclusion drafts**. The native confirmation displays question, assumptions, proposer, exact claims/citations, source head, current STALE state and UNVERIFIED quantities. Cancel is the default. **Accept these claims and limits** explicitly acknowledges those displayed limits; **Reject draft** records rejection without an accepted report. No CLI/MCP acceptance action exists.

Trusted setup selects `SEED_REVIEWER_CONFIG`, an absolute regular JSON file outside the project. It has exactly this shape, with IDs matching the study/project:

```json
{"schema":"seed.reviewer/0.1","projectId":"project-id","studyId":"study-id","actor":{"kind":"human","name":"Reviewer name"}}
```

Protect this file and the other external host state using the trusted setup's filesystem permissions. Moving a file outside the project does not itself establish reviewer identity. The renderer supplies neither reviewer identity nor an acceptance decision; the main process resolves the native dialog response. The same configured agent is never promoted to a human by opening this dialog.

The implemented `seed.conclusion-review/0.1` receipt binds project/study IDs, source report/head and draft identity/hash; host-resolved human reviewer/time; decision (`accepted` or `rejected`); exact display hash and acknowledged current input hashes, stale/pin/verification limits; exact claims and proposing actor. Its hash covers the canonical record excluding `hash`. A project lock revalidates identity, evidence, current inputs and current policy before a new decision. An accepted receipt never relabels unverified physics as verified.

Acceptance creates a derived immutable study with the verified original prefix and one final human conclusion. The new report opens in its own tab; the original remains unchanged. The accepted evidence embeds the review receipt and derived head. A protected publication record links review hash to report ID and pending/published phase. A staging plan binds every copied snapshot and document hash. Partial known staging files may be rebuilt from checked source bytes; unexpected files or links refuse. The accepted report receipt covers the full bundle, including Markdown and snapshots, during registration, recovery and display.

Retry after a committed acceptance finishes that historical version without a second decision, even if current inputs changed. The accepted receipt's original limits and reviewer remain unchanged. A missing already-registered bundle must be restored as exact bytes; recovery refuses to assign a replacement ID. Published accepted reports can be reopened from their original report's draft chooser after restart. Rejection is immutable for that draft; a revision requires a new draft.

Accepted reports are v2 derivatives of the source v1 report. Revised drafts can create sibling v2 reports with separate review/draft identities. Chaining corrections from an already-finalized accepted study, broader version numbering, reviewer setup UI and cross-platform sign-off remain future work. Automated Electron acceptance supplies test responses to the native dialog; it verifies routing and refusal behavior, not a real person's scientific acceptance.
