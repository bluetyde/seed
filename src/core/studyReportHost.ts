import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";
import { validateHostConfiguration } from "./fileRunHost";
import { inside, readAdmissions, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { openProject, withProjectLockAsync } from "./projectStore";
import { buildReport, type ReportRun, type Series } from "./report";
import { validate } from "./validate";
import { writeFileAtomic } from "./atomicFile";
import { evaluateGate } from "./policy";
import { prepareReport, finishReport } from "./reportReceipt";

/** Host-selected human header; requestId is the only client input. No conclusion or approval is invented. */
export async function exportStudyReport(file: string, headerFile: string | undefined, request: unknown) {
  let staging: string | undefined;
  try {
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).join() !== "requestId" ||
      typeof (request as any).requestId !== "string" ||
      !(request as any).requestId ||
      (request as any).requestId.length > 256
    )
      throw Error("only an original requestId is accepted");
    if (!headerFile || !isAbsolute(headerFile))
      throw Error("set SEED_STUDY_HEADER to a trusted absolute human header file");
    regularFile(file);
    const configBytes = readFileSync(file);
    const c = validateHostConfiguration(JSON.parse(configBytes.toString("utf8")));
    const projectRoot = realpathSync(c.projectRoot),
      state = realpathSync(c.stateRoot);
    if (
      inside(projectRoot, realpathSync(file)) ||
      inside(projectRoot, state) ||
      inside(projectRoot, realpathSync(headerFile))
    )
      throw Error("host configuration, state and human header must be outside project");
    const header = readHostJson(headerFile);
    if (
      !validate("study", header).ok ||
      header.type !== "header" ||
      header.hash !== undefined ||
      header.prev !== undefined
    )
      throw Error("invalid unchained human study header");
    const project = openProject(projectRoot);
    if (!project.ok) return { ok: false as const, errors: project.errors };
    if (
      header.studyId !== c.study.studyId ||
      header.projectId !== project.value.manifest.projectId ||
      header.tier !== c.study.tier ||
      canonicalJson(header.budget) !== canonicalJson(c.study.budget) ||
      canonicalJson(header.parameters) !== canonicalJson(c.study.parameters)
    )
      throw Error("human header differs from host project or study policy");
    const engine = safeChild(
      safeChild(state, "engines", true),
      sha256Hex(realpathSync(c.runtime.path)),
      true,
    );
    const locked = await withProjectLockAsync(projectRoot, async () => {
      if (existsSync(join(engine, "lease")))
        throw Error("active or abandoned calculation lease; finish or recover it before report export");
      const rows = readAdmissions(engine);
      const requestId = (request as any).requestId;
      const scope = (row: any) =>
        row.event.projectId === project.value.manifest.projectId &&
        row.event.configHash === sha256Hex(configBytes);
      const admission = [...rows]
        .reverse()
        .find(
          (row: any) =>
            scope(row) && row.event.phase === "request" && row.event.event.request?.requestId === requestId,
        );
      const nextRequest =
        admission && rows.find((row: any) => row.seq > admission.seq && row.event.phase === "request");
      const attemptRows = admission
        ? rows.filter(
            row => row.seq >= admission.seq && row.seq < (nextRequest?.seq ?? Infinity) && scope(row),
          )
        : [];
      const decision = attemptRows.find(
        (row: any) => row.event.phase === "decision" && row.event.event.requestId === requestId,
      );
      if (!admission || !decision) throw Error("no guarded admission for this request");
      const admitted = (admission.event as any).event;
      const gate = (decision.event as any).event;
      if (!gate.decision.allow || canonicalJson(admitted.configuration) !== canonicalJson(c))
        throw Error("refused admission or host configuration changed since run");
      const registered = c.cases[admitted.request.caseId];
      if (!registered) throw Error("case is no longer registered");
      const folders = project.value.manifest.folders as { runs: string; studies: string };
      const runsRoot = safeChild(projectRoot, folders.runs, true);
      if (!inside(projectRoot, realpathSync(runsRoot))) throw Error("runs folder leaves project");
      const requests = readHostJson(safeChild(runsRoot, "requests.json"));
      const runId = requests[requestId]?.runId;
      if (typeof runId !== "string" || !/^r-[A-Za-z0-9_-]+$/.test(runId))
        throw Error("no bound run for request");
      const runRoot = safeChild(runsRoot, runId, true);
      const record = readHostJson(safeChild(runRoot, "run-record.json"));
      const exportDecision = evaluateGate(
        {
          operation: "append_step",
          actor: c.actor,
          studyId: c.study.studyId,
          inputRevisions: registered.inputs.map(i => ({ artifact: i.path, revision: i.sha256 })),
        },
        { study: c.study, grants: c.grants },
      );
      if (!exportDecision.allow) return { ok: false as const, errors: exportDecision.errors };
      const outcome = attemptRows.find(
        (row: any) =>
          row.seq > decision.seq && row.event.phase === "outcome" && row.event.event.runId === runId,
      );
      if (
        !outcome ||
        !(outcome.event as any).event.ok ||
        !validate("run-record", record).ok ||
        sha256Hex(canonicalJson(record)) !== (outcome.event as any).event.recordSha256 ||
        record.state !== (outcome.event as any).event.state ||
        record.extensions?.["seed.dispatch"]?.requestId !== requestId ||
        record.extensions?.["seed.dispatch"]?.studyId !== header.studyId ||
        canonicalJson(record.inputs) !== canonicalJson(registered.inputs)
      )
        throw Error("saved run differs from audited terminal outcome");
      if (!["completed", "cancelled", "failed", "interrupted", "terminated-by-trip"].includes(record.state))
        throw Error("run is not terminal");
      const revisions = header.startRevisions.map((r: any) => r.revision).sort();
      if (canonicalJson(revisions) !== canonicalJson(record.inputs.map((i: any) => i.sha256).sort()))
        throw Error("human header does not cover exactly the run's input revisions");
      regularFile(c.oracles.evidenceFile);
      const evidenceBytes = readFileSync(c.oracles.evidenceFile);
      if (sha256Hex(evidenceBytes) !== c.oracles.evidenceSha256) throw Error("oracle evidence changed");
      const oracle = JSON.parse(evidenceBytes.toString());
      if (
        oracle.verdict !== "pass" ||
        oracle.blocked !== false ||
        canonicalJson(oracle.pins) !== canonicalJson(gate.pins)
      )
        throw Error("oracle evidence differs from admitted pins");
      const checked = (path: string, hash: string) => {
        const abs = safeChild(projectRoot, path);
        if (!inside(runRoot, realpathSync(abs))) throw Error("output leaves its bound run");
        regularFile(abs);
        const bytes = readFileSync(abs);
        if (sha256Hex(bytes) !== hash) throw Error("saved output hash changed");
        return bytes;
      };
      const reportRun: ReportRun = { record };
      if (record.state === "completed") {
        const indexes: any[] = [];
        for (const output of record.outputs) {
          const bytes = checked(output.path, output.sha256);
          try {
            const doc = JSON.parse(bytes.toString());
            if (doc.schema === "seed.results-index/0.1") indexes.push(doc);
          } catch {
            /* quantity formats may be non-JSON */
          }
        }
        if (indexes.length !== 1) throw Error("completed run must contain one results index");
        const index = indexes[0];
        if (
          !validate("results-index", index).ok ||
          canonicalJson(index.adapter) !== canonicalJson(record.adapter)
        )
          throw Error("results index adapter or schema mismatch");
        const series: Record<string, Series> = {};
        for (const q of index.quantities) {
          if (!record.outputs.some((o: any) => o.path === q.data.path && o.sha256 === q.data.sha256))
            throw Error("quantity not bound in run outputs");
          const data = JSON.parse(checked(q.data.path, q.data.sha256).toString());
          if (c.adapter.id !== "raft" || data.quantity !== q.name || data.unit !== q.unit)
            throw Error("series format not supported by this first RAFT report workflow");
          series[q.name] = { x: data.t, y: data.values, xLabel: "Time (s)", yLabel: `${q.name} (${q.unit})` };
        }
        reportRun.results = index;
        reportRun.series = series;
      }
      const stale = record.inputs.some((i: any) => {
        try {
          regularFile(join(projectRoot, i.path));
          return sha256Hex(readFileSync(join(projectRoot, i.path))) !== i.sha256;
        } catch {
          return true;
        }
      });
      const entries: any[] = [
        header,
        {
          schema: "seed.study/0.1",
          type: "step",
          seq: 1,
          time: decision.time,
          actor: gate.actor,
          action: "oracle",
          reason: `Pinned admission oracle set: ${c.oracles.evidenceSha256}. Quantities retain their adapter verification labels.`,
          inputsChanged: [],
          runs: [],
          oracle: { set: c.oracles.evidenceSha256, verdict: "pass" },
        },
        {
          schema: "seed.study/0.1",
          type: "step",
          seq: 2,
          time: decision.time,
          actor: gate.actor,
          action: "run",
          reason: `Registered case ${admitted.request.caseId}; policy admission via ${gate.decision.via}.`,
          inputsChanged: [],
          runs: [runId],
        },
        {
          schema: "seed.study/0.1",
          type: "step",
          seq: 3,
          time: outcome.time,
          actor: gate.actor,
          action: record.state === "cancelled" ? "cancel" : "note",
          reason: `Audited terminal outcome: ${record.state}. No scientific conclusion has been accepted.`,
          inputsChanged: [],
          runs: [runId],
        },
      ];
      let prev: string | null = null;
      const studyLines = entries.map(entry => {
        const body = { ...entry, prev };
        const hash = sha256Hex(canonicalJson(body));
        prev = hash;
        return JSON.stringify({ ...body, hash });
      });
      const report = buildReport({
        studyLines,
        runs: { [runId]: reportRun },
        staleRunIds: stale ? [runId] : [],
        generatedBy: "SEED guarded single-case report/0.1",
      });
      if (!report.ok) return { ok: false as const, errors: report.errors };
      const studies = safeChild(projectRoot, folders.studies, true);
      mkdirSync(studies, { recursive: true });
      if (!inside(projectRoot, realpathSync(studies))) throw Error("studies folder leaves project");
      const bundleName = `${header.studyId}-${sha256Hex(requestId).slice(0, 16)}`;
      const target = safeChild(studies, bundleName, true);
      if (existsSync(target)) {
        const reportId = finishReport(state, projectRoot, header.projectId, header.studyId, requestId, runId);
        if (reportId)
          return {
            ok: true as const,
            state: "report-saved",
            runId,
            studyId: header.studyId,
            reportId,
            report: {
              html: relative(projectRoot, join(target, "report.html")).replaceAll("\\", "/"),
              markdown: relative(projectRoot, join(target, "report.md")).replaceAll("\\", "/"),
            },
          };
        throw Error("study export already exists; immutable bundles are never overwritten");
      }
      staging = safeChild(studies, ".report-" + randomBytes(12).toString("hex"), true);
      mkdirSync(staging);
      const snapshotFiles: { source: string; path: string; sha256: string }[] = [];
      for (const input of record.inputs) {
        const source = relative(projectRoot, join(runRoot, "inputs", input.path)).replaceAll("\\", "/");
        const bytes = checked(source, input.sha256),
          path = "inputs/" + input.path;
        const destination = safeChild(staging, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        snapshotFiles.push({ source: input.path, path, sha256: input.sha256 });
      }
      for (const output of record.outputs ?? []) {
        const bytes = checked(output.path, output.sha256),
          path = "outputs/" + output.path;
        const destination = safeChild(staging, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        snapshotFiles.push({ source: output.path, path, sha256: output.sha256 });
      }
      writeFileAtomic(join(staging, "study.jsonl"), studyLines.join("\n") + "\n");
      writeFileAtomic(join(staging, "report.html"), report.value.html);
      writeFileAtomic(join(staging, "report.md"), report.value.markdown);
      const savedEvidence = {
        schema: "seed.study-evidence/0.1",
        requestId,
        runId,
        header,
        exportDecision,
        admission: {
          journalVerified: true,
          projectId: header.projectId,
          configHash: sha256Hex(configBytes),
          references: [admission, decision, outcome].map(row => ({
            seq: row.seq,
            hash: row.hash,
            prev: row.prev,
            time: row.time,
          })),
          request: admitted.request,
          decision: gate,
          outcome: (outcome.event as any).event,
          runtimeSha256: c.runtime.sha256,
        },
        oracle,
        record,
        stale,
        snapshotFiles,
      };
      writeHostJson(join(staging, "evidence.json"), savedEvidence);
      if (
        sha256Hex(readFileSync(file)) !== sha256Hex(configBytes) ||
        canonicalJson(readHostJson(headerFile)) !== canonicalJson(header) ||
        canonicalJson(readHostJson(safeChild(runRoot, "run-record.json"))) !== canonicalJson(record)
      )
        throw Error("study evidence changed during export");
      for (const output of record.outputs ?? []) checked(output.path, output.sha256);
      prepareReport(
        state,
        projectRoot,
        header.projectId,
        header.studyId,
        requestId,
        runId,
        relative(projectRoot, target),
        [
          sha256Hex(report.value.html),
          sha256Hex(studyLines.join("\n") + "\n"),
          sha256Hex(JSON.stringify(savedEvidence, null, 2) + "\n"),
        ],
      );
      renameSync(staging, target);
      staging = undefined;
      const reportId = finishReport(state, projectRoot, header.projectId, header.studyId, requestId, runId)!;
      return {
        ok: true as const,
        state: "report-saved",
        runId,
        studyId: header.studyId,
        reportId,
        report: {
          html: relative(projectRoot, join(target, "report.html")).replaceAll("\\", "/"),
          markdown: relative(projectRoot, join(target, "report.md")).replaceAll("\\", "/"),
        },
      };
    });
    return locked.ok ? locked.value : { ok: false as const, errors: locked.errors };
  } catch (e) {
    return {
      ok: false as const,
      errors: [
        {
          code: "E_NOT_PERMITTED",
          field: "",
          message: e instanceof Error ? e.message : "study report refused",
          source: "seed",
        },
      ],
    };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
