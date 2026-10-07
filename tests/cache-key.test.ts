import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { cacheKey, cacheKeyParts, findCacheHit, type CacheCandidate, type CacheKeyParts } from "../src/core/cacheKey";
import { RunManager } from "../src/core/runManager";
import { createTempProject, type TempProject } from "./helpers/project";

// Plan 04: "Cache key includes inputs, material revisions, mapping recipe, versions, settings, seeds; one test per component."
const h = (c: string) => c.repeat(64);
const full: CacheKeyParts = {
  adapter: { id: "raft", version: "0.1.0" },
  inputs: [
    { path: "models/a.json", sha256: h("a") },
    { path: "models/b.json", sha256: h("b") },
  ],
  settings: { case: "models/a.json", threads: 2 },
  seed: 7,
  engine: { name: "raft-engine", version: "2.4.0" },
  dataLibrary: { id: "endfb-8", hash: h("c") },
  materialRevisions: [
    { material: "fuel", revision: 3 },
    { material: "clad", revision: 1 },
  ],
  mappingRecipe: h("d"),
};
const key = (p: CacheKeyParts) => cacheKey(p);
const without = (k: keyof CacheKeyParts): CacheKeyParts => {
  const c = structuredClone(full) as Record<string, unknown>;
  delete c[k];
  return c as unknown as CacheKeyParts;
};

describe("the cache key: every component changes it", () => {
  const base = key(full);

  it("is a sha256 and the same for the same parts", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(key(structuredClone(full))).toBe(base);
  });

  it.each([
    ["an input's content", (p: CacheKeyParts) => (p.inputs[0]!.sha256 = h("e"))],
    ["an input's path", (p: CacheKeyParts) => (p.inputs[1]!.path = "models/c.json")],
    ["an added input", (p: CacheKeyParts) => p.inputs.push({ path: "models/z.json", sha256: h("f") })],
    ["a removed input", (p: CacheKeyParts) => p.inputs.pop()],
    ["a material revision", (p: CacheKeyParts) => (p.materialRevisions![0]!.revision = 4)],
    ["a material's identity", (p: CacheKeyParts) => (p.materialRevisions![1]!.material = "moderator")],
    ["an added material", (p: CacheKeyParts) => p.materialRevisions!.push({ material: "gap", revision: 1 })],
    ["the mapping recipe", (p: CacheKeyParts) => (p.mappingRecipe = h("e"))],
    ["the adapter version", (p: CacheKeyParts) => (p.adapter.version = "0.1.1")],
    ["the adapter id", (p: CacheKeyParts) => (p.adapter.id = "feed")],
    ["the engine version", (p: CacheKeyParts) => (p.engine!.version = "2.4.1")],
    ["the engine name", (p: CacheKeyParts) => (p.engine!.name = "other-engine")],
    ["the data library id", (p: CacheKeyParts) => (p.dataLibrary!.id = "endfb-7")],
    ["the data library hash", (p: CacheKeyParts) => (p.dataLibrary!.hash = h("e"))],
    ["a setting's value", (p: CacheKeyParts) => (p.settings!.threads = 4)],
    ["an added setting", (p: CacheKeyParts) => (p.settings!.extra = true)],
    ["a nested setting", (p: CacheKeyParts) => ((p.settings!.nested as unknown) = { a: [1, 2] })],
    ["the seed", (p: CacheKeyParts) => (p.seed = 8)],
  ])("%s", (_name, change) => {
    const p = structuredClone(full);
    change(p);
    expect(key(p)).not.toBe(base);
  });

  it("a seed of zero is not the same as no seed (a stochastic run with no seed must not match a seeded one)", () => {
    const unset = structuredClone(full);
    delete unset.seed;
    const zero = { ...structuredClone(full), seed: 0 };
    expect(key(unset)).not.toBe(key(zero));
  });

  it.each(["engine", "dataLibrary", "materialRevisions", "mappingRecipe", "seed"] as const)("leaving out %s differs from having it (a miss, never a false hit)", (k) => {
    expect(key(without(k))).not.toBe(base);
  });
});

describe("what does not change the key", () => {
  const base = key(full);

  it("the order of the inputs", () => {
    const p = structuredClone(full);
    p.inputs.reverse();
    expect(key(p)).toBe(base);
  });

  it("the order of the materials", () => {
    const p = structuredClone(full);
    p.materialRevisions!.reverse();
    expect(key(p)).toBe(base);
  });

  it("the order of the keys inside settings", () => {
    const p = structuredClone(full);
    p.settings = { threads: 2, case: "models/a.json" };
    expect(key(p)).toBe(base);
  });

  it("no settings and an empty settings object are the same, and no materials and an empty list are the same", () => {
    const a = { ...structuredClone(full), settings: undefined, materialRevisions: [] };
    const b = { ...structuredClone(full), settings: {}, materialRevisions: undefined };
    expect(key(a)).toBe(key(b));
  });

  it("a data library without a hash is not the same as one with a hash", () => {
    const a = structuredClone(full);
    delete a.dataLibrary!.hash;
    expect(key(a)).not.toBe(base);
  });

  it("the parts that are hashed can be read back (to show why two keys differ)", () => {
    const parts = cacheKeyParts(full);
    expect(Object.keys(parts).sort()).toEqual(["adapter", "dataLibrary", "engine", "inputs", "mappingRecipe", "materialRevisions", "seed", "settings"]);
    expect((parts.inputs as { path: string }[]).map((i) => i.path)).toEqual(["models/a.json", "models/b.json"]);
  });
});

describe("a cache lookup names the run it found, and only when asked to", () => {
  const k = h("1");
  const run = (over: Partial<CacheCandidate>): CacheCandidate => ({ runId: "r-1", state: "completed", cacheKey: k, finishedAt: "2026-10-07T10:00:00Z", attempt: 1, ...over });

  it("no hit unless reuse was requested, even when a run matches", () => {
    const r = findCacheHit([run({})], k, { reuse: false });
    expect(r).toEqual({ hit: false, reason: "cache reuse was not requested" });
  });

  it("a completed, current run with the same key is a hit and says which run", () => {
    const r = findCacheHit([run({})], k, { reuse: true });
    expect(r).toMatchObject({ hit: true, runId: "r-1", attempt: 1, finishedAt: "2026-10-07T10:00:00Z" });
    if (r.hit) expect(r.note).toContain("r-1");
  });

  it("no earlier run with the key is a miss with that reason", () => {
    expect(findCacheHit([run({ cacheKey: h("2") })], k, { reuse: true })).toEqual({ hit: false, reason: "no earlier run has this cache key" });
    expect(findCacheHit([], k, { reuse: true })).toMatchObject({ hit: false });
    expect(findCacheHit([run({ cacheKey: undefined })], k, { reuse: true })).toMatchObject({ hit: false });
  });

  it.each(["failed", "cancelled", "interrupted", "terminated-by-trip", "running", "queued"])("a %s run is not reusable", (state) => {
    const r = findCacheHit([run({ state })], k, { reuse: true });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.reason).toContain(state);
  });

  it("a stale run is not reusable and is named as stale", () => {
    const r = findCacheHit([run({ stale: true })], k, { reuse: true });
    expect(r.hit).toBe(false);
    if (!r.hit) expect(r.reason).toContain("completed (stale)");
  });

  it("with several candidates the most recently finished usable one wins, whatever the order of the list", () => {
    const list = [run({ runId: "r-old", finishedAt: "2026-10-07T09:00:00Z" }), run({ runId: "r-new", finishedAt: "2026-10-07T11:00:00Z" }), run({ runId: "r-failed", state: "failed", finishedAt: "2026-10-07T12:00:00Z" })];
    for (const l of [list, [...list].reverse()]) {
      const r = findCacheHit(l, k, { reuse: true });
      expect(r).toMatchObject({ hit: true, runId: "r-new" });
    }
  });

  it("a tie in time is broken by run id, again independent of the order", () => {
    const list = [run({ runId: "r-b" }), run({ runId: "r-a" })];
    for (const l of [list, [...list].reverse()]) expect(findCacheHit(l, k, { reuse: true })).toMatchObject({ hit: true, runId: "r-a" });
  });
});

describe("the run manager records exactly this key", () => {
  const projects: TempProject[] = [];
  afterEach(async () => {
    while (projects.length > 0) await projects.pop()?.cleanup();
  });

  it("a completed run's record carries cacheKey(adapter, inputs, seed, settings)", async () => {
    const proj = createTempProject("seed-cachekey-");
    projects.push(proj);
    const content = JSON.stringify({ name: "pin", counter: 1, fake: { validate: "ok" } }) + "\n";
    proj.createFile("models/pin.json", content);
    const hash = sha256Hex(content);
    const adapter = { command: process.execPath, args: [join(__dirname, "fixtures", "fake-adapter", "cli.cjs")], id: "fake", version: "0.1.0" };
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter, pollMs: 50 });
    const settings = { scenario: "success", delayMs: 50 };
    const out = await mgr.start({
      requestId: "req-ck-1",
      actor: { kind: "human", name: "t" },
      artifact: { path: "models/pin.json", revision: { hash, counter: 1 } },
      inputs: [{ path: "models/pin.json", sha256: hash }],
      settings,
      seed: 5,
      budget: { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const record = JSON.parse(readFileSync(join(proj.root, "runs", out.runId, "run-record.json"), "utf8"));
    expect(record.cacheKey).toBe(cacheKey({ adapter: { id: "fake", version: "0.1.0" }, inputs: [{ path: "models/pin.json", sha256: hash }], settings, seed: 5 }));
    // and findCacheHit sees that run
    expect(findCacheHit([{ runId: out.runId, state: record.state, cacheKey: record.cacheKey, attempt: record.attempt }], record.cacheKey, { reuse: true })).toMatchObject({ hit: true, runId: out.runId });
  }, 30000);
});
