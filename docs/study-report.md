# Single-case study and report workflow

The guarded CLI and MCP can now turn a terminal RAFT calculation into a saved study/report bundle. Run the registered case first, then export using its original request ID. The report is reconstructed from the durable admission decision and terminal outcome, not from client claims. This is the first single-case workflow; live append-only multi-run studies, accepted conclusions and replay remain planned.

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

The reply contains project-relative HTML and Markdown paths. No client path, actor, question, policy, output destination or approval field is accepted. Fresh `append_step` policy applies; an A0 agent needs a separately scoped grant for that operation. Configuration must still match the audited run admission. Runs from before terminal record hashes were added require a new guarded calculation. An active or abandoned engine lease blocks export. An identical run retry must match the earliest original audited record hash and state; it cannot bless an edited saved record. Valid retries retain a reference to that original outcome.

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

This first report route supports completed RAFT time series. Failed/cancelled/trip states remain visible when a terminal audited run is exportable and its lease has been safely released. General recovered-run exports without an original hashed outcome, other adapters' series formats, comparison, aggregate study budgets, UI integration and accepted conclusions remain follow-ups.

## Desktop lesson panel

Start SEED with the same trusted `SEED_HOST_CONFIG` and `SEED_STUDY_HEADER` environment variables. The welcome page lists registered lesson cases. **Run** uses the configured study budget and a new host-generated request ID. It retains the configured actor and approval rules; clicking a desktop button does not grant human authority. **Cancel calculation** uses fresh cancellation checks and reports acknowledgment separately from the eventual stop. **Save study report** calls the same guarded export and shows the project-relative saved location.

The renderer cannot choose configuration paths, actors, budgets, request IDs or output destinations. Companion app views have no host preload and cannot use the lesson IPC handlers. The detached calculation owner survives closing the desktop; closing SEED does not cancel it. Use the existing human CLI recovery process if the owner fails. The first panel keeps its current request in memory: reconnect/history after restarting SEED and opening saved reports within the desktop are follow-ups. No scientific conclusion is accepted by this panel.

For actual Electron-to-RAFT acceptance, set `SEED_GUI_ACCEPTANCE=1` alongside `SEED_RAFT_REPO` and run `npx vitest run tests/raft-oracles.test.ts --maxWorkers=1` after building. This clicks the real lesson run/save buttons, waits for terminal completion and asserts the report-saved state. The shell suite checks missing setup and app-tab behavior.
