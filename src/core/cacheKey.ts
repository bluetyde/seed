import { canonicalJson, sha256Hex } from "./canonical";

/**
 * The cache key of a run (plan 04, "Cache key"): what a run's result depends on. Two runs with the same key were asked the same
 * question of the same software; a cache hit is shown as one, with the original run ID, and is never silent.
 *
 * Components, each of which changes the key when it changes:
 *  - the input hashes (path and sha256 of every input of the snapshot; the order of the list does not matter),
 *  - the material revisions the run read,
 *  - the mapping recipe (the digest of the transfer recipe that produced an input, if one did),
 *  - the adapter version and the engine (name and version),
 *  - the data library (id and hash),
 *  - the settings, and the seed.
 *
 * A component that is not known is left out of the key, not guessed. That means a key made without the engine version differs from one made
 * with it: they never match, so the miss is on the safe side.
 */
export type CacheKeyParts = {
  adapter: { id: string; version: string };
  inputs: { path: string; sha256: string }[];
  settings?: Record<string, unknown>;
  seed?: number;
  engine?: { name: string; version: string };
  dataLibrary?: { id: string; hash?: string };
  materialRevisions?: { material: string; revision: number }[];
  /** The sha256 digest of the transfer recipe used to produce an input. */
  mappingRecipe?: string;
};

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const byMaterial = (a: { material: string }, b: { material: string }) => (a.material < b.material ? -1 : a.material > b.material ? 1 : 0);

/** The canonical object that is hashed (also useful to show why two keys differ). */
export function cacheKeyParts(parts: CacheKeyParts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    adapter: { id: parts.adapter.id, version: parts.adapter.version },
    inputs: [...parts.inputs].sort(byPath).map((i) => ({ path: i.path, sha256: i.sha256 })),
    seed: parts.seed ?? null,
    settings: parts.settings ?? {},
  };
  if (parts.engine !== undefined) out.engine = { name: parts.engine.name, version: parts.engine.version };
  if (parts.dataLibrary !== undefined) out.dataLibrary = { id: parts.dataLibrary.id, ...(parts.dataLibrary.hash !== undefined ? { hash: parts.dataLibrary.hash } : {}) };
  if (parts.materialRevisions !== undefined && parts.materialRevisions.length > 0) {
    out.materialRevisions = [...parts.materialRevisions].sort(byMaterial).map((m) => ({ material: m.material, revision: m.revision }));
  }
  if (parts.mappingRecipe !== undefined) out.mappingRecipe = parts.mappingRecipe;
  return out;
}

export function cacheKey(parts: CacheKeyParts): string {
  return sha256Hex(canonicalJson(cacheKeyParts(parts)));
}

/** What a stored run record offers for a cache lookup (the fields of `seed.run-record/0.1` that matter). */
export type CacheCandidate = {
  runId: string;
  state: string;
  cacheKey?: string;
  finishedAt?: string;
  attempt?: number;
  /** True when a later input revision made this run's results stale. */
  stale?: boolean;
};

export type CacheLookup =
  | { hit: true; runId: string; attempt: number | null; finishedAt: string | null; note: string }
  | { hit: false; reason: string };

/**
 * Looks for a run that may stand in for a new request. Reuse is opt-in (`reuse`, the `cacheReuse` flag of the run verb, false by default),
 * only a completed, current run with the same key counts, and the answer names that run: a hit is never a silent substitution. When
 * several qualify, the most recently finished one wins (ties by run id), so the answer does not depend on the order of the listing.
 */
export function findCacheHit(candidates: readonly CacheCandidate[], key: string, opts: { reuse: boolean }): CacheLookup {
  if (!opts.reuse) return { hit: false, reason: "cache reuse was not requested" };
  const same = candidates.filter((c) => c.cacheKey === key);
  if (same.length === 0) return { hit: false, reason: "no earlier run has this cache key" };
  const usable = same.filter((c) => c.state === "completed" && c.stale !== true);
  if (usable.length === 0) {
    const states = [...new Set(same.map((c) => (c.stale === true ? `${c.state} (stale)` : c.state)))].sort();
    return { hit: false, reason: `earlier runs with this cache key are not reusable: ${states.join(", ")}` };
  }
  const best = [...usable].sort((a, b) => {
    const fa = a.finishedAt ?? "";
    const fb = b.finishedAt ?? "";
    if (fa !== fb) return fa < fb ? 1 : -1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  })[0]!;
  return {
    hit: true,
    runId: best.runId,
    attempt: best.attempt ?? null,
    finishedAt: best.finishedAt ?? null,
    note: `cache hit: results of run ${best.runId}${best.finishedAt ? ` (finished ${best.finishedAt})` : ""}, not a new calculation`,
  };
}
