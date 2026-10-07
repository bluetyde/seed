/**
 * Transfers through the trusted host (docs/transfer-recipe.md section 6): the same discipline as the run host. A configuration selected by the
 * trusted environment (never by a request) names the project, the state folder, the actor and the study, and for every app the oracle evidence
 * that gates it and, for a target, its `transfer` command. The agent's verbs are propose, status and apply; approval is a human verb of the admin
 * CLI and has no MCP tool. Every decision is appended to a hash-chained journal in the state folder.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson, sha256Hex } from "./canonical";
import { appendAdmission, inside, readHostJson, regularFile, safeChild, writeHostJson } from "./hostFiles";
import { loadOracleAuthority, oracleFlags, type OracleSource } from "./oracleAuthority";
import type { PinSet } from "./oracle";
import { resolveInside } from "./paths";
import type { Actor, GateContext, PolicyStudy } from "./policy";
import { openProject, saveProjectHeld, withProjectLockAsync } from "./projectStore";
import {
  applyTransfer, checkPipeline, evaluateTransfer, listApprovals, readRecipes, recipeDigest, recipeRevisions, recordApproval, spawnTransferCommand, writeRecipe,
  type AppliedRecord, type Recipe, type TransferView
} from "./transfer";
import type { TypedError } from "./validate";
import { validate } from "./validate";

export type TransferHostConfig = {
  schema: "seed.transfer-host/0.1";
  projectRoot: string;
  stateRoot: string;
  actor: Actor;
  study: PolicyStudy;
  transfersFolder?: string;
  apps: Record<string, {
    adapter: { id: string; version: string };
    oracles: OracleSource;
    acceptedPins: PinSet;
    transfer?: { command: string; args: string[]; fields: { field: string; accepts: { dimension: string; normalization?: string }[] }[]; timeoutSeconds?: number };
  }>;
};

export type HostOutcome = ({ ok: true } & Record<string, unknown>) | { ok: false; errors: TypedError[] };

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, "../../schema/common.schema.json"), "utf8")));
const check = ajv.compile(JSON.parse(readFileSync(join(__dirname, "../../schema/transfer-host.schema.json"), "utf8")));

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const fail = (code: string, message: string, field = ""): HostOutcome => ({ ok: false, errors: [err(code, field, message)] });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEXT = 8 * 1024 * 1024;

export function validateTransferHostConfig(value: unknown): TransferHostConfig {
  if (!check(value)) throw Error("invalid seed.transfer-host/0.1 configuration: " + ajv.errorsText(check.errors));
  const c = structuredClone(value) as TransferHostConfig;
  const paths = [c.projectRoot, c.stateRoot];
  for (const a of Object.values(c.apps)) paths.push(a.oracles.repository, a.oracles.entriesDir, a.oracles.inputsRoot, a.oracles.evidenceFile, ...(a.transfer ? [a.transfer.command] : []));
  if (paths.some((p) => !isAbsolute(p))) throw Error("host paths and the transfer executables must be absolute");
  const seen = new Set<string>();
  for (const b of c.study.parameters) {
    if (b.min > b.max || seen.has(b.id)) throw Error("invalid or duplicate parameter bound");
    seen.add(b.id);
  }
  return c;
}

/** Trusted setup code writes the configuration; no verb does. It must live outside the project. */
export function saveTransferHostConfig(file: string, value: unknown): void {
  const c = validateTransferHostConfig(value);
  if (!isAbsolute(file) || inside(realpathSync(c.projectRoot), realpathSync(dirname(file)))) throw Error("host configuration must live outside the project");
  writeHostJson(file, c);
}

type Ctx = {
  c: TransferHostConfig;
  project: string;
  state: string;
  projectId: string;
  folder: string;
  manifest: Record<string, any>;
  manifestRevision: string;
  journal: string;
  configHash: string;
};

function open(file: string): Ctx {
  if (!isAbsolute(file)) throw Object.assign(Error("the transfer host configuration path must be absolute"), { code: "E_SETUP_REQUIRED" });
  regularFile(file);
  const bytes = readFileSync(file);
  const c = validateTransferHostConfig(JSON.parse(bytes.toString("utf8")));
  const project = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
  if (inside(project, realpathSync(file)) || inside(project, state)) throw Error("the host configuration and state must be outside the project");
  const p = openProject(project);
  if (!p.ok) throw Object.assign(Error(p.errors[0]?.message ?? "the project cannot be opened"), { code: p.errors[0]?.code ?? "E_SETUP_REQUIRED" });
  const journal = safeChild(state, "transfer-journal", true);
  mkdirSync(journal, { recursive: true });
  return {
    c, project, state, projectId: String(p.value.manifest.projectId), folder: c.transfersFolder ?? "transfers", manifest: p.value.manifest as Record<string, any>,
    manifestRevision: p.value.revision, journal, configHash: sha256Hex(bytes)
  };
}

const audit = (x: Ctx, phase: string, event: unknown) => appendAdmission(x.journal, { phase, actor: x.c.actor, projectId: x.projectId, configHash: x.configHash, event });

/** A regular file that is not a link and whose real location is inside the project: a linked ancestor does not get a read or write out. */
function realInside(project: string, abs: string): boolean {
  try {
    return inside(realpathSync(project), realpathSync(abs));
  } catch {
    return false;
  }
}

function readText(abs: string, project: string): string | null {
  try {
    const s = lstatSync(abs);
    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_TEXT || !realInside(project, abs)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

const artifactOf = (x: Ctx, id: string): { path: string; revision: { hash: string; counter: number } } | undefined => (x.manifest.artifacts as any[]).find((a) => a.id === id);
const currentRevisions = (x: Ctx): Record<string, string> => Object.fromEntries((x.manifest.artifacts as any[]).map((a) => [a.id, a.revision.hash]));

function appliedFolder(x: Ctx, create: boolean): string | undefined {
  const parent = safeChild(x.state, "transfer-applied", true);
  if (create) mkdirSync(parent, { recursive: true });
  if (!existsSync(parent)) return undefined;
  const child = safeChild(parent, sha256Hex(x.projectId + "\n" + x.project), true);
  if (create) mkdirSync(child, { recursive: true });
  return existsSync(child) ? child : undefined;
}
function listApplied(x: Ctx): AppliedRecord[] {
  const dir = appliedFolder(x, false);
  if (!dir) return [];
  const out: AppliedRecord[] = [];
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".json")).slice(0, 1000)) {
    try {
      const d = readHostJson(safeChild(dir, n));
      if (d.schema === "seed.transfer-applied/0.2" && d.projectId === x.projectId && typeof d.recipeId === "string" && /^[0-9a-f]{64}$/.test(d.recipeDigest) && typeof d.targetRevisionAfter === "string") out.push({ recipeId: d.recipeId, recipeDigest: d.recipeDigest, targetRevisionAfter: d.targetRevisionAfter });
    } catch { /* an unreadable record is not an applied transfer */ }
  }
  return out;
}

/** The source run's results index and state, read from the project's runs folder. */
function sourceRun(x: Ctx, runId: string): { indexText: string | null; state: string | null } {
  if (!ID.test(runId)) return { indexText: null, state: null };
  const runs = (x.manifest.folders as { runs: string }).runs;
  const dir = resolveInside(x.project, runs + "/" + runId);
  if (!dir.ok) return { indexText: null, state: null };
  const indexText = readText(join(dir.value, "results.json"), x.project);
  let state: string | null = null;
  const rec = readText(join(dir.value, "run-record.json"), x.project);
  if (rec) { try { state = String(JSON.parse(rec).state); } catch { state = null; } }
  return { indexText, state };
}

function viewOf(x: Ctx, recipe: Recipe, approvals = listApprovals(x.state, x.projectId, x.project).approvals): TransferView {
  const run = sourceRun(x, recipe.source.runId);
  return {
    projectId: x.projectId, projectRoot: x.project, now: new Date(), sourceIndex: run.indexText, sourceRunState: run.state,
    readData: (rel) => {
      const abs = resolveInside(x.project, rel);
      return abs.ok ? readText(abs.value, x.project) : null;
    },
    currentRevisions: currentRevisions(x),
    artifactPaths: Object.fromEntries((x.manifest.artifacts as any[]).map((a) => [a.id, a.path])),
    targetTransfers: x.c.apps[recipe.target.app]?.transfer?.fields,
    approvals, applied: listApplied(x)
  };
}

/** The gate flags for the apps a recipe touches: the source run's adapter and the target. Throws when an app is not configured or its evidence fails. */
function gateFor(x: Ctx, recipe: Recipe, view: TransferView): GateContext {
  const ids = new Set<string>([recipe.target.app]);
  try { ids.add(String(JSON.parse(view.sourceIndex ?? "null")?.adapter?.id)); } catch { /* no index: evaluateTransfer says so */ }
  let pinsChanged = false, oracleBlocked = false;
  for (const id of ids) {
    const app = x.c.apps[id];
    if (!app) throw Object.assign(Error(`the app ${JSON.stringify(id)} is not configured for transfers`), { code: "E_SETUP_REQUIRED" });
    const auth = loadOracleAuthority(app.oracles, { id: app.adapter.id, version: app.adapter.version }, x.state);
    const flags = oracleFlags({ acceptedPins: app.acceptedPins, ...auth }, app.adapter);
    pinsChanged ||= flags.pinsChanged;
    oracleBlocked ||= flags.oracleBlocked;
  }
  return { study: x.c.study, now: () => view.now, pinsChanged, oracleBlocked };
}

function guarded(file: string, verb: string, body: (x: Ctx) => Promise<HostOutcome> | HostOutcome): Promise<HostOutcome> {
  return (async () => {
    let x: Ctx | undefined;
    try {
      x = open(file);
      return await body(x);
    } catch (e) {
      const message = e instanceof Error ? e.message : "transfer host failed";
      const code = (e as { code?: unknown })?.code;
      const out = fail(typeof code === "string" && /^[EW]_[A-Z0-9_]{2,40}$/.test(code) ? code : "E_SETUP_REQUIRED", message);
      try { if (x) audit(x, verb + "-error", { message }); } catch { /* the journal is best effort for a failed setup */ }
      return out;
    }
  })();
}

const recipeIdOf = (request: unknown): string | null => {
  const r = request as Record<string, unknown> | null;
  return r && typeof r === "object" && Object.keys(r).length === 1 && typeof r.recipeId === "string" && ID.test(r.recipeId) ? r.recipeId : null;
};
const loadRecipe = (x: Ctx, id: string): Recipe | undefined => readRecipes(x.project, x.folder).recipes.find((r) => r.recipeId === id);

/** Agent: write a recipe proposal. Refused unless it is well formed, checks out against the source run and the target, and closes no cycle. */
export function proposeTransfer(file: string, request: unknown): Promise<HostOutcome> {
  return guarded(file, "propose", (x) => {
    const r = request as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Object.keys(r).length !== 1 || !r.recipe || typeof r.recipe !== "object") return fail("E_SCHEMA_INVALID", "the request is {recipe}");
    const v = validate("transfer-recipe", r.recipe);
    if (!v.ok) return { ok: false, errors: v.errors };
    const recipe = r.recipe as Recipe;
    const view = viewOf(x, recipe);
    const ev = evaluateTransfer(recipe, view);
    audit(x, "propose-request", { recipeId: recipe.recipeId, digest: ev.digest, state: ev.state });
    // A proposal must be a recipe that could be approved: not invalid and not stale (an unapproved one is exactly what a proposal is).
    const blocking = ev.errors.filter((e) => !(ev.state === "proposed" && e.field === "/approval"));
    if (ev.state === "invalid" || ev.state === "stale") return { ok: false, errors: blocking.length ? blocking : ev.errors };
    if (ev.state === "approved" || ev.state === "applied") return fail("E_EXISTS", `this exact recipe is already ${ev.state}`, "/recipeId");
    const cycles = checkPipeline([...readRecipes(x.project, x.folder).recipes.filter((o) => o.recipeId !== recipe.recipeId), recipe]);
    if (cycles.length) return { ok: false, errors: cycles };
    const gate = gateFor(x, recipe, view);
    const w = writeRecipe({ projectRoot: x.project, folder: x.folder, recipe, actor: x.c.actor, gate, studyId: x.c.study.studyId });
    audit(x, "propose-outcome", w.ok ? { ok: true, recipeId: recipe.recipeId, digest: w.digest } : { ok: false, errors: w.errors });
    return w.ok ? { ok: true, recipeId: recipe.recipeId, digest: w.digest, state: "proposed" } : { ok: false, errors: w.errors };
  });
}

/** Read-only: where a recipe stands and why. */
export function transferStatus(file: string, request: unknown): Promise<HostOutcome> {
  return guarded(file, "status", (x) => {
    const id = recipeIdOf(request);
    if (!id) return fail("E_SCHEMA_INVALID", "the request is {recipeId}");
    const recipe = loadRecipe(x, id);
    if (!recipe) return fail("E_NOT_FOUND", `no recipe ${id}`, "/recipeId");
    const ev = evaluateTransfer(recipe, viewOf(x, recipe));
    return { ok: true, recipeId: id, state: ev.state, digest: ev.digest, errors: ev.errors, ...(ev.approval ? { approval: { approvalId: ev.approval.approvalId, approvedBy: ev.approval.approvedBy, expires: ev.approval.expires } } : {}) };
  });
}

/** Human, admin CLI only: approve exactly this recipe content, for the proposer, until an expiry. Refused for anything that is not a clean proposal. */
export function approveTransfer(file: string, request: unknown): Promise<HostOutcome> {
  return guarded(file, "approve", (x) => {
    const r = request as Record<string, unknown> | null;
    const allowed = new Set(["recipeId", "recipeDigest", "expiresInHours", "approvalId"]);
    if (!r || typeof r !== "object" || Object.keys(r).some((k) => !allowed.has(k)) || typeof r.recipeId !== "string" || !ID.test(r.recipeId) || typeof r.recipeDigest !== "string" || !/^[0-9a-f]{64}$/.test(r.recipeDigest)) {
      return fail("E_SCHEMA_INVALID", "the request is {recipeId, recipeDigest, expiresInHours?, approvalId?}: the digest is the one the reviewer read");
    }
    const hours = r.expiresInHours === undefined ? 24 : r.expiresInHours;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 168) return fail("E_SCHEMA_INVALID", "expiresInHours is a number above 0 and at most 168", "/expiresInHours");
    const recipe = loadRecipe(x, r.recipeId);
    if (!recipe) return fail("E_NOT_FOUND", `no recipe ${r.recipeId}`, "/recipeId");
    if (recipeDigest(recipe) !== r.recipeDigest) return fail("E_STALE_REVISION", "the recipe is not the one that was reviewed (its digest differs)", "/recipeDigest");
    const view = viewOf(x, recipe);
    const ev = evaluateTransfer(recipe, view);
    if (ev.state !== "proposed") return { ok: false, errors: ev.errors.length ? ev.errors : [err("E_EXISTS", "/recipeId", `the recipe is ${ev.state}, not a proposal`)] };
    const now = new Date();
    const approvalId = typeof r.approvalId === "string" ? r.approvalId : "appr-" + randomBytes(6).toString("hex");
    if (!ID.test(approvalId)) return fail("E_SCHEMA_INVALID", "approvalId is an id", "/approvalId");
    const out = recordApproval({
      stateRoot: x.state, projectRoot: x.project, projectId: x.projectId, studyId: x.c.study.studyId, recipe, approver: x.c.actor, grantedTo: recipe.proposedBy,
      approvalId, now, expires: new Date(now.getTime() + hours * 3600e3)
    });
    audit(x, "approve-outcome", out.ok ? { ok: true, approvalId, recipeId: recipe.recipeId, digest: r.recipeDigest, revisions: out.approval.inputRevisions } : { ok: false, errors: out.errors });
    return out.ok ? { ok: true, approval: out.approval } : { ok: false, errors: out.errors };
  });
}

/** Agent: apply an approved recipe. The target's own command maps; SEED writes the new target file and revision, and records provenance. */
export function applyTransferFromHost(file: string, request: unknown): Promise<HostOutcome> {
  return guarded(file, "apply", async (x) => {
    const id = recipeIdOf(request);
    if (!id) return fail("E_SCHEMA_INVALID", "the request is {recipeId}");
    const recipe = loadRecipe(x, id);
    if (!recipe) return fail("E_NOT_FOUND", `no recipe ${id}`, "/recipeId");
    const app = x.c.apps[recipe.target.app];
    if (!app?.transfer) return fail("E_SETUP_REQUIRED", `the app ${recipe.target.app} has no transfer command configured`, "/target/app");
    const target = artifactOf(x, recipe.target.artifact);
    if (!target) return fail("E_NOT_FOUND", `the target artifact ${recipe.target.artifact} is not in the project`, "/target/artifact");
    const abs = resolveInside(x.project, target.path);
    if (!abs.ok) return { ok: false, errors: [err(abs.error.code, "/target/artifact", abs.error.message)] };
    const targetContent = readText(abs.value, x.project);
    if (targetContent === null) return fail("E_NOT_FOUND", "the target file cannot be read", "/target/artifact");
    if (sha256Hex(targetContent) !== target.revision.hash) return fail("E_STALE_REVISION", "the target file does not match the revision the project records", "/target/revision");
    const view = viewOf(x, recipe);
    const gate = gateFor(x, recipe, view);
    // Writing a new target revision is a new_revision in effect: a failed oracle set or changed pins stop it as they stop a proposal.
    if (gate.oracleBlocked || gate.pinsChanged) {
      audit(x, "apply-refused", { recipeId: id, reason: "oracle set not clear or pins changed" });
      return fail("E_NOT_PERMITTED", "an oracle set of the source or target app is not clear, or its pins changed since a human accepted them", "/oracles");
    }
    audit(x, "apply-request", { recipeId: id, digest: recipeDigest(recipe), revisions: recipeRevisions(recipe) });
    const spec = app.transfer;
    const out = await applyTransfer({
      recipe, view, actor: x.c.actor, gate, studyId: x.c.study.studyId, targetContent,
      run: (req) => spawnTransferCommand(spec.command, spec.args, req, (spec.timeoutSeconds ?? 120) * 1000)
    });
    if (!out.ok) {
      audit(x, "apply-refused", { recipeId: id, errors: out.errors });
      return { ok: false, errors: out.errors };
    }
    // The commit is one critical section under the project's writer lock: everything the approval stood on (every source pin, the target, the data,
    // the approval itself) is checked again against fresh state, then the file and its revision change together. Nothing else can commit in
    // between, so a rollback can only ever undo this call's own write.
    const tmp = abs.value + ".transfer-" + randomBytes(6).toString("hex");
    let committed = false;
    let failure: HostOutcome | undefined;
    const locked = await withProjectLockAsync(x.project, async () => {
      try {
        const now = open(file);
        const ev2 = evaluateTransfer(recipe, viewOf(now, recipe));
        if (ev2.state !== "approved") {
          failure = { ok: false, errors: ev2.errors.length ? ev2.errors : [err("E_STALE_REVISION", "/recipeId", `the recipe is ${ev2.state}, not approved, at the moment of the commit`)] };
          return;
        }
        const fresh = openProject(x.project);
        if (!fresh.ok) throw Error("the project cannot be reopened");
        const art = (fresh.value.manifest.artifacts as any[]).find((a) => a.id === recipe.target.artifact);
        if (!art || art.revision.hash !== target.revision.hash || !realInside(x.project, abs.value) || readText(abs.value, x.project) !== targetContent) {
          throw Object.assign(Error("the target changed while the transfer ran"), { code: "E_STALE_REVISION" });
        }
        writeFileSync(tmp, out.content, { flag: "wx" });
        renameSync(tmp, abs.value);
        const manifest = structuredClone(fresh.value.manifest) as Record<string, any>;
        const entry = (manifest.artifacts as any[]).find((a) => a.id === recipe.target.artifact);
        entry.revision = { hash: out.contentSha256, counter: art.revision.counter + 1 };
        const saved = saveProjectHeld(x.project, manifest, fresh.value.revision);
        if (!saved.ok) {
          writeFileSync(abs.value + ".restore", targetContent, { flag: "w" });
          renameSync(abs.value + ".restore", abs.value);
          throw Object.assign(Error("the project could not record the new revision: " + (saved.errors[0]?.message ?? "")), { code: saved.errors[0]?.code });
        }
        committed = true;
      } finally {
        if (existsSync(tmp)) rmSync(tmp, { force: true });
      }
    }).catch((e) => ({ ok: false as const, errors: [err(typeof (e as any)?.code === "string" && /^[EW]_[A-Z0-9_]{2,40}$/.test((e as any).code) ? (e as any).code : "E_INTERNAL", "", e instanceof Error ? e.message : "the transfer could not be written")] }));
    if (failure) {
      audit(x, "apply-refused", { recipeId: id, errors: (failure as { errors: TypedError[] }).errors, at: "commit" });
      return failure;
    }
    // Releasing the lock can fail after the work was committed: that is a committed transfer with a warning, not a failed one.
    if (!committed) {
      audit(x, "apply-failed", { recipeId: id, errors: (locked as { errors?: TypedError[] }).errors });
      return { ok: false, errors: (locked as { errors?: TypedError[] }).errors ?? [err("E_INTERNAL", "", "the transfer could not be written")] };
    }
    const incomplete: string[] = [];
    if (!locked.ok) incomplete.push("the writer lock could not be released cleanly: " + (locked.errors[0]?.message ?? ""));
    const record = {
      schema: "seed.transfer-applied/0.2", projectId: x.projectId, ...out.provenance, appliedAt: new Date().toISOString(), actor: x.c.actor,
      checks: out.checks ?? null, targetPath: target.path, resultSha256: sha256Hex(canonicalJson(out.provenance))
    };
    try {
      const dir = appliedFolder(x, true)!;
      writeHostJson(safeChild(dir, `${id}-${out.provenance.recipeDigest.slice(0, 16)}.json`), record);
    } catch (e) {
      incomplete.push("the applied record could not be written (the recipe will show as stale until it is): " + (e instanceof Error ? e.message : String(e)));
    }
    try {
      audit(x, "apply-outcome", { ok: true, ...out.provenance, ...(incomplete.length ? { incomplete } : {}) });
    } catch (e) {
      incomplete.push("the journal entry could not be appended: " + (e instanceof Error ? e.message : String(e)));
    }
    return { ok: true, recipeId: id, state: "applied", ...(incomplete.length ? { incomplete } : {}), provenance: out.provenance, checks: out.checks ?? null, target: { artifact: recipe.target.artifact, path: target.path, revision: { hash: out.contentSha256, counter: target.revision.counter + 1 } } };
  });
}
