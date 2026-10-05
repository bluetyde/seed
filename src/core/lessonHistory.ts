import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { inside, readAdmissions, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { validateHostConfiguration } from "./fileRunHost";
import { openProject } from "./projectStore";
import { controlBinding } from "./hostControl";
import { isAlive } from "./procTree";
import { readRegisteredReport, reportReceiptFolder } from "./reportReceipt";
import { evaluateGate } from "./policy";

function context(file: string) {
  const c = validateHostConfiguration(readHostJson(file)),
    root = realpathSync(c.projectRoot),
    state = realpathSync(c.stateRoot);
  if (inside(root, state) || inside(root, realpathSync(file)))
    throw Error("lesson history must be outside project");
  const project = openProject(root);
  if (!project.ok) throw Error("project unavailable");
  return { c, root, state, project: project.value, hash: sha256Hex(readFileSync(file)) };
}
export function saveLessonIntent(file: string, requestId: string, caseId: string): void {
  const h = context(file),
    folder = safeChild(
      h.state,
      join("desktop-intents", sha256Hex(h.project.manifest.projectId + "\n" + h.root)),
      true,
    );
  mkdirSync(folder, { recursive: true });
  if (!/^desktop-[0-9a-f-]{36}$/.test(requestId) || !Object.hasOwn(h.c.cases, caseId))
    throw Error("invalid desktop intent");
  const target = safeChild(folder, requestId + ".json");
  if (existsSync(target)) throw Error("request intent already exists");
  const reservation = safeChild(folder, "reservation", true);
  mkdirSync(reservation);
  try {
    if (existsSync(safeChild(folder, "maintenance", true)))
      throw Error("intent reservation maintenance is in progress; inspect if interrupted");
    writeHostJson(safeChild(reservation, "owner.json"), { pid: process.pid, token: randomUUID() });
    if (existsSync(target)) throw Error("request intent already exists");
    if (readdirSync(folder).filter(n => /^desktop-[0-9a-f-]{36}\.json$/.test(n)).length >= 1000)
      throw Error("lesson intent capacity reached; trusted archival required before launch");
    writeHostJson(target, {
      schema: "seed.desktop-intent/0.1",
      requestId,
      caseId,
      projectId: h.project.manifest.projectId,
      adapterId: h.c.adapter.id,
      studyId: h.c.study.studyId,
      projectRoot: h.root,
      configHash: h.hash,
      time: new Date().toISOString(),
    });
  } finally {
    const ownerFile = safeChild(reservation, "owner.json");
    if (existsSync(ownerFile)) unlinkSync(ownerFile);
    rmdirSync(reservation);
  }
}

/** Human maintenance of desktop metadata only; no native job or engine lease is touched. */
export function releaseLessonReservation(file: string, request: unknown) {
  let maintenance: string | undefined;
  try {
    if (!request || typeof request !== "object" || Object.keys(request).length !== 0)
      throw Error("only an empty request is accepted");
    const h = context(file);
    if (h.c.actor.kind !== "human") throw Error("reservation maintenance requires a human host identity");
    const folder = safeChild(
      h.state,
      join("desktop-intents", sha256Hex(h.project.manifest.projectId + "\n" + h.root)),
      true,
    );
    const guard = safeChild(folder, "maintenance", true);
    mkdirSync(guard);
    maintenance = guard;
    const reservation = safeChild(folder, "reservation", true),
      ownerFile = safeChild(reservation, "owner.json"),
      owner = readHostJson(ownerFile);
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 2 ||
      typeof owner.token !== "string" ||
      isAlive(owner.pid)
    )
      throw Error("reservation owner is alive or ambiguous; inspect manually");
    if (
      readdirSync(reservation).join() !== "owner.json" ||
      canonicalJson(readHostJson(ownerFile)) !== canonicalJson(owner)
    )
      throw Error("reservation changed; refusing cleanup");
    unlinkSync(ownerFile);
    rmdirSync(reservation);
    return { ok: true as const, state: "intent-reservation-released" };
  } catch (e) {
    return {
      ok: false as const,
      errors: [{ code: "E_NOT_PERMITTED", field: "", message: String(e), source: "seed" }],
    };
  } finally {
    if (maintenance) rmdirSync(maintenance);
  }
}

/** Observation only. No dispatch, lease cleanup, outcome repair or grant issuance. */
export function lessonHistory(
  file: string,
  observedAfter: number,
): { items: HostLessonHistory[]; blocked: boolean; warning?: string } {
  const h = context(file),
    enginePath = join(h.state, "engines", sha256Hex(realpathSync(h.c.runtime.path)));
  const engine = existsSync(enginePath)
    ? safeChild(safeChild(h.state, "engines", true), sha256Hex(realpathSync(h.c.runtime.path)), true)
    : undefined;
  const rows = engine ? readAdmissions(engine) : [];
  const lease = engine ? safeChild(engine, "lease", true) : undefined;
  let blocked = !!lease && existsSync(lease);
  const folder = safeChild(
    h.state,
    join("desktop-intents", sha256Hex(h.project.manifest.projectId + "\n" + h.root)),
    true,
  );
  const reserved = ["reservation", "maintenance"].some(name =>
    existsSync(
      safeChild(
        h.state,
        join("desktop-intents", sha256Hex(h.project.manifest.projectId + "\n" + h.root), name),
        true,
      ),
    ),
  );
  if (reserved) blocked = true;
  const names = existsSync(folder)
    ? readdirSync(folder)
        .filter(n => /^desktop-[0-9a-f-]{36}\.json$/.test(n))
        .sort()
    : [];
  if (names.length > 1000) throw Error("lesson history exceeds 1000 entries; trusted archival required");
  const items: HostLessonHistory[] = [];
  for (const name of names) {
    const intent = readHostJson(safeChild(folder, name));
    if (intent.projectId !== h.project.manifest.projectId || intent.projectRoot !== h.root) continue;
    if (
      intent.schema !== "seed.desktop-intent/0.1" ||
      intent.requestId + ".json" !== name ||
      typeof intent.caseId !== "string" ||
      typeof intent.time !== "string"
    )
      throw Error("invalid trusted lesson intent");
    const item: HostLessonHistory = {
      requestId: intent.requestId,
      adapterId: intent.adapterId,
      caseId: intent.caseId,
      time: intent.time,
      status: "pending admission",
    };
    items.push(item);
    if (
      intent.configHash !== h.hash ||
      intent.studyId !== h.c.study.studyId ||
      intent.adapterId !== h.c.adapter.id
    ) {
      item.status = "configuration changed";
      continue;
    }
    const admitted = [...rows]
      .reverse()
      .find(
        (r: any) =>
          r.event.phase === "request" &&
          r.event.projectId === intent.projectId &&
          r.event.configHash === h.hash &&
          r.event.event.request?.requestId === intent.requestId,
      );
    if (!admitted) continue;
    const next = rows.find((r: any) => r.seq > admitted.seq && r.event.phase === "request");
    const attempt = rows.filter(
      (r: any) =>
        r.seq > admitted.seq &&
        r.seq < (next?.seq ?? Infinity) &&
        r.event.projectId === intent.projectId &&
        r.event.configHash === h.hash,
    );
    const decision: any = attempt.find((r: any) => r.event.phase === "decision");
    if (decision?.event.event.decision.allow === false) {
      item.status = "refused";
      continue;
    }
    const outcome: any = attempt.find((r: any) => r.event.phase === "outcome");
    if (outcome?.event.event.ok === false) {
      item.status = "refused or failed";
      continue;
    }
    if (outcome?.event.event.ok === true) {
      try {
        const e = outcome.event.event,
          record = readHostJson(
            safeChild(
              h.root,
              join((h.project.manifest.folders as { runs: string }).runs, e.runId, "run-record.json"),
            ),
          );
        if (
          sha256Hex(canonicalJson(record)) !== e.recordSha256 ||
          record.state !== e.state ||
          record.extensions?.["seed.dispatch"]?.requestId !== intent.requestId
        )
          throw Error("audited record changed");
        for (const output of record.outputs ?? []) {
          const path = safeChild(h.root, output.path);
          regularFile(path);
          if (sha256Hex(readFileSync(path)) !== output.sha256) throw Error("saved output changed");
        }
        item.status = e.state;
        item.canSave = !blocked && ["completed", "cancelled", "terminated-by-trip"].includes(e.state);
      } catch {
        item.status = "evidence unavailable or changed";
      }
      continue;
    }
    item.status = "recovery or inspection required";
    if (blocked && lease) {
      try {
        const owner = readHostJson(safeChild(lease, "owner.json")),
          active = readHostJson(safeChild(lease, "active.json")),
          beat = readHostJson(safeChild(lease, "heartbeat.json"));
        if (
          decision?.event.event.decision.allow === true &&
          typeof active.runId === "string" &&
          typeof active.jobId === "string" &&
          active.requestId === intent.requestId &&
          active.token === owner.token &&
          active.binding === controlBinding(h.c) &&
          beat.token === owner.token &&
          beat.pid === owner.pid &&
          beat.requestId === intent.requestId &&
          beat.configHash === h.hash &&
          Number.isFinite(beat.time) &&
          beat.time > observedAfter &&
          Date.now() - beat.time >= 0 &&
          Date.now() - beat.time < 4000 &&
          isAlive(owner.pid)
        ) {
          item.status = "running";
          item.cancellable = evaluateGate(
            {
              operation: "cancel",
              actor: h.c.actor,
              studyId: h.c.study.studyId,
              inputRevisions: active.inputs,
            },
            { study: h.c.study, grants: h.c.grants },
          ).allow;
        }
      } catch {
        /* ambiguous ownership stays inspection-only */
      }
    }
  }
  const reports = reportReceiptFolder(h.state, h.root, h.project.manifest.projectId as string);
  const reportNames = existsSync(reports)
    ? readdirSync(reports).filter(n => /^[0-9a-f]{32}\.json$/.test(n))
    : [];
  if (reportNames.length > 1000)
    throw Error("report history exceeds 1000 receipts; trusted archival required");
  for (const name of reportNames) {
    const receipt = readHostJson(safeChild(reports, name));
    if (receipt.projectId !== h.project.manifest.projectId || receipt.projectRoot !== h.root) continue;
    const item = items.find(i => i.requestId === receipt.requestId);
    if (!item) continue;
    if (receipt.reportId + ".json" !== name) throw Error("report receipt identity mismatch");
    item.reportId = receipt.reportId;
    try {
      readRegisteredReport(file, receipt.reportId);
      item.reportId = receipt.reportId;
      item.canSave = false;
    } catch {
      item.reportError = "Saved report unavailable or changed";
      item.canSave = false;
    }
  }
  return {
    items: items.sort((a, b) => b.time.localeCompare(a.time)),
    blocked,
    ...(reserved
      ? {
          warning:
            "Request intent reservation unresolved; trusted human inspection or release-intent-reservation is required.",
        }
      : {}),
  };
}
