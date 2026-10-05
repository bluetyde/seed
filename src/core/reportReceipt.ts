import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./canonical";
import { inside, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { validateHostConfiguration } from "./fileRunHost";
import { openProject } from "./projectStore";

const pendingName = (root: string, requestId: string) => "pending-" + sha256Hex(root + "\n" + requestId) + ".json";
export function prepareReport(state: string, projectRoot: string, projectId: string, studyId: string, requestId: string, runId: string, bundle: string, hashes: string[]): void {
  const receipts = safeChild(state, "reports", true); mkdirSync(receipts, { recursive: true });
  const reportId = randomBytes(16).toString("hex");
  const files = ["report.html", "study.jsonl", "evidence.json"].map((name, i) => {
    return { path: join(bundle, name).replaceAll("\\", "/"), sha256: hashes[i] };
  });
  const pending = safeChild(receipts, pendingName(projectRoot, requestId));
  if (existsSync(pending)) throw Error("pending report publication requires inspection before retry");
  writeHostJson(pending, { schema: "seed.report-receipt/0.1", reportId, version: 1,
    projectRoot, projectId, studyId, requestId, runId, files });
}

export function finishReport(state: string, projectRoot: string, projectId: string, studyId: string, requestId: string, runId: string): string | undefined {
  const receipts = safeChild(state, "reports", true);
  const pending = safeChild(receipts, pendingName(projectRoot, requestId));
  if (!existsSync(pending)) return undefined;
  const receipt = readHostJson(pending);
  if (receipt.projectRoot !== projectRoot || receipt.projectId !== projectId || receipt.studyId !== studyId || receipt.requestId !== requestId || receipt.runId !== runId ||
    !/^[0-9a-f]{32}$/.test(receipt.reportId) || !Array.isArray(receipt.files) || receipt.files.length !== 3) throw Error("pending report receipt mismatch");
  for (const entry of receipt.files) {
    const file = safeChild(projectRoot, entry.path); regularFile(file);
    if (sha256Hex(readFileSync(file)) !== entry.sha256) throw Error("pending published report changed; refusing registration");
  }
  renameSync(pending, safeChild(receipts, receipt.reportId + ".json"));
  return receipt.reportId;
}

/** Only IDs from the protected host catalog; no caller-controlled path or HTML. */
export function readRegisteredReport(config: string, reportId: unknown): { html: Buffer; title: string } {
  if (typeof reportId !== "string" || !/^[0-9a-f]{32}$/.test(reportId)) throw Error("unknown report identity");
  const c = validateHostConfiguration(readHostJson(config));
  const root = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
  if (inside(root, state) || inside(root, realpathSync(config))) throw Error("report catalog must be outside project");
  const receipt = readHostJson(safeChild(safeChild(state, "reports", true), reportId + ".json"));
  const project = openProject(root);
  if (!project.ok || receipt.schema !== "seed.report-receipt/0.1" || receipt.reportId !== reportId || receipt.version !== 1 ||
    receipt.projectRoot !== root || receipt.projectId !== project.value.manifest.projectId || typeof receipt.studyId !== "string" ||
    !Array.isArray(receipt.files) || receipt.files.length !== 3) throw Error("invalid report receipt or project scope");
  let html: Buffer | undefined;
  for (let i = 0; i < 3; i++) {
    const entry = receipt.files[i], name = ["report.html", "study.jsonl", "evidence.json"][i];
    if (typeof entry.path !== "string" || !entry.path.endsWith("/" + name) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw Error("invalid report receipt files");
    const file = safeChild(root, entry.path); regularFile(file); const bytes = readFileSync(file);
    if (sha256Hex(bytes) !== entry.sha256) throw Error("saved report evidence changed; refusing display");
    if (i === 0) html = bytes;
  }
  return { html: html!, title: `Report: ${receipt.studyId} (v1)` };
}
