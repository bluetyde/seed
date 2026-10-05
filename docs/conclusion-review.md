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

## Planned: human review receipt

Human review is not implemented yet. No CLI/MCP acceptance action exists. The desktop must display the exact draft and evidence limits before a separate explicit review confirmation. Trusted setup must supply reviewer identity independently of an agent's configured actor.

The future `seed.conclusion-review/0.1` receipt will bind project/study IDs, source report/head and draft identity/hash; host-resolved human reviewer/time; decision (`accepted` or `rejected`); displayed current input hashes, stale/verification limits and explicit acknowledgments; and, on acceptance, derived study-head/report-version identity. The protected record hash covers all fields. A project lock must revalidate those identities and current policy before recording the decision. An accepted receipt alone must never relabel unverified physics as verified.

Acceptance creates a new derived immutable study with one final human conclusion and a new report receipt/tab. The original remains unchanged. Retry after publication failure must use the same accepted version and receipt; correction starts a new derived version. Rejection produces no accepted report. This schema description is a design contract, not evidence that a review has occurred.
