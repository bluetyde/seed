/**
 * Transfers (docs/transfer-recipe.md): a reviewed move of a quantity from one app's result into another app's input.
 *
 * SEED owns the recipe file, its states, the human approval record, the checks that need only SEED's records and the
 * generic data shapes, invalidation and provenance. The physical mapping and its physical checks (coverage,
 * conservation, boundary form) belong to the target app and run behind the app's own `transfer` command.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { inside, readHostJson, safeChild, writeHostJson } from "./hostFiles";
import { evaluateGate, issueGrant, type Actor, type GateContext, type Grant, type Revision } from "./policy";
import { readQuantityData, type IndexEntryView, type QuantityData } from "./quantityData";
import { parseUnit, unitMismatch, type Dimension } from "./units";
import { validate, type TypedError } from "./validate";

export type Recipe = {
  schema: "seed.transfer-recipe/0.2";
  recipeId: string;
  proposedBy: Actor;
  proposedAt: string;
  source: {
    runId: string; resultsSha256: string; quantity: string; dataSha256: string; unit: string; dimension: Dimension;
    normalization: string; revisionPins: Revision[];
  };
  target: { app: string; artifact: string; revision: string; field: string };
  units: { to: string };
  normalization: { kind: "none" | "source-rate" | "total-power"; value?: { value: number; unit: string }; origin?: string };
  mapping: { spatial: Record<string, unknown>; time: { kind: "steady" | "series"; grid?: Record<string, unknown> }; extrapolation: "refused" };
  tolerance: { conservation: number; fixedBefore: "mapping" };
  applicability?: { range?: Record<string, unknown>; note?: string };
};

export type Approval = {
  schema: "seed.transfer-approval/0.2";
  approvalId: string; projectId: string; projectRoot: string; studyId: string; recipeId: string; recipeDigest: string;
  inputRevisions: Revision[];
  approvedBy: { kind: "human"; name: string };
  grantedTo: Actor;
  approvedAt: string; expires: string; grantId: string;
};

/** A transfer that was applied: the target's revision after it, so the target moving on by itself is told from the transfer's own change. */
export type AppliedRecord = { recipeId: string; recipeDigest: string; targetRevisionAfter: string };
export type TransferState = "proposed" | "approved" | "applied" | "stale" | "invalid";

const err = (code: string, field: string, message: string, source: TypedError["source"] = "seed"): TypedError => ({ code, field, message, source });
const MAX_FILE = 8 * 1024 * 1024;

export function recipeDigest(recipe: unknown): string {
  return sha256Hex(canonicalJson(recipe));
}

/** What an approval and a grant must name: the source pins and the target's revision, exactly. */
export function recipeRevisions(recipe: Recipe): Revision[] {
  return [...recipe.source.revisionPins, { artifact: recipe.target.artifact, revision: recipe.target.revision }];
}

const sameRevisions = (a: readonly Revision[], b: readonly Revision[]): boolean => {
  const key = (r: Revision) => `${r.artifact}\u0000${r.revision}`;
  const x = new Set(a.map(key)), y = new Set(b.map(key));
  return x.size === y.size && [...x].every((k) => y.has(k));
};

// ---- the checks SEED can make from its own records ----

export type TransferView = {
  projectId: string;
  projectRoot: string;
  now: Date;
  /** The source run: the results-index text (null when the run is missing) and whether the run completed. */
  sourceIndex: string | null;
  sourceRunState: string | null;
  /** Reads a data file of the source run by the path the index gives; null when missing. */
  readData: (relPath: string) => string | null;
  /** The current revision of every artifact the recipe names. */
  currentRevisions: Record<string, string>;
  /** What the target app declared in `describe.transfers`, when known. */
  targetTransfers?: { field: string; accepts: { dimension: string; normalization?: string }[] }[];
  approvals: readonly Approval[];
  applied: readonly AppliedRecord[];
};

type Eval = { state: TransferState; errors: TypedError[]; digest: string; approval?: Approval };

/** Dimension of the mapped quantity, from the source dimension and how the recipe normalizes it. */
function resultDimensions(source: Dimension, kind: Recipe["normalization"]["kind"]): Dimension[] | string {
  if (kind === "none") return [source];
  if (kind === "total-power") return ["power", "power-per-length", "power-per-volume"];
  if (source === "energy") return ["power"];
  if (source === "count" || source === "dimensionless" || source === "probability") return ["rate"];
  return `no rule turns a ${source} score into a rate with a source rate`;
}

function checkUnitsAndNormalization(r: Recipe, indexNormalization: string | undefined): TypedError[] {
  const e: TypedError[] = [];
  const bad = unitMismatch(r.source.unit, r.source.dimension);
  if (bad) e.push(err("E_UNITS", "/source/unit", bad));
  const n = r.normalization;
  if (n.kind === "none") {
    if (indexNormalization !== undefined && indexNormalization !== "none") e.push(err("E_NORMALIZATION_MISSING", "/normalization", `the source is ${indexNormalization}; the recipe declares no normalization`));
  } else {
    if (indexNormalization === "none") e.push(err("E_UNITS", "/normalization", "the source is already absolute; a normalization would be applied twice"));
    if (!n.value || !n.origin) e.push(err("E_NORMALIZATION_MISSING", "/normalization", `${n.kind} needs a value and where it comes from`));
    else {
      const nb = unitMismatch(n.value.unit, n.kind === "source-rate" ? "rate" : "power");
      if (nb) e.push(err("E_UNITS", "/normalization/value/unit", nb));
    }
  }
  const dims = resultDimensions(r.source.dimension, n.kind);
  if (typeof dims === "string") e.push(err("E_UNITS", "/normalization", dims));
  else if (!parseUnit(r.units.to).ok || !dims.some((d) => unitMismatch(r.units.to, d) === null)) {
    e.push(err("E_UNITS", "/units/to", `${JSON.stringify(r.units.to)} is not a unit of ${dims.join(" or ")}`));
  }
  return e;
}

export function evaluateTransfer(recipeIn: unknown, view: TransferView): Eval {
  const v = validate("transfer-recipe", recipeIn);
  if (!v.ok) return { state: "invalid", errors: v.errors, digest: "" };
  const r = recipeIn as Recipe;
  const digest = recipeDigest(r);
  const invalid: TypedError[] = [];
  const stale: TypedError[] = [];

  // The source run and its result.
  let q: (IndexEntryView & { data: { path: string; sha256: string }; normalization?: string }) | undefined;
  if (view.sourceIndex === null) invalid.push(err("E_OUTPUT_INCOMPLETE", "/source/runId", "the source run has no results index"));
  else {
    let index: any;
    try { index = JSON.parse(view.sourceIndex); } catch { index = null; }
    const vi = index ? validate("results-index", index) : { ok: false as const, errors: [err("E_SCHEMA_INVALID", "/source", "the source results index is not JSON")] };
    if (!vi.ok) invalid.push(...vi.errors);
    else if (view.sourceRunState !== "completed") invalid.push(err("E_OUTPUT_INCOMPLETE", "/source/runId", `the source run is ${view.sourceRunState ?? "unknown"}, not completed`));
    else {
      if (sha256Hex(view.sourceIndex) !== r.source.resultsSha256) stale.push(err("E_STALE_REVISION", "/source/resultsSha256", "the source results differ from the ones the recipe pinned"));
      q = index.quantities.find((x: { name: string }) => x.name === r.source.quantity);
      if (!q) invalid.push(err("E_NOT_FOUND", "/source/quantity", `the source run has no quantity ${JSON.stringify(r.source.quantity)}`));
      else {
        const qd = q as any;
        if (qd.unit !== r.source.unit) invalid.push(err("E_UNITS", "/source/unit", `the result's unit is ${JSON.stringify(qd.unit)}, the recipe says ${JSON.stringify(r.source.unit)}`));
        if (qd.dimension === undefined) invalid.push(err("E_UNITS", "/source/dimension", "the source quantity declares no dimension, so it is not offered to transfers"));
        else if (qd.dimension !== r.source.dimension) invalid.push(err("E_UNITS", "/source/dimension", `the result's dimension is ${qd.dimension}, the recipe says ${r.source.dimension}`));
        if (qd.normalization !== r.source.normalization) stale.push(err("E_STALE_REVISION", "/source/normalization", "the result's normalization differs from the recipe's"));
        if (qd.data.sha256 !== r.source.dataSha256) stale.push(err("E_STALE_REVISION", "/source/dataSha256", "the source data differ from the ones the recipe pinned"));
        const text = view.readData(qd.data.path);
        if (text === null) invalid.push(err("E_OUTPUT_INCOMPLETE", "/source/dataSha256", "the source data file is missing"));
        else if (sha256Hex(text) !== qd.data.sha256) stale.push(err("E_STALE_REVISION", "/source/dataSha256", "the source data file does not match the hash in the results index"));
        else {
          const rd = readQuantityData(text, qd);
          if (!rd.ok) invalid.push(...rd.errors);
        }
      }
    }
  }
  invalid.push(...checkUnitsAndNormalization(r, q ? (q as any).normalization : undefined));

  // What the target accepts.
  if (view.targetTransfers) {
    const t = view.targetTransfers.find((x) => x.field === r.target.field);
    if (!t) invalid.push(err("E_UNSUPPORTED", "/target/field", `the target app declares no transfer ${JSON.stringify(r.target.field)}`));
    else if (!t.accepts.some((a) => a.dimension === r.source.dimension && (a.normalization === undefined || a.normalization === r.source.normalization))) {
      invalid.push(err("E_UNITS", "/target/field", `the target does not accept a ${r.source.dimension} (${r.source.normalization}) source for ${r.target.field}`));
    }
  }

  // Revisions: any change since the recipe was written makes it stale.
  r.source.revisionPins.forEach((p, i) => {
    if (view.currentRevisions[p.artifact] !== p.revision) stale.push(err("E_STALE_REVISION", `/source/revisionPins/${i}`, `${p.artifact} is not at the pinned revision`));
  });
  const appliedRec = view.applied.find((a) => a.recipeId === r.recipeId && a.recipeDigest === digest);
  const targetNow = view.currentRevisions[r.target.artifact];
  if (targetNow !== r.target.revision && !(appliedRec && targetNow === appliedRec.targetRevisionAfter)) {
    stale.push(err("E_STALE_REVISION", "/target/revision", `${r.target.artifact} is not at the pinned revision`));
  }

  if (invalid.length) return { state: "invalid", errors: [...invalid, ...stale], digest };
  if (stale.length) return { state: "stale", errors: stale, digest };

  // An applied transfer stays applied while its source and the target it produced stand, whatever became of the approval since.
  if (appliedRec) return { state: "applied", errors: [], digest };

  // Approval.
  const mine = view.approvals.filter((a) => a.recipeId === r.recipeId && a.projectId === view.projectId && a.projectRoot === view.projectRoot);
  const good = mine.find((a) => a.recipeDigest === digest && a.approvedBy.kind === "human" && Date.parse(a.expires) > view.now.getTime() && sameRevisions(a.inputRevisions, recipeRevisions(r)));
  if (!good) {
    const why = mine.length === 0 ? "the recipe has no approval"
      : !mine.some((a) => a.recipeDigest === digest) ? "the recipe changed after it was approved"
      : !mine.some((a) => a.recipeDigest === digest && Date.parse(a.expires) > view.now.getTime()) ? "the approval has expired"
      : "the approval names other revisions than the recipe's";
    return { state: "proposed", errors: [err("E_NOT_PERMITTED", "/approval", why)], digest };
  }
  return { state: "approved", errors: [], digest, approval: good };
}

// ---- pipeline graph ----

function edges(recipes: readonly Recipe[]): { from: string; to: string; id: string }[] {
  return recipes.flatMap((r) => r.source.revisionPins.map((p) => ({ from: p.artifact, to: r.target.artifact, id: r.recipeId })));
}

/** A cycle among the artifacts the recipes connect is refused at definition. */
export function checkPipeline(recipes: readonly Recipe[]): TypedError[] {
  const es = edges(recipes);
  const next = new Map<string, string[]>();
  for (const e of es) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const out: TypedError[] = [];
  const walk = (n: string, path: string[]): void => {
    state.set(n, 1);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) out.push(err("E_RECIPE_CYCLE", "/recipes", `a cycle: ${[...path.slice(path.indexOf(m)), m].join(" -> ")}`));
      else if (!state.has(m)) walk(m, [...path, m]);
    }
    state.set(n, 2);
  };
  for (const n of next.keys()) if (!state.has(n)) walk(n, [n]);
  return out;
}

/** Everything downstream of changed artifacts: the recipes that read them and, through targets, the artifacts after those. */
export function downstreamOf(recipes: readonly Recipe[], changed: readonly string[]): { recipeIds: string[]; artifacts: string[] } {
  const hit = new Set<string>(changed), ids = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const r of recipes) {
      if (r.source.revisionPins.some((p) => hit.has(p.artifact))) {
        ids.add(r.recipeId);
        if (!hit.has(r.target.artifact)) { hit.add(r.target.artifact); grew = true; }
      }
    }
  }
  return { recipeIds: [...ids].sort(), artifacts: [...hit].filter((a) => !changed.includes(a)).sort() };
}

// ---- recipe files (in the project) ----

function transfersFolder(projectRoot: string, folder: string): string {
  const root = realpathSync(projectRoot);
  const dir = join(root, folder);
  if (!inside(root, dir) || dir === root) throw Error("the transfers folder leaves the project");
  if (existsSync(dir)) {
    const s = lstatSync(dir);
    if (s.isSymbolicLink() || !s.isDirectory()) throw Error("the transfers folder must be a real folder");
  } else mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** An agent (or human) writes a recipe proposal. Needs the propose_transfer gate; the proposer must be the actor. */
export function writeRecipe(opts: { projectRoot: string; folder?: string; recipe: Recipe; actor: Actor; gate: GateContext; studyId: string }): { ok: true; path: string; digest: string } | { ok: false; errors: TypedError[] } {
  const v = validate("transfer-recipe", opts.recipe);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (opts.recipe.proposedBy.kind !== opts.actor.kind || opts.recipe.proposedBy.name !== opts.actor.name) {
    return { ok: false, errors: [err("E_NOT_PERMITTED", "/proposedBy", "a recipe is written by the actor it names as its proposer")] };
  }
  const d = evaluateGate({ operation: "propose_transfer", actor: opts.actor, studyId: opts.studyId, inputRevisions: recipeRevisions(opts.recipe) }, opts.gate);
  if (!d.allow) return { ok: false, errors: d.errors };
  const dir = transfersFolder(opts.projectRoot, opts.folder ?? "transfers");
  const file = safeChild(dir, opts.recipe.recipeId + ".json");
  writeHostJson(file, opts.recipe);
  return { ok: true, path: file, digest: recipeDigest(opts.recipe) };
}

export function readRecipes(projectRoot: string, folder = "transfers"): { recipes: Recipe[]; problems: TypedError[] } {
  const root = realpathSync(projectRoot), dir = join(root, folder);
  const recipes: Recipe[] = [], problems: TypedError[] = [];
  if (!existsSync(dir)) return { recipes, problems };
  const real = transfersFolder(projectRoot, folder);
  for (const name of readdirSync(real).filter((n) => n.endsWith(".json")).slice(0, 1000)) {
    try {
      const doc = readHostJson(safeChild(real, name));
      const v = validate("transfer-recipe", doc);
      if (!v.ok) problems.push(err("E_SCHEMA_INVALID", `/${name}`, v.errors[0]!.message));
      else if (doc.recipeId + ".json" !== name) problems.push(err("E_SCHEMA_INVALID", `/${name}`, "the file name is not the recipe id"));
      else recipes.push(doc as Recipe);
    } catch (e) { problems.push(err("E_SCHEMA_INVALID", `/${name}`, e instanceof Error ? e.message : "unreadable")); }
  }
  return { recipes, problems };
}

// ---- approval records (host state, outside the project) ----

function approvalsFolder(stateRoot: string, projectId: string, projectRoot: string, create: boolean): string | undefined {
  const parent = safeChild(stateRoot, "transfer-approvals", true);
  if (create) mkdirSync(parent, { recursive: true });
  if (!existsSync(parent)) return undefined;
  const child = safeChild(parent, sha256Hex(projectId + "\n" + projectRoot), true);
  if (create) mkdirSync(child, { recursive: true });
  return existsSync(child) ? child : undefined;
}

/** Only a human writes this. It binds the approval to the recipe's content and to the exact source and target revisions. */
export function recordApproval(opts: {
  stateRoot: string; projectRoot: string; projectId: string; studyId: string; recipe: Recipe; approver: Actor; grantedTo: Actor;
  approvalId: string; now: Date; expires: Date;
}): { ok: true; approval: Approval } | { ok: false; errors: TypedError[] } {
  const v = validate("transfer-recipe", opts.recipe);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (inside(realpathSync(opts.projectRoot), realpathSync(opts.stateRoot))) return { ok: false, errors: [err("E_PATH_INVALID", "/stateRoot", "approval records live outside the project")] };
  const revisions = recipeRevisions(opts.recipe);
  const grant = issueGrant(opts.approver, {
    grantId: "grant-" + opts.approvalId, studyId: opts.studyId, actor: { kind: opts.grantedTo.kind, name: opts.grantedTo.name }, operation: "enable_transfer",
    inputRevisions: revisions, issuedAt: opts.now.toISOString(), expires: opts.expires.toISOString()
  });
  if (!grant.ok) return grant;
  const approval: Approval = {
    schema: "seed.transfer-approval/0.2", approvalId: opts.approvalId, projectId: opts.projectId, projectRoot: opts.projectRoot, studyId: opts.studyId,
    recipeId: opts.recipe.recipeId, recipeDigest: recipeDigest(opts.recipe), inputRevisions: revisions,
    approvedBy: { kind: "human", name: opts.approver.name }, grantedTo: opts.grantedTo,
    approvedAt: opts.now.toISOString(), expires: opts.expires.toISOString(), grantId: grant.grant.grantId
  };
  const vv = validate("transfer-approval", approval);
  if (!vv.ok) return { ok: false, errors: vv.errors };
  const dir = approvalsFolder(opts.stateRoot, opts.projectId, opts.projectRoot, true)!;
  const file = safeChild(dir, opts.approvalId + ".json");
  if (existsSync(file)) return { ok: false, errors: [err("E_EXISTS", "/approvalId", "an approval with this id already exists")] };
  writeHostJson(file, approval);
  return { ok: true, approval };
}

export function listApprovals(stateRoot: string, projectId: string, projectRoot: string): { approvals: Approval[]; problems: TypedError[] } {
  const approvals: Approval[] = [], problems: TypedError[] = [];
  const dir = approvalsFolder(stateRoot, projectId, projectRoot, false);
  if (!dir) return { approvals, problems };
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).slice(0, 1000)) {
    try {
      const doc = readHostJson(safeChild(dir, name));
      const v = validate("transfer-approval", doc);
      if (!v.ok) problems.push(err("E_SCHEMA_INVALID", `/${name}`, v.errors[0]!.message));
      else if (doc.approvalId + ".json" !== name || doc.projectId !== projectId || doc.projectRoot !== projectRoot) problems.push(err("E_SCHEMA_INVALID", `/${name}`, "the approval does not belong to this file or project"));
      else approvals.push(doc as Approval);
    } catch (e) { problems.push(err("E_SCHEMA_INVALID", `/${name}`, e instanceof Error ? e.message : "unreadable")); }
  }
  return { approvals, problems };
}

/** The approvals as grants the policy gate can read: only ones that cover this exact recipe content. */
export function grantsFromApprovals(approvals: readonly Approval[], recipe: Recipe): Grant[] {
  const digest = recipeDigest(recipe);
  return approvals.filter((a) => a.recipeId === recipe.recipeId && a.recipeDigest === digest).map((a) => ({
    grantId: a.grantId, studyId: a.studyId, actor: { kind: a.grantedTo.kind, name: a.grantedTo.name }, operation: "enable_transfer" as const,
    inputRevisions: a.inputRevisions, issuedAt: a.approvedAt, expires: a.expires, approvedBy: { kind: "human" as const, name: a.approvedBy.name }
  }));
}

// ---- applying ----

export type TransferRequest = {
  schema: "seed.transfer-request/0.2";
  recipe: Recipe;
  recipeDigest: string;
  source: { quantity: IndexEntryView; data: QuantityData };
  target: { artifact: string; revision: string; content: string };
};
export type TransferReply = { ok: true; output: { content: string }; checks?: Record<string, unknown> } | { ok: false; errors: { code: string; field?: string; message: string }[] };

export type AppliedTransfer = {
  ok: true;
  content: string;
  contentSha256: string;
  provenance: { recipeId: string; recipeDigest: string; approvalId: string; sourceRunId: string; sourceResultsSha256: string; targetRevisionBefore: string; targetRevisionAfter: string };
  checks?: Record<string, unknown>;
};

/** Runs the target's `transfer` command: the request on stdin, one reply on stdout, exit 0. */
export function spawnTransferCommand(command: string, args: string[], request: TransferRequest, timeoutMs = 120000): Promise<TransferReply> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", tooBig = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const fail = (message: string) => resolve({ ok: false, errors: [{ code: "E_APP_FAILED", message }] });
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); if (out.length > MAX_FILE) { tooBig = true; child.kill(); } });
    child.on("error", (e) => { clearTimeout(timer); fail("the transfer command did not start: " + e.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tooBig) return fail("the transfer reply is too large");
      if (code !== 0) return fail(`the transfer command exited with ${code}`);
      try { resolve(JSON.parse(out.trim().split("\n").pop() ?? "") as TransferReply); } catch { fail("the transfer command did not answer with JSON"); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Applies an approved recipe: the gate (enable_transfer, through the approvals as grants), the SEED-side checks, then the
 * target's own command. Returns the new target content and the provenance; the host registers it as the target's new revision.
 */
export async function applyTransfer(opts: {
  recipe: Recipe; view: TransferView; actor: Actor; gate: GateContext; studyId: string; targetContent: string;
  run: (request: TransferRequest) => Promise<TransferReply>;
}): Promise<AppliedTransfer | { ok: false; errors: TypedError[] }> {
  const { recipe, view } = opts;
  const gate = evaluateGate(
    { operation: "enable_transfer", actor: opts.actor, studyId: opts.studyId, inputRevisions: recipeRevisions(recipe) },
    { ...opts.gate, grants: grantsFromApprovals(view.approvals, recipe), now: () => view.now }
  );
  if (!gate.allow) return { ok: false, errors: gate.errors };
  const ev = evaluateTransfer(recipe, view);
  if (ev.state === "applied") return { ok: false, errors: [err("E_EXISTS", "/recipeId", "this recipe was already applied")] };
  if (ev.state !== "approved" || !ev.approval) return { ok: false, errors: ev.errors.length ? ev.errors : [err("E_NOT_PERMITTED", "/approval", `the recipe is ${ev.state}`)] };

  const index = JSON.parse(view.sourceIndex!);
  const q = index.quantities.find((x: { name: string }) => x.name === recipe.source.quantity);
  const read = readQuantityData(view.readData(q.data.path)!, q);
  if (!read.ok) return { ok: false, errors: read.errors };
  const reply = await opts.run({ schema: "seed.transfer-request/0.2", recipe, recipeDigest: ev.digest, source: { quantity: q, data: read.data }, target: { artifact: recipe.target.artifact, revision: recipe.target.revision, content: opts.targetContent } });
  if (!reply || typeof reply !== "object" || typeof (reply as { ok?: unknown }).ok !== "boolean") return { ok: false, errors: [err("E_APP_FAILED", "/reply", "the transfer command answered with something else than a reply", "app-content")] };
  if (!reply.ok) {
    const errs = Array.isArray(reply.errors) ? reply.errors : [];
    return { ok: false, errors: (errs.length ? errs : [{ code: "E_APP_FAILED", message: "the transfer command refused without a reason" }]).slice(0, 20).map((e) => ({
      code: /^[EW]_[A-Z0-9_]{2,40}$/.test(String(e?.code)) ? String(e.code) : "E_APP_FAILED", field: typeof e?.field === "string" ? e.field : "", message: String(e?.message ?? "").slice(0, 500), source: "app-content" as const }))};
  }
  if (!reply.output || typeof reply.output.content !== "string" || reply.output.content.length === 0 || reply.output.content.length > MAX_FILE) {
    return { ok: false, errors: [err("E_APP_FAILED", "/output", "the transfer command returned no usable target content", "app-content")] };
  }
  const after = sha256Hex(reply.output.content);
  if (reply.output.content === opts.targetContent) return { ok: false, errors: [err("E_APP_FAILED", "/output", "the transfer left the target unchanged", "app-content")] };
  return {
    ok: true, content: reply.output.content, contentSha256: after, ...(reply.checks ? { checks: reply.checks } : {}),
    provenance: { recipeId: recipe.recipeId, recipeDigest: ev.digest, approvalId: ev.approval.approvalId, sourceRunId: recipe.source.runId, sourceResultsSha256: recipe.source.resultsSha256, targetRevisionBefore: recipe.target.revision, targetRevisionAfter: after }
  };
}
