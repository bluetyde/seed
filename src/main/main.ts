// The host window: a thin top bar (menu row + tab row) and, below it, the active tab's page. App tabs are separate web views, each
// with its own storage, loading a server this host started (or attached to). Nothing from the host is drawn over an app.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, WebContentsView, type Input, type WebContents } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyInstall, loadRegistry, type AppEntry } from "./apps";
import { loadCatalog } from "./catalog";
import { Git } from "./git";
import { defaultCheckCmd, defaultRunCmd, Installer } from "./installer";
import { InstallStore } from "./store";
import * as os from "node:os";
import { ProcessManager } from "./processes";
import { TabModel } from "./tabs";
import { Lesson } from "./lesson";
import { createReportView } from "./reportView";
protocol.registerSchemesAsPrivileged([{ scheme: "seed-report", privileges: { standard: true, secure: true } }]);

const MENU_H = 32;
const TAB_H = 36;
const BAR_H = MENU_H + TAB_H;
const BG = "#0e1013";
const DIST = path.join(__dirname, "..");

// Tests point these at a scratch folder and a fake-app registry.
if (process.env.EXPERIMENT_STUDIO_USER_DATA) app.setPath("userData", process.env.EXPERIMENT_STUDIO_USER_DATA);
const userRegistry = () => path.join(app.getPath("userData"), "apps.json");
const defaultRegistry = () => process.env.EXPERIMENT_STUDIO_APPS ?? path.join(DIST, "..", process.platform === "win32" ? "apps.windows.json" : "apps.default.json");

nativeTheme.themeSource = "dark";

interface TabRuntime {
  status: TabStatus;
  error?: { message: string; output: string };
  view?: WebContentsView;
}

let win: BrowserWindow;
let barView: WebContentsView;
let pageView: WebContentsView;
let barExpanded = false;
let quitting = false;
let rawRegistry: AppEntry[] = [];
let installer: Installer;
let store: InstallStore;
let registrySource = "";
let registryProblems: string[] = [];
/** The app list with each catalog app's install folder filled in. */
function registry(): (AppEntry & { missingInstall?: boolean })[] {
  return rawRegistry.map((e) => applyInstall(e, e.catalog ? installer?.installPath(e.catalog) : undefined));
}
const tabs = new TabModel();
const runtime = new Map<string, TabRuntime>();
const processes = new ProcessManager();
const childWindows = new Map<string, Set<BrowserWindow>>();
const lesson = new Lesson(process.env.SEED_HOST_CONFIG, process.env.SEED_STUDY_HEADER, () => refresh(), undefined, openReport);

async function openReport(reportId: string): Promise<void> {
  if (!process.env.SEED_HOST_CONFIG) throw Error("No trusted host configuration.");
  const created = createReportView(process.env.SEED_HOST_CONFIG, reportId);
  const tab = tabs.openReport(reportId, created.title);
  const existing = runtime.get(tab.id);
  if (existing?.view) { created.view.webContents.close(); refresh(); return; }
  const opening: TabRuntime = { status: "running", view: created.view };
  runtime.set(tab.id, opening);
  win.contentView.addChildView(created.view);
  watchShortcuts(created.view.webContents);
  try { await created.view.webContents.loadURL(created.url); }
  catch (e) { if (runtime.get(tab.id) === opening) { destroyView(opening); setError(tab.id, String(e), ""); throw e; } return; }
  if (runtime.get(tab.id) !== opening) return;
  refresh();
}

// ---- state shown in the bar and the welcome page ----

function snapshot(): HostState {
  const status = (id: string): TabStatus => runtime.get(id)?.status ?? "idle";
  return {
    lesson: lesson.snapshot(),
    tabs: tabs.tabs.map((t) => {
      const rt = runtime.get(t.id);
      const a = registry().find((x) => x.id === t.appId);
      return { id: t.id, kind: t.kind, ...(t.appId ? { appId: t.appId } : {}), title: t.title, icon: t.kind === "welcome" ? "home" : a?.icon ?? "app", status: t.kind === "welcome" ? "running" : status(t.id), ...(rt?.error ? { error: rt.error } : {}) };
    }),
    activeId: tabs.activeId,
    apps: registry().map((a) => ({ id: a.id, name: a.name, icon: a.icon, available: !a.missingInstall, status: status(`app:${a.id}`) })),
    installs: installer?.list() ?? [],
    installRoot: store?.load().installRoot ?? "",
    registrySource,
    registryProblems,
  };
}

function refresh(): void {
  layout();
  const s = snapshot();
  for (const v of [barView, pageView]) if (v && !v.webContents.isDestroyed()) v.webContents.send("state", s);
}

/** Which view fills the area under the bar: the app itself once it is running, otherwise the host's own page (welcome, starting, error). */
function layout(): void {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize() as [number, number];
  barView.setBounds({ x: 0, y: 0, width: w, height: barExpanded ? h : BAR_H });
  const area = { x: 0, y: BAR_H, width: w, height: Math.max(0, h - BAR_H) };
  const activeRt = tabs.activeId ? runtime.get(tabs.activeId) : undefined;
  const showApp = activeRt?.status === "running" && !!activeRt.view;
  pageView.setBounds(area);
  pageView.setVisible(!showApp);
  for (const [id, rt] of runtime) {
    if (!rt.view) continue;
    rt.view.setBounds(area);
    rt.view.setVisible(showApp && id === tabs.activeId);
  }
  if (showApp && tabs.activeId) runtime.get(tabs.activeId)!.view!.webContents.focus();
}

// ---- opening and closing tabs ----

function openExternalSafe(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") void shell.openExternal(url);
  } catch { /* not a URL: ignore it */ }
}

function createAppView(entry: AppEntry, url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { partition: `persist:${entry.id}`, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBackgroundColor(BG);
  const origin = new URL(url).origin;
  const wc = view.webContents;
  guardContents(wc, origin, entry.id);
  wc.on("did-fail-load", (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return;       // -3: the load was replaced by another one
    setError(`app:${entry.id}`, `${entry.name} could not be loaded from ${failedUrl}: ${desc} (${code}).`, processes.output(entry.id));
  });
  watchShortcuts(wc);
  return view;
}

/**
 * Navigation rules for an app's pages. A window the app opens on its own origin (Virtual Reactor's operator window) is a real window
 * that shares the app's storage and workers; anything else opens in the system browser. Those windows close with the app's tab.
 */
function guardContents(wc: WebContents, origin: string, appId: string): void {
  wc.setWindowOpenHandler(({ url: target }) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(target).origin === origin; } catch { /* not a URL: treated as foreign */ }
    if (!sameOrigin) { openExternalSafe(target); return { action: "deny" }; }
    return { action: "allow", overrideBrowserWindowOptions: { width: 1200, height: 800, backgroundColor: BG, autoHideMenuBar: true } };
  });
  wc.on("did-create-window", (child) => {
    child.setMenu(null);
    guardContents(child.webContents, origin, appId);
    const set = childWindows.get(appId) ?? new Set<BrowserWindow>();
    set.add(child);
    childWindows.set(appId, set);
    child.once("closed", () => set.delete(child));
  });
  wc.on("will-navigate", (e, target) => {
    if (new URL(target).origin !== origin) { e.preventDefault(); openExternalSafe(target); }
  });
}

function closeChildWindows(appId: string): void {
  for (const w of [...(childWindows.get(appId) ?? [])]) if (!w.isDestroyed()) w.destroy();
  childWindows.delete(appId);
}

function setError(id: string, message: string, output: string): void {
  const rt = runtime.get(id) ?? { status: "error" as TabStatus };
  rt.status = "error";
  rt.error = { message, output };
  if (rt.view) destroyView(rt, id.replace(/^app:/, ""));
  runtime.set(id, rt);
  refresh();
}

function destroyView(rt: TabRuntime, appId?: string): void {
  if (appId) closeChildWindows(appId);
  const v = rt.view;
  rt.view = undefined;
  if (!v) return;
  if (!win.isDestroyed()) win.contentView.removeChildView(v);
  if (!v.webContents.isDestroyed()) v.webContents.close();
}

async function openApp(appId: string): Promise<void> {
  const entry = registry().find((a) => a.id === appId);
  if (!entry) return;
  if (entry.missingInstall) { tabs.openWelcome(); refresh(); return; }       // nothing to start: the Welcome page offers the install
  const tab = tabs.openApp(entry.id, entry.name);
  const have = runtime.get(tab.id);
  if (have && (have.status === "starting" || have.status === "running")) { refresh(); return; }
  runtime.set(tab.id, { status: "starting" });
  refresh();
  try {
    const running = await processes.ensure(entry);
    const rt = runtime.get(tab.id);
    if (!tabs.tabs.some((t) => t.id === tab.id) || !rt) return;      // closed while starting; closeTab already stopped the server
    const view = createAppView(entry, running.url);
    rt.view = view;
    rt.status = "running";
    delete rt.error;
    win.contentView.addChildView(view);
    win.contentView.addChildView(barView);             // keep the bar on top
    void view.webContents.loadURL(running.url);
    refresh();
  } catch (e) {
    if (!tabs.tabs.some((t) => t.id === tab.id)) return;
    const output = (e as { output?: string }).output ?? "";
    setError(tab.id, (e as Error).message, output);
  }
}

/** Closes a tab. The app is asked first, so its own "unsaved changes" prompt can stop it. Resolves false if the user chose to stay. */
async function closeTab(id: string): Promise<boolean> {
  const tab = tabs.tabs.find((t) => t.id === id);
  if (!tab) return true;
  const rt = runtime.get(id);
  if (rt?.view && !rt.view.webContents.isDestroyed()) {
    const wc = rt.view.webContents;
    const closed = await new Promise<boolean>((resolve) => {
      const onPrevent = (e: { preventDefault(): void }) => {
        const choice = dialog.showMessageBoxSync(win, { type: "question", buttons: ["Close anyway", "Stay"], defaultId: 1, cancelId: 1, title: "Unsaved changes", message: `${tab.title} has unsaved changes.`, detail: "Close the tab and lose them?" });
        if (choice === 0) e.preventDefault();         // ignore the page's prompt: the unload goes ahead
        else { wc.removeListener("will-prevent-unload", onPrevent); resolve(false); }
      };
      wc.on("will-prevent-unload", onPrevent);
      wc.once("destroyed", () => resolve(true));
      wc.close({ waitForBeforeUnload: true });
    });
    if (!closed) return false;
    rt.view = undefined;
  }
  if (tab.appId) closeChildWindows(tab.appId);
  if (rt?.view) destroyView(rt);
  runtime.delete(id);
  tabs.close(id);
  if (tab.appId) await processes.stop(tab.appId);
  refresh();
  return true;
}

async function closeAll(): Promise<boolean> {
  for (const t of [...tabs.tabs]) if (!(await closeTab(t.id))) return false;
  return true;
}

// ---- menu actions and shortcuts ----

function activeAppView(): WebContents | undefined {
  const rt = tabs.activeId ? runtime.get(tabs.activeId) : undefined;
  return rt?.view?.webContents;
}

function reloadRegistry(): void {
  const r = loadRegistry(userRegistry(), defaultRegistry());
  rawRegistry = r.apps;
  registryProblems = r.problems;
  registrySource = r.source;
  refresh();
}

function menuAction(a: MenuAction): void {
  switch (a) {
    case "newTab": tabs.openWelcome(); refresh(); break;
    case "closeTab": if (tabs.activeId) void closeTab(tabs.activeId); break;
    case "quit": win.close(); break;
    case "nextTab": tabs.next(); refresh(); break;
    case "prevTab": tabs.prev(); refresh(); break;
    case "reloadTab": {
      const id = tabs.activeId;
      const rt = id ? runtime.get(id) : undefined;
      if (rt?.view) rt.view.webContents.reload();
      else if (id?.startsWith("app:")) void retry(id);
      break;
    }
    case "devTools": activeAppView()?.openDevTools({ mode: "detach" }); break;
    case "fullscreen": win.setFullScreen(!win.isFullScreen()); break;
    case "editRegistry": {
      const p = userRegistry();
      if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(defaultRegistry(), p); }
      shell.showItemInFolder(p);
      break;
    }
    case "reloadRegistry": reloadRegistry(); break;
    case "chooseInstallRoot": void chooseInstallRoot(); break;
    case "checkUpdates": void installer.checkAll(); tabs.openWelcome(); refresh(); break;
    case "about": void dialog.showMessageBox(win, { type: "info", title: "SEED", message: "SEED", detail: `Opens the suite apps as tabs.\nElectron ${process.versions.electron}\nApp list: ${registrySource}` }); break;
  }
}

async function retry(tabId: string): Promise<void> {
  const reportId = tabs.tabs.find(t => t.id === tabId)?.reportId;
  if (reportId) {
    const rt = runtime.get(tabId); if (rt) destroyView(rt); runtime.delete(tabId);
    try { await openReport(reportId); } catch (e) { setError(tabId, String(e), ""); }
    return;
  }
  const rt = runtime.get(tabId);
  if (rt?.view) destroyView(rt, tabId.replace(/^app:/, ""));
  runtime.delete(tabId);
  const appId = tabs.tabs.find((t) => t.id === tabId)?.appId;
  if (appId) { await processes.stop(appId); await openApp(appId); }
}

function watchShortcuts(wc: WebContents): void {
  wc.on("before-input-event", (e: { preventDefault(): void }, input: Input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const k = input.key.toLowerCase();
    let handled = true;
    if (k === "tab") menuAction(input.shift ? "prevTab" : "nextTab");
    else if (k === "w") menuAction("closeTab");
    else if (k === "t") menuAction("newTab");
    else if (k === "r" && !input.shift) menuAction("reloadTab");
    else if (/^[1-9]$/.test(k)) { if (tabs.activateIndex(Number(k))) refresh(); }
    else handled = false;
    if (handled) e.preventDefault();
  });
}

// ---- start up ----

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 800, minHeight: 500, show: false, backgroundColor: BG, title: "SEED",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 12, y: 9 } } : {}),
    titleBarOverlay: { color: "#1b1e22", symbolColor: "#d8dde3", height: MENU_H },
  });
  Menu.setApplicationMenu(null);
  const hostPrefs = { preload: path.join(__dirname, "..", "preload", "hostApi.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };
  pageView = new WebContentsView({ webPreferences: hostPrefs });
  pageView.setBackgroundColor(BG);
  barView = new WebContentsView({ webPreferences: hostPrefs });
  barView.setBackgroundColor("#00000000");
  win.contentView.addChildView(pageView);
  win.contentView.addChildView(barView);
  void pageView.webContents.loadFile(path.join(DIST, "renderer", "welcome.html"));
  void barView.webContents.loadFile(path.join(DIST, "renderer", "index.html"));
  if (process.platform === "darwin") barView.webContents.on("did-finish-load", () => {
    void barView.webContents.insertCSS(".menurow { padding-left: 84px; padding-right: 8px; }");
  });
  for (const v of [pageView, barView]) {
    watchShortcuts(v.webContents);
    v.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    v.webContents.on("will-navigate", (e) => e.preventDefault());
  }
  win.on("resize", layout);
  // The BrowserWindow itself loads no document: its child views do. Waiting
  // for the parent's ready-to-show leaves the native window hidden indefinitely.
  win.show();
  win.focus();
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void (async () => {
      if (!(await closeAll())) return;           // the user stayed to keep unsaved work
      await processes.stopAll();
      quitting = true;
      win.close();
    })();
  });
}

async function chooseInstallRoot(): Promise<void> {
  const r = await dialog.showOpenDialog(win, { title: "Folder for new installs", defaultPath: store.load().installRoot, properties: ["openDirectory", "createDirectory"] });
  if (!r.canceled && r.filePaths[0]) await installer.setInstallRoot(r.filePaths[0]);
}

async function adoptFolder(id: string): Promise<void> {
  const r = await dialog.showOpenDialog(win, { title: "Choose the existing clone", defaultPath: store.load().installRoot, properties: ["openDirectory"] });
  if (!r.canceled && r.filePaths[0]) await installer.adopt(id, r.filePaths[0]);
}

function checkSender(e: { sender: WebContents }): boolean {
  return e.sender === barView.webContents || e.sender === pageView.webContents;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const catalogFile = process.env.SEED_CATALOG ?? path.join(DIST, "..", "catalog.json");
  const catalog = loadCatalog(catalogFile, !!process.env.SEED_CATALOG);
  if (!process.env.SEED_CATALOG) {
    for (const repo of catalog.repos) {
      repo.candidates = [path.join(os.homedir(), repo.folder), path.resolve(DIST, "..", "..", repo.folder)];
      if (process.platform !== "win32") repo.prerequisites = repo.prerequisites.filter((p) => p.id !== "wsl" && p.id !== "conda-env");
    }
  }
  store = new InstallStore(path.join(app.getPath("userData"), "installs.json"), process.env.SEED_INSTALL_ROOT ?? path.join(os.homedir(), "SEED", "apps"));
  installer = new Installer({
    repos: catalog.repos, store, git: new Git(), runCmd: defaultRunCmd, checkCmd: defaultCheckCmd,
    isRunning: (id) => tabs.tabs.some((t) => t.id === `app:${id}`),
    onChange: () => refresh(),
  });
  reloadRegistry();
  createWindow();
  void installer.refreshAll();
  processes.onExit = (appId, code) => setError(`app:${appId}`, `${registry().find((a) => a.id === appId)?.name ?? appId} stopped by itself (exit code ${code ?? "unknown"}).`, processes.output(appId));

  ipcMain.handle("state:get", (e) => (checkSender(e) ? snapshot() : undefined));
  ipcMain.on("lesson:run", (e, id: unknown) => { if (e.sender === pageView.webContents) void lesson.run(id); });
  ipcMain.on("lesson:cancel", (e) => { if (e.sender === pageView.webContents) lesson.cancel(); });
  ipcMain.on("lesson:save", (e) => { if (e.sender === pageView.webContents) void lesson.save(); });
  ipcMain.on("lesson:openReport", (e) => { if (e.sender === pageView.webContents) void lesson.openSaved(); });
  ipcMain.on("tab:openApp", (e, id: unknown) => { if (checkSender(e) && typeof id === "string") void openApp(id); });
  ipcMain.on("tab:new", (e) => { if (checkSender(e)) menuAction("newTab"); });
  ipcMain.on("tab:activate", (e, id: unknown) => { if (checkSender(e) && typeof id === "string" && tabs.activate(id)) refresh(); });
  ipcMain.on("tab:close", (e, id: unknown) => { if (checkSender(e) && typeof id === "string") void closeTab(id); });
  ipcMain.on("tab:retry", (e, id: unknown) => { if (checkSender(e) && typeof id === "string") void retry(id); });
  ipcMain.on("menu:action", (e, a: unknown) => { if (checkSender(e) && typeof a === "string") menuAction(a as MenuAction); });
  const known = (id: unknown): id is string => typeof id === "string" && installer.list().some((i) => i.id === id);
  const guarded = (p: Promise<void>) => { void p.catch((e: Error) => dialog.showErrorBox("SEED", e.message)); };
  ipcMain.on("inst:install", (e, id: unknown) => { if (checkSender(e) && known(id)) guarded(installer.install(id).then(reloadRegistry)); });
  ipcMain.on("inst:update", (e, id: unknown) => { if (checkSender(e) && known(id)) guarded(installer.update(id)); });
  ipcMain.on("inst:check", (e, id: unknown) => { if (checkSender(e)) guarded(known(id) ? installer.check(id) : installer.checkAll()); });
  ipcMain.on("inst:cancel", (e, id: unknown) => { if (checkSender(e) && known(id)) installer.cancel(id); });
  ipcMain.on("inst:adopt", (e, id: unknown) => { if (checkSender(e) && known(id)) guarded(adoptFolder(id).then(reloadRegistry)); });
  ipcMain.on("inst:useFound", (e, id: unknown) => {
    const found = checkSender(e) && known(id) ? installer.list().find((i) => i.id === id)?.candidate : undefined;
    if (found && known(id)) guarded(installer.adopt(id, found).then(reloadRegistry));
  });
  ipcMain.on("inst:forget", (e, id: unknown) => { if (checkSender(e) && known(id)) guarded(installer.forget(id).then(reloadRegistry)); });
  ipcMain.on("inst:root", (e) => { if (checkSender(e)) guarded(chooseInstallRoot()); });
  ipcMain.on("bar:expand", (e, on: unknown) => { if (checkSender(e)) { barExpanded = on === true; layout(); } });

  tabs.openWelcome();
  refresh();
});

app.on("activate", () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on("window-all-closed", () => app.quit());
