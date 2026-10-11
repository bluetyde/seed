# SEED shell (skeleton)

SEED (System for Engineering and Experimental Design) is a desktop host (Electron) that opens the suite apps as tabs. While an app is open the host shows only a thin top bar: a menu row (File, View, Window, Help) and a tab row (one tab per open app, a + button that opens the Welcome page). The apps themselves are unchanged web apps.

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

## Install and update the suite

The Welcome page (File > Install and update apps) shows each app in `catalog.json` (OpenMC Studio, NODAL Studio, Virtual Reactor/RAFT) with what it can do next:

- **Install**: clones the repository from GitHub into the install folder (default: the `apps` folder inside the SEED folder, which git ignores; changeable on the Welcome page. Apps cloned earlier into `~/SEED/apps`, into your home folder or beside SEED are still found), checks the programs it needs first (Git, Node 24), then runs its install steps (`npm ci --ignore-scripts`). A failed step keeps its output on the card; running Install again repeats the steps.
- **Use the existing copy / Choose a folder**: adopts a clone you already have. It must be a clone of the same GitHub repository; nothing in it is changed.
- **Check for updates**: asks GitHub (fetch only). **Update**: fast-forwards the branch. It refuses, with the reason on the card, if the app is open, the copy has uncommitted changes or commits GitHub does not have, or it is on another branch. It never resets, forces or switches branches. Install steps rerun only if a watched file (the lockfile) changed.
- **Forget this copy** only removes SEED's record of the folder.
- Private repositories need your own GitHub sign-in on this computer (Git Credential Manager or `gh auth login`). SEED runs the git on your PATH with prompts disabled and stores no credentials.
- OpenMC Studio runs natively on macOS/Linux and through WSL on Windows. Its launcher checks the conda environment; SEED does not create the environment or install nuclear data.

Installed paths are saved in `installs.json` in the user data folder, and the app list refers to them as `{install}`.

## Register an app

Help > Edit the app list copies `apps.default.json` to the user data folder as `apps.json`; edit it, then Help > Reload the app list. A bad entry is named in a banner and skipped; the defaults are not silently used instead of a broken file.

Fields: `catalog` (optional: the `catalog.json` id that installs it; `{install}` then stands for its folder), `id` (lowercase, digits, dashes), `name`, `icon` (`atom`, `pipe`, `reactor`, `app`), `healthPath`, `urlPath` (`{token}` is replaced), `start` (`command`, `args`, `cwd`, `env`; `{port}` and `{token}` are replaced), optional `attachUrl` (http on this computer only), optional `startTimeoutMs`. Install paths come from local settings or a folder you adopt; shipped files contain no personal checkout paths.

## Known gaps

- macOS/Linux use `apps.default.json`; Windows uses `apps.windows.json`. Run `npm start` on any platform, `Start SEED.command` on macOS (or via bash on Linux), or `Start SEED.cmd` on Windows. Node 24+ must be on PATH; the shell launcher also accepts `SEED_NODE_BIN` for a custom Node bin directory. The Welcome page offers home-directory and sibling clones.
- The "Close anyway / Stay" box is not covered by an automated test: Playwright's debugger answers the page's prompt before Electron raises `will-prevent-unload`. Checked by hand by the user on 2026-10-01: the native box appears and works.
- If the host process itself is killed, servers it started can be left running (they are not children of a job object).
- No packaging/installer, no auto-update, no signing.
- Not started: project manifest, adapters, runs, sweeps, reports (see PLAN.md E0, E2 and later).

## Real-app opening check

After adopting the three installed apps, run `npm run build` followed by
`node scripts/smoke-apps.cjs` with Node 24+ on PATH. This opens the real apps
in SEED, checks their rendered canvases, switches tabs, and verifies each owned
server stops when its tab closes. It saves screenshots and a JSON report in a
printed temporary folder. It uses the current SEED profile; close SEED first.
This checks app integration, not simulation accuracy or optional AI services.
