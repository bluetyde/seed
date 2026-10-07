import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest, validateRecordKinds, type Installed, type Manifest, type Platform, type RecordRegistry } from "../src/core/components";
import { componentsSatisfying, resolveChain, validateSuite, type ChainRequest } from "../src/core/packages";

// Cross-app packages (docs/packages-cross-app.md): the chains the research session named, on fake manifests of five apps.
const linux: Platform = { os: "linux", arch: "x64" };
const appVersions = { studio: "1.0.0", raft: "1.0.0", feed: "1.0.0", sneed: "1.0.0", nodal: "1.0.0" };
let n = 0;
const sha = () => (++n).toString(16).padStart(64, "0");
const comp = (id: string, kind: "core" | "addon" | "library", extra: Record<string, unknown> = {}, bytes = 1000) => ({
  id, version: "1.0.0", kind, title: id, platforms: [{ os: "linux", arch: "x64" }], capabilities: [id],
  artifacts: [{ id: id + "-pack", sha256: sha(), downloadBytes: bytes, expandedBytes: bytes * 3, archive: "tar.gz" }],
  license: { spdx: "MIT" }, ...extra
});
const manifest = (app: string, components: unknown[], schema = "seed.component-manifest/0.2") => ({ schema, app, recipeRevision: "r1", components });
const valid = (m: unknown): Manifest => {
  const v = validateManifest(m);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.manifest;
};

const registry: RecordRegistry = {
  schema: "seed.record-kinds/0.1",
  kinds: [
    { record: "depletion-record", version: 1, owner: "studio", status: "planned", summary: "depletion", manual: "Run a depletion in Studio and save its record." },
    { record: "th-result", version: 1, owner: "nodal", status: "planned", summary: "thermal-hydraulic result", manual: "Run a loop in NODAL or RAFT and save the result." }
  ]
};

function suite(over: { dropDepletion?: boolean } = {}): Manifest[] {
  const studio = manifest("studio", [
    comp("studio-core", "core", {}, 100),
    comp("openmc-env", "library", { satisfies: ["conda-env"] }, 2_000_000),
    comp("chain-file", "library", {}, 27_500_000),
    ...(over.dropDepletion ? [] : [comp("studio-depletion", "addon", { produces: [{ record: "depletion-record", version: 1 }], dependsOn: [{ component: "studio-core" }, { component: "chain-file" }, { component: "openmc-env" }] }, 5000)]),
    comp("studio-cad", "addon", { dependsOn: [{ component: "studio-core" }] }, 40_000)
  ]);
  const raft = manifest("raft", [
    comp("raft-core", "core", { produces: [{ record: "th-result", version: 1 }] }, 300),
    comp("raft-burnup", "addon", { consumes: [{ record: "depletion-record", minVersion: 1 }], dependsOn: [{ component: "raft-core" }] }, 800),
    comp("raft-ai-operator", "addon", { dependsOn: [{ component: "raft-core" }] }, 4_700_000)
  ]);
  const feed = manifest("feed", [
    comp("feed-core", "core", {}, 200),
    comp("feed-burnup", "addon", { consumes: [{ record: "depletion-record", minVersion: 1, maxVersion: 1 }], dependsOn: [{ component: "feed-core" }] }, 600)
  ]);
  const nodal = manifest("nodal", [comp("nodal-core", "core", { produces: [{ record: "th-result", version: 1 }] }, 400)]);
  const sneed = manifest("sneed", [
    comp("sneed-core", "core", {}, 150),
    comp("sneed-th-link", "addon", { consumes: [{ record: "th-result", minVersion: 1 }], dependsOn: [{ component: "sneed-core" }] }, 90)
  ]);
  return [studio, raft, feed, nodal, sneed].map(valid);
}
const base = (over: Partial<ChainRequest> = {}): ChainRequest => ({ manifests: suite(), registry, installed: [], select: [], platform: linux, appVersions, ...over });
const rec = (app: string, component: string, over: Partial<Installed> = {}): Installed => ({
  app, component, version: "1.0.0", origin: "managed", location: `/seed/${app}/${component}`, manifestSha256: "a".repeat(64), selectedByUser: false, installedAt: "2026-10-07T00:00:00Z", ...over
});
const names = (r: ReturnType<typeof resolveChain>) => (r.ok ? r.steps.map((s) => `${s.action}:${s.app}/${s.component}`) : []);
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));

describe("the registry of record kinds", () => {
  it("the shipped record-kinds.json is valid and names the depletion record", () => {
    const v = validateRecordKinds(JSON.parse(readFileSync(join(__dirname, "..", "record-kinds.json"), "utf8")));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.registry.kinds.map((k) => `${k.record}@${k.version}`)).toContain("depletion-record@1");
  });

  it.each([
    ["an unknown schema version", (r: any) => (r.schema = "seed.record-kinds/0.2")],
    ["an extra field", (r: any) => (r.kinds[0].installCommand = "x")],
    ["a record listed twice at one version", (r: any) => r.kinds.push(structuredClone(r.kinds[0]))],
    ["a defined kind without its schema hash", (r: any) => (r.kinds[0].status = "defined")],
    ["a kind with no way to make it by hand", (r: any) => delete r.kinds[0].manual],
    ["a version of 0", (r: any) => (r.kinds[0].version = 0)],
    ["an id with a space", (r: any) => (r.kinds[0].record = "depletion record")]
  ])("%s is refused", (_n, f) => {
    const r = JSON.parse(JSON.stringify(registry));
    f(r);
    expect(validateRecordKinds(r).ok).toBe(false);
  });

  it("a defined kind that names its wire schema and pins the hash is fine", () => {
    const r = JSON.parse(JSON.stringify(registry));
    r.kinds[0].status = "defined";
    r.kinds[0].wireSchema = "studio.depletion/0.1";
    r.kinds[0].schemaSha256 = "b".repeat(64);
    expect(validateRecordKinds(r).ok).toBe(true);
  });

  it("the same record at two versions is two entries", () => {
    const r = JSON.parse(JSON.stringify(registry));
    r.kinds.push({ ...r.kinds[0], version: 2 });
    expect(validateRecordKinds(r).ok).toBe(true);
  });
});

describe("manifest v0.2", () => {
  const m = (c: unknown, schema = "seed.component-manifest/0.2") => manifest("x", [comp("x-core", "core"), c], schema);

  it("a v0.1 manifest keeps its meaning: it may not carry produces, consumes or satisfies", () => {
    for (const extra of [{ produces: [{ record: "r", version: 1 }] }, { consumes: [{ record: "r", minVersion: 1 }] }, { satisfies: ["conda-env"] }]) {
      expect(validateManifest(m(comp("x-add", "addon", extra), "seed.component-manifest/0.1")).ok).toBe(false);
    }
    expect(validateManifest(m(comp("x-add", "addon"), "seed.component-manifest/0.1")).ok).toBe(true);
  });

  it("the same fields in a v0.2 manifest are accepted where they belong", () => {
    expect(validateManifest(m(comp("x-add", "addon", { produces: [{ record: "r", version: 1 }], consumes: [{ record: "q", minVersion: 1, maxVersion: 2 }] }))).ok).toBe(true);
    expect(validateManifest(m(comp("x-lib", "library", { satisfies: ["conda-env"] }))).ok).toBe(true);
  });

  it.each([
    ["a core that needs another app's record (the base app must run alone)", (c: any) => ({ ...c, kind: "core" }), { consumes: [{ record: "r", minVersion: 1 }] }, "E_COMPONENT_DEPENDENCY"],
    ["a library that needs a record", (c: any) => c, { __kind: "library", consumes: [{ record: "r", minVersion: 1 }] }, "E_COMPONENT_DEPENDENCY"],
    ["a library that makes a record", (c: any) => c, { __kind: "library", produces: [{ record: "r", version: 1 }] }, "E_COMPONENT_DEPENDENCY"],
    ["an add-on that satisfies a prerequisite", (c: any) => c, { satisfies: ["conda-env"] }, "E_COMPONENT_DEPENDENCY"],
    ["the same record needed twice", (c: any) => c, { consumes: [{ record: "r", minVersion: 1 }, { record: "r", minVersion: 2 }] }, "E_SCHEMA_INVALID"],
    ["the same record version made twice", (c: any) => c, { produces: [{ record: "r", version: 1 }, { record: "r", version: 1 }] }, "E_SCHEMA_INVALID"],
    ["a maximum version below the minimum", (c: any) => c, { consumes: [{ record: "r", minVersion: 3, maxVersion: 2 }] }, "E_RECORD_VERSION"],
    ["a prerequisite listed twice", (c: any) => c, { __kind: "library", satisfies: ["conda-env", "conda-env"] }, "E_SCHEMA_INVALID"]
  ])("%s is refused", (_n, _f, extra: any, code) => {
    const { __kind, ...rest } = extra;
    const kind = _n.startsWith("a core") ? "core" : (__kind ?? "addon");
    const bad = comp("x-bad", kind, rest);
    const manifestWith = kind === "core" ? manifest("x", [comp("x-core", "core"), bad]) : m(bad);
    const r = validateManifest(manifestWith);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });

  it("a record id or version outside the pattern is refused by the schema", () => {
    for (const extra of [{ produces: [{ record: "Bad Id", version: 1 }] }, { produces: [{ record: "r", version: 0 }] }, { consumes: [{ record: "r", minVersion: 1.5 }] }, { produces: [{ record: "r", version: 1, extra: 1 }] }]) {
      expect(validateManifest(m(comp("x-add", "addon", extra))).ok).toBe(false);
    }
  });
});

describe("the suite together", () => {
  it("the five fake apps are valid together", () => {
    expect(validateSuite(suite(), registry)).toEqual([]);
  });

  it("a record that is not in the registry, a version it does not have, and an unregistered produced version are refused", () => {
    const unknown = suite();
    unknown[1]!.components[1]!.consumes![0]!.record = "mystery";
    expect(validateSuite(unknown, registry).map((e) => e.code)).toEqual(["E_RECORD_UNKNOWN"]);
    const tooNew = suite();
    tooNew[1]!.components[1]!.consumes![0]!.minVersion = 2;
    expect(validateSuite(tooNew, registry).map((e) => e.code)).toEqual(["E_RECORD_VERSION"]);
    const madeUnregistered = suite();
    madeUnregistered[0]!.components[3]!.produces![0]!.version = 7;
    expect(validateSuite(madeUnregistered, registry).map((e) => e.code)).toEqual(["E_RECORD_VERSION"]);
    const madeUnknown = suite();
    madeUnknown[0]!.components[3]!.produces![0]!.record = "mystery";
    expect(validateSuite(madeUnknown, registry).map((e) => e.code)).toEqual(["E_RECORD_UNKNOWN"]);
  });

  it("two manifests for one app are refused", () => {
    expect(validateSuite([...suite(), suite()[0]!], registry).map((e) => e.code)).toContain("E_SCHEMA_INVALID");
  });

  it("an unavoidable cycle across apps is named: each needs a record only the other makes", () => {
    const reg: RecordRegistry = { ...registry, kinds: [...registry.kinds, { record: "a-rec", version: 1, owner: "a", status: "planned", summary: "a", manual: "m" }, { record: "b-rec", version: 1, owner: "b", status: "planned", summary: "b", manual: "m" }] };
    const a = valid(manifest("a", [comp("a-core", "core"), comp("a-add", "addon", { produces: [{ record: "a-rec", version: 1 }], consumes: [{ record: "b-rec", minVersion: 1 }], dependsOn: [{ component: "a-core" }] })]));
    const b = valid(manifest("b", [comp("b-core", "core"), comp("b-add", "addon", { produces: [{ record: "b-rec", version: 1 }], consumes: [{ record: "a-rec", minVersion: 1 }], dependsOn: [{ component: "b-core" }] })]));
    const errs = validateSuite([a, b], reg);
    expect(errs.map((e) => e.code)).toEqual(["E_COMPONENT_CYCLE"]);
    expect(errs[0]!.message).toMatch(/a\/a-add -> b\/b-add -> a\/a-add|b\/b-add -> a\/a-add -> b\/b-add/);
  });

  it("two possible producers are not a cycle: the user can choose", () => {
    expect(validateSuite(suite(), registry)).toEqual([]);
  });
});

describe("a chain across apps", () => {
  it("RAFT burnup alone brings Studio's depletion package with the chain file and the environment, producer before consumer, and says so", () => {
    const r = resolveChain(base({ select: [{ app: "raft", component: "raft-burnup" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = names(r);
    expect(order.sort()).toEqual(
      ["install:raft/raft-burnup", "install:raft/raft-core", "install:studio/chain-file", "install:studio/openmc-env", "install:studio/studio-core", "install:studio/studio-depletion"].sort()
    );
    const idx = (k: string) => r.steps.findIndex((s) => `${s.app}/${s.component}` === k);
    expect(idx("studio/studio-depletion")).toBeLessThan(idx("raft/raft-burnup"));
    expect(idx("studio/chain-file")).toBeLessThan(idx("studio/studio-depletion"));
    expect(idx("studio/studio-core")).toBeLessThan(idx("studio/studio-depletion"));
    expect(r.chain).toEqual([{ consumer: "raft/raft-burnup", record: "depletion-record", minVersion: 1, producer: "studio/studio-depletion", how: "added" }]);
    expect(r.steps.filter((s) => s.selectedByUser).map((s) => s.component)).toEqual(["raft-burnup"]); // only what the user chose; cores, libraries and producers are not choices
    expect(r.steps.find((s) => s.component === "studio-depletion")!.selectedByUser).toBe(false);
  });

  it("the cost is the sum over the whole chain, and one grant names every component that would be installed", () => {
    const r = resolveChain(base({ select: [{ app: "raft", component: "raft-burnup" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parts = [300, 800, 100, 5000, 27_500_000, 2_000_000];
    expect(r.cost.downloadBytes).toBe(parts.reduce((a, b) => a + b, 0));
    expect(r.cost.expandedBytes).toBe(parts.reduce((a, b) => a + b, 0) * 3);
    expect(r.grant.map((g) => `${g.app}/${g.component}`).sort()).toEqual(["raft/raft-burnup", "raft/raft-core", "studio/chain-file", "studio/openmc-env", "studio/studio-core", "studio/studio-depletion"]);
  });

  it("RAFT and FEED burnup together share one depletion package: it is in the plan once and costs once", () => {
    const r = resolveChain(base({ select: [{ app: "raft", component: "raft-burnup" }, { app: "feed", component: "feed-burnup" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.filter((s) => s.component === "studio-depletion")).toHaveLength(1);
    expect(r.chain.map((e) => `${e.consumer}->${e.producer}:${e.how}`)).toEqual(["feed/feed-burnup->studio/studio-depletion:added", "raft/raft-burnup->studio/studio-depletion:added"]);
    expect(r.cost.downloadBytes).toBe(300 + 800 + 100 + 5000 + 27_500_000 + 2_000_000 + 200 + 600);
  });

  it("a producer that is installed already costs nothing and is not in the grant", () => {
    const installed = [rec("studio", "studio-core"), rec("studio", "chain-file"), rec("studio", "openmc-env"), rec("studio", "studio-depletion", { selectedByUser: true })];
    const r = resolveChain(base({ installed, select: [{ app: "raft", component: "raft-burnup" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ producer: "studio/studio-depletion", how: "installed" });
    expect(r.grant.map((g) => `${g.app}/${g.component}`).sort()).toEqual(["raft/raft-burnup", "raft/raft-core"]);
    expect(r.cost.downloadBytes).toBe(300 + 800);
  });

  it("the user may choose the producer too: it is then chosen by the user, and the edge says so", () => {
    const r = resolveChain(base({ select: [{ app: "raft", component: "raft-burnup" }, { app: "studio", component: "studio-depletion" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ how: "chosen" });
    expect(r.steps.find((s) => s.component === "studio-depletion")!.selectedByUser).toBe(true);
  });

  it("an add-on with no record to find does not pull in anything from another app", () => {
    const r = resolveChain(base({ select: [{ app: "raft", component: "raft-ai-operator" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => s.app)).toEqual(["raft", "raft"]);
    expect(r.chain).toEqual([]);
  });

  it("nothing chosen installs only each app's core... and here, with no app chosen, nothing at all", () => {
    const r = resolveChain(base());
    expect(r).toMatchObject({ ok: true, steps: [], grant: [], cost: { downloadBytes: 0, expandedBytes: 0 } });
  });

  describe("when no producer can be found", () => {
    it("a record no package makes is refused naming the record and how to make it by hand", () => {
      const r = resolveChain(base({ manifests: suite({ dropDepletion: true }), select: [{ app: "raft", component: "raft-burnup" }] }));
      expect(codes(r)).toEqual(["E_RECORD_NO_PRODUCER"]);
      if (!r.ok) {
        expect(r.errors[0]!.message).toContain("depletion-record");
        expect(r.errors[0]!.message).toContain("Run a depletion in Studio");
      }
    });

    it("a producer that is not available on this platform is as good as none", () => {
      const r = resolveChain(base({ platform: { os: "macos", arch: "arm64" }, select: [{ app: "raft", component: "raft-burnup" }] }));
      expect(r.ok).toBe(false);
    });

    it("a producer whose app version is out of its range is as good as none", () => {
      const ms = suite();
      ms[0]!.components.find((c) => c.id === "studio-depletion")!.appVersions = { min: "2.0.0" };
      const r = resolveChain(base({ manifests: ms, select: [{ app: "raft", component: "raft-burnup" }] }));
      expect(codes(r)).toEqual(["E_RECORD_NO_PRODUCER"]);
    });
  });

  describe("when several packages could make the record", () => {
    const select = [{ app: "sneed", component: "sneed-th-link" }];

    it("is never guessed: both are named and the user must choose", () => {
      const r = resolveChain(base({ select }));
      expect(codes(r)).toEqual(["E_RECORD_AMBIGUOUS"]);
      if (!r.ok) expect(r.errors[0]!.message).toMatch(/nodal\/nodal-core or raft\/raft-core/);
    });

    it("the choice adds that producer's core and nothing of the other", () => {
      const r = resolveChain(base({ select, producerChoice: { "th-result": "nodal/nodal-core" } }));
      expect(r.ok).toBe(true);
      expect(names(r).sort()).toEqual(["install:nodal/nodal-core", "install:sneed/sneed-core", "install:sneed/sneed-th-link"]);
    });

    it("a choice that is not a producer of that record is refused, and so is a choice for a producer that is not usable", () => {
      expect(codes(resolveChain(base({ select, producerChoice: { "th-result": "feed/feed-core" } })))).toEqual(["E_RECORD_AMBIGUOUS"]);
      expect(codes(resolveChain(base({ select, producerChoice: { "th-result": "nowhere/x" } })))).toEqual(["E_RECORD_AMBIGUOUS"]);
    });

    it("an installed producer settles it without a choice", () => {
      const r = resolveChain(base({ select, installed: [rec("nodal", "nodal-core")] }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.chain[0]).toMatchObject({ producer: "nodal/nodal-core", how: "installed" });
    });
  });

  describe("cycles in the chosen chain", () => {
    it("a choice that makes a loop is refused with the loop named, although each manifest is fine alone", () => {
      const reg: RecordRegistry = { ...registry, kinds: [...registry.kinds, { record: "s-rec", version: 1, owner: "a", status: "planned", summary: "s", manual: "m" }, { record: "r-rec", version: 1, owner: "b", status: "planned", summary: "r", manual: "m" }] };
      const a = valid(manifest("a", [comp("a-core", "core"), comp("a-add", "addon", { produces: [{ record: "s-rec", version: 1 }], consumes: [{ record: "r-rec", minVersion: 1 }], dependsOn: [{ component: "a-core" }] })]));
      const b = valid(manifest("b", [comp("b-core", "core"), comp("b-add", "addon", { produces: [{ record: "r-rec", version: 1 }], consumes: [{ record: "s-rec", minVersion: 1 }], dependsOn: [{ component: "b-core" }] })]));
      // a-add needs r-rec (only b-add makes it) and b-add needs s-rec (only a-add makes it): an unavoidable loop, caught before planning
      expect(codes(resolveChain({ ...base(), manifests: [a, b], registry: reg, select: [{ app: "a", component: "a-add" }], appVersions: { a: "1.0.0", b: "1.0.0" } }))).toEqual(["E_COMPONENT_CYCLE"]);
    });

    it("an avoidable loop appears only when the choice makes it", () => {
      const reg: RecordRegistry = { ...registry, kinds: [...registry.kinds, { record: "s-rec", version: 1, owner: "a", status: "planned", summary: "s", manual: "m" }, { record: "r-rec", version: 1, owner: "b", status: "planned", summary: "r", manual: "m" }] };
      const a = valid(manifest("a", [comp("a-core", "core"), comp("a-add", "addon", { produces: [{ record: "s-rec", version: 1 }], consumes: [{ record: "r-rec", minVersion: 1 }], dependsOn: [{ component: "a-core" }] })]));
      const b = valid(manifest("b", [comp("b-core", "core"), comp("b-add", "addon", { produces: [{ record: "r-rec", version: 1 }], consumes: [{ record: "s-rec", minVersion: 1 }], dependsOn: [{ component: "b-core" }] })]));
      const c = valid(manifest("c", [comp("c-core", "core", { produces: [{ record: "r-rec", version: 1 }] })]));
      const mk = (choice: string) => resolveChain({ ...base(), manifests: [a, b, c], registry: reg, select: [{ app: "a", component: "a-add" }], appVersions: { a: "1.0.0", b: "1.0.0", c: "1.0.0" }, producerChoice: { "r-rec": choice } });
      expect(mk("c/c-core").ok).toBe(true);
      expect(codes(mk("b/b-add"))).toEqual(["E_COMPONENT_CYCLE"]);
    });
  });

  describe("what the user chose and what is refused up front", () => {
    it("an unknown component, a core and a library cannot be chosen; an app version must be given", () => {
      expect(codes(resolveChain(base({ select: [{ app: "raft", component: "nope" }] })))).toEqual(["E_COMPONENT_UNKNOWN"]);
      expect(codes(resolveChain(base({ select: [{ app: "nowhere", component: "x" }] })))).toEqual(["E_COMPONENT_UNKNOWN"]);
      expect(codes(resolveChain(base({ select: [{ app: "raft", component: "raft-core" }] })))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
      expect(codes(resolveChain(base({ select: [{ app: "studio", component: "chain-file" }] })))).toEqual(["E_COMPONENT_NOT_SELECTABLE"]);
      expect(codes(resolveChain(base({ appVersions: { studio: "1.0.0", raft: "1.0.0" }, select: [{ app: "feed", component: "feed-burnup" }] })))).toEqual(["E_COMPONENT_APP_VERSION"]);
    });

    it("an invalid suite is refused before anything is planned", () => {
      const ms = suite();
      ms[1]!.components[1]!.consumes![0]!.record = "mystery";
      expect(codes(resolveChain(base({ manifests: ms, select: [{ app: "raft", component: "raft-burnup" }] })))).toEqual(["E_RECORD_UNKNOWN"]);
    });
  });

  describe("offline and disk apply to the whole chain", () => {
    it("an artifact missing from the cache, in the other app, is named with its app", () => {
      const r = resolveChain(base({ offline: true, cache: new Set(), select: [{ app: "raft", component: "raft-burnup" }] }));
      expect(codes(r)).toEqual(["E_OFFLINE_MISSING"]);
    });

    it("too little disk for the whole chain is refused, not for the first app only", () => {
      const ok = resolveChain(base({ select: [{ app: "raft", component: "raft-burnup" }] }));
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(codes(resolveChain(base({ freeBytes: ok.cost.expandedBytes - 1, select: [{ app: "raft", component: "raft-burnup" }] })))).toEqual(["E_DISK_SPACE"]);
      expect(resolveChain(base({ freeBytes: ok.cost.expandedBytes, select: [{ app: "raft", component: "raft-burnup" }] })).ok).toBe(true);
    });
  });

  it("the plan does not depend on the order of the lists", () => {
    const sel = [{ app: "raft", component: "raft-burnup" }, { app: "feed", component: "feed-burnup" }, { app: "studio", component: "studio-cad" }];
    const a = resolveChain(base({ select: sel }));
    const b = resolveChain(base({ select: [...sel].reverse(), manifests: [...suite()].reverse() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the input is not changed", () => {
    const ms = suite();
    const before = JSON.stringify([ms, registry]);
    resolveChain(base({ manifests: ms, select: [{ app: "raft", component: "raft-burnup" }] }));
    expect(JSON.stringify([ms, registry])).toBe(before);
  });
});

describe("environment prerequisites as library components", () => {
  it("names the components that would fulfil a catalog prerequisite, in any app", () => {
    expect(componentsSatisfying(suite(), "conda-env")).toEqual([{ app: "studio", component: "openmc-env" }]);
    expect(componentsSatisfying(suite(), "wsl")).toEqual([]);
  });

  it("two apps offering the same prerequisite are both listed, in a fixed order", () => {
    const ms = [...suite(), valid(manifest("other", [comp("other-core", "core"), comp("other-env", "library", { satisfies: ["conda-env"] })]))];
    expect(componentsSatisfying(ms, "conda-env").map((x) => `${x.app}/${x.component}`)).toEqual(["other/other-env", "studio/openmc-env"]);
  });
});
