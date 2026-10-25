/**
 * The passes of the lumped power-temperature loop between OpenMC Studio and FEED (docs/coupling-prerequisites.md section 7, decision 1; docs/coupling-host.md).
 * One pass, from the iterate T (the volume-mean fuel temperature, K):
 *
 *   1. T becomes the temperature of the fuel material of a scratch copy of the OpenMC project, by Studio's own transfer command (`fuel-temperature`);
 *   2. Studio's generator makes model.py of that project; OpenMC runs it through the OpenMC adapter (an eigenvalue run: k-eff is kept in the record);
 *   3. the heating mesh of that run becomes the heat rate of a scratch copy of the FEED case, by FEED's own transfer command (`heating-to-pin`), normalized
 *      to the total power the loop registers;
 *   4. FEED runs the case through the FEED adapter; its `temperature_fuel_mean` is the pass's answer.
 *
 * Nothing is written to the project: the copies live in the loop's scratch folder, inside the state folder (decision 2). The apps own the mapping of
 * their own files (their transfer commands); SEED builds the request and checks what comes back. The recipes below are fixed by this module and by the loop's
 * registration (which the grant names), so no recipe waits for a person's approval inside a pass. The power is fixed, so the heating shape and the total
 * do not depend on T: the loop proves the exchange, not the physics, and says so (the registration's purpose).
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical";
import type { PassFunction } from "./coupling";
import type { CouplingHostConfig, CouplingLoopRegistration, PassBuilder, PassContext } from "./couplingHost";
import type { Actor, Revision } from "./policy";
import { openProject } from "./projectStore";
import { readQuantityData } from "./quantityData";
import { RunManager, type Budget } from "./runManager";
import { recipeDigest, spawnTransferCommand, validateRecipe, type Recipe, type TransferReply } from "./transfer";
import type { TypedError } from "./validate";

export const LUMPED_KIND = "lumped-power-temperature";
export const EXCHANGED = "temperature_fuel_mean";

export type LumpedOptions = {
  openmc: { app: string; artifact: string; material: string; /** the heating mesh quantity of the run, as the index names it ("<tally>:heating") */ quantity: string; threads?: number };
  feed: {
    app: string; artifact: string; pin: string; frame: string; applyTo: string; binCount: number; totalPowerW: number;
    slices: { id: string; z: { min: number; max: number } }[];
  };
};

type Files = { path: string; text: string }[];
type RunDone = { runId: string; index: any; root: string };
type Step<T> = ({ ok: true } & T) | { ok: false; reason: string; runId?: string };

/** What a pass does to the world; the real ones are made from the host configuration, tests give fakes. */
export type LumpedDeps = {
  transfer(app: "openmc" | "feed", request: unknown): Promise<TransferReply>;
  /** Studio's generator: model.py of a project file. Resolves with the problems Studio reports (none when it accepts the project). */
  generateModel(projectFile: string, modelFile: string): Promise<string[]>;
  /** One calculation through the app's adapter, in a scratch project folder holding `files`. */
  run(app: "openmc" | "feed", root: string, files: Files, settings: Record<string, unknown>, requestId: string): Promise<Step<RunDone>>;
};

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown, re = /^[A-Za-z0-9][A-Za-z0-9._:,-]{0,63}$/): x is string => typeof x === "string" && re.test(x);

/** The options of a lumped loop, checked; every problem named. Also used before pass 1. */
export function checkLumpedOptions(loop: CouplingLoopRegistration): { ok: true; options: LumpedOptions } | { ok: false; errors: TypedError[] } {
  const e: TypedError[] = [];
  const o = loop.options;
  if (!isObj(o) || !isObj(o.openmc) || !isObj(o.feed)) return { ok: false, errors: [err("E_SCHEMA_INVALID", "/options", "a lumped loop has options { openmc, feed }")] };
  const m = o.openmc, f = o.feed;
  for (const [k, v] of [["app", m.app], ["artifact", m.artifact], ["material", m.material]] as const) if (!str(v)) e.push(err("E_SCHEMA_INVALID", `/options/openmc/${k}`, `${k} is an id`));
  if (typeof m.quantity !== "string" || m.quantity.length < 1 || m.quantity.length > 80) e.push(err("E_SCHEMA_INVALID", "/options/openmc/quantity", "quantity is the heating mesh quantity of the run, as its index names it"));
  if (m.threads !== undefined && (!Number.isInteger(m.threads) || (m.threads as number) < 1 || (m.threads as number) > 16)) e.push(err("E_SCHEMA_INVALID", "/options/openmc/threads", "threads is a whole number from 1 to 16"));
  for (const [k, v] of [["app", f.app], ["artifact", f.artifact], ["pin", f.pin], ["frame", f.frame], ["applyTo", f.applyTo]] as const) if (!str(v)) e.push(err("E_SCHEMA_INVALID", `/options/feed/${k}`, `${k} is an id or a label`));
  if (!Number.isInteger(f.binCount) || (f.binCount as number) < 1) e.push(err("E_SCHEMA_INVALID", "/options/feed/binCount", "binCount is the number of bins of the pin, a whole number"));
  if (!num(f.totalPowerW) || (f.totalPowerW as number) <= 0) e.push(err("E_SCHEMA_INVALID", "/options/feed/totalPowerW", "totalPowerW is a positive number of watts: the pin's total power, which the loop holds fixed"));
  const slices = f.slices;
  if (!Array.isArray(slices) || slices.length < 1 || slices.length > 100 || !slices.every((s) => isObj(s) && str(s.id) && isObj(s.z) && num(s.z.min) && num(s.z.max) && (s.z.max as number) > (s.z.min as number))) e.push(err("E_SCHEMA_INVALID", "/options/feed/slices", "slices are [{id, z: {min, max}}] in metres, each with max above min"));
  else if (!slices.some((s) => (s as { id: string }).id === f.applyTo)) e.push(err("E_SCHEMA_INVALID", "/options/feed/applyTo", "applyTo names one of the slices"));
  if (!loop.apps.includes(String(m.app)) || !loop.apps.includes(String(f.app)) || m.app === f.app) e.push(err("E_SCHEMA_INVALID", "/options", "the loop's apps are the OpenMC app and the FEED app of its options, two different ones"));
  const pinned = (app: unknown, artifact: unknown) => (Object.hasOwn(loop.inputs, String(app)) ? (loop.inputs[String(app)] as Revision[]) : []).some((r) => r.artifact === artifact);
  if (!pinned(m.app, m.artifact)) e.push(err("E_SCHEMA_INVALID", "/options/openmc/artifact", "the artifact is not among the pinned inputs of the OpenMC app"));
  if (!pinned(f.app, f.artifact)) e.push(err("E_SCHEMA_INVALID", "/options/feed/artifact", "the artifact is not among the pinned inputs of the FEED app"));
  return e.length ? { ok: false, errors: e } : { ok: true, options: o as unknown as LumpedOptions };
}

const messageOf = (r: TransferReply) => (r.ok ? "" : (r.errors ?? []).slice(0, 3).map((x) => `${x.code}${x.field ? " " + x.field : ""}: ${x.message}`).join("; ") || "no reason given");
const scalarOf = (text: string, entry: any): number | null => {
  const r = readQuantityData(text, entry);
  return r.ok && r.data.kind === "scalar" && num(r.data.value) ? r.data.value : null;
};
const tableRow = (text: string, entry: any): (string | number | string[])[] | null => {
  const r = readQuantityData(text, entry);
  return r.ok && r.data.kind === "table" && r.data.rows.length === 1 ? (r.data.rows[0] as (string | number | string[])[]) : null;
};

/** One pass as a function of the iterate; `deps` do the work, `inputs` hold the two start files. */
export function makeLumpedPass(args: { loopId: string; requestId: string; options: LumpedOptions; actor: Actor; openmcProject: string; feedCase: string; scratchRoot: string; deps: LumpedDeps }): PassFunction {
  const { options: o, deps, actor } = args;
  const now = () => new Date().toISOString();
  return async (iterate, index) => {
    const T = iterate[EXCHANGED] as number;
    const tag = `${args.requestId}-p${String(index).padStart(3, "0")}`;
    const fail = (reason: string, runs?: Record<string, string>) => ({ ok: false as const, reason, ...(runs ? { runs } : {}) });
    const base = join(args.scratchRoot, "pass-" + String(index).padStart(3, "0"));

    // 1. the temperature into the OpenMC project, by Studio's transfer command
    const projectRevision = sha256Hex(args.openmcProject);
    const tempRecipe: Recipe = {
      schema: "seed.transfer-recipe/0.2", recipeId: `${tag}-temperature`.slice(0, 64), proposedBy: actor, proposedAt: now(),
      source: { runId: `${tag}-iterate`.slice(0, 64), resultsSha256: sha256Hex(`iterate ${T}`), quantity: "fuel_temperature", dataSha256: sha256Hex(`iterate ${T}`), unit: "K", dimension: "temperature", normalization: "none", revisionPins: [{ artifact: o.openmc.artifact, revision: projectRevision }] },
      target: { app: "openmc-studio", artifact: "project", revision: projectRevision, field: "fuel-temperature" },
      units: { to: "K" }, normalization: { kind: "none" },
      mapping: { spatial: { meaning: "volume-mean", materials: [{ material: o.openmc.material }] }, time: { kind: "steady" }, extrapolation: "refused" },
      tolerance: { conservation: 0.01, fixedBefore: "mapping" },
    };
    const tempOk = validateRecipe(tempRecipe);
    if (!tempOk.ok) return fail("the temperature recipe is not valid: " + tempOk.errors.map((x) => x.message).join("; "));
    const toStudio = await deps.transfer("openmc", {
      schema: "seed.transfer-request/0.2", recipe: tempRecipe, recipeDigest: recipeDigest(tempRecipe),
      source: { quantity: { name: "fuel_temperature", unit: "K", dimension: "temperature", normalization: "none" }, data: { schema: "seed.quantity-data/0.2", quantity: "fuel_temperature", kind: "scalar", unit: "K", value: T } },
      target: { artifact: "project", revision: projectRevision, content: args.openmcProject },
    });
    if (!toStudio.ok) return fail("OpenMC Studio refused the temperature " + T + " K: " + messageOf(toStudio));
    const applied = (toStudio.checks as { applied?: { temperatureK?: number }[] } | undefined)?.applied?.[0]?.temperatureK;
    if (applied !== T) return fail(`OpenMC Studio set ${String(applied)} K where ${T} K was asked`);

    // 2. model.py of that project, and the OpenMC run
    const omRoot = join(base, "openmc");
    const projectFile = "models/pin.openmc-studio.json", modelFile = "models/pin.py";
    mkdirSync(join(omRoot, "models"), { recursive: true });
    writeFileSync(join(omRoot, projectFile), toStudio.output.content);
    const problems = await deps.generateModel(join(omRoot, projectFile), join(omRoot, modelFile));
    if (problems.length > 0) return fail("Studio's generator does not accept the project: " + problems.slice(0, 3).join("; "));
    const modelText = readFileSync(join(omRoot, modelFile), "utf8");
    const om = await deps.run("openmc", omRoot, [{ path: projectFile, text: toStudio.output.content }, { path: modelFile, text: modelText }], { project: projectFile, model: modelFile, threads: o.openmc.threads ?? 1 }, `${tag}-openmc`);
    if (!om.ok) return fail("the OpenMC run did not complete: " + om.reason, om.runId ? { [o.openmc.app]: om.runId } : undefined);
    const runs: Record<string, string> = { [o.openmc.app]: om.runId };
    const mesh = om.index.quantities.find((q: any) => q.name === o.openmc.quantity);
    if (!mesh) return fail(`the OpenMC run has no quantity ${JSON.stringify(o.openmc.quantity)}`, runs);
    const info: Record<string, number | string> = { temperatureAppliedK: T };
    const keff = om.index.quantities.find((q: any) => q.name === "keff");
    if (keff) {
      const row = tableRow(readFileSync(join(om.root, keff.data.path), "utf8"), keff);
      if (row && num(row[1]) && num(row[2])) { info.keff = row[1] as number; info.keffStd = row[2] as number; }
    }

    // 3. the heating into the FEED case, by FEED's transfer command
    const caseRevision = sha256Hex(args.feedCase);
    const meshText = readFileSync(join(om.root, mesh.data.path), "utf8");
    const meshData = readQuantityData(meshText, mesh);
    if (!meshData.ok) return fail("the heating mesh of the OpenMC run cannot be read: " + meshData.errors.map((x) => x.message).join("; "), runs);
    const heatRecipe: Recipe = {
      schema: "seed.transfer-recipe/0.2", recipeId: `${tag}-heating`.slice(0, 64), proposedBy: actor, proposedAt: now(),
      source: { runId: om.runId, resultsSha256: sha256Hex(JSON.stringify(om.index)), quantity: mesh.name, dataSha256: mesh.data.sha256, unit: mesh.unit, dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: o.openmc.artifact, revision: sha256Hex(toStudio.output.content) }] },
      target: { app: "feed", artifact: "pin-case", revision: caseRevision, field: "heating-to-pin" },
      units: { to: "W" },
      normalization: { kind: "total-power", value: { value: o.feed.totalPowerW, unit: "W" }, origin: "the total power of the pin, held fixed by the loop's registration" },
      mapping: { spatial: { pin: o.feed.pin, frame: o.feed.frame, slices: o.feed.slices, applyTo: o.feed.applyTo, pinBinCount: o.feed.binCount, columns: { pin: "xy" } }, time: { kind: "steady" }, extrapolation: "refused" },
      tolerance: { conservation: 1e-6, fixedBefore: "mapping" },
    };
    const heatOk = validateRecipe(heatRecipe);
    if (!heatOk.ok) return fail("the heating recipe is not valid: " + heatOk.errors.map((x) => x.message).join("; "), runs);
    const toFeed = await deps.transfer("feed", {
      schema: "seed.transfer-request/0.2", recipe: heatRecipe, recipeDigest: recipeDigest(heatRecipe),
      source: { quantity: mesh, data: meshData.data }, target: { artifact: "pin-case", revision: caseRevision, content: args.feedCase },
    });
    if (!toFeed.ok) return fail("FEED refused the heating of the OpenMC run: " + messageOf(toFeed), runs);

    // 4. the FEED run, and its fuel temperature
    const feRoot = join(base, "feed");
    const caseFile = "models/pin.case.json";
    const fe = await deps.run("feed", feRoot, [{ path: caseFile, text: toFeed.output.content }], { case: caseFile }, `${tag}-feed`);
    if (!fe.ok) return fail("the FEED run did not complete: " + fe.reason, fe.runId ? { ...runs, [o.feed.app]: fe.runId } : runs);
    runs[o.feed.app] = fe.runId;
    const q = fe.index.quantities.find((x: any) => x.name === EXCHANGED);
    if (!q) return fail(`the FEED run has no ${EXCHANGED}`, runs);
    const value = scalarOf(readFileSync(join(fe.root, q.data.path), "utf8"), q);
    if (value === null) return fail(`${EXCHANGED} of the FEED run is not a finite number`, runs);
    return { ok: true, calc: { [EXCHANGED]: value }, runs, info: { ...info, heatingPowerW: o.feed.totalPowerW } };
  };
}

// ---- the real dependencies ------------------------------------------------------------------------------------------------------------------------

/** The dependencies made from the host configuration: the apps' transfer commands, their adapters, and Studio's generator. */
export function realLumpedDeps(config: CouplingHostConfig, options: LumpedOptions, budget: Budget): LumpedDeps | { error: TypedError } {
  const appOf = { openmc: config.apps[options.openmc.app], feed: config.apps[options.feed.app] };
  for (const which of ["openmc", "feed"] as const) {
    const a = appOf[which];
    if (!a?.transfer) return { error: err("E_SETUP_REQUIRED", `/apps/${options[which].app}/transfer`, `the app ${options[which].app} has no transfer command in the configuration`) };
    if (!a.runner) return { error: err("E_SETUP_REQUIRED", `/apps/${options[which].app}/runner`, `the app ${options[which].app} has no runner (its adapter's command line) in the configuration`) };
  }
  // the OpenMC generator and its configuration are the adapter's (SEED_OPENMC_* variables); it is loaded only when a pass needs it
  const lib = () => createRequire(__filename)(join(__dirname, "..", "..", "adapters", "openmc", "lib.cjs")) as { config(): any; regenerate(cfg: any, projectAbs: string, outAbs: string): Promise<{ problems?: string[]; error?: TypedError }> };
  return {
    transfer: (app, request) => {
      const c = appOf[app]!.transfer!;
      return spawnTransferCommand(c.command, c.args, request as never, (c.timeoutSeconds ?? 180) * 1000);
    },
    generateModel: async (projectFile, modelFile) => {
      const l = lib();
      const cfg = l.config();
      if (cfg.setup) throw new Error("the OpenMC runner is not configured: " + cfg.setup);
      const r = await l.regenerate(cfg, projectFile, modelFile);
      if (r.error) throw new Error(r.error.message);
      return r.problems ?? [];
    },
    run: async (app, root, files, settings, requestId) => {
      for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
      for (const f of files) writeFileSync(join(root, f.path), f.text);
      const inputs = files.map((f) => ({ path: f.path, sha256: sha256Hex(f.text) }));
      const runner = appOf[app]!.runner!;
      const adapter = appOf[app]!.adapter;
      const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: { command: runner.command, args: runner.args, id: adapter.id, version: adapter.version }, pollMs: 200, callTimeoutMs: 180000 });
      const first = inputs[0]!;
      const out = await mgr.start({ requestId, actor: config.actor, artifact: { path: first.path, revision: { hash: first.sha256, counter: 1 } }, inputs, budget, settings });
      if (!out.ok) return { ok: false, reason: out.errors.slice(0, 3).map((e) => `${e.code}: ${e.message}`).join("; "), ...(out.runId ? { runId: out.runId } : {}) };
      if (out.state !== "completed") return { ok: false, reason: `the run ended ${out.state}: ${JSON.stringify((out.record as { native?: unknown }).native ?? null)}`, runId: out.runId };
      return { ok: true, runId: out.runId, root, index: JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8")) };
    },
  };
}

/** The pass builder registered for the kind `lumped-power-temperature`. */
export const lumpedPowerTemperature: PassBuilder = (ctx: PassContext) => {
  const checked = checkLumpedOptions(ctx.loop);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const o = checked.options;
  const study = ctx.config.study.budget;
  const budget: Budget = { maxWallSeconds: study.maxWallSeconds, maxCores: study.maxCores, maxMemoryMB: study.maxMemoryMB, maxDiskMB: study.maxDiskMB };
  const deps = realLumpedDeps(ctx.config, o, budget);
  if ("error" in deps) return { ok: false, errors: [deps.error] };
  return lumpedPassFrom(ctx, o, deps);
};

/** The pass of a context with given dependencies (the builder above with the real ones; tests with fakes). */
export function lumpedPassFrom(ctx: PassContext, o: LumpedOptions, deps: LumpedDeps): PassFunction | { ok: false; errors: TypedError[] } {
  const opened = openProject(ctx.projectRoot);
  if (!opened.ok) return { ok: false, errors: opened.errors };
  const artifacts = opened.value.manifest.artifacts as { id: string; path: string; revision: { hash: string } }[];
  const text = (artifact: string): string | TypedError => {
    const a = artifacts.find((x) => x.id === artifact);
    if (!a) return err("E_NOT_FOUND", "/options", `the project has no artifact ${artifact}`);
    const body = readFileSync(join(ctx.projectRoot, a.path), "utf8");
    return sha256Hex(body) === a.revision.hash ? body : err("E_STALE_REVISION", "/options", `the file of ${artifact} is not at the revision the project records`);
  };
  const openmcProject = text(o.openmc.artifact), feedCase = text(o.feed.artifact);
  if (typeof openmcProject !== "string") return { ok: false, errors: [openmcProject] };
  if (typeof feedCase !== "string") return { ok: false, errors: [feedCase] };
  mkdirSync(ctx.scratchRoot, { recursive: true });
  return makeLumpedPass({ loopId: ctx.loopId, requestId: ctx.requestId, options: o, actor: ctx.config.actor, openmcProject, feedCase, scratchRoot: ctx.scratchRoot, deps });
}
