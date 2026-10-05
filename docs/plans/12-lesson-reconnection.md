# Plan 12: Lesson history and reconnection after restart

Status: implemented for new SEED desktop requests (2026-10-04). Follows [report tabs](11-report-tabs.md), before human conclusion acceptance.

## Student behavior

Reopening SEED restores the lesson's known calculations and saved reports for the configured project. A calculation still owned by its detached supervisor appears as running, with **Cancel calculation** available when current policy permits. Completed calculations offer report save/open actions. An abandoned or ambiguous calculation says it needs recovery; restarting SEED never silently starts it again. Old reports open in their own tabs.

## Implementation

Ownership boundary: this plan restores SEED-launched request status and SEED report receipts only, scoped by project, adapter and configuration. Native calculation inspection, recovery/collection and native app history are adapter-specific. RAFT recovery is not reused for OpenMC, NODAL or other apps. Each adapter must declare and verify its own supported native lifecycle operations before SEED exposes them. A live SEED owner heartbeat indicates host activity, not independently verified native solver progress. This service never calls an adapter to infer or repair native state.

1. Persist a bounded desktop request-intent entry in trusted host state before launching the supervisor: generated request ID, case/project/study IDs, configuration hash and timestamp. Store no approvals in renderer storage. Use atomic writes and versioned records. Intent alone is not evidence of admission or launch.
2. Add a read-only reconciliation service. Join intents with verified, project/config-scoped admission entries, protected active/lease records and saved run records. A project-writable request map or run record alone cannot prove a calculation's ownership, completion or report eligibility. Report identities come from the trusted receipts in Plan 11.
3. Classify separately: pending admission, refused, running with confirmed owner, completed, cancelled/tripped, recovery required, and unknown/inconsistent. Bind owner observations to the protected lease token/request/configuration; PID existence alone is insufficient. Define bounded status polling and freshness/handshake evidence for a live supervisor. Ambiguity must remain visible rather than enabling takeover.
4. Reattach the desktop to status observation, never to execution replay. Reconcile terminal outcomes against their original audited record hashes and output evidence. Poll while the lesson is visible, stop unnecessary polling when closed, and prevent duplicate dispatch from reconnect actions.
5. Use original request IDs for fresh guarded cancellation and report export. Reevaluate current policy and scoped grants. Configuration changes, different projects, revoked authority or changed pins must not inherit an old action's permission. Previously saved reports remain historical views when their receipts/files validate.
6. Show a compact history list: case, time, status and report action. Distinguish missing/altered evidence from a normal unfinished calculation. Keep existing human CLI recovery explicit; automatic recovery, killing owners, resuming native jobs and replay remain outside this slice. Define retention/pagination and deterministic behavior when two desktop clients observe the same request.

Likely files: new trusted intent/reconciliation modules, `src/main/lesson.ts`, protected host status/owner support as needed, welcome/preload/types, report receipt lookup. No companion-app changes.

## Acceptance

- Actual Electron closes during a real RAFT calculation; supervisor continues; reopening observes the same request and eventual result, with no second native job or admission.
- Reopen after completion/cancellation, reopen a saved report tab, and distinguish a refused request from a pending intent.
- Crash before intent write, after intent but before admission, during launch, after outcome and during report publication produce explicit, conservative states.
- Dead/unconfirmed owner, PID reuse, corrupt/partial journal, altered run, project/config switch and grant revocation never enable an unauthorized cancel/export or automatic restart.
- Two desktops and duplicate clicks preserve one admitted job; unavailable history does not prevent normal app tabs from opening. Existing actual cancellation/recovery tests pass.

Exit: restart restores trustworthy status and report history without changing calculation ownership. Broad native recovery and editable project setup remain separate work.

Implementation checkpoint: shared desktop intent/admission/receipt reconciliation is implemented with per-project partitions, fresh host heartbeat observation, guarded cancellation/export and history pages. Native per-app recovery remains in its adapter. Interrupted intent reservations are surfaced and have a human-only metadata release path; missing ownership/maintenance evidence still requires inspection. Legacy requests without desktop intents and native app history are not imported. Actual Electron restart and RAFT acceptance is recorded in the coordination log.
