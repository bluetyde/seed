import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical";
import { validateHostConfiguration } from "./fileRunHost";
import { appendMaterialsRecord, inside, readHostJson, regularFile } from "./hostFiles";
import { planMaterialMerge, type MaterialChange } from "./materialMerge";
import { openProject, saveProject } from "./projectStore";
import type { TypedError } from "./validate";

export type MaterialMergeOutcome =
  | {
      ok: true;
      /** True when nothing was written: a dry run, or entries that change nothing. */
      dryRun: boolean;
      written: boolean;
      changes: MaterialChange[];
      revisionBefore: string;
      revisionAfter: string;
    }
  | { ok: false; errors: TypedError[] };

const refuse = (message: string, code = "E_NOT_PERMITTED", field = ""): MaterialMergeOutcome => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });

/**
 * Merges the material entries of a producing app into the host's project (human-only: the admin CLI). The request holds `entries`, the `ownedSets` the
 * producer owns, and optionally `dryRun`. The merge itself is `planMaterialMerge`; the write is the project store's `saveProject`, with the revision read
 * together with the manifest, so a project that changed in between is refused (`E_STALE_REVISION`) and nothing is half written. Every outcome is one line
 * in `materials.jsonl` of the host's state folder.
 */
export function mergeMaterialsFromHost(file: string, request: unknown): MaterialMergeOutcome {
  let note: (event: Record<string, unknown>) => void = () => {};
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request)) return refuse("the request is an object with entries, ownedSets and an optional dryRun", "E_SCHEMA_INVALID");
    const r = request as { entries?: unknown; ownedSets?: unknown; dryRun?: unknown };
    if (Object.keys(r).some((k) => !["entries", "ownedSets", "dryRun"].includes(k)) || (r.dryRun !== undefined && typeof r.dryRun !== "boolean"))
      return refuse("the request has only entries, ownedSets and dryRun (true or false)", "E_SCHEMA_INVALID");
    const dryRun = r.dryRun === true;
    if (!isAbsolute(file)) return refuse("SEED_ADMIN_HOST_CONFIG must be an absolute path", "E_SETUP_REQUIRED");
    regularFile(file);
    const c = validateHostConfiguration(readHostJson(file));
    if (c.actor.kind !== "human") return refuse("materials are merged into a project only by a human host identity");
    const projectRoot = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
    if (inside(projectRoot, realpathSync(file)) || inside(projectRoot, state)) return refuse("host files must be outside the project");
    const project = openProject(projectRoot);
    if (!project.ok) return { ok: false, errors: project.errors };
    const entriesSha256 = sha256Hex(canonicalJson(r.entries ?? null));
    note = (event) => appendMaterialsRecord(state, { projectId: project.value.manifest.projectId, actor: c.actor, ownedSets: r.ownedSets, entriesSha256, dryRun, ...event });

    const plan = planMaterialMerge(project.value.manifest as Record<string, any>, r.entries, r.ownedSets);
    if (!plan.ok) {
      note({ phase: "refused", errors: plan.errors.map((e) => ({ code: e.code, field: e.field })) });
      return { ok: false, errors: plan.errors };
    }
    const before = project.value.revision;
    if (dryRun || !plan.changed) {
      note({ phase: dryRun ? "dry-run" : "unchanged", changes: plan.changes, revisionBefore: before });
      return { ok: true, dryRun, written: false, changes: plan.changes, revisionBefore: before, revisionAfter: before };
    }
    const saved = saveProject(projectRoot, plan.manifest, before, { waitMs: 5000 });
    if (!saved.ok) {
      note({ phase: "refused", errors: saved.errors.map((e) => ({ code: e.code, field: e.field })), revisionBefore: before });
      return { ok: false, errors: saved.errors };
    }
    note({ phase: "merged", changes: plan.changes, revisionBefore: before, revisionAfter: saved.value.revision });
    return { ok: true, dryRun: false, written: true, changes: plan.changes, revisionBefore: before, revisionAfter: saved.value.revision };
  } catch (e) {
    const message = e instanceof Error ? e.message : "material merge failed";
    try { note({ phase: "refused", reason: message }); } catch { /* the log cannot be written: the refusal still goes back */ }
    return refuse(message, "E_SETUP_REQUIRED");
  }
}
