// @covers R-MAT-01
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/core/canonical";
import { MAX_ENTRY_BYTES, MAX_MERGE_ENTRIES, planMaterialMerge, type MergePlan } from "../src/core/materialMerge";
import { validate } from "../src/core/validate";

// Merging another app's material entries into a project (docs/material-merge.md; contract section 5 and 11). The merge takes only the sets the producer owns.
const COMP = (density: number, extra: Record<string, unknown> = {}) => ({ schema: "openmc.composition/0.1", units: "g/cm3", density, fractionType: "ao", components: [{ name: "U235", fraction: 1 }], ...extra });
const THERMAL = { schema: "thermal.conductivity/0.1", units: "W/m/K", value: 3.6, source: { kind: "sourced", text: "a table" } };
// an unknown vendor set with keys that must never be interpreted (parsed from text: an own key named __proto__)
const VENDOR = JSON.parse('{"schema":"vendor.thing/1","__proto__":{"x":1},"constructor":{"y":2},"nested":{"__proto__":[1,2]}}');
const manifest = (materials: unknown[] = []): Record<string, any> => ({
  schema: "seed.project/0.1", projectId: "p-0123456789ab", name: "m", created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", seedVersion: "0.1.0",
  folders: { models: "models", runs: "runs", studies: "studies", oracles: "oracles" }, artifacts: [], materials,
});
const mat = (id: string, revision: number, sets: Record<string, unknown>, name = id.toUpperCase()) => ({ id, revision, name, sets });
const OWNED = ["openmc.composition"];
const plan = (m: Record<string, any>, entries: unknown, owned: unknown = OWNED) => planMaterialMerge(m, entries, owned);
const ok = (p: MergePlan) => { if (!p.ok) throw new Error(JSON.stringify(p.errors)); return p; };
const codes = (p: MergePlan) => (p.ok ? [] : p.errors.map((e) => `${e.code} ${e.field}`));

describe("adding, changing and leaving alone", () => {
  it("adds a material the project does not have, as revision 1, with only the producer's set", () => {
    const p = ok(plan(manifest(), [mat("uo2", 1, { "openmc.composition": COMP(10.4) })]));
    expect(p.manifest.materials).toEqual([mat("uo2", 1, { "openmc.composition": COMP(10.4) }, "UO2")]);
    expect(p.changes).toEqual([{ id: "uo2", action: "added", to: 1, sets: OWNED, ignoredSets: [] }]);
    expect(p.changed).toBe(true);
  });

  it("changes the producer's set of an existing material, one revision up, and keeps every other set exactly", () => {
    const m = manifest([mat("fuel", 3, { "openmc.composition": COMP(10), "thermal.conductivity": THERMAL, "vendor.thing": VENDOR })]);
    const p = ok(plan(m, [mat("fuel", 4, { "openmc.composition": COMP(10.4) }, "FUEL")]));
    const out = p.manifest.materials[0];
    expect(out.revision).toBe(4);
    expect(out.sets["openmc.composition"]).toEqual(COMP(10.4));
    expect(canonicalJson(out.sets["thermal.conductivity"])).toBe(canonicalJson(THERMAL));
    expect(canonicalJson(out.sets["vendor.thing"])).toBe(canonicalJson(VENDOR));
    expect(Object.keys(out.sets["vendor.thing"])).toEqual(["schema", "__proto__", "constructor", "nested"]); // the own keys are still there
    expect(p.changes).toEqual([{ id: "fuel", action: "changed", from: 3, to: 4, nameChanged: false, sets: OWNED, ignoredSets: [] }]);
  });

  it("an entry that would change nothing leaves the material and its revision alone, whatever revision it names (a merge twice is harmless)", () => {
    const m = manifest([mat("fuel", 3, { "openmc.composition": COMP(10) })]);
    for (const rev of [1, 3, 4, 9]) {
      const p = ok(plan(m, [mat("fuel", rev, { "openmc.composition": COMP(10) }, "FUEL")]));
      expect(p.changed).toBe(false);
      expect(p.changes[0]).toMatchObject({ action: "unchanged", from: 3, to: 3 });
      expect(p.manifest.materials).toEqual(m.materials);
    }
  });

  it("a changed name alone is a change (one revision up), and says so", () => {
    const m = manifest([mat("fuel", 1, { "openmc.composition": COMP(10) }, "Fuel")]);
    const p = ok(plan(m, [mat("fuel", 2, { "openmc.composition": COMP(10) }, "Fuel, enriched")]));
    expect(p.changes[0]).toMatchObject({ action: "changed", from: 1, to: 2, nameChanged: true });
    expect(p.manifest.materials[0].name).toBe("Fuel, enriched");
  });

  it("merges a list: some added, some changed, some unchanged, in one plan, new materials after the old ones in entry order", () => {
    const m = manifest([mat("a", 1, { "openmc.composition": COMP(1) }), mat("b", 2, { "openmc.composition": COMP(2) })]);
    const p = ok(plan(m, [mat("z", 1, { "openmc.composition": COMP(26) }), mat("b", 2, { "openmc.composition": COMP(2) }, "B"), mat("a", 2, { "openmc.composition": COMP(1.5) }, "A"), mat("y", 1, { "openmc.composition": COMP(25) })]));
    expect(p.manifest.materials.map((x: any) => [x.id, x.revision])).toEqual([["a", 2], ["b", 2], ["z", 1], ["y", 1]]);
    expect(p.changes.map((c) => [c.id, c.action])).toEqual([["z", "added"], ["b", "unchanged"], ["a", "changed"], ["y", "added"]]);
  });

  it("the result is a valid project manifest and the input manifest is not touched", () => {
    const m = manifest([mat("fuel", 1, { "openmc.composition": COMP(10), "vendor.thing": VENDOR })]);
    const before = canonicalJson(m);
    const p = ok(plan(m, [mat("fuel", 2, { "openmc.composition": COMP(11) }, "FUEL"), mat("new", 1, { "openmc.composition": COMP(2) })]));
    expect(canonicalJson(m)).toBe(before);
    expect(validate("project", p.manifest).ok).toBe(true);
  });
});

describe("what the merge refuses", () => {
  it("a changed entry that was made from another revision is stale, and the message says which revision the project holds", () => {
    const m = manifest([mat("fuel", 3, { "openmc.composition": COMP(10) })]);
    for (const rev of [1, 3, 5]) {
      const p = plan(m, [mat("fuel", rev, { "openmc.composition": COMP(11) }, "FUEL")]);
      expect(codes(p)).toEqual(["E_STALE_REVISION /entries/0/revision"]);
      if (!p.ok) expect(p.errors[0]!.message).toMatch(/holds revision 3.*must be revision 4.*export it again/);
    }
  });

  it("a new material must be revision 1: another number means it was made from a material the project does not have", () => {
    const p = plan(manifest(), [mat("uo2", 2, { "openmc.composition": COMP(10) })]);
    expect(codes(p)).toEqual(["E_STALE_REVISION /entries/0/revision"]);
  });

  it("is all or nothing: one stale entry refuses the whole merge, and the errors name every bad entry", () => {
    const m = manifest([mat("a", 1, { "openmc.composition": COMP(1) }), mat("b", 1, { "openmc.composition": COMP(2) })]);
    const p = plan(m, [mat("a", 2, { "openmc.composition": COMP(1.1) }, "A"), mat("b", 5, { "openmc.composition": COMP(2.2) }, "B"), mat("c", 3, { "openmc.composition": COMP(3) })]);
    expect(codes(p)).toEqual(["E_STALE_REVISION /entries/1/revision", "E_STALE_REVISION /entries/2/revision"]);
  });

  it.each([
    ["no entries", [], OWNED, "/entries"],
    ["entries that are not a list", { a: 1 }, OWNED, "/entries"],
    ["no owned sets", [mat("a", 1, { "openmc.composition": COMP(1) })], [], "/ownedSets"],
    ["owned sets that are not a list", [mat("a", 1, { "openmc.composition": COMP(1) })], "openmc.composition", "/ownedSets"],
    ["too many owned sets", [mat("a", 1, { "openmc.composition": COMP(1) })], Array.from({ length: 9 }, (_, i) => `o.s${i}`), "/ownedSets"],
    ["an owned set name that is not a set name", [mat("a", 1, { "openmc.composition": COMP(1) })], ["Composition"], "/ownedSets/0"],
    ["an owned set name that could name a prototype", [mat("a", 1, { "openmc.composition": COMP(1) })], ["__proto__"], "/ownedSets/0"],
    ["an owned set named twice", [mat("a", 1, { "openmc.composition": COMP(1) })], ["openmc.composition", "openmc.composition"], "/ownedSets"],
  ])("refuses %s", (_n, entries, owned, field) => {
    const p = plan(manifest(), entries, owned);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.errors.map((e) => e.field)).toContain(field);
  });

  it.each([
    ["an entry that is not an object", 5, "/entries/0"],
    ["an extra field", { ...mat("a", 1, { "openmc.composition": COMP(1) }), approvedBy: "x" }, "/entries/0/approvedBy"],
    ["a missing id", { revision: 1, name: "a", sets: { "openmc.composition": COMP(1) } }, "/entries/0/id"],
    ["an id that is not an id", mat("../a", 1, { "openmc.composition": COMP(1) }), "/entries/0/id"],
    ["a revision of 0", mat("a", 0, { "openmc.composition": COMP(1) }), "/entries/0/revision"],
    ["a revision that is not whole", mat("a", 1.5, { "openmc.composition": COMP(1) }), "/entries/0/revision"],
    ["a revision that is a string", mat("a", "1" as unknown as number, { "openmc.composition": COMP(1) }), "/entries/0/revision"],
    ["an empty name", mat("a", 1, { "openmc.composition": COMP(1) }, ""), "/entries/0/name"],
    ["a name over 120 characters", mat("a", 1, { "openmc.composition": COMP(1) }, "x".repeat(121)), "/entries/0/name"],
    ["sets that are a list", { id: "a", revision: 1, name: "a", sets: [] }, "/entries/0/sets"],
    ["a set with no schema", mat("a", 1, { "openmc.composition": { density: 1 } }), "/entries/0/sets/openmc.composition"],
    ["a set that is not an object", mat("a", 1, { "openmc.composition": 5 }), "/entries/0/sets/openmc.composition"],
    ["an entry over the size limit", mat("a", 1, { "openmc.composition": COMP(1, { note: "x".repeat(MAX_ENTRY_BYTES) }) }), "/entries/0"],
  ])("refuses %s", (_n, entry, field) => {
    const p = plan(manifest(), [entry]);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.errors.map((e) => e.field)).toContain(field);
  });

  it("refuses the same material twice in one list, and a list over the limit", () => {
    const e = mat("a", 1, { "openmc.composition": COMP(1) });
    expect(codes(plan(manifest(), [e, e]))).toEqual(["E_SCHEMA_INVALID /entries/1/id"]);
    expect(plan(manifest(), Array.from({ length: MAX_MERGE_ENTRIES + 1 }, (_, i) => mat(`m${i}`, 1, { "openmc.composition": COMP(1) }))).ok).toBe(false);
  });

  it("refuses an entry that carries none of the producer's sets: there is nothing to merge", () => {
    const p = plan(manifest(), [mat("a", 1, { "thermal.conductivity": THERMAL })]);
    expect(codes(p)).toEqual(["E_PROP_MISSING /entries/0/sets"]);
  });

  it("refuses a project that has no materials list", () => {
    const m = manifest(); delete m.materials;
    expect(plan(m, [mat("a", 1, { "openmc.composition": COMP(1) })]).ok).toBe(false);
  });
});

describe("what the merge never takes from an entry", () => {
  it("a set the producer does not own is ignored and reported, even when the entry's copy differs from the project's (it may be older)", () => {
    const m = manifest([mat("fuel", 1, { "openmc.composition": COMP(10), "thermal.conductivity": THERMAL })]);
    const stale = { ...THERMAL, value: 99 };
    const p = ok(plan(m, [mat("fuel", 2, { "openmc.composition": COMP(11), "thermal.conductivity": stale, "vendor.new": { schema: "v/1" } }, "FUEL")]));
    expect(p.manifest.materials[0].sets["thermal.conductivity"]).toEqual(THERMAL);
    expect(p.manifest.materials[0].sets["vendor.new"]).toBeUndefined();
    expect(p.changes[0]!.ignoredSets).toEqual(["thermal.conductivity", "vendor.new"]);
  });

  it("an owned set missing from an entry is not a deletion: the project keeps its set", () => {
    const m = manifest([mat("fuel", 1, { "openmc.composition": COMP(10), "vendor.thing": VENDOR })]);
    const p = ok(plan(m, [mat("fuel", 2, { "openmc.composition": COMP(11) }, "FUEL")], ["openmc.composition", "vendor.thing"]));
    expect(p.manifest.materials[0].sets["vendor.thing"]).toEqual(VENDOR);
    expect(p.changes[0]!.sets).toEqual(["openmc.composition"]);
  });

  it("nothing in a set is interpreted: keys named __proto__ and constructor inside the producer's own set arrive as plain own data", () => {
    const set = JSON.parse('{"schema":"openmc.composition/0.1","__proto__":{"polluted":true},"constructor":{"prototype":{"p":1}}}');
    const p = ok(plan(manifest(), [mat("a", 1, { "openmc.composition": set })]));
    const written = p.manifest.materials[0].sets["openmc.composition"];
    expect(Object.keys(written)).toEqual(["schema", "__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(canonicalJson(written)).toBe(canonicalJson(set));
  });
});
