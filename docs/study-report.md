# Single-case study and report workflow

The guarded CLI and MCP can now turn a terminal RAFT calculation into a saved study/report bundle. Run the registered case first, then export using its original request ID. The report is reconstructed from the durable admission decision and terminal outcome, not from client claims. This is the first single-case workflow; live append-only multi-run studies and replay remain planned. Desktop human-reviewed derivatives are described in [conclusion review](conclusion-review.md).

## Trusted human setup

Keep the existing `SEED_HOST_CONFIG`. Before running the lesson, a human supplies an external absolute `SEED_STUDY_HEADER` file conforming to the header variant of `seed.study/0.1`. It must not live inside the project and must not already have `hash` or `prev` fields. Example structure:

```json
{
  "schema": "seed.study/0.1", "type": "header", "seq": 0,
  "studyId": "lesson-1", "created": "2026-10-04T12:00:00Z",
  "projectId": "project-id-from-seed-project-manifest",
  "question": "How does power evolve in this registered synthetic RAFT case?",
  "assumptions": ["Synthetic library; limited validation coverage"],
  "parameters": [],
  "budget": {"maxWallSeconds":30,"maxCores":1,"maxMemoryMB":512,"maxDiskMB":512},
  "tier": "A1",
  "startRevisions": [{"artifact":"input-0","revision":"replace-with-the-first-input-sha256"}],
  "setBy": {"kind":"human","name":"Lesson author"}
}
```

Use the actual project/study IDs, tier, budget and parameter bounds from the host. Include one start revision for every case input hash, including library files; artifact names are stable human labels, not executable paths. Set the question and assumptions yourself. Export does not create an approval or a scientific conclusion.

## CLI and MCP

Use the existing CLI `run` request or MCP `seed_run_case`. After it completes, send `{"requestId":"original-request"}` to:

- `node dist/cli/seed.js report`, with both host-selected environment variables set; JSON goes on stdin.
- MCP `seed_export_study_report`, with `SEED_STUDY_HEADER` configured in the server environment before starting it.

The reply contains project-relative HTML and Markdown paths and an opaque reportId for the trusted receipt. No client path, actor, question, policy, output destination or approval field is accepted. Fresh `append_step` policy applies; an A0 agent needs a separately scoped grant for that operation. Configuration must still match the audited run admission. Runs from before terminal record hashes were added require a new guarded calculation. An active or abandoned engine lease blocks export. An identical run retry must match the earliest original audited record hash and state; it cannot bless an edited saved record. Valid retries retain a reference to that original outcome.

## Saved bundle

The project manifest's `studies` folder receives a new directory derived from the study and request IDs. It contains:

- `report.html`: offline HTML with inline SVG series, run IDs, normalization, existing verification flags, actors, assumptions and the report builder's educational-use statement.
- `report.md`: the same study in Markdown.
- `study.jsonl`: hash-chained human header and evidence-derived oracle, run and terminal-outcome steps. No conclusion is invented.
- `evidence.json`: saved run record, pinned oracle evidence, fresh export decision, scoped references to the verified host admission journal, stale status and copied-file hashes.
- `inputs/` and `outputs/`: byte-checked copies of the run snapshot inputs and recorded outputs, preserving custom library/material files that belong to this case.

The export verifies the admission hash chain, project/configuration scope, saved terminal record hash, oracle evidence/pins, results schema/adapter/provenance, quantity paths/hashes and RAFT series shape. A changed current model is marked STALE; it is never substituted for the original snapshot. A passed admission oracle set does not change the adapter's quantity verification labels.

Scoped journal references contain source sequence and hash identifiers, rather than unrelated projects' admission payloads or complete host configurations. Checking those references independently requires access to the original trusted host journal. This provisional local evidence is not a signed attestation.

Publication uses a temporary sibling folder followed by rename. Export never edits run files or overwrites an existing bundle. Interrupted unpublished staging folders may need trusted cleanup; directory-metadata durability remains filesystem-dependent. Reports are historical snapshots and do not automatically acquire a new STALE badge after later model edits. The bundled inputs and outputs support inspection; automatic execution replay is not implemented.

## Acceptance

Set `SEED_RAFT_REPO` to a built compatible RAFT checkout and run `npm run test:e2:raft`. This runs actual CLI/MCP calculations and report exports, validates study chains and copied-file hashes, checks escaping and STALE/UNVERIFIED labels, and refuses altered records, corrupt output and linked destinations. A shared-journal fixture verifies request-ID collisions do not select another project's evidence and unrelated configuration is not exported. Set `SEED_STUDY_DEMO_OUTPUT` to a dedicated acceptance-output directory to retain both example bundles after the temporary test project is removed.

This first report route supports completed RAFT time series. Failed/cancelled/trip states remain visible when a terminal audited run is exportable and its lease has been safely released. General recovered-run exports without an original hashed outcome, other adapters' series formats, comparison, aggregate study budgets and broader study UI remain follow-ups. Human-reviewed report derivatives use the separate [conclusion workflow](conclusion-review.md).

## Desktop lesson panel

Start SEED with the same trusted `SEED_HOST_CONFIG` and `SEED_STUDY_HEADER` environment variables. The welcome page lists registered lesson cases. **Run** uses the configured study budget and a new host-generated request ID. It retains the configured actor and approval rules; clicking a desktop button does not grant human authority. **Cancel calculation** uses fresh cancellation checks and reports acknowledgment separately from the eventual stop. **Save study report** calls the same guarded export and shows the project-relative saved location.

The renderer cannot choose configuration paths, actors, budgets, request IDs or output destinations. Companion app views have no host preload and cannot use the lesson IPC handlers. The detached calculation owner survives closing the desktop; closing SEED does not cancel it. Use the existing human CLI recovery process if the owner fails. The panel records request intent before dispatch: new desktop requests now have trusted restart status/history. Successful saves automatically open a report tab; Open report refocuses the current saved version. Running, saving or viewing accepts no scientific conclusion. Draft authoring and a separate native human review action are described in [conclusion review](conclusion-review.md).

For actual Electron-to-RAFT acceptance, set `SEED_GUI_ACCEPTANCE=1` alongside `SEED_RAFT_REPO` and run `npx vitest run tests/raft-oracles.test.ts --maxWorkers=1` after building. This clicks the real lesson run/save buttons, waits for terminal completion and asserts the report-saved state. The shell suite checks missing setup and app-tab behavior.

Report tabs check host-owned receipts and the HTML, study, evidence and Markdown hashes before opening/reloading. The receipt pins generated bytes, not project claims. Reports are served offline in a sandboxed session without scripts, host preload, network, popups or downloads. Closing a report does not stop an app or calculation. A receipt-finalization interruption can be retried through the same guarded export; a pending receipt without a published bundle requires trusted inspection. Existing bundles without receipts are not automatically imported. Viewer failures preserve the saved identity for Open report retry.

## Restart history and app boundaries

SEED restores only its own desktop-launched requests and report receipts. Each row names the adapter. Native inspection, recovery, collection and native app history remain specific to each app adapter; this does not give OpenMC or Pipe Studio RAFT recovery behavior. Report series export currently supports RAFT.

New requests record intent in protected host state before launch. Reopening the configured project reconciles the admission hash chain and original terminal record/output hashes. A fresh matching supervisor heartbeat produced after this observer started allows observation of an active host request; it is not a claim about native solver progress. No heartbeat, inconsistent evidence or an abandoned owner means inspection/recovery is required. Restart never dispatches or resumes a native job. Cancellation/export still use their original request ID and fresh host checks. Exact configuration changes disable old calculation actions; validated historical reports remain viewable.

The welcome page refreshes every two seconds while visible and offers selection plus pages of 50 entries. Intents and new report receipts are partitioned by project identity and canonical root, with a 1,000-entry history limit per partition. Trusted archival is required at capacity; history errors do not close app tabs or remove fresh cancellation of a known active request. Pre-feature desktop requests, CLI/MCP-only requests without desktop intents and legacy flat receipts are not automatically added to history. Existing flat receipts can still be opened by a known ID.

An interrupted desktop intent reservation is shown explicitly. A human host can send `{}` to the separate admin entry, `node dist/cli/admin.js release-intent-reservation` (`npm run seed:admin`), with `SEED_ADMIN_HOST_CONFIG` pointing at a host configuration whose actor is a human. The agent CLI (`dist/cli/seed.js`) has no such verb and never reads that variable. It releases only this project's reservation with a recorded, provably dead owner; it never modifies native jobs or engine leases. Live/PID-ambiguous owners, missing owner records, or interrupted maintenance require trusted inspection. There is no MCP cleanup tool and no automatic reservation recovery.

## Receipt versions

`seed.report-receipt/0.1` (the first version) binds three files of a first report: `report.html`, `study.jsonl` and `evidence.json`; the exported `report.md` was a convenience copy that no receipt protected, so it could be changed after the export without any check noticing (limit L7 of the E2 exit review). **From 2026-10-06 every new receipt is `seed.report-receipt/0.2`**, which also binds `report.md`: a first report lists exactly four files (html, study, evidence, markdown, in that order); a revised report (accepted conclusion, version 2) lists its three core files and any extra files, and `report.md` must be among them. `prepareReport` refuses to write a receipt that does not bind `report.md`. The readers (registration of a published report, the saved-report viewer) accept both versions: a 0.1 receipt keeps its three-file rule and still opens; its Markdown stays unprotected, as it always was, and a re-export writes a 0.2 receipt. The conclusion draft binds only the three core files of its source report (`sourceFiles`, as before); the receipt itself binds the Markdown.
