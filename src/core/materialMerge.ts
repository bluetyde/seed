import { canonicalJson } from "./canonical";
import type { TypedError } from "./validate";

/**
 * Merging another app's material entries into a project (docs/material-merge.md). An app that owns a set of a material (OpenMC Studio owns
 * `openmc.composition`) produces entries `{id, revision, name, sets}`; SEED writes them into `seed.project.json` through its own project store,
 * so the one lock protocol, the stale-revision check and the revision rule of the contract (section 11) stay in one place.
 *
 * What the merge takes, and what it never does:
 *  - it takes only the **sets the caller names as the producer's own** (`ownedSets`) and the material's name. Every other set an entry carries is ignored and
 *    reported, never written: the entry holds a copy made when the producer exported, and the project may have changed since;
 *  - every set the project holds that is not named stays exactly as stored, byte for byte, including unknown sets and keys such as `__proto__`;
 *  - it never removes a material, a set or a key;
 *  - the revision is the project's: a material that changes becomes `stored revision + 1`, and the entry must say exactly that (it was made from the
 *    revision the project holds now), otherwise it is refused as stale and the producer exports again. A new material is revision 1. A material that
 *    would not change is left alone, whatever revision the entry says;
 *  - nothing is merged unless every entry is: one refusal refuses all.
 */

export type MaterialEntry = { id: string; revision: number; name: string; sets: Record<string, unknown> };
export type MaterialChange = {
  id: string;
  action: "added" | "changed" | "unchanged";
  from?: number;
  to?: number;
  nameChanged?: boolean;
  /** The owned sets written (added or changed) or confirmed (unchanged). */
  sets: string[];
  /** Sets the entry carried that were not named as the producer's own, and so were not read. */
  ignoredSets: string[];
};
export type MergePlan = { ok: true; manifest: Record<string, any>; changes: MaterialChange[]; changed: boolean } | { ok: false; errors: TypedError[] };

export const MAX_MERGE_ENTRIES = 500;
export const MAX_ENTRY_BYTES = 256 * 1024;
const SET_KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/;
const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Checks the shape of the request; the content of a set is not looked at beyond being an object with a schema string (the project schema checks the rest on save). */
function shape(entries: unknown, ownedSets: unknown): { errors: TypedError[]; entries: MaterialEntry[]; owned: string[] } {
  const errors: TypedError[] = [];
  let owned: string[] = [];
  if (!Array.isArray(ownedSets) || ownedSets.length < 1 || ownedSets.length > 8) errors.push(err("E_SCHEMA_INVALID", "/ownedSets", "name the set or sets the producer owns: 1 to 8 set names"));
  else {
    const bad = ownedSets.findIndex((s) => typeof s !== "string" || !SET_KEY.test(s));
    if (bad >= 0) errors.push(err("E_SCHEMA_INVALID", `/ownedSets/${bad}`, "a set name is a producer, a dot and a name, for example openmc.composition"));
    else if (new Set(ownedSets).size !== ownedSets.length) errors.push(err("E_SCHEMA_INVALID", "/ownedSets", "a set is named once"));
    else owned = ownedSets as string[];
  }
  const out: MaterialEntry[] = [];
  if (!Array.isArray(entries) || entries.length < 1) {
    errors.push(err("E_SCHEMA_INVALID", "/entries", "entries is a list of at least one material entry"));
    return { errors, entries: out, owned };
  }
  if (entries.length > MAX_MERGE_ENTRIES) {
    errors.push(err("E_SCHEMA_INVALID", "/entries", `at most ${MAX_MERGE_ENTRIES} entries in one merge`));
    return { errors, entries: out, owned };
  }
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const f = `/entries/${i}`;
    if (!isObject(e)) return errors.push(err("E_SCHEMA_INVALID", f, "an entry is an object"));
    const extra = Object.keys(e).filter((k) => !["id", "revision", "name", "sets"].includes(k));
    if (extra.length) return errors.push(err("E_SCHEMA_INVALID", `${f}/${extra[0]}`, `an entry has only id, revision, name and sets; not ${extra.join(", ")}`));
    if (typeof e.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.id)) return errors.push(err("E_SCHEMA_INVALID", `${f}/id`, "a material id is letters, digits, dots, underscores and dashes, at most 64, not starting with a symbol"));
    if (seen.has(e.id)) return errors.push(err("E_SCHEMA_INVALID", `${f}/id`, `the material ${e.id} is in the list twice`));
    seen.add(e.id);
    if (!Number.isSafeInteger(e.revision) || (e.revision as number) < 1) return errors.push(err("E_SCHEMA_INVALID", `${f}/revision`, "a revision is a whole number, 1 or more"));
    if (typeof e.name !== "string" || e.name.length < 1 || e.name.length > 120) return errors.push(err("E_SCHEMA_INVALID", `${f}/name`, "a name is 1 to 120 characters"));
    if (!isObject(e.sets)) return errors.push(err("E_SCHEMA_INVALID", `${f}/sets`, "sets is an object"));
    if (canonicalJson(e).length > MAX_ENTRY_BYTES) return errors.push(err("E_SCHEMA_INVALID", f, `an entry is at most ${MAX_ENTRY_BYTES} bytes`));
    if (!owned.some((k) => own(e.sets as object, k))) return errors.push(err("E_PROP_MISSING", `${f}/sets`, `the entry carries none of the producer's sets (${owned.join(", ") || "none named"}); there is nothing to merge`));
    for (const k of owned) {
      const v = own(e.sets as object, k) ? (e.sets as Record<string, unknown>)[k] : undefined;
      if (v !== undefined && (!isObject(v) || typeof v.schema !== "string" || v.schema.length < 1 || v.schema.length > 80)) errors.push(err("E_SCHEMA_INVALID", `${f}/sets/${k}`, "a set is an object with a schema string"));
    }
    out.push(e as unknown as MaterialEntry);
  });
  return { errors, entries: out, owned };
}

/**
 * Plans the merge against the manifest as it is now. Pure: the manifest is not changed (the result is a copy), nothing is read or written.
 * The caller saves `manifest` with the revision it read, so a project that changed in the meantime is refused by the store.
 */
export function planMaterialMerge(manifest: Record<string, any>, entries: unknown, ownedSets: unknown): MergePlan {
  const s = shape(entries, ownedSets);
  if (s.errors.length) return { ok: false, errors: s.errors };
  // the manifest is JSON data: a JSON round trip copies it exactly, including own keys named __proto__
  const next = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
  if (!Array.isArray(next.materials)) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/materials", "the project has no materials list")] };
  const errors: TypedError[] = [];
  const changes: MaterialChange[] = [];
  s.entries.forEach((entry, i) => {
    const f = `/entries/${i}`;
    const at = next.materials.findIndex((m: any) => m?.id === entry.id);
    const ignoredSets = Object.keys(entry.sets).filter((k) => !s.owned.includes(k)).sort();
    const given = s.owned.filter((k) => own(entry.sets, k));
    if (at < 0) {
      if (entry.revision !== 1) return void errors.push(err("E_STALE_REVISION", `${f}/revision`, `the project has no material ${entry.id}, so it is added as revision 1; the entry says revision ${entry.revision}, which was made from a material that is not there`));
      const sets: Record<string, unknown> = {};
      for (const k of given) sets[k] = entry.sets[k];
      next.materials.push({ id: entry.id, revision: 1, name: entry.name, sets });
      return void changes.push({ id: entry.id, action: "added", to: 1, sets: given, ignoredSets });
    }
    const stored = next.materials[at];
    const sets: Record<string, unknown> = { ...stored.sets };
    for (const k of given) sets[k] = entry.sets[k];
    const same = canonicalJson({ name: stored.name, sets: stored.sets }) === canonicalJson({ name: entry.name, sets });
    if (same) return void changes.push({ id: entry.id, action: "unchanged", from: stored.revision, to: stored.revision, sets: given, ignoredSets });
    if (entry.revision !== stored.revision + 1) {
      return void errors.push(err("E_STALE_REVISION", `${f}/revision`, `the project holds revision ${stored.revision} of ${entry.id}; a changed entry must be revision ${stored.revision + 1}, but this one says ${entry.revision}: it was made from another revision, so export it again from the current project`));
    }
    next.materials[at] = { ...stored, revision: stored.revision + 1, name: entry.name, sets };
    changes.push({ id: entry.id, action: "changed", from: stored.revision, to: stored.revision + 1, nameChanged: stored.name !== entry.name, sets: given, ignoredSets });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: next, changes, changed: changes.some((c) => c.action !== "unchanged") };
}
