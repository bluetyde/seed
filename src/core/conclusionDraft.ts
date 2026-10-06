import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";
import { validateHostConfiguration } from "./fileRunHost";
import { inside, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { openProject, withProjectLockAsync } from "./projectStore";
import { readRegisteredReport, reportReceiptFolder } from "./reportReceipt";
import { verifyStudyLog } from "./semantic";
import { evaluateGate } from "./policy";

export type ConclusionClaim = { text: string; runs: string[]; oracles: string[] };
/** Desktop text authoring automatically cites the selected protected report's run. */
export async function proposeReportConclusion(file: string, reportId: string, text: unknown) {
  if (typeof text !== "string" || !text.trim() || text.length > 2000)
    throw Error("Enter a conclusion of 1 to 2000 characters.");
  readRegisteredReport(file, reportId);
  const c = validateHostConfiguration(readHostJson(file)),
    root = realpathSync(c.projectRoot),
    state = realpathSync(c.stateRoot),
    project = openProject(root);
  if (!project.ok) throw Error("report project unavailable");
  let dir = reportReceiptFolder(state, root, project.value.manifest.projectId as string);
  if (!existsSync(dir) || !existsSync(safeChild(dir, reportId + ".json")))
    dir = safeChild(state, "reports", true);
  const receipt = readHostJson(safeChild(dir, reportId + ".json"));
  return proposeConclusion(file, { reportId, claims: [{ text, runs: [receipt.runId], oracles: [] }] });
}
export function claimsOf(value: unknown): ConclusionClaim[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw Error("draft requires 1 to 20 claims");
  return value.map(claim => {
    if (
      !claim ||
      typeof claim !== "object" ||
      Object.keys(claim).sort().join() !== "oracles,runs,text" ||
      typeof claim.text !== "string" ||
      !claim.text.trim() ||
      claim.text.length > 2000
    )
      throw Error("invalid bounded claim");
    for (const key of ["runs", "oracles"] as const) {
      if (
        !Array.isArray(claim[key]) ||
        claim[key].length > 20 ||
        new Set(claim[key]).size !== claim[key].length ||
        claim[key].some((id: unknown) => typeof id !== "string" || !id.length || id.length > 256)
      )
        throw Error("invalid claim citations");
    }
    if (!claim.runs.length && !claim.oracles.length) throw Error("each claim needs a study citation");
    return { text: claim.text, runs: [...claim.runs], oracles: [...claim.oracles] };
  });
}

/** Proposal only. No actor, time, acceptance flag, path or approval can come from a caller. */
export async function proposeConclusion(file: string, request: unknown) {
  try {
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).sort().join() !== "claims,reportId" ||
      typeof (request as any).reportId !== "string" ||
      !/^[0-9a-f]{32}$/.test((request as any).reportId)
    )
      throw Error("only reportId and claims are accepted");
    const claims = claimsOf((request as any).claims),
      reportId = (request as any).reportId;
    regularFile(file);
    const configBytes = readFileSync(file),
      configHash = sha256Hex(configBytes);
    const c = validateHostConfiguration(JSON.parse(configBytes.toString()));
    const root = realpathSync(c.projectRoot),
      state = realpathSync(c.stateRoot);
    if (inside(root, state) || inside(root, realpathSync(file)))
      throw Error("draft host configuration and state must be outside project");
    const project = openProject(root);
    if (!project.ok) return { ok: false as const, errors: project.errors };
    const result = await withProjectLockAsync(root, async () => {
      readRegisteredReport(file, reportId); // Check all original receipt bytes before reading study/evidence.
      let receipts = reportReceiptFolder(state, root, project.value.manifest.projectId as string);
      if (!existsSync(receipts) || !existsSync(safeChild(receipts, reportId + ".json")))
        receipts = safeChild(state, "reports", true);
      const receipt = readHostJson(safeChild(receipts, reportId + ".json"));
      const studyBytes = readFileSync(safeChild(root, receipt.files[1].path));
      if (sha256Hex(studyBytes) !== receipt.files[1].sha256) throw Error("source study changed");
      if (!studyBytes.toString().endsWith("\n")) throw Error("partial study log");
      const lines = studyBytes.toString().slice(0, -1).split("\n");
      if (verifyStudyLog(lines).length) throw Error("invalid source study chain");
      const entries = lines.map(line => JSON.parse(line)),
        header = entries[0];
      if (entries.some(entry => entry.type === "conclusion"))
        throw Error("source already has a finalized conclusion");
      if (
        header.studyId !== c.study.studyId ||
        header.studyId !== receipt.studyId ||
        header.projectId !== receipt.projectId
      )
        throw Error("source study scope changed");
      const evidence = readHostJson(safeChild(root, receipt.files[2].path));
      if (
        evidence.schema !== "seed.study-evidence/0.1" ||
        evidence.requestId !== receipt.requestId ||
        evidence.runId !== receipt.runId ||
        evidence.admission?.configHash !== configHash ||
        evidence.record?.runId !== receipt.runId
      )
        throw Error("source admission or configuration changed");
      const runs = new Set<string>(),
        oracles = new Set<string>();
      for (const entry of entries) {
        for (const run of entry.runs ?? []) runs.add(run);
        if (entry.oracle) oracles.add(entry.oracle.set);
      }
      for (const claim of claims) {
        if (
          claim.runs.some(id => !runs.has(id) || id !== receipt.runId) ||
          claim.oracles.some(id => !oracles.has(id))
        )
          throw Error("citation is not in the source study");
      }
      const gate = evaluateGate(
        {
          operation: "append_step",
          actor: c.actor,
          studyId: c.study.studyId,
          inputRevisions: evidence.record.inputs.map((i: any) => ({ artifact: i.path, revision: i.sha256 })),
        },
        { study: c.study, grants: c.grants },
      );
      if (!gate.allow) return { ok: false as const, errors: gate.errors };
      const body = {
        schema: "seed.conclusion-draft/0.1",
        status: "draft",
        projectRoot: root,
        projectId: receipt.projectId,
        studyId: receipt.studyId,
        reportId,
        sourceHead: entries.at(-1).hash,
        sourceFiles: receipt.files.slice(0, 3), // the three the draft reasons over; report.md is bound by the receipt itself
        configHash,
        actor: c.actor,
        claims,
        claimsHash: sha256Hex(canonicalJson(claims)),
      };
      const identity = sha256Hex(canonicalJson(body));
      const partition = safeChild(state, "conclusion-drafts", true);
      mkdirSync(partition, { recursive: true });
      const folder = safeChild(partition, sha256Hex(receipt.projectId + "\n" + root), true);
      mkdirSync(folder, { recursive: true });
      const target = safeChild(folder, identity + ".json");
      readRegisteredReport(file, reportId);
      if (sha256Hex(readFileSync(file)) !== configHash)
        throw Error("host configuration changed during proposal");
      if (existsSync(target)) {
        const saved = readHostJson(target),
          { draftId, time, hash, ...savedBody } = saved;
        if (
          canonicalJson(savedBody) !== canonicalJson(body) ||
          !/^[0-9a-f]{32}$/.test(draftId) ||
          typeof time !== "string" ||
          hash !== sha256Hex(canonicalJson({ ...savedBody, draftId, time }))
        )
          throw Error("saved draft changed; inspection required");
        return {
          ok: true as const,
          state: "conclusion-drafted",
          draftId,
          claimsHash: body.claimsHash,
          sourceHead: body.sourceHead,
        };
      }
      if (readdirSync(folder).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length >= 1000)
        throw Error("draft capacity reached; trusted archival required");
      const draft = { ...body, draftId: randomBytes(16).toString("hex"), time: new Date().toISOString() };
      writeHostJson(target, { ...draft, hash: sha256Hex(canonicalJson(draft)) });
      return {
        ok: true as const,
        state: "conclusion-drafted",
        draftId: draft.draftId,
        claimsHash: body.claimsHash,
        sourceHead: body.sourceHead,
      };
    });
    return result.ok ? result.value : { ok: false as const, errors: result.errors };
  } catch (error) {
    return {
      ok: false as const,
      errors: [
        {
          code: "E_NOT_PERMITTED",
          field: "",
          source: "seed" as const,
          message: error instanceof Error ? error.message : "conclusion draft refused",
        },
      ],
    };
  }
}
