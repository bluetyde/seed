# Experiment Studio shell (skeleton)

A desktop host (Electron) that opens the suite apps as tabs. While an app is open the host shows only a thin top bar: a menu row (File, View, Window, Help) and a tab row (one tab per open app, a + button that opens the Welcome page). The apps themselves are unchanged web apps.

Status: skeleton for milestone E1 (launcher). There are no adapters, project files, runs, comparisons or reports yet, and no menu entries pretend to offer them.

## Run

```
npm install          # first time; downloads Electron
npm test             # unit tests (tabs, registry, process manager)
npm run start        # build and open the host
npm run e2e          # Electron end-to-end tests against fake app servers
REAL_APPS=1 SHELL_SHOTS=<folder> npm run e2e   # also opens the real NODAL and Virtual Reactor (opt-in)
```

## How it works

- `src/main/main.ts`: one window, three kinds of web view. The **bar** (transparent page, always on top), the **host page** (Welcome, "Starting...", and error pages), and one **app view** per running app tab. Only one of host page / app view is visible under the bar. While a menu is open the bar covers the whole window so the menu can overlap the app.
- Each app view uses its own storage (`persist:<appId>`), no preload, no Node, sandboxed. It may only navigate within its own origin; other links open in the system browser. Permission prompts are refused. The bar and host page get a small preload (`src/preload/hostApi.ts`) and the main process accepts IPC only from those two views.
- `src/main/processes.ts` starts a server on a free port with a fresh random token, waits for its health URL, and stops it (process tree) when the tab closes or the host quits. A server that already answers at `attachUrl` is used and never stopped. A server that exits before it is ready, or never answers, gives an error page with its output and a Try again button. A server that dies later turns its tab into the same error page.
- `src/main/tabs.ts` is the pure tab model. At most one tab per app. Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1..9, Ctrl+W, Ctrl+T, Ctrl+R work even while an app has focus.
- Closing a tab asks the app first, so an app's own "unsaved changes" prompt can stop it; the host shows "Close anyway / Stay". Quitting does the same for every tab and stops only the servers the host started.

## Register an app

Help > Edit the app list copies `apps.default.json` to the user data folder as `apps.json`; edit it, then Help > Reload the app list. A bad entry is named in a banner and skipped; the defaults are not silently used instead of a broken file.

Fields: `id` (lowercase, digits, dashes), `name`, `icon` (`atom`, `pipe`, `reactor`, `app`), `healthPath`, `urlPath` (`{token}` is replaced), `start` (`command`, `args`, `cwd`, `env`; `{port}` and `{token}` are replaced), optional `attachUrl` (http on this computer only), optional `startTimeoutMs`. The default paths assume this computer's layout (NODAL and Virtual Reactor from the shared workspace; OpenMC Studio from `C:\OpenMC` started inside WSL).

## Known gaps

- Windows only so far. macOS and the Mac SSD layout need their own start commands.
- The "Close anyway / Stay" box is not covered by an automated test: Playwright's debugger answers the page's prompt before Electron raises `will-prevent-unload`. Check by hand.
- If the host process itself is killed, servers it started can be left running (they are not children of a job object).
- No packaging/installer, no auto-update, no signing.
- Not started: project manifest, adapters, runs, sweeps, reports (see PLAN.md E0, E2 and later).
