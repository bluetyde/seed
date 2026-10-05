# Plan 11: Reports in SEED tabs

Status: implemented for new guarded exports (2026-10-04); actual desktop acceptance and review recorded in the coordination log. Builds on the guarded desktop lesson at `13c60ab` and [Plan 07](07-studies-and-reports.md).

## Student behavior

After **Save study report** succeeds, SEED opens the saved report in a new tab and keeps the lesson and app tabs open. Title: `Report: <study name>`. Saving does not claim that a scientific conclusion was accepted. A report tab shows its saved version, run identity and verification labels. Opening that same saved version again activates its existing tab; different reports and versions get separate tabs. Closing a report only closes its view, never a calculation or app server. Keyboard tab switching and closing work consistently.

## Implementation

1. Add a `report` kind and opaque report identity to TabModel and shared host types. Keep report lifecycle separate from app process lifecycle. Extend snapshot, layout, activation, retry/reload, menu actions and close behavior; do not treat a report as an app registry entry.
2. During guarded export, create a bounded, atomic host-owned receipt outside the project containing project/study/request/run IDs, bundle version, relative paths and hashes of report HTML, study record and evidence. Publish only complete bundles. Specify how a crash between bundle publication and receipt write is reported; never bless project-provided content to repair a missing receipt automatically.
3. Return an opaque report ID to the desktop controller after publication. The renderer may ask to open that ID, never a filesystem path or URL. Main resolves it through the trusted receipt, checks project scope, regular files, containment, linked ancestors and byte hashes before opening. Initial support is for newly registered exports; legacy bundles without receipts need a separately planned, explicit import/validation path.
4. Display HTML in a sandboxed WebContentsView with context isolation, no Node integration, no preload, no host IPC and no permissions. Serve only checked report bytes through a restricted local protocol. Block scripts, network requests, frames, forms, downloads, popups and arbitrary file navigation. Allow the generated CSS and inline SVG plots. In-document run anchors work; evidence links, if added, resolve through host-controlled identifiers.
5. Open and focus the tab automatically after save. Add **Open report** for the current saved receipt. If opening fails after a successful save, retain the saved identity and show an opening error with retry; do not rerun export or calculation.
6. Treat reports as historical snapshots. Show the saved STALE/UNVERIFIED labels unchanged. A separately computed current-input status must be clearly labeled as current and must not rewrite the saved report. Report history and reopening after restart come from [Plan 12](12-lesson-reconnection.md).

Likely files: `src/main/tabs.ts`, `src/main/main.ts`, new report-view/receipt modules, `src/main/lesson.ts`, preload/types, welcome/topbar, `src/core/studyReportHost.ts`. Rendering stays in the existing report builder.

## Acceptance

- Real Electron-to-RAFT run/save opens a report tab with the correct run, plots and labels; lesson and app tabs remain available.
- Two reports open independently; reopening one version focuses it. Closing either report leaves calculations and app servers untouched. Keyboard navigation and reload behave correctly.
- Edited HTML/evidence, missing files, forged IDs, traversal and junction substitution refuse before display; report views cannot invoke lesson/install IPC, execute injected scripts or read unrelated files/network resources.
- Offline viewing works. Save success followed by view failure remains recoverable without a duplicate calculation or export.
- Existing desktop tab/process tests and guarded export regressions pass. Review the new file/protocol/IPC boundary before merging.

Exit: a newly saved guarded report opens safely in a SEED tab. PDF, arbitrary HTML imports, report editing and restart history are outside this slice.

Implementation notes: export persists trusted pending hashes before bundle rename; a retry can finish a published pending receipt after checking its original hashes. A pending receipt without a published bundle requires inspection. Report views use an isolated, script-disabled session and a restricted seed-report protocol. Legacy bundles without receipts and restart report history remain outside this slice.
