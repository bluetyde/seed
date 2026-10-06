import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./canonical";
import { inside, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { validateHostConfiguration } from "./fileRunHost";
import { openProject } from "./projectStore";

/**
 * Receipt versions: seed.report-receipt/0.1 binds three files (report.html, study.jsonl, evidence.json) for a first report; 0.2 (from
 * 2026-10-06) binds report.md as well, so the Markdown copy is as protected as the HTML. New receipts are 0.2; 0.1 receipts stay readable.
 */
export const RECEIPT_SCHEMAS = ["seed.report-receipt/0.1", "seed.report-receipt/0.2"];
const CORE_FILES = ["report.html", "study.jsonl", "evidence.json"];

/** Whether a receipt's file list has the shape its schema and report version call for (the hashes are checked separately). */
export function receiptFilesOk(receipt: { schema?: unknown; version?: unknown; files?: unknown }): boolean {
  const files = receipt.files;
  if (!Array.isArray(files) || files.length < 3 || files.length > 1000) return false;
  if (receipt.schema === "seed.report-receipt/0.1") return receipt.version !== 1 || files.length === 3;
  if (receipt.schema !== "seed.report-receipt/0.2") return false;
  const isMarkdown = (f: unknown) => typeof (f as { path?: unknown })?.path === "string" && ((f as { path: string }).path === "report.md" || (f as { path: string }).path.endsWith("/report.md"));
  if (receipt.version === 1) return files.length === 4 && isMarkdown(files[3]);
  return files.some(isMarkdown);
}

const pendingName = (root: string, requestId: string) =>
  "pending-" + sha256Hex(root + "\n" + requestId) + ".json";
export const reportReceiptFolder = (state: string, root: string, projectId: string) =>
  safeChild(state, join("reports", sha256Hex(projectId + "\n" + root)), true);
export function prepareReport(
  state: string,
  projectRoot: string,
  projectId: string,
  studyId: string,
  requestId: string,
  runId: string,
  bundle: string,
  hashes: string[],
  lineage?: { version: number; sourceReportId: string; extraFiles?: { path: string; sha256: string }[] },
): string {
  const receipts = reportReceiptFolder(state, projectRoot, projectId);
  mkdirSync(receipts, { recursive: true });
  const reportId = randomBytes(16).toString("hex");
  const files = CORE_FILES.map((name, i) => {
    return { path: join(bundle, name).replaceAll("\\", "/"), sha256: hashes[i] };
  });
  // a first report passes the Markdown hash as a fourth one; a revised report (lineage) carries report.md among its extra files
  if (hashes.length === 4) files.push({ path: join(bundle, "report.md").replaceAll("\\", "/"), sha256: hashes[3] });
  for (const f of lineage?.extraFiles ?? [])
    files.push({ path: join(bundle, f.path).replaceAll("\\", "/"), sha256: f.sha256 });
  if (!files.some((f) => f.path.endsWith("/report.md") || f.path === "report.md")) throw Error("a report receipt must bind report.md");
  const pending = safeChild(receipts, pendingName(projectRoot, requestId));
  if (existsSync(pending)) {
    const prior = readHostJson(pending);
    if (
      lineage &&
      prior.version === lineage.version &&
      prior.sourceReportId === lineage.sourceReportId &&
      prior.projectRoot === projectRoot &&
      prior.projectId === projectId &&
      prior.studyId === studyId &&
      prior.requestId === requestId &&
      prior.runId === runId &&
      /^[0-9a-f]{32}$/.test(prior.reportId) &&
      JSON.stringify(prior.files) === JSON.stringify(files)
    )
      return prior.reportId;
    throw Error("pending report publication requires inspection before retry");
  }
  writeHostJson(pending, {
    schema: "seed.report-receipt/0.2",
    reportId,
    version: 1,
    projectRoot,
    projectId,
    studyId,
    requestId,
    runId,
    files,
    ...(lineage ? { version: lineage.version, sourceReportId: lineage.sourceReportId } : {}),
  });
  return reportId;
}

export function finishReport(
  state: string,
  projectRoot: string,
  projectId: string,
  studyId: string,
  requestId: string,
  runId: string,
): string | undefined {
  let receipts = reportReceiptFolder(state, projectRoot, projectId);
  if (!existsSync(receipts) || !existsSync(safeChild(receipts, pendingName(projectRoot, requestId))))
    receipts = safeChild(state, "reports", true);
  if (!existsSync(receipts)) return undefined;
  const pending = safeChild(receipts, pendingName(projectRoot, requestId));
  if (!existsSync(pending)) return undefined;
  const receipt = readHostJson(pending);
  if (
    receipt.projectRoot !== projectRoot ||
    receipt.projectId !== projectId ||
    receipt.studyId !== studyId ||
    receipt.requestId !== requestId ||
    receipt.runId !== runId ||
    !/^[0-9a-f]{32}$/.test(receipt.reportId) ||
    !receiptFilesOk(receipt)
  )
    throw Error("pending report receipt mismatch");
  for (const entry of receipt.files) {
    const file = safeChild(projectRoot, entry.path);
    regularFile(file);
    if (sha256Hex(readFileSync(file)) !== entry.sha256)
      throw Error("pending published report changed; refusing registration");
  }
  renameSync(pending, safeChild(receipts, receipt.reportId + ".json"));
  return receipt.reportId;
}

/** Only IDs from the protected host catalog; no caller-controlled path or HTML. */
export function readRegisteredReport(config: string, reportId: unknown): { html: Buffer; title: string } {
  if (typeof reportId !== "string" || !/^[0-9a-f]{32}$/.test(reportId))
    throw Error("unknown report identity");
  const c = validateHostConfiguration(readHostJson(config));
  const root = realpathSync(c.projectRoot),
    state = realpathSync(c.stateRoot);
  if (inside(root, state) || inside(root, realpathSync(config)))
    throw Error("report catalog must be outside project");
  const project = openProject(root);
  if (!project.ok) throw Error("report project unavailable");
  let receipts = reportReceiptFolder(state, root, project.value.manifest.projectId as string);
  if (!existsSync(receipts) || !existsSync(safeChild(receipts, reportId + ".json")))
    receipts = safeChild(state, "reports", true);
  const receipt = readHostJson(safeChild(receipts, reportId + ".json"));
  if (
    !project.ok ||
    !RECEIPT_SCHEMAS.includes(receipt.schema) ||
    receipt.reportId !== reportId ||
    ![1, 2].includes(receipt.version) ||
    (receipt.version === 2 && !/^[0-9a-f]{32}$/.test(receipt.sourceReportId)) ||
    receipt.projectRoot !== root ||
    receipt.projectId !== project.value.manifest.projectId ||
    typeof receipt.studyId !== "string" ||
    !receiptFilesOk(receipt)
  )
    throw Error("invalid report receipt or project scope");
  let html: Buffer | undefined;
  for (let i = 0; i < receipt.files.length; i++) {
    const entry = receipt.files[i],
      name = [...CORE_FILES, "report.md"][i];
    if (
      typeof entry.path !== "string" ||
      (i < 3 && !entry.path.endsWith("/" + name)) ||
      (i === 3 && receipt.schema === "seed.report-receipt/0.2" && receipt.version === 1 && !entry.path.endsWith("/" + name)) ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      throw Error("invalid report receipt files");
    const file = safeChild(root, entry.path);
    regularFile(file);
    const bytes = readFileSync(file);
    if (sha256Hex(bytes) !== entry.sha256) throw Error("saved report evidence changed; refusing display");
    if (i === 0) html = bytes;
  }
  return { html: html!, title: `Report: ${receipt.studyId} (v${receipt.version})` };
}
