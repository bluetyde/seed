// @covers R-MAT-01
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { runCli } from "../src/cli/seed";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { writeHostJson } from "../src/core/hostFiles";
import { openProject, saveProject } from "../src/core/projectStore";
import { fixture, fixtureDirs, lines } from "./helpers/replayFixture";

// The material merge as a human runs it: `node dist/cli/admin.js import-materials` (docs/material-merge.md). Real project store, real lock, real files.
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const COMP = (density: number) => ({ schema: "openmc.composition/0.1", units: "g/cm3", density, fractionType: "ao", components: [{ name: "U235", fraction: 1 }] });
const THERMAL = { schema: "thermal.conductivity/0.1", units: "W/m/K", value: 3.6 };
const VENDOR_TEXT = '{"schema":"vendor.thing/1","__proto__":{"x":1},"constructor":{"y":2}}';
const OWNED = ["openmc.composition"];
const input = (v: unknown) => Readable.from([JSON.stringify(v)]);
const human = { kind: "human" as const, name: "FIXTURE, not a person" };

/** A project holding two materials (one with a FEED-style thermal set and an unknown vendor set), and a host configuration whose actor is a human. */
async function setup(actor: { kind: "human" | "agent"; name: string; model?: string } = human) {
  const f = await fixture();
  const opened = openProject(f.project);
  if (!opened.ok) throw new Error("project did not open");
  const manifest = JSON.parse(JSON.stringify(opened.value.manifest));
  manifest.materials = [
    { id: "fuel", revision: 2, name: "Fuel", sets: { "openmc.composition": COMP(10), "thermal.conductivity": THERMAL, "vendor.thing": JSON.parse(VENDOR_TEXT) } },
    { id: "water", revision: 1, name: "Water", sets: { "openmc.composition": COMP(1) } },
  ];
  const saved = saveProject(f.project, manifest, opened.value.revision);
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
  writeHostJson(f.file, { ...f.config, actor });
  const admin = (request: unknown) => runAdminCli(["import-materials"], input(request), f.file);
  const manifestFile = join(f.project, "seed.project.json");
  return { ...f, admin, manifestFile, text: () => readFileSync(manifestFile, "utf8"), revision: () => { const o = openProject(f.project); if (!o.ok) throw new Error("open"); return o.value.revision; }, log: () => lines(join(f.state, "materials.jsonl")).map((x) => x.event) };
}
const entry = (id: string, revision: number, density: number, name = id[0]!.toUpperCase() + id.slice(1)) => ({ id, revision, name, sets: { "openmc.composition": COMP(density) } });

describe("import-materials: the human admin verb", () => {
  it("is an admin verb and not a verb of the CLI an agent is given", async () => {
    const f = await setup();
    const agentCli = await runCli(["import-materials"], input({}), f.file);
    expect(agentCli).toMatchObject({ code: 2, reply: { errors: [{ code: "E_VERB_UNKNOWN" }] } });
    expect(JSON.stringify((await runAdminCli(["nonsense"], input({}), f.file)).reply)).toContain("import-materials");
  });

  it("adds a new material and changes an existing one, writing through the project store, and logs it", async () => {
    const f = await setup();
    const before = f.revision();
    const r = await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4), entry("steel", 1, 7.8)] });
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, dryRun: false, written: true, revisionBefore: before });
    expect((r.reply as any).revisionAfter).toBe(f.revision());
    expect((r.reply as any).changes.map((c: any) => [c.id, c.action])).toEqual([["fuel", "changed"], ["steel", "added"]]);
    const o = openProject(f.project);
    if (!o.ok) throw new Error("open");
    const byId = Object.fromEntries((o.value.manifest.materials as any[]).map((m) => [m.id, m]));
    expect(byId.fuel.revision).toBe(3);
    expect(byId.fuel.sets["openmc.composition"].density).toBe(10.4);
    expect(byId.steel).toMatchObject({ revision: 1, name: "Steel" });
    expect(byId.water.revision).toBe(1);
    const row = f.log().at(-1);
    expect(row).toMatchObject({ phase: "merged", ownedSets: OWNED, revisionBefore: before, actor: human, dryRun: false });
    expect(row.entriesSha256).toBe(sha256Hex(canonicalJson([entry("fuel", 3, 10.4), entry("steel", 1, 7.8)])));
  });

  it("keeps the other sets of a changed material in the file as they were written, byte for byte, including keys named __proto__", async () => {
    const f = await setup();
    const textBefore = f.text();
    const thermalBefore = textBefore.slice(textBefore.indexOf('"thermal.conductivity"'));
    expect(textBefore).toContain('"__proto__"');
    await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] });
    const after = f.text();
    expect(after).toContain('"__proto__"');
    expect(after).toContain('"constructor"');
    const fuelAfter = JSON.parse(after).materials[0].sets;
    expect(canonicalJson(fuelAfter["thermal.conductivity"])).toBe(canonicalJson(THERMAL));
    expect(canonicalJson(fuelAfter["vendor.thing"])).toBe(canonicalJson(JSON.parse(VENDOR_TEXT)));
    expect(thermalBefore.length).toBeGreaterThan(0);
  });

  it("a dry run says what would change and writes nothing: the file, the revision and the lock folder are as they were", async () => {
    const f = await setup();
    const textBefore = f.text(), revBefore = f.revision();
    const r = await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)], dryRun: true });
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ ok: true, dryRun: true, written: false });
    expect((r.reply as any).changes[0]).toMatchObject({ id: "fuel", action: "changed", from: 2, to: 3 });
    expect(f.text()).toBe(textBefore);
    expect(f.revision()).toBe(revBefore);
    expect(f.log().at(-1)).toMatchObject({ phase: "dry-run", dryRun: true });
  });

  it("merging the same entries again is harmless: nothing is written and no revision moves", async () => {
    const f = await setup();
    await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] });
    const textAfterFirst = f.text();
    const again = await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] });
    expect(again.code).toBe(0);
    expect(again.reply).toMatchObject({ ok: true, written: false });
    expect((again.reply as any).changes[0].action).toBe("unchanged");
    expect(f.text()).toBe(textAfterFirst);
    expect(f.log().map((x) => x.phase)).toEqual(["merged", "unchanged"]);
  });

  it("an entry made from an older revision is refused as stale, and nothing is written: Studio exports again", async () => {
    const f = await setup();
    await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] });
    const textAfter = f.text();
    // a second producer export made from revision 2 (before the merge above) now claims revision 3 for different content
    const stale = await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 11)] });
    expect(stale).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_STALE_REVISION", field: "/entries/0/revision" }] } });
    expect(f.text()).toBe(textAfter);
    expect(f.log().at(-1)).toMatchObject({ phase: "refused", errors: [{ code: "E_STALE_REVISION" }] });
  });

  it("one bad entry refuses the whole merge: the good ones are not written either", async () => {
    const f = await setup();
    const textBefore = f.text();
    const r = await f.admin({ ownedSets: OWNED, entries: [entry("steel", 1, 7.8), entry("fuel", 9, 10.4)] });
    expect(r.code).toBe(2);
    expect(f.text()).toBe(textBefore);
  });

  it("SEED does not judge the content of the producer's set: it is stored as given (the project schema asks only for a schema string); the producer's own validator owns the rest", async () => {
    const f = await setup();
    const odd = { id: "fuel", revision: 3, name: "Fuel", sets: { "openmc.composition": { ...COMP(10.4), source: { kind: "anything", text: "x" }, extra: [1, { a: 2 }] } } };
    const r = await f.admin({ ownedSets: OWNED, entries: [odd] });
    expect(r.code).toBe(0);
    expect(JSON.parse(f.text()).materials[0].sets["openmc.composition"].extra).toEqual([1, { a: 2 }]);
  });

  it("is for a human host identity only: an agent's host configuration is refused and nothing is written", async () => {
    const f = await setup({ kind: "agent", name: "bot", model: "fixture" });
    const textBefore = f.text();
    const r = await f.admin({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] });
    expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_NOT_PERMITTED" }] } });
    expect((r.reply as any).errors[0].message).toMatch(/only by a human/);
    expect(f.text()).toBe(textBefore);
  });

  it("needs its own configuration variable, and the host files must be outside the project", async () => {
    const f = await setup();
    expect(await runAdminCli(["import-materials"], input({}), undefined)).toMatchObject({ code: 2, reply: { errors: [{ code: "E_SETUP_REQUIRED" }] } });
    const inside = join(f.project, "host.json");
    writeFileSync(inside, readFileSync(f.file));
    const r = await runAdminCli(["import-materials"], input({ ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)] }), inside);
    expect(r.code).toBe(2);
    expect((r.reply as any).errors[0].message).toMatch(/outside the project/);
  });

  it.each([
    ["an extra field", { ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)], path: "/x" }],
    ["no owned sets", { entries: [entry("fuel", 3, 10.4)] }],
    ["no entries", { ownedSets: OWNED }],
    ["a dryRun that is not a boolean", { ownedSets: OWNED, entries: [entry("fuel", 3, 10.4)], dryRun: "yes" }],
    ["a list instead of an object", [entry("fuel", 3, 10.4)]],
  ])("refuses a request with %s", async (_n, request) => {
    const f = await setup();
    const textBefore = f.text();
    const r = await f.admin(request);
    expect(r.code).toBe(2);
    expect(f.text()).toBe(textBefore);
    expect(existsSync(join(f.state, "materials.jsonl")) ? f.log().every((x) => x.phase === "refused") : true).toBe(true);
  });
});
