# Plan 01: Shell and installer

The host that opens the suite apps as tabs, and installs and updates them. **Implemented** (2026-10-01 to 2026-10-03); this plan records what exists, what is verified, and what is still open. Operating details are in [../shell.md](../shell.md).

## What exists

| Part | Files | Behaviour |
|---|---|---|
| Window and tabs | `src/main/main.ts`, `tabs.ts`, `src/renderer/` | One window, a menu row and a tab row; one sandboxed web view per app with its own storage; at most one tab per app; Ctrl+Tab and friends work while an app has focus |
| App registry | `src/main/apps.ts`, `apps.default.json`, `apps.windows.json` | Per-app start command, health URL, token URL; user copy via Help; a bad entry is named and skipped, defaults are not silently substituted |
| Process manager | `src/main/processes.ts` | Free port, per-launch token, health wait, stop only servers the host started, attach to a running server, error page with output and Try again |
| Installer | `catalog.ts`, `git.ts`, `installer.ts`, `store.ts`, `catalog.json` | Clone, adopt, check (fetch only), fast-forward update, dependency steps, prerequisite checks; refuses on open app, dirty tree, local commits or other branch |
| Same-origin windows | `main.ts` | A window an app opens on its own origin is host-managed in the same storage (RAFT's operator window and SharedWorker) |

## Rules this plan keeps

- The shell never edits an app's repository beyond clone and fast-forward, never resets or forces, and stores no credentials.
- An app view has no Node and no preload; it may navigate only within its own origin; permission prompts are refused.
- The core ([plan 02](02-project-and-materials.md) onward) must not import Electron. The shell becomes a client of it.

## Verified

- vitest (git against local bare repos, installer jobs, catalog and store validation, tab model, process manager) and Electron e2e against fake apps; real GitHub clone and open of NODAL and RAFT; macOS open, render, switch and stop of all three apps; the unsaved-work prompt checked by hand (2026-10-01).
- Not covered by automated tests: the "Close anyway / Stay" box (two `fixme` e2e tests, Playwright answers the prompt first); the native folder pickers.

## Open

- Real-app integration check on Windows and Linux hosts (configuration coverage is not runtime verification).
- Verify each default start command by a real launch on Windows, macOS and Linux.
- Install the OpenMC conda environment and nuclear data; update SEED itself; sign-in help; offline cached copy; update notices.
- If the host process is killed, servers it started can be left running (no job object).
- Packaging, signing and auto-update ([plan 10](10-release-and-packaging.md)).
- Refactor point: when the core exists, move the registry and installer state behind it so the headless core can launch apps without a window.

## Acceptance for "done"

The plan is complete when the open items above are closed with evidence (a command and its result on each OS) and the shell is a client of the headless core with no behaviour change in the existing tests.
