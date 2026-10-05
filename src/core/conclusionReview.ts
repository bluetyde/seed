import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, dirname, relative } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { claimsOf } from "./conclusionDraft";
import { validateHostConfiguration } from "./fileRunHost";
import { inside, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { openProject, withProjectLockAsync } from "./projectStore";
import { readRegisteredReport, prepareReport, finishReport, reportReceiptFolder } from "./reportReceipt";
import { verifyStudyLog } from "./semantic";
import { buildReport, type ReportRun } from "./report";
import { evaluateGate } from "./policy";
export const reviewPublication = { write: writeFileSync, rename: renameSync };

function context(file: string) {
  regularFile(file);
  const bytes = readFileSync(file),
    c = validateHostConfiguration(JSON.parse(bytes.toString()));
  const root = realpathSync(c.projectRoot),
    state = realpathSync(c.stateRoot),
    p = openProject(root);
  if (!p.ok) throw Error("review project unavailable");
  if (inside(root, state) || inside(root, realpathSync(file)))
    throw Error("review host state must be outside project");
  const key = sha256Hex(p.value.manifest.projectId + "\n" + root);
  return { c, root, state, p: p.value, hash: sha256Hex(bytes), key };
}
function folder(state: string, key: string, kind: string, create = false) {
  const parent = safeChild(state, kind, true);
  if (create) mkdirSync(parent, { recursive: true });
  if (!existsSync(parent)) return undefined;
  const child = safeChild(parent, key, true);
  if (create) mkdirSync(child, { recursive: true });
  return existsSync(child) ? child : undefined;
}
function drafts(file: string) {
  const h = context(file),
    dir = folder(h.state, h.key, "conclusion-drafts");
  const names = dir ? readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/.test(n)) : [];
  if (names.length > 1000) throw Error("draft history capacity exceeded");
  return names.map(name => {
    const d = readHostJson(safeChild(dir!, name)),
      { hash, draftId, time, ...body } = d;
    if (
      d.schema !== "seed.conclusion-draft/0.1" ||
      d.status !== "draft" ||
      d.projectRoot !== h.root ||
      d.projectId !== h.p.manifest.projectId ||
      !/^[0-9a-f]{32}$/.test(draftId) ||
      !Number.isFinite(Date.parse(time)) ||
      sha256Hex(canonicalJson(body)) + ".json" !== name ||
      sha256Hex(canonicalJson({ ...body, draftId, time })) !== hash ||
      sha256Hex(canonicalJson(claimsOf(d.claims))) !== d.claimsHash
    )
      throw Error("draft history changed");
    return d;
  });
}
export function listConclusionDrafts(file: string, reportId: string) {
  readRegisteredReport(file, reportId);
  const h = context(file),
    reviews = folder(h.state, h.key, "conclusion-reviews");
  return drafts(file)
    .filter(d => d.reportId === reportId)
    .map(d => {
      let acceptedReportId: string | undefined;
      if (reviews && existsSync(safeChild(reviews, d.draftId + "-report.json"))) {
        const publication = readHostJson(safeChild(reviews, d.draftId + "-report.json"));
        if (publication.status === "published") {
          readRegisteredReport(file, publication.reportId);
          acceptedReportId = publication.reportId;
        }
      }
      return {
        draftId: d.draftId as string,
        time: d.time as string,
        text: d.claims[0].text as string,
        acceptedReportId,
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time));
}

/**
 * A reviewer file names a person, but a file cannot prove who is at the keyboard. Two cheap checks make it harder to
 * misuse: the file names the operating-system account allowed to use it (a copy made for another account fails),
 * and on POSIX it must belong to the running account and not be writable by group or others. The native
 * confirmation dialog is what a person actually answers. Returns the first problem, or null.
 */
export function reviewerSetupProblem(
  reviewer: { osUser?: unknown },
  file: { uid: number; mode: number },
  running: { username: string; uid?: number; platform?: string },
): string | null {
  const platform = running.platform ?? process.platform;
  const norm = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  if (typeof reviewer.osUser !== "string" || !reviewer.osUser.trim() || reviewer.osUser.length > 256)
    return "reviewer setup must name the operating-system account (osUser)";
  if (norm(reviewer.osUser) !== norm(running.username))
    return "reviewer setup belongs to another operating-system account";
  if (platform !== "win32") {
    if (running.uid === undefined || file.uid !== running.uid)
      return "reviewer setup file is not owned by the running account";
    if ((file.mode & 0o022) !== 0) return "reviewer setup file is writable by group or others";
  }
  return null;
}

/** Trusted setup selects the reviewer; the renderer never supplies their identity. */
export function inspectConclusion(file: string, reviewerFile: string | undefined, draftId: string) {
  const h = context(file),
    d = drafts(file).find(d => d.draftId === draftId);
  if (!d || d.configHash !== h.hash || d.studyId !== h.c.study.studyId)
    throw Error("draft or host configuration changed");
  if (!reviewerFile || !isAbsolute(reviewerFile))
    throw Error("Set SEED_REVIEWER_CONFIG to an external trusted human reviewer file.");
  regularFile(reviewerFile);
  if (inside(h.root, realpathSync(reviewerFile))) throw Error("reviewer setup must be outside project");
  const reviewerBytes = readFileSync(reviewerFile),
    reviewer = JSON.parse(reviewerBytes.toString());
  if (
    Object.keys(reviewer).sort().join() !== "actor,osUser,projectId,schema,studyId" ||
    reviewer.schema !== "seed.reviewer/0.2" ||
    reviewer.projectId !== d.projectId ||
    reviewer.studyId !== d.studyId ||
    !reviewer.actor ||
    Object.keys(reviewer.actor).sort().join() !== "kind,name" ||
    reviewer.actor.kind !== "human" ||
    typeof reviewer.actor.name !== "string" ||
    !reviewer.actor.name.trim() ||
    reviewer.actor.name.length > 256
  )
    throw Error("invalid scoped human reviewer setup");
  const setupStat = statSync(reviewerFile);
  const setupProblem = reviewerSetupProblem(
    reviewer,
    { uid: setupStat.uid, mode: setupStat.mode },
    { username: userInfo().username, uid: process.getuid?.() },
  );
  if (setupProblem) throw Error(setupProblem);
  readRegisteredReport(file, d.reportId);
  if (!Array.isArray(d.sourceFiles) || d.sourceFiles.length !== 3) throw Error("invalid draft source files");
  const bytes = d.sourceFiles.map((f: any) => {
    const path = safeChild(h.root, f.path);
    regularFile(path);
    const data = readFileSync(path);
    if (sha256Hex(data) !== f.sha256) throw Error("draft evidence changed");
    return data;
  });
  const lines = bytes[1].toString().trimEnd().split("\n"),
    entries = lines.map((line: string) => JSON.parse(line));
  if (
    verifyStudyLog(lines).length ||
    entries.at(-1).hash !== d.sourceHead ||
    entries.some((e: any) => e.type === "conclusion")
  )
    throw Error("draft study changed");
  const evidence = JSON.parse(bytes[2].toString()),
    snapshotRoot = dirname(safeChild(h.root, d.sourceFiles[2].path));
  const checked = (source: string, hash: string) => {
    const s = evidence.snapshotFiles.find((s: any) => s.source === source && s.sha256 === hash);
    if (!s) throw Error("missing cited run snapshot");
    const path = safeChild(snapshotRoot, s.path);
    regularFile(path);
    const data = readFileSync(path);
    if (sha256Hex(data) !== hash) throw Error("run snapshot changed");
    return data;
  };
  const record = evidence.record,
    run: ReportRun = { record };
  const gate = evaluateGate(
    {
      operation: "append_step",
      actor: reviewer.actor,
      studyId: d.studyId,
      inputRevisions: record.inputs.map((i: any) => ({ artifact: i.path, revision: i.sha256 })),
    },
    { study: h.c.study, grants: h.c.grants },
  );
  if (!gate.allow) throw Error(gate.errors.map(e => e.message).join("; "));
  if (record.state === "completed") {
    const indexes = record.outputs
      .map((o: any) => {
        const data = checked(o.path, o.sha256);
        try {
          return JSON.parse(data.toString());
        } catch {
          return undefined;
        }
      })
      .filter((d: any) => d?.schema === "seed.results-index/0.1");
    if (indexes.length !== 1) throw Error("invalid saved results index");
    run.results = indexes[0];
    run.series = {};
    for (const q of indexes[0].quantities) {
      const data = JSON.parse(checked(q.data.path, q.data.sha256).toString());
      if (data.quantity !== q.name || data.unit !== q.unit) throw Error("saved quantity mismatch");
      run.series[q.name] = { x: data.t, y: data.values, xLabel: "Time (s)", yLabel: `${q.name} (${q.unit})` };
    }
  }
  const currentInputs = record.inputs.map((i: any) => {
    let current: string | null = null;
    try {
      const p = safeChild(h.root, i.path);
      regularFile(p);
      current = sha256Hex(readFileSync(p));
    } catch {
      /* missing input is stale */
    }
    return { path: i.path, saved: i.sha256, current };
  });
  let pinsChanged = false;
  for (const pin of [
    { path: h.c.runtime.path, hash: h.c.runtime.sha256 },
    { path: h.c.oracles.evidenceFile, hash: h.c.oracles.evidenceSha256 },
  ]) {
    try {
      regularFile(pin.path);
      if (sha256Hex(readFileSync(pin.path)) !== pin.hash) pinsChanged = true;
    } catch {
      pinsChanged = true;
    }
  }
  const stale = pinsChanged || currentInputs.some((i: any) => i.saved !== i.current);
  const unverified =
    (run.results as any)?.quantities
      .filter((q: any) => q.verification !== "verified")
      .map((q: any) => q.name) ?? [];
  const binding = {
    draftHash: d.hash,
    configHash: h.hash,
    reviewerHash: sha256Hex(reviewerBytes),
    currentInputs,
    stale,
    pinsChanged,
    unverified,
  };
  let committedReview: any;
  const reviews = folder(h.state, h.key, "conclusion-reviews");
  if (reviews && existsSync(safeChild(reviews, draftId + ".json"))) {
    committedReview = readHostJson(safeChild(reviews, draftId + ".json"));
    const { hash, ...body } = committedReview;
    if (hash !== sha256Hex(canonicalJson(body)) || committedReview.draftHash !== d.hash)
      throw Error("committed review changed");
  }
  return {
    h,
    draft: d,
    reviewer: reviewer.actor,
    lines,
    header: entries[0],
    evidence,
    run,
    binding,
    committedReview,
    displayHash: sha256Hex(canonicalJson(binding)),
  };
}

/** Called only after the main process's native review confirmation, never by CLI/MCP. */
export async function decideConclusion(
  file: string,
  reviewerFile: string | undefined,
  draftId: string,
  displayHash: string,
  decision: "accepted" | "rejected",
) {
  const root = context(file).root;
  const result = await withProjectLockAsync(root, async () => {
    const s = inspectConclusion(file, reviewerFile, draftId),
      { h, draft: d } = s;
    if (!["accepted", "rejected"].includes(decision)) throw Error("invalid review decision");
    const reviews = folder(h.state, h.key, "conclusion-reviews", true)!;
    const target = safeChild(reviews, draftId + ".json");
    let review: any;
    if (existsSync(target)) {
      review = readHostJson(target);
      const { hash, ...body } = review;
      if (
        hash !== sha256Hex(canonicalJson(body)) ||
        review.draftHash !== d.hash ||
        review.decision !== decision ||
        review.acknowledgedLimits.configHash !== s.binding.configHash ||
        review.acknowledgedLimits.reviewerHash !== s.binding.reviewerHash ||
        canonicalJson(review.reviewer) !== canonicalJson(s.reviewer)
      )
        throw Error("draft already reviewed differently or review changed");
    } else {
      if (displayHash !== s.displayHash) throw Error("review changed; review the exact draft again");
      const body = {
        schema: "seed.conclusion-review/0.1",
        projectId: d.projectId,
        studyId: d.studyId,
        draftId,
        draftHash: d.hash,
        sourceReportId: d.reportId,
        sourceHead: d.sourceHead,
        displayHash,
        reviewer: s.reviewer,
        time: new Date().toISOString(),
        decision,
        acknowledgedLimits: s.binding,
        claims: d.claims,
        proposedBy: d.actor,
      };
      review = { ...body, hash: sha256Hex(canonicalJson(body)) };
      writeHostJson(target, review);
    }
    if (decision === "rejected") return { decision, draftId };
    const requestId = s.evidence.requestId + "-review-" + draftId;
    const studies = safeChild(root, (h.p.manifest.folders as any).studies, true);
    const bundle = safeChild(studies, d.studyId + "-accepted-" + draftId, true);
    const publication = safeChild(reviews, draftId + "-report.json");
    if (existsSync(publication)) {
      const saved = readHostJson(publication);
      if (
        saved.reviewHash !== review.hash ||
        !["pending", "published"].includes(saved.status) ||
        !/^[0-9a-f]{32}$/.test(saved.reportId)
      )
        throw Error("accepted publication changed");
      if (!existsSync(bundle)) {
        const catalog = reportReceiptFolder(h.state, root, d.projectId);
        if (existsSync(safeChild(catalog, saved.reportId + ".json")))
          throw Error(
            "registered accepted bundle missing; restore its exact bytes, never replace its identity",
          );
        const pending = safeChild(catalog, "pending-" + sha256Hex(root + "\n" + requestId) + ".json");
        if (!existsSync(pending) || readHostJson(pending).reportId !== saved.reportId)
          throw Error("accepted publication receipt missing or changed");
      }
    }
    if (existsSync(publication) && existsSync(bundle)) {
      const saved = readHostJson(publication);
      if (saved.reviewHash !== review.hash) throw Error("accepted report lineage changed");
      if (saved.status !== "published") {
        const finished = finishReport(h.state, root, d.projectId, d.studyId, requestId, s.evidence.runId);
        if (finished && finished !== saved.reportId) throw Error("accepted publication identity changed");
        readRegisteredReport(file, saved.reportId);
        writeHostJson(publication, { ...saved, status: "published" });
      }
      readRegisteredReport(file, saved.reportId);
      return { decision, draftId, reportId: saved.reportId as string };
    }
    if (existsSync(bundle)) {
      const reportId = finishReport(h.state, root, d.projectId, d.studyId, requestId, s.evidence.runId);
      if (!reportId) throw Error("accepted bundle lacks pending trusted receipt");
      writeHostJson(publication, { reviewHash: review.hash, reportId, status: "published" });
      return { decision, draftId, reportId };
    }
    const conclusion = {
      schema: "seed.study/0.1",
      type: "conclusion",
      seq: s.lines.length,
      time: review.time,
      actor: review.reviewer,
      claims: d.claims,
      prev: d.sourceHead,
    };
    const lines = [...s.lines, JSON.stringify({ ...conclusion, hash: sha256Hex(canonicalJson(conclusion)) })];
    const report = buildReport({
      studyLines: lines,
      runs: { [s.evidence.runId]: s.run },
      staleRunIds: review.acknowledgedLimits.stale ? [s.evidence.runId] : [],
      generatedBy: `SEED human-accepted report; reviewer ${review.reviewer.name}; proposed by ${d.actor.kind} ${d.actor.name}; review ${review.hash}`,
    });
    if (!report.ok) throw Error(report.errors.map(e => e.message).join("; "));
    const acceptedEvidence = {
      ...s.evidence,
      stale: review.acknowledgedLimits.stale,
      review,
      sourceReportId: d.reportId,
      derivedHead: JSON.parse(lines.at(-1)!).hash,
    };
    const studyText = lines.join("\n") + "\n",
      evidenceText = JSON.stringify(acceptedEvidence, null, 2) + "\n";
    const staging = safeChild(studies, ".accepted-" + draftId, true);
    const stagedFiles: { path: string; data: Buffer }[] = [];
    for (const snapshot of s.evidence.snapshotFiles) {
      const source = safeChild(dirname(safeChild(root, d.sourceFiles[2].path)), snapshot.path);
      regularFile(source);
      const data = readFileSync(source);
      if (sha256Hex(data) !== snapshot.sha256) throw Error("snapshot changed during acceptance");
      stagedFiles.push({ path: snapshot.path, data });
    }
    stagedFiles.push(
      ...[
        { path: "study.jsonl", data: Buffer.from(studyText) },
        { path: "report.html", data: Buffer.from(report.value.html) },
        { path: "report.md", data: Buffer.from(report.value.markdown) },
        { path: "evidence.json", data: Buffer.from(evidenceText) },
      ],
    );
    const plan = {
      reviewHash: review.hash,
      files: stagedFiles.map(f => ({ path: f.path, sha256: sha256Hex(f.data) })),
    };
    const planFile = safeChild(reviews, draftId + "-staging.json");
    if (existsSync(planFile)) {
      if (canonicalJson(readHostJson(planFile)) !== canonicalJson(plan))
        throw Error("accepted staging plan changed");
    } else {
      if (existsSync(staging)) throw Error("unregistered staging requires inspection");
      writeHostJson(planFile, plan);
    }
    if (!existsSync(staging)) mkdirSync(staging);
    const allowed = new Set(stagedFiles.map(f => f.path.replaceAll("\\", "/")));
    for (const f of stagedFiles) {
      let parent = dirname(f.path);
      while (parent !== ".") {
        allowed.add(parent.replaceAll("\\", "/"));
        parent = dirname(parent);
      }
    }
    for (const name of readdirSync(staging, { recursive: true }) as string[]) {
      if (!allowed.has(name.replaceAll("\\", "/"))) throw Error("unexpected accepted staging contents");
    }
    for (const f of stagedFiles) {
      const dest = safeChild(staging, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      reviewPublication.write(dest, f.data);
    }
    const latest = inspectConclusion(file, reviewerFile, draftId);
    if (
      latest.draft.hash !== review.draftHash ||
      latest.binding.configHash !== review.acknowledgedLimits.configHash ||
      latest.binding.reviewerHash !== review.acknowledgedLimits.reviewerHash
    )
      throw Error("review identity changed during publication");
    const pendingId = prepareReport(
      h.state,
      root,
      d.projectId,
      d.studyId,
      requestId,
      s.evidence.runId,
      relative(root, bundle),
      [sha256Hex(report.value.html), sha256Hex(studyText), sha256Hex(evidenceText)],
      {
        version: 2,
        sourceReportId: d.reportId,
        extraFiles: plan.files.filter(f => !["report.html", "study.jsonl", "evidence.json"].includes(f.path)),
      },
    );
    writeHostJson(publication, { reviewHash: review.hash, reportId: pendingId, status: "pending" });
    reviewPublication.rename(staging, bundle);
    const reportId = finishReport(h.state, root, d.projectId, d.studyId, requestId, s.evidence.runId)!;
    writeHostJson(publication, { reviewHash: review.hash, reportId, status: "published" });
    return { decision, draftId, reportId };
  });
  if (!result.ok) throw Error(result.errors.map(e => e.message).join("; "));
  return result.value;
}
