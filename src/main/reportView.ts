import { session, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { readRegisteredReport } from "../core/reportReceipt";

export function createReportView(config: string, reportId: string): { view: WebContentsView; url: string; title: string } {
  const verified = readRegisteredReport(config, reportId);
  const isolated = session.fromPartition(`report-${randomUUID()}`);
  const url = `seed-report://${reportId}/report.html`;
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", e => e.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url }));
  isolated.protocol.handle("seed-report", request => {
    if (request.url !== url) return new Response("Not found", { status: 404 });
    try {
      const report = readRegisteredReport(config, reportId);
      return new Response(new Uint8Array(report.html), { headers: { "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; sandbox",
        "Cache-Control": "no-store" } });
    } catch { return new Response("Report evidence changed or is unavailable. Display refused.", { status: 409, headers: { "Content-Type": "text/plain" } }); }
  });
  const view = new WebContentsView({ webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false } });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (e, target) => { if (target.split("#")[0] !== url) e.preventDefault(); });
  view.webContents.once("destroyed", () => isolated.protocol.unhandle("seed-report"));
  return { view, url, title: verified.title };
}
