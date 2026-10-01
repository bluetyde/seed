import { type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..", "..");

/** The window as the user sees it (bar and app together), saved as a PNG. Electron's capturePage leaves out child views. */
export const captureWindow = async (host: ElectronApplication, out: string) => {
  const r = await host.evaluate(async ({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.show(); w.setAlwaysOnTop(true); w.focus();
    await new Promise((res) => setTimeout(res, 400));
    const b = w.getBounds(); const f = screen.getPrimaryDisplay().scaleFactor;
    return { x: Math.round(b.x * f), y: Math.round(b.y * f), w: Math.round(b.width * f), h: Math.round(b.height * f) };
  });
  execFileSync("powershell", ["-NoProfile", "-File", join(root, "scripts", "capture.ps1"), String(r.x), String(r.y), String(r.w), String(r.h), out]);
  await host.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setAlwaysOnTop(false));
};
