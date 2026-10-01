import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { captureWindow } from "./capture";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeRemote } from "../helpers/repo";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..", "..");
const fake = join(root, "tests", "fixtures", "fake-app.cjs");
const SHOTS = process.env.SHELL_SHOTS;           // set to a folder to save screenshots

const entry = (id: string, name: string, extra: string[] = []) => ({
  id, name, icon: "app", healthPath: "/health", urlPath: "/", startTimeoutMs: 15_000,
  start: { command: process.execPath, args: [fake, "--port", "{port}", "--title", name, ...extra] },
});

let host: ElectronApplication | undefined;

let installRoot = "";
async function launch(apps: unknown[], catalogRepos: unknown[] = []): Promise<Page> {
  const dir = mkdtempSync(join(tmpdir(), "exp-studio-"));
  const registry = join(dir, "registry.json");
  writeFileSync(registry, JSON.stringify({ apps }));
  const catalog = join(dir, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ repos: catalogRepos }));
  installRoot = join(dir, "installs");
  const userData = join(dir, "user");
  mkdirSync(userData);
  host = await electron.launch({ args: [root], env: { ...process.env, EXPERIMENT_STUDIO_APPS: registry, EXPERIMENT_STUDIO_USER_DATA: userData, SEED_CATALOG: catalog, SEED_INSTALL_ROOT: installRoot } });
  const bar = await pageWhere((p) => p.url().endsWith("/renderer/index.html"));
  await bar.waitForSelector(".tabrow");
  return bar;
}

async function pageWhere(match: (p: Page) => boolean, timeout = 20_000): Promise<Page> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = host!.windows().find(match);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no matching window");
}

const appPage = (title: string) => pageWhere((p) => p.url().startsWith("http://127.0.0.1:"), 20_000).then(async (p) => { await expect.poll(() => p.title()).toBe(title); return p; });
/** A key press delivered the way a user types it (not through the debugger), into the page at this url. */
const press = (urlPrefix: string, key: string, modifiers: string[]) => host!.evaluate(({ webContents }, [u, k, m]) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(u!))!;
  wc.sendInputEvent({ type: "keyDown", keyCode: k!, modifiers: m as any });
  wc.sendInputEvent({ type: "keyUp", keyCode: k!, modifiers: m as any });
}, [urlPrefix, key, modifiers] as const);
/** The whole window as the user sees it: the bar and the app together. */
const shot = async (name: string) => {
  if (!SHOTS) return;
  await captureWindow(host!, join(SHOTS, name));
};
const alive = async (url: string) => { try { return (await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };

test.afterEach(async () => { await host?.close().catch(() => undefined); host = undefined; });

test("starts with only the Welcome tab and lists the registered apps", async () => {
  const bar = await launch([entry("a", "Fake A"), entry("b", "Fake B")]);
  await expect.poll(() => host!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  await expect(bar.locator(".tab")).toHaveCount(1);
  await expect(bar.locator(".tab")).toContainText("Welcome");
  const welcome = await pageWhere((p) => p.url().endsWith("/renderer/welcome.html"));
  await expect(welcome.locator(".card")).toHaveCount(2);
  await shot("welcome.png");
});

test("opening an app starts its server, shows it under the bar only, and closing the tab stops the server", async () => {
  const bar = await launch([entry("a", "Fake A")]);
  const welcome = await pageWhere((p) => p.url().endsWith("/renderer/welcome.html"));
  await welcome.click('[data-open-app="a"]');
  const app = await appPage("Fake A");
  await expect(bar.locator('[data-tab="app:a"] .dot')).toHaveClass(/running/);
  expect(await app.evaluate(() => window.innerHeight)).toBeGreaterThan(500);
  const win = await host!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
  expect(await app.evaluate(() => window.innerWidth)).toBe(win[0]);
  expect(win[1] - (await app.evaluate(() => window.innerHeight))).toBe(68);          // the bar is the only thing the host adds
  const url = app.url();
  expect(await alive(url)).toBe(true);
  await shot("app-open.png");
  await bar.click('[data-close="app:a"]');
  await expect(bar.locator('[data-tab="app:a"]')).toHaveCount(0);
  await expect.poll(() => alive(url)).toBe(false);
});

test("a menu opens over the app and closes on Escape", async () => {
  const bar = await launch([entry("a", "Fake A")]);
  await bar.evaluate(() => window.host.openApp("a"));
  await appPage("Fake A");
  await bar.click('[data-menu="File"]');
  await expect(bar.locator(".menu")).toBeVisible();
  const box = await bar.locator(".menu").boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(68);                 // it reaches below the bar, over the app
  await shot("menu-open.png");
  await bar.keyboard.press("Escape");
  await expect(bar.locator(".menu")).toHaveCount(0);
});

test("Ctrl+Tab, Ctrl+N and Ctrl+W work while an app has focus", async () => {
  const bar = await launch([entry("a", "Fake A"), entry("b", "Fake B")]);
  await bar.evaluate(() => { window.host.openApp("a"); });
  await appPage("Fake A");
  await bar.evaluate(() => { window.host.openApp("b"); });
  await expect(bar.locator('[data-tab="app:b"]')).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => host!.windows().filter((p) => p.url().startsWith("http://127.0.0.1:")).length).toBe(2);
  const selected = () => bar.locator('.tab[aria-selected="true"]').getAttribute("data-tab");
  const inApp = (key: string, mods: string[]) => press("http://127.0.0.1:", key, mods);
  await inApp("Tab", ["control"]);                                  // b -> welcome (wraps)
  await expect.poll(selected).toBe("welcome");
  await inApp("2", ["control"]);                                    // the 2nd tab is app a
  await expect.poll(selected).toBe("app:a");
  await inApp("Tab", ["control", "shift"]);
  await expect.poll(selected).toBe("welcome");
  await inApp("9", ["control"]);                                    // 9 is always the last tab
  await expect.poll(selected).toBe("app:b");
  await inApp("w", ["control"]);
  await expect(bar.locator('[data-tab="app:b"]')).toHaveCount(0);
});

test("a window the app opens on its own origin is a real window that shares its workers; other links go to the system browser", async () => {
  const bar = await launch([entry("a", "Fake A", ["--shared"])]);
  await bar.evaluate(() => window.host.openApp("a"));
  const app = await appPage("Fake A");
  await expect(app.locator("#count")).toHaveText("1");
  await app.click("#open");
  const popup = await pageWhere((p) => p.url().endsWith("/popup"));
  await expect(popup.locator("#count")).toHaveText("2");           // the same SharedWorker served both windows
  const before = await host!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await bar.click('[data-close="app:a"]');
  await expect(bar.locator('[data-tab="app:a"]')).toHaveCount(0);
  await expect.poll(() => host!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeLessThan(before);   // its windows close with the tab
});

test("an app that fails to start shows its output and a Try again button; the tab is not blank", async () => {
  const bar = await launch([entry("bad", "Broken App", ["--exit", "2"])]);
  await bar.evaluate(() => window.host.openApp("bad"));
  const page = await pageWhere((p) => p.url().endsWith("/renderer/welcome.html"));
  await expect(page.locator("h1")).toHaveText("Broken App did not open");
  await expect(page.locator("pre.out")).toContainText("ModuleNotFoundError: foo");
  await expect(bar.locator('[data-tab="app:bad"] .dot')).toHaveClass(/error/);
  await expect(page.locator("[data-retry]")).toBeVisible();
  await shot("error.png");
});

// Playwright's debugger answers the page's beforeunload prompt before Electron raises will-prevent-unload, so the host's own
// "Close anyway / Stay" box cannot be driven from here. Checked by hand; see docs/shell.md.
test.fixme("closing a tab whose app has unsaved work asks first; Stay keeps it and its server", async () => {
  const bar = await launch([entry("a", "Fake A", ["--beforeunload"])]);
  await bar.evaluate(() => window.host.openApp("a"));
  const app = await appPage("Fake A");
  app.on("dialog", (d) => void d.dismiss());                       // Stay
  await app.click("#x");                                            // user activation, which Chromium requires for the prompt
  const url = app.url();
  await bar.click('[data-close="app:a"]');
  await expect(bar.locator('[data-tab="app:a"]')).toHaveCount(1);
  expect(await alive(url)).toBe(true);
});

test.fixme("closing a tab whose app has unsaved work, choosing to close anyway, closes it and stops the server", async () => {
  const bar = await launch([entry("a", "Fake A", ["--beforeunload"])]);
  await bar.evaluate(() => window.host.openApp("a"));
  const app = await appPage("Fake A");
  app.on("dialog", (d) => void d.accept());                        // Leave
  await app.click("#x");
  const url = app.url();
  await bar.click('[data-close="app:a"]');
  await expect(bar.locator('[data-tab="app:a"]')).toHaveCount(0);
  await expect.poll(() => alive(url)).toBe(false);
});

test("quitting stops every server the host started", async () => {
  const bar = await launch([entry("a", "Fake A"), entry("b", "Fake B")]);
  await bar.evaluate(() => { window.host.openApp("a"); window.host.openApp("b"); });
  await expect(bar.locator('[data-tab="app:a"] .dot')).toHaveClass(/running/);
  await expect(bar.locator('[data-tab="app:b"] .dot')).toHaveClass(/running/);
  await expect.poll(() => host!.windows().filter((p) => p.url().startsWith("http://127.0.0.1:")).length).toBe(2);
  const urls = host!.windows().map((p) => p.url()).filter((u) => u.startsWith("http://127.0.0.1:"));
  const closed = host!.waitForEvent("close");
  await host!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await closed;
  host = undefined;
  for (const u of urls) await expect.poll(() => alive(u)).toBe(false);
});

// ---- installer / updater, against a local git remote (no network) ----

async function installFixture() {
  const remote = makeRemote({ "server.cjs": readFileSync(fake, "utf-8"), "package-lock.json": "1" });
  const repo = {
    id: "demo", name: "Demo", url: remote.url, branch: "main", folder: "demo", private: false, candidates: [], prerequisites: [],
    steps: [{ label: "Install deps", cwd: ".", command: process.execPath, args: ["-e", "require('fs').writeFileSync('deps.ok', '1')"], watch: ["package-lock.json"] }],
  };
  const appEntry = { id: "demo", catalog: "demo", name: "Demo", icon: "app", healthPath: "/health", urlPath: "/", startTimeoutMs: 15_000, start: { command: process.execPath, args: ["{install}/server.cjs", "--port", "{port}", "--title", "Demo"] } };
  const bar = await launch([appEntry], [repo]);
  const welcome = await pageWhere((p) => p.url().endsWith("/renderer/welcome.html"));
  return { remote, bar, welcome, card: welcome.locator('[data-app="demo"]') };
}

test("an app that is not installed offers Install, not Open; installing clones it, runs the steps and then it opens", async () => {
  const { bar, welcome, card } = await installFixture();
  await expect(card).toHaveAttribute("data-install-state", "not-installed");
  await expect(card.locator("[data-open-app]")).toHaveCount(0);
  await bar.evaluate(() => window.host.openApp("demo"));              // even asked directly, it cannot start a path that is not there
  await expect(bar.locator('[data-tab="app:demo"]')).toHaveCount(0);
  await card.locator("[data-install]").click();
  await expect(card).toHaveAttribute("data-install-state", "up-to-date", { timeout: 30_000 });
  expect(readFileSync(join(installRoot, "demo", "deps.ok"), "utf-8")).toBe("1");
  await card.locator("[data-open-app]").click();
  await appPage("Demo");
  await shot("installer-open.png");
});

test("checking for updates finds a new commit and Update brings it in; the step reruns only because package-lock.json changed", async () => {
  const { remote, welcome, card } = await installFixture();
  await card.locator("[data-install]").click();
  await expect(card).toHaveAttribute("data-install-state", "up-to-date", { timeout: 30_000 });
  writeFileSync(join(installRoot, "demo", "deps.ok"), "stale");
  remote.commit({ "package-lock.json": "2" });
  await card.locator("[data-check]").click();
  await expect(card).toHaveAttribute("data-install-state", "update-available", { timeout: 20_000 });
  await expect(card).toContainText("1 new commit");
  await shot("installer-update-available.png");
  await card.locator("[data-update]").click();
  await expect(card).toHaveAttribute("data-install-state", "up-to-date", { timeout: 30_000 });
  expect(readFileSync(join(installRoot, "demo", "package-lock.json"), "utf-8")).toBe("2");
  expect(readFileSync(join(installRoot, "demo", "deps.ok"), "utf-8")).toBe("1");        // rewritten by the rerun step
  await expect(welcome.locator("[data-update]")).toHaveCount(0);
});

test("Update is refused while the app is open, with the reason on its card", async () => {
  const { remote, bar, welcome, card } = await installFixture();
  await card.locator("[data-install]").click();
  await expect(card).toHaveAttribute("data-install-state", "up-to-date", { timeout: 30_000 });
  await card.locator("[data-open-app]").click();
  await appPage("Demo");
  remote.commit({ "b.txt": "2" });
  await bar.click('[data-tab="welcome"]');
  await card.locator("[data-check]").click();
  await expect(card).toHaveAttribute("data-install-state", "update-available", { timeout: 20_000 });
  await card.locator("[data-update]").click();
  await expect(card.locator('[role="alert"]')).toContainText("Close the Demo tab first");
});
