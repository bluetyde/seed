# Plan 13: Draft and human-accepted conclusions

Status: planned. Implement after [report tabs](11-report-tabs.md) and [reconnection](12-lesson-reconnection.md). Extends [Plan 07](07-studies-and-reports.md); it does not increase physics verification coverage.

## Student behavior

A study offers **Draft conclusion**. Each claim includes plain text and citations to that study's runs or oracle verdicts. Drafts are clearly labeled; agents may propose them. A human reviews the exact claims, assumptions, citations, verification coverage and stale state in SEED, then explicitly accepts or rejects that draft. Saving a report, running a case or opening a report never accepts a conclusion.

Acceptance produces a new immutable report version in a new SEED tab. The original report remains available. Accepted means a human accepted those claims, not that SEED proved them scientifically correct.

## Implementation

1. Add a bounded, host-owned draft/review record bound to project/study ID, verified study-head hash, exact claim payload hash and cited run/oracle evidence hashes. Draft proposals cannot set an accepting actor, acceptance time or approval receipt. Validate lengths and citations against the actual study, not arbitrary project files or free-text paths.
2. Keep drafts outside the finalized `seed.study/0.1` record: the current semantic rules allow one conclusion, last. Store draft revisions and review events separately. On acceptance, produce a derived immutable study version with the existing verified prefix and one final human conclusion, plus a trusted receipt linking source head, draft hash, human review and version. Document/version the review receipt schema before implementation; do not silently reinterpret an agent conclusion as human-accepted.
3. Provide a dedicated main-process review action initiated from SEED's own UI. Resolve human identity from trusted setup and require an explicit human review confirmation of the displayed draft. Derive the accepting actor/time in the host; never accept them from renderer/MCP input or reuse the configured agent actor as a human. Agents may submit bounded drafts through a guarded proposal route, but no agent-facing acceptance tool exists.
4. Under a project lock, recheck the study head, draft/citation hashes, current-input status and policy before recording acceptance. A changed draft, citation or study requires renewed review. Show STALE and UNVERIFIED coverage prominently; require acknowledgment of those displayed limits where present, preserving their labels in the accepted report. Citation checks establish traceability, not the truth of natural-language claims.
5. Feed only the accepted finalized record to the report builder. Register the new bundle with the trusted report receipt/version mechanism from Plan 11, open it in a new tab and keep the original unmodified. Rejection leaves a review event and no accepted report. A correction creates a new derived version with lineage; it never appends a second conclusion to the old finalized record.
6. Persist review state for reconnect. Bound duplicate acceptance by draft/head identity. If acceptance is recorded but report generation/opening fails, retry that same version without a second acceptance event. Cancellation of the human review dialog leaves the draft unaccepted.

Likely files: new draft/review host module and schema, semantic/report integration, desktop review UI and narrowly scoped IPC, receipt/version support, optional guarded proposal CLI/MCP route. Keep proposals and human acceptance distinct.

## Acceptance

- A real RAFT lesson supports cited draft, rejection, explicit human acceptance and a new report tab; original bundle bytes remain identical.
- No save/run action accepts implicitly. Forged human actors, agent/MCP acceptance, malformed claims, unrelated citations and changed draft/study/evidence are refused.
- Accepted report identifies the human, exact claims and citations while preserving STALE/UNVERIFIED and assumptions. Agent involvement remains visible even when a human accepts.
- Crash/restart, cancelled review, duplicate clicks, two reviewers and report-generation failure preserve an unambiguous review/version history.
- Schema/semantic/report, guarded host and actual desktop acceptance checks pass; review the human-authority boundary before merging.

Exit: one reproducible lesson ends with an explicitly human-accepted, traceable conclusion and a versioned report. Multi-run research authoring and automatic assessment of scientific claims remain outside this slice. Follow with the E2 exit review and resolve its remaining criteria explicitly.
