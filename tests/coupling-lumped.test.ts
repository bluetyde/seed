// @covers R-STUDY-09
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCoupling } from "../src/core/coupling";
import { checkLumpedOptions, EXCHANGED, makeLumpedPass, type LumpedDeps, type LumpedOptions } from "../src/core/couplingLumped";
import type { CouplingLoopRegistration } from "../src/core/couplingHost";
import { recipeDigest } from "../src/core/transfer";

// The passes of the lumped loop with fake apps: what a pass asks of Studio's transfer, of Studio's generator, of the OpenMC and FEED runs and of FEED's
// transfer, in what order, with which recipes, and how each way of failing comes out. The fake apps have a known answer: FEED's mean fuel temperature is
// 600 + 0.1 times the temperature OpenMC was given, whose fixed point is 666.67 K. The real apps run in tests/coupling-lumped-real.test.ts.
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const actor = { kind: "agent" as const, name: "claude", model: "opus" };

const options: LumpedOptions = {
  openmc: { app: "openmc", artifact: "om-project", material: "m_uo2", quantity: "Pin mesh:heating", threads: 2 },
  feed: { app: "feed", artifact: "pin-case", pin: "1,1", frame: "openmc-model", applyTo: "s1", binCount: 4, totalPowerW: 250, slices: [{ id: "s1", z: { min: -0.0063, max: 0.0063 } }] },
};
const projectText = JSON.stringify({ materials: [{ id: "m_uo2" }, { id: "m_zirc" }] }, null, 2) + "\n";
const caseText = JSON.stringify({ caseId: "pin", power: { linearHeatRate: { value: 1, unit: "kW/m" } } }, null, 2) + "\n";

type Log = { op: string; detail?: any }[];
function fakes(over: Partial<{ studioRefuses: boolean; studioSetsOther: boolean; problems: string[]; openmcFails: string; noMesh: boolean; feedRefuses: boolean; feedRunFails: string; noTemp: boolean; nanTemp: boolean; noKeff: boolean; studioLies: boolean; studioExtra: boolean; feedLies: boolean; feedNoConservation: boolean; feedBigConservation: boolean; feedWrongRate: boolean; degC: boolean; degCIndexOnly: boolean; tamperedMesh: boolean }> = {}) {
  const log: Log = [];
  const requests: any[] = [];
  let lastT = NaN;
  const write = (root: string, rel: string, body: unknown) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    const text = JSON.stringify(body);
    writeFileSync(abs, text);
    return { path: rel, sha256: sha(text) };
  };
  const deps: LumpedDeps = {
    transfer: async (app, request: any) => {
      requests.push({ app, request });
      log.push({ op: `transfer:${app}` });
      if (app === "openmc") {
        if (over.studioRefuses) return { ok: false, errors: [{ code: "E_TEMPERATURE_RANGE", field: "/source/data", message: "outside the library" }] };
        const T = request.source.data.value;
        lastT = T;
        if (over.studioLies) return { ok: true, output: { content: request.target.content }, checks: { applied: [{ material: "m_uo2", temperatureK: T }] } };
        const p = JSON.parse(request.target.content);
        p.materials[0].temperature = over.studioSetsOther ? T + 1 : T;
        if (over.studioExtra) p.materials[1].temperature = 500;
        return { ok: true, output: { content: JSON.stringify(p, null, 2) + "\n" }, checks: { applied: [{ material: "m_uo2", temperatureK: over.studioSetsOther ? T + 1 : T }] } };
      }
      if (over.feedRefuses) return { ok: false, errors: [{ code: "E_CONSERVATION", message: "lost 3 %" }] };
      if (over.feedLies) return { ok: true, output: { content: request.target.content }, checks: { conservation: { relativeDifference: 0 } } };
      const c = JSON.parse(request.target.content);
      c.power.linearHeatRate = { value: (request.recipe.normalization.value.value / 0.0126) * (over.feedWrongRate ? 2 : 1), unit: "W/m" };
      return { ok: true, output: { content: JSON.stringify(c, null, 2) + "\n" }, ...(over.feedNoConservation ? {} : { checks: { conservation: { relativeDifference: over.feedBigConservation ? 0.1 : 0, tolerance: 1e-6 } } }) };
    },
    generateModel: async (projectFile, modelFile) => {
      log.push({ op: "generate" });
      writeFileSync(modelFile, "# model for " + sha(readFileSync(projectFile, "utf8")).slice(0, 8) + "\n");
      return over.problems ?? [];
    },
    run: async (app, root, files, settings, requestId) => {
      log.push({ op: `run:${app}`, detail: { files: files.map((f) => f.path), settings, requestId } });
      const runId = `r-${app}-${log.length}`;
      if (app === "openmc") {
        if (over.openmcFails) return { ok: false, reason: over.openmcFails, runId };
        const quantities: any[] = [];
        if (!over.noMesh) {
          const mesh = write(root, `runs/${runId}/native/quantities/000.json`, {
            schema: "seed.quantity-data/0.2", quantity: "Pin mesh:heating", kind: "table", unit: "eV",
            columns: [{ name: "xy", unit: "1", role: "label" }, { name: "z_min", unit: "cm", role: "coordinate" }, { name: "z_max", unit: "cm", role: "coordinate" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }],
            rows: [[["1,1"], -0.63, -0.315, 100, 1], [["1,1"], -0.315, 0, 200, 1], [["1,1"], 0, 0.315, 200, 1], [["1,1"], 0.315, 0.63, 100, 1]], meta: { frame: "openmc-model" },
          });
          if (over.tamperedMesh) writeFileSync(join(root, mesh.path), JSON.stringify({ tampered: true }));
          quantities.push({ name: "Pin mesh:heating", unit: "eV", dimension: "energy", normalization: "per-source-particle", data: { path: mesh.path, sha256: mesh.sha256 } });
        }
        if (!over.noKeff) {
          const k = write(root, `runs/${runId}/native/quantities/001.json`, { schema: "seed.quantity-data/0.2", quantity: "keff", kind: "table", unit: "1", columns: [{ name: "bin", unit: "1", role: "label" }, { name: "mean", unit: "1", role: "value" }, { name: "std", unit: "1", role: "std", of: "mean" }], rows: [[["keff"], 1.0 + lastT * 1e-5, 0.005]] });
          quantities.push({ name: "keff", unit: "1", dimension: "dimensionless", normalization: "none", data: { path: k.path, sha256: k.sha256 } });
        }
        return { ok: true, runId, root, index: { runId, quantities } };
      }
      if (over.feedRunFails) return { ok: false, reason: over.feedRunFails, runId };
      const quantities: any[] = [];
      if (!over.noTemp) {
        const t = write(root, `runs/${runId}/native/quantities/000.json`, { schema: "seed.quantity-data/0.2", quantity: EXCHANGED, kind: "scalar", unit: over.degC ? "degC" : "K", value: over.nanTemp ? null : 600 + 0.1 * lastT });
        quantities.push({ name: EXCHANGED, unit: over.degC || over.degCIndexOnly ? "degC" : "K", dimension: "temperature", normalization: "none", data: { path: t.path, sha256: t.sha256 } });
      }
      return { ok: true, runId, root, index: { runId, quantities } };
    },
  };
  return { deps, log, requests };
}
const passFor = (deps: LumpedDeps, scratch: string) => {
  const d = mkdtempSync(join(tmpdir(), "seed lumped "));
  dirs.push(d);
  return makeLumpedPass({ loopId: "lumped", requestId: "req-1", options, actor, openmcProject: projectText, feedCase: caseText, scratchRoot: join(d, scratch), deps });
};
const def = { exchanged: [{ id: EXCHANGED, tolerance: 1e-4, min: 250, max: 2500 }], maxPasses: 10, relaxation: 1, consecutive: 2 };

describe("the passes of the lumped loop (fake apps)", () => {
  it("converge on the fake apps' fixed point, with both run ids and k-eff in every pass", async () => {
    const f = fakes();
    const outcome = await runCoupling(def as never, { [EXCHANGED]: 900 }, passFor(f.deps, "s"));
    expect(outcome.state).toBe("converged");
    expect(outcome.result!.iterate[EXCHANGED]).toBeCloseTo(666.667, 2);
    expect(outcome.passes.length).toBeGreaterThanOrEqual(3);
    expect(outcome.passes.length).toBeLessThanOrEqual(8);
  });

  it("run each pass in the order temperature, generator, OpenMC, heating, FEED, and return the runs and k-eff", async () => {
    const f = fakes();
    const pass = passFor(f.deps, "s");
    const r = await pass({ [EXCHANGED]: 900 }, 1);
    expect(f.log.map((x) => x.op)).toEqual(["transfer:openmc", "generate", "run:openmc", "transfer:feed", "run:feed"]);
    expect(r).toMatchObject({ ok: true, calc: { [EXCHANGED]: 690 } });
    if (!r.ok) return;
    expect(Object.keys(r.runs!).sort()).toEqual(["feed", "openmc"]);
    expect(r.info).toMatchObject({ temperatureAppliedK: 900, keffStd: 0.005, heatingPowerW: 250 });
    expect(r.info!.keff).toBeCloseTo(1.009, 6);
  });

  it("ask Studio for the iterate temperature of the fuel material, with a request that names its revision and digest", async () => {
    const f = fakes();
    await passFor(f.deps, "s")({ [EXCHANGED]: 812.5 }, 1);
    const { request } = f.requests.find((x) => x.app === "openmc");
    expect(request.schema).toBe("seed.transfer-request/0.2");
    expect(request.recipe.target).toEqual({ app: "openmc-studio", artifact: "project", revision: sha(projectText), field: "fuel-temperature" });
    expect(request.recipe.mapping.spatial).toEqual({ meaning: "volume-mean", materials: [{ material: "m_uo2" }] });
    expect(request.recipe.units).toEqual({ to: "K" });
    expect(request.source.data).toMatchObject({ kind: "scalar", unit: "K", value: 812.5, quantity: "fuel_temperature" });
    expect(request.recipeDigest).toBe(recipeDigest(request.recipe));
    expect(request.target.content).toBe(projectText);
  });

  it("hand FEED the heating mesh with the registered total power, pin, slices and bin count, and the case it was given", async () => {
    const f = fakes();
    await passFor(f.deps, "s")({ [EXCHANGED]: 900 }, 1);
    const { request } = f.requests.find((x) => x.app === "feed");
    expect(request.recipe.target).toEqual({ app: "feed", artifact: "pin-case", revision: sha(caseText), field: "heating-to-pin" });
    expect(request.recipe.normalization).toMatchObject({ kind: "total-power", value: { value: 250, unit: "W" } });
    expect(request.recipe.mapping.spatial).toEqual({ pin: "1,1", frame: "openmc-model", slices: options.feed.slices, applyTo: "s1", pinBinCount: 4, columns: { pin: "xy" } });
    expect(request.recipe.units).toEqual({ to: "W" });
    expect(request.source.data.kind).toBe("table");
    expect(request.source.data.rows).toHaveLength(4);
    expect(request.recipeDigest).toBe(recipeDigest(request.recipe));
    expect(request.target.content).toBe(caseText);
  });

  it("run OpenMC on the project Studio returned and the model made from it, with the registered threads, and FEED on the case FEED returned", async () => {
    const f = fakes();
    await passFor(f.deps, "s")({ [EXCHANGED]: 900 }, 2);
    const om = f.log.find((x) => x.op === "run:openmc")!.detail, fe = f.log.find((x) => x.op === "run:feed")!.detail;
    expect(om.files).toEqual(["models/pin.openmc-studio.json", "models/pin.py"]);
    expect(om.settings).toEqual({ project: "models/pin.openmc-studio.json", model: "models/pin.py", threads: 2 });
    expect(om.requestId).toBe("req-1-p002-openmc");
    expect(fe.files).toEqual(["models/pin.case.json"]);
    expect(fe.settings).toEqual({ case: "models/pin.case.json" });
    expect(fe.requestId).toBe("req-1-p002-feed");
  });

  it("work in the loop's scratch folder, one folder per pass, and write nothing anywhere else", async () => {
    const f = fakes();
    const d = mkdtempSync(join(tmpdir(), "seed lumped scratch "));
    dirs.push(d);
    const pass = makeLumpedPass({ loopId: "lumped", requestId: "req-1", options, actor, openmcProject: projectText, feedCase: caseText, scratchRoot: join(d, "scratch"), deps: f.deps });
    await pass({ [EXCHANGED]: 900 }, 1);
    await pass({ [EXCHANGED]: 800 }, 2);
    expect(readdirSync(join(d, "scratch")).sort()).toEqual(["pass-001", "pass-002"]);
    expect(JSON.parse(readFileSync(join(d, "scratch", "pass-001", "openmc", "models", "pin.openmc-studio.json"), "utf8")).materials[0].temperature).toBe(900);
    expect(JSON.parse(readFileSync(join(d, "scratch", "pass-002", "openmc", "models", "pin.openmc-studio.json"), "utf8")).materials[0].temperature).toBe(800);
    expect(readdirSync(d)).toEqual(["scratch"]);
  });

  it.each<[string, Parameters<typeof fakes>[0], RegExp, string[]]>([
    ["Studio refuses the temperature", { studioRefuses: true }, /OpenMC Studio refused the temperature 900 K: E_TEMPERATURE_RANGE/, []],
    ["Studio sets another temperature than it was asked", { studioSetsOther: true }, /set 901 K where 900 K was asked/, []],
    ["Studio's generator reports problems", { problems: ["no fissile material"] }, /generator does not accept the project: no fissile material/, []],
    ["the OpenMC run does not complete", { openmcFails: "the run ended failed" }, /OpenMC run did not complete: the run ended failed/, ["openmc"]],
    ["the OpenMC run has no heating mesh", { noMesh: true }, /no quantity "Pin mesh:heating"/, ["openmc"]],
    ["FEED refuses the heating", { feedRefuses: true }, /FEED refused the heating of the OpenMC run: E_CONSERVATION/, ["openmc"]],
    ["the FEED run does not complete", { feedRunFails: "E_NOT_CONVERGED" }, /FEED run did not complete: E_NOT_CONVERGED/, ["feed", "openmc"]],
    ["Studio hands back the project unchanged while claiming the temperature", { studioLies: true }, /not the one it was given with the temperature of m_uo2 set to 900 K/, []],
    ["Studio changes more than the one temperature", { studioExtra: true }, /nothing else changed/, []],
    ["FEED hands back the case unchanged", { feedLies: true }, /FEED returned the case unchanged/, ["openmc"]],
    ["FEED's reply carries no conservation check", { feedNoConservation: true }, /carries no conservation check/, ["openmc"]],
    ["FEED reports a conservation difference over the tolerance", { feedBigConservation: true }, /conservation difference of 0.1, outside the recipe's tolerance of 0.000001/, ["openmc"]],
    ["FEED's case does not hold the registered power", { feedWrongRate: true }, /does not hold the registered power as a heat rate of 19841/, ["openmc"]],
    ["the heating mesh is not the file its index describes", { tamperedMesh: true }, /not the file its index describes/, ["openmc"]],
    ["the FEED temperature is in degrees Celsius", { degC: true }, /not a finite number in K/, ["feed", "openmc"]],
    ["the FEED index says degrees Celsius while the data say K", { degCIndexOnly: true }, /not a finite number in K/, ["feed", "openmc"]],
    ["the FEED run has no fuel temperature", { noTemp: true }, /FEED run has no temperature_fuel_mean/, ["feed", "openmc"]],
    ["the FEED fuel temperature is not a number", { nanTemp: true }, /not a finite number/, ["feed", "openmc"]],
  ])("a pass fails with the reason, and the runs it made, when %s", async (_n, over, reason, runApps) => {
    const f = fakes(over);
    const r = await passFor(f.deps, "s")({ [EXCHANGED]: 900 }, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(reason);
    expect(Object.keys(r.runs ?? {}).sort()).toEqual(runApps);
  });

  it("a pass that fails ends the loop as engine-failure with the earlier passes kept", async () => {
    const f = fakes();
    const inner = passFor(f.deps, "s");
    let n = 0;
    const outcome = await runCoupling(def as never, { [EXCHANGED]: 900 }, async (it, i) => { if (++n === 3) f.deps.run = async () => ({ ok: false, reason: "WSL went away" }); return inner(it, i); });
    expect(outcome.state).toBe("engine-failure");
    expect(outcome.passes).toHaveLength(2);
    expect(outcome.reason).toMatch(/WSL went away/);
  });
});

describe("the options of a lumped loop", () => {
  const loop = (over: (o: any) => void = () => {}): CouplingLoopRegistration => {
    const o = structuredClone(options) as any;
    over(o);
    return { purpose: "plumbing-test", kind: "lumped-power-temperature", apps: ["openmc", "feed"], inputs: { openmc: [{ artifact: "om-project", revision: "a".repeat(64) }], feed: [{ artifact: "pin-case", revision: "b".repeat(64) }] }, definition: def, start: { [EXCHANGED]: 900 }, options: o };
  };
  it("are accepted as registered", () => {
    expect(checkLumpedOptions(loop())).toMatchObject({ ok: true });
  });
  it.each<[string, (o: any) => void, string]>([
    ["no feed block", (o) => delete o.feed, "/options"],
    ["a material that is not an id", (o) => (o.openmc.material = "a b"), "/options/openmc/material"],
    ["no heating quantity", (o) => (o.openmc.quantity = ""), "/options/openmc/quantity"],
    ["threads of 0", (o) => (o.openmc.threads = 0), "/options/openmc/threads"],
    ["a power of 0", (o) => (o.feed.totalPowerW = 0), "/options/feed/totalPowerW"],
    ["a power that is not a number", (o) => (o.feed.totalPowerW = "250"), "/options/feed/totalPowerW"],
    ["a bin count of 0", (o) => (o.feed.binCount = 0), "/options/feed/binCount"],
    ["a slice that ends before it starts", (o) => (o.feed.slices[0].z = { min: 1, max: 0 }), "/options/feed/slices"],
    ["an applyTo that is no slice", (o) => (o.feed.applyTo = "s9"), "/options/feed/applyTo"],
    ["the same app twice", (o) => (o.feed.app = "openmc"), "/options"],
    ["an artifact that is not pinned", (o) => (o.openmc.artifact = "other"), "/options/openmc/artifact"],
  ])("are refused with %s", (_n, edit, field) => {
    const r = checkLumpedOptions(loop(edit));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain(field);
  });
});
