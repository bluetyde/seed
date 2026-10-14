// @covers R-MAT-01
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { canonicalJson } from "../src/core/canonical";
import { writeHostJson } from "../src/core/hostFiles";
import { openProject } from "../src/core/projectStore";
import { appDir } from "./helpers/appDir";
import { fixture, fixtureDirs } from "./helpers/replayFixture";

// The material round trip with OpenMC Studio (FEED's TODO "Material round trip with real OpenMC", plan 02 acceptance "reopening in OpenMC keeps both sets"),
// through Studio's own command line: Studio reads a project, a person changes a material, Studio exports entries, SEED merges them (option (a): SEED writes
// the manifest), and Studio reads the project again. Uses Studio's fixture project (a FEED thermal set, an unknown vendor set with __proto__ keys, extra keys
// inside the composition set, and materials Studio must skip). Needs the OpenMC Studio checkout (SEED_OPENMC_REPO) at its SEED materials commit and a Python on
// the path; skipped otherwise, loudly. This does NOT run FEED's importer or OpenMC.
const repo = [process.env.SEED_OPENMC_REPO, appDir("openmc-studio")].find((p) => p && existsSync(join(p, "studio", "openmc_studio", "seed_materials.py"))) ?? appDir("openmc-studio");
const studioFixture = join(repo, "test", "fixtures", "seed", "seed.project.json");
const python = (() => { const r = spawnSync("python", ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" }); return r.status === 0 && r.stdout.trim() === "3"; })();
const have = existsSync(studioFixture) && python;
const dirs: string[] = [];
afterEach(() => { for (const d of [...dirs.splice(0), ...fixtureDirs.splice(0)]) rmSync(d, { recursive: true, force: true }); });
if (!have) console.warn(`OpenMC Studio's SEED materials module or Python not found (${repo}): the material round trip with Studio was skipped`);

/** Studio's command line (python -m openmc_studio.seed_materials ...), the way a person would run it. */
function studio(args: string[]): any {
  const r = spawnSync("python", ["-m", "openmc_studio.seed_materials", ...args], { encoding: "utf8", cwd: join(repo, "studio"), env: { ...process.env, PYTHONPATH: join(repo, "studio") }, timeout: 60000 });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

describe.skipIf(!have)("OpenMC Studio's entries through SEED's merge (option a), against Studio's own fixture project", () => {
  async function setup() {
    const f = await fixture();
    writeHostJson(f.file, { ...f.config, actor: { kind: "human", name: "FIXTURE, not a person" } });
    copyFileSync(studioFixture, join(f.project, "seed.project.json"));
    expect(openProject(f.project).ok).toBe(true);
    const merge = (entries: unknown, dryRun = false) => runAdminCli(["import-materials"], Readable.from([JSON.stringify({ ownedSets: ["openmc.composition"], entries, dryRun })]), f.file);
    return { ...f, merge, manifest: () => JSON.parse(readFileSync(join(f.project, "seed.project.json"), "utf8")) };
  }
  const fixtureManifest = JSON.parse(readFileSync(studioFixture, "utf8"));
  const byId = (m: any, id: string) => m.materials.find((x: any) => x.id === id);

  it("Studio reads the project, a person changes a density and adds a steel, Studio exports, SEED merges, Studio reads it again", async () => {
    const f = await setup();
    // 1. Studio reads what it can from the project
    const imported = studio(["import", join(f.project, "seed.project.json")]);
    expect(imported.materials.map((m: any) => m.id)).toEqual(["mat-fuel", "mat-water"]);
    // 2. a person edits in Studio: the fuel gets denser, a steel is added
    const edited = imported.materials.map((m: any) => (m.id === "mat-fuel" ? { ...m, density: 10.6 } : m));
    edited.push({ id: "mat-steel", name: "Steel", density: 7.8, frac: "wo", comps: "Fe56:1", sab: "", ref: "assumed value" });
    const studioFile = join(mkdtempSync(join(tmpdir(), "seed-studio-")), "studio.json");
    dirs.push(join(studioFile, ".."));
    writeFileSync(studioFile, JSON.stringify({ materials: edited }));
    // 3. Studio produces the entries (it reads the project to number the revisions); SEED merges them
    const exported = studio(["export", studioFile, "--project", join(f.project, "seed.project.json")]);
    const entries = Array.isArray(exported) ? exported : exported.entries;
    expect(entries.map((e: any) => [e.id, e.revision])).toEqual([["mat-fuel", 4], ["mat-water", 1], ["mat-steel", 1]]);
    const r = await f.merge(entries);
    expect(r.code, JSON.stringify(r.reply)).toBe(0);
    expect((r.reply as any).changes.map((c: any) => [c.id, c.action])).toEqual([["mat-fuel", "changed"], ["mat-water", "unchanged"], ["mat-steel", "added"]]);

    // 4. what the project holds now
    const after = f.manifest();
    expect(byId(after, "mat-fuel").revision).toBe(4);
    expect(byId(after, "mat-fuel").sets["openmc.composition"].density).toBe(10.6);
    expect(byId(after, "mat-water")).toEqual(byId(fixtureManifest, "mat-water"));
    expect(byId(after, "mat-steel")).toMatchObject({ revision: 1, name: "Steel" });
    // "reopening keeps both sets": FEED's thermal set and the unknown vendor set of the fuel are exactly as they were, __proto__ keys included
    for (const k of ["thermal.conductivity", "vendor.notes"]) expect(canonicalJson(byId(after, "mat-fuel").sets[k])).toBe(canonicalJson(byId(fixtureManifest, "mat-fuel").sets[k]));
    expect(Object.keys(byId(after, "mat-fuel").sets["vendor.notes"])).toEqual(Object.keys(byId(fixtureManifest, "mat-fuel").sets["vendor.notes"]));
    // keys inside Studio's own set that Studio does not own are kept
    expect(byId(after, "mat-fuel").sets["openmc.composition"]).toMatchObject({ conditions: { temperature: 900 }, enrichment: 0.031 });
    // materials Studio skipped (thermal only, another schema version, another writer's) are untouched
    for (const id of ["mat-thermal-only", "mat-old-schema", "mat-other-writer"]) expect(canonicalJson(byId(after, id))).toBe(canonicalJson(byId(fixtureManifest, id)));
    expect(openProject(f.project).ok).toBe(true);

    // 5. Studio reads the project again and sees the new density and the steel
    const again = studio(["import", join(f.project, "seed.project.json")]);
    expect(again.materials.map((m: any) => [m.id, m.density])).toEqual([["mat-fuel", 10.6], ["mat-water", 0.74], ["mat-steel", 7.8]]);
  }, 180000);

  it("merging the same Studio export twice changes nothing the second time", async () => {
    const f = await setup();
    const imported = studio(["import", join(f.project, "seed.project.json")]);
    const studioFile = join(mkdtempSync(join(tmpdir(), "seed-studio-")), "studio.json");
    dirs.push(join(studioFile, ".."));
    writeFileSync(studioFile, JSON.stringify({ materials: imported.materials.map((m: any) => (m.id === "mat-fuel" ? { ...m, density: 10.7 } : m)) }));
    const entries = studio(["export", studioFile, "--project", join(f.project, "seed.project.json")]);
    const list = Array.isArray(entries) ? entries : entries.entries;
    expect((await f.merge(list)).code).toBe(0);
    const text = readFileSync(join(f.project, "seed.project.json"), "utf8");
    const second = await f.merge(list);
    expect(second.code).toBe(0);
    expect(second.reply).toMatchObject({ written: false });
    expect(readFileSync(join(f.project, "seed.project.json"), "utf8")).toBe(text);
  }, 180000);

  it("an export made before another change to the same material is refused as stale and the project is left alone", async () => {
    const f = await setup();
    const imported = studio(["import", join(f.project, "seed.project.json")]);
    const studioFile = join(mkdtempSync(join(tmpdir(), "seed-studio-")), "studio.json");
    dirs.push(join(studioFile, ".."));
    writeFileSync(studioFile, JSON.stringify({ materials: imported.materials.map((m: any) => (m.id === "mat-fuel" ? { ...m, density: 10.8 } : m)) }));
    const exported = studio(["export", studioFile, "--project", join(f.project, "seed.project.json")]);
    const list = Array.isArray(exported) ? exported : exported.entries;
    // someone else changes the fuel's composition in the project first (revision 3 to 4)
    const m = f.manifest();
    byId(m, "mat-fuel").revision = 4;
    byId(m, "mat-fuel").sets["openmc.composition"] = { ...byId(m, "mat-fuel").sets["openmc.composition"], density: 10.5 };
    writeFileSync(join(f.project, "seed.project.json"), JSON.stringify(m, null, 2) + "\n");
    const before = readFileSync(join(f.project, "seed.project.json"), "utf8");
    const r = await f.merge(list);
    expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_STALE_REVISION" }] } });
    expect(readFileSync(join(f.project, "seed.project.json"), "utf8")).toBe(before);
  }, 180000);
});
