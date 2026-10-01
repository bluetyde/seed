import { _electron as electron, expect, test } from "@playwright/test";
import { captureWindow } from "./capture";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Opt-in: opens the real NODAL Studio and Virtual Reactor dev servers from the default app list.
//   REAL_APPS=1 SHELL_SHOTS=<folder> npx playwright test -c tests/e2e/playwright.config.ts real-apps
const root = resolve(__dirname, "..", "..");
test.skip(!process.env.REAL_APPS, "set REAL_APPS=1 to run against the real apps");

test("NODAL Studio and Virtual Reactor open as tabs under the bar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exp-studio-real-"));
  // Override the sibling checkout layout with REAL_INSTALL_ROOT.
  const base = process.env.REAL_INSTALL_ROOT ?? resolve(root, "..");
  const paths = { "nodal-studio": join(base, "nodal-studio"), "virtual-reactor": join(base, "raft") };
  writeFileSync(join(dir, "installs.json"), JSON.stringify({ installRoot: base ?? dir, paths }));
  const host = await electron.launch({ args: [root], env: { ...process.env, EXPERIMENT_STUDIO_USER_DATA: dir } });
  try {
    const t0 = Date.now();
    let bar;
    while (!bar && Date.now() - t0 < 20_000) { bar = host.windows().find((p) => p.url().endsWith("/renderer/index.html")); await new Promise((r) => setTimeout(r, 100)); }
    await bar!.evaluate(() => { window.host.openApp("nodal-studio"); });
    await expect(bar!.locator('[data-tab="app:nodal-studio"] .dot')).toHaveClass(/running/, { timeout: 90_000 });
    await bar!.evaluate(() => { window.host.openApp("virtual-reactor"); });
    await expect(bar!.locator('[data-tab="app:virtual-reactor"] .dot')).toHaveClass(/running/, { timeout: 90_000 });
    await new Promise((r) => setTimeout(r, 2500));
    const shot = async (name: string) => {
      if (process.env.SHELL_SHOTS) await captureWindow(host, join(process.env.SHELL_SHOTS, name));
    };
    await shot("real-virtual-reactor.png");
    // Virtual Reactor's operator window must open as a window of the same app (it shares a SharedWorker with the main window)
    const vr = host.windows().find((p) => p.url().includes("role=") === false && p.url().startsWith("http://127.0.0.1:") && /virtual/i.test(p.url() + ""))
      ?? (await (async () => { for (const p of host.windows()) if (p.url().startsWith("http://127.0.0.1:") && (await p.title()) === "Virtual Reactor") return p; })())!;
    await vr.click('[data-op="open-operator"]');
    let op;
    for (let i = 0; i < 100 && !op; i++) { op = host.windows().find((p) => p.url().includes("role=operator")); await new Promise((r) => setTimeout(r, 100)); }
    expect(op, "the operator window opened inside the host").toBeTruthy();
    await expect(op!.locator('[data-op="window"]')).toContainText("operator window");
    await expect(vr.locator('[data-op="window"]')).toContainText("full window");
    await bar!.click('[data-tab="app:nodal-studio"]');
    await new Promise((r) => setTimeout(r, 1500));
    await shot("real-nodal.png");
    const titles = await host.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getTitle()));
    console.log("titles:", JSON.stringify(titles));
  } finally {
    await host.close().catch(() => undefined);
  }
});
