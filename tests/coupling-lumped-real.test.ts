// @covers R-STUDY-09
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync as git } from "node:child_process";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { couplingRegistrationPin, runCouplingFromHostFile, saveCouplingHostConfig, validateCouplingHostConfig, type CouplingHostConfig } from "../src/core/couplingHost";
import { readAdmissions, writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { issueGrant, type Actor } from "../src/core/policy";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import { appDir } from "./helpers/appDir";

// The lumped power-temperature loop with the REAL apps: OpenMC Studio's eigenvalue run in WSL (its transfer command, its generator in Electron, OpenMC), and
// FEED's solver (its transfer command, the solver in WSL), each through its own SEED adapter, under the coupling host's gate with a human grant. The
// project holds a UO2 pin cell with a heating mesh and a FEED pin case; the pin power is held fixed, so FEED's temperature does not depend on what OpenMC was
// given and the loop converges in three passes: it proves the exchange, not the physics (the loop says so: purpose plumbing-test). Skipped, loudly, when
// the runtimes are not there.
const win = process.platform === "win32";
const omCandidates = [process.env.SEED_OPENMC_REPO, join(appDir("openmc-studio"))];
const omRepo = omCandidates.find((p) => p && existsSync(join(p, "test", "generated", "eigenvalue_pin.project.json")) && existsSync(join(p, "studio", "tools", "regen_script.cjs"))) ?? "";
const electron = process.env.SEED_ELECTRON ?? join(__dirname, "..", "node_modules", "electron", "dist", win ? "electron.exe" : "electron");
const distro = process.env.SEED_OPENMC_WSL_DISTRO ?? "Ubuntu";
const py = process.env.SEED_OPENMC_PYTHON ?? "/root/miniconda3/envs/openmc-mcnp/bin/python";
const data = process.env.SEED_OPENMC_DATA ?? "/root/nuclear_data/endfb-viii.0-hdf5/cross_sections.xml";
const probe = (args: string[]) => (win ? spawnSync("wsl.exe", ["-d", distro, "--exec", ...args], { encoding: "utf8" }) : spawnSync(args[0]!, args.slice(1), { encoding: "utf8" }));
const haveOpenmc = omRepo !== "" && existsSync(electron) && probe(["/usr/bin/test", "-f", data]).status === 0 && probe(["/usr/bin/test", "-x", py]).status === 0;

const feedRepo = [process.env.SEED_FEED_REPO, join(appDir("feed"))].find((p) => p && existsSync(join(p, "dist", "cli", "headless.js"))) ?? "";
const feedBundle = join(feedRepo, "dist", "cli", "headless.js");
const feedCaseFile = join(feedRepo, "oracles", "seed", "models", "synthetic-const.case.json");
const feedDescribe: any = (() => {
  if (!feedRepo || !existsSync(feedCaseFile)) return null;
  const r = spawnSync(process.execPath, [feedBundle, "describe"], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { return null; }
})();
const haveFeed = !!feedDescribe && feedDescribe.solver?.available === true && Array.isArray(feedDescribe.transfers) && feedDescribe.transfers.length > 0;
const have = haveOpenmc && haveFeed;

const names = ["SEED_OPENMC_REPO", "SEED_ELECTRON", "SEED_OPENMC_PYTHON", "SEED_OPENMC_DATA", "SEED_OPENMC_WSL_DISTRO", "SEED_FEED_HEADLESS"] as const;
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const dirs: string[] = [];
beforeAll(() => { if (have) Object.assign(process.env, { SEED_OPENMC_REPO: omRepo, SEED_ELECTRON: electron, SEED_OPENMC_PYTHON: py, SEED_OPENMC_DATA: data, SEED_OPENMC_WSL_DISTRO: distro, SEED_FEED_HEADLESS: feedBundle }); });
afterAll(() => {
  for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!have) console.warn(`OpenMC Studio (${haveOpenmc ? "ok" : "missing: " + (omRepo || "no checkout")}) or FEED (${haveFeed ? "ok" : "missing: " + (feedRepo || "no checkout")}) is not available: the real lumped loop test was skipped`);
});

const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };
const adapters = join(__dirname, "..", "adapters");

async function appOracles(root: string, name: string, adapterId: string) {
  const repo = join(root, name + "-repo"), entries = join(repo, "entries");
  mkdirSync(entries, { recursive: true });
  const model = JSON.stringify({ name });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "q", value: 1, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = { schema: "seed.oracle/0.1", oracleId: name + "-one", entryVersion: 1, adapter: adapterId, adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
    source: { kind: "hand", text: "test", check: "fixture" }, coverage: { quantities: ["q"], domain: "fixture" }, toleranceHash: sha256Hex(canonicalJson({ expected, tolerance })) };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) expect(git("git", args, { encoding: "utf8" }).status).toBe(0);
  const commit = git("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: adapterId, version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", quantity: "q", value: 1, unit: "1" }) });
  const evidence = join(root, name + "-evidence.json");
  writeHostJson(evidence, result);
  return { adapter: { id: adapterId, version: "0.1.0" }, oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: result.pins };
}

describe.skipIf(!have)("the lumped power-temperature loop with real OpenMC Studio and real FEED", () => {
  it("runs under a grant, converges, hands each app the other's result, and writes nothing to the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "seed lumped real "));
    dirs.push(root);
    const project = join(root, "project"), state = join(root, "state");
    mkdirSync(state, { recursive: true });
    expect(createProject(project, { name: "Lumped loop", seedVersion: "0.1.0" }).ok).toBe(true);

    // the OpenMC project: Studio's UO2 pin cell (eigenvalue, 1000 x 40) plus a heating mesh over the fuel, one pin column of four axial bins (lengths in cm)
    const om = JSON.parse(readFileSync(join(omRepo, "test", "generated", "eigenvalue_pin.project.json"), "utf8"));
    om.tallies = [{ cells: [], ebins: "", id: "mesh", kind: "mesh", name: "Pin mesh", lx: -0.5, ly: -0.5, lz: -0.63, ux: 0.5, uy: 0.5, uz: 0.63, nx: 1, ny: 1, nz: 4, scores: ["heating"] }];
    const omText = JSON.stringify(om, null, 2) + "\n";
    const feedText = readFileSync(feedCaseFile, "utf8");
    writeFileSync(join(project, "models/pin.openmc-studio.json"), omText);
    writeFileSync(join(project, "models/pin.case.json"), feedText);
    const p = openProject(project);
    if (!p.ok) throw Error("project");
    const manifest = structuredClone(p.value.manifest) as Record<string, any>;
    manifest.artifacts = [
      { id: "om-project", app: "openmc", path: "models/pin.openmc-studio.json", format: "openmc-studio.project", formatVersion: "1", revision: { hash: sha256Hex(omText), counter: 1 } },
      { id: "pin-case", app: "feed", path: "models/pin.case.json", format: "feed.case", formatVersion: "1", revision: { hash: sha256Hex(feedText), counter: 1 } },
    ];
    expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);

    const inputs = { openmc: [{ artifact: "om-project", revision: sha256Hex(omText) }], feed: [{ artifact: "pin-case", revision: sha256Hex(feedText) }] };
    const cfg = (grants: any[]): CouplingHostConfig => ({
      schema: "seed.coupling-host/0.1", projectRoot: project, stateRoot: state, actor: agent,
      study: { studyId: "study-1", tier: "A2", budget: { maxWallSeconds: 900, maxCores: 1, maxMemoryMB: 4096, maxDiskMB: 1024, maxCases: 100 }, parameters: [] },
      grants,
      apps: {
        openmc: { ...apps.openmc, runner: { command: process.execPath, args: [join(adapters, "openmc", "cli.cjs")] }, transfer: { command: process.execPath, args: [join(adapters, "openmc", "transfer.cjs")], timeoutSeconds: 240 } },
        feed: { ...apps.feed, runner: { command: process.execPath, args: [join(adapters, "feed", "cli.cjs")] }, transfer: { command: process.execPath, args: [feedBundle, "transfer"], timeoutSeconds: 120 } },
      },
      loops: {
        lumped: {
          purpose: "plumbing-test", kind: "lumped-power-temperature", apps: ["openmc", "feed"], inputs,
          definition: { exchanged: [{ id: "temperature_fuel_mean", tolerance: 1e-3, min: 250, max: 2500 }], maxPasses: 6, relaxation: 1, consecutive: 2 },
          start: { temperature_fuel_mean: 900 },
          options: {
            openmc: { app: "openmc", artifact: "om-project", material: "m_uo2", quantity: "Pin mesh:heating", threads: 1 },
            feed: { app: "feed", artifact: "pin-case", pin: "1,1", frame: "openmc-model", applyTo: "s1", binCount: 4, totalPowerW: 250, slices: [{ id: "s1", z: { min: -0.0063, max: 0.0063 } }] },
          },
        },
      },
    });
    const apps = { openmc: await appOracles(root, "openmc", "openmc"), feed: await appOracles(root, "feed", "feed") };
    const validated = validateCouplingHostConfig(JSON.parse(JSON.stringify(cfg([]))));
    const g = issueGrant(human, { grantId: "g-1", studyId: "study-1", actor: { kind: agent.kind, name: agent.name }, operation: "enable_coupling", inputRevisions: [...inputs.openmc, ...inputs.feed, couplingRegistrationPin("lumped", validated.loops.lumped!)], issuedAt: "2026-10-25T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" } as any);
    if (!g.ok) throw new Error(JSON.stringify(g.errors));
    const file = join(root, "agent-host.json");
    saveCouplingHostConfig(file, cfg([g.grant]));

    const out = await runCouplingFromHostFile(file, { requestId: "req-real-1", loopId: "lumped" });
    expect(out, JSON.stringify(out).slice(0, 1500)).toMatchObject({ ok: true, verification: "unverified", purpose: "plumbing-test" });
    if (!out.ok) return;
    expect(out.outcome.state, out.outcome.reason).toBe("converged");
    const T = out.outcome.result!.iterate.temperature_fuel_mean as number;
    expect(T).toBeGreaterThan(300);
    expect(T).toBeLessThan(2500);

    // the journal: a start, a row per pass with both apps' run ids and the k-eff OpenMC found, an outcome
    const rows = readAdmissions(join(state, "coupling-journal")).map((r) => r.event as any);
    const passes = rows.filter((r) => r.phase === "pass");
    expect(passes.length).toBe(out.outcome.result!.passes);
    expect(rows[0].phase).toBe("start");
    expect(rows.at(-1)).toMatchObject({ phase: "outcome", state: "converged", verification: "unverified" });
    expect(passes[0].iterate.temperature_fuel_mean).toBe(900);
    expect(passes[1].iterate.temperature_fuel_mean).toBe(passes[0].calc.temperature_fuel_mean); // the answer of one pass is the iterate of the next
    for (const row of passes) {
      expect(Object.keys(row.runs).sort()).toEqual(["feed", "openmc"]);
      expect(row.info.keff).toBeGreaterThan(0.5);
      expect(row.info.keff).toBeLessThan(2);
      expect(row.info.keffStd).toBeGreaterThan(0);
    }
    expect(passes[0].info.temperatureAppliedK).toBe(900);
    expect(passes[1].info.temperatureAppliedK).toBeCloseTo(passes[0].calc.temperature_fuel_mean, 9);

    // what each app was given, from the scratch copies: Studio's project holds the temperature, FEED's case the heat rate of the registered power
    const scratch = join(state, "coupling-scratch");
    const only = join(scratch, readdirSync(scratch)[0]!);
    const sentOpenmc = JSON.parse(readFileSync(join(only, "pass-002", "openmc", "models", "pin.openmc-studio.json"), "utf8"));
    expect(sentOpenmc.materials.find((m: any) => m.id === "m_uo2").temperature).toBeCloseTo(passes[0].calc.temperature_fuel_mean, 9);
    const sentFeed = JSON.parse(readFileSync(join(only, "pass-002", "feed", "models", "pin.case.json"), "utf8"));
    expect(sentFeed.power.linearHeatRate.unit).toBe("W/m");
    expect(Math.abs(sentFeed.power.linearHeatRate.value - 250 / 0.0126) / (250 / 0.0126)).toBeLessThan(1e-6);
    // and FEED's last answer is the loop's result
    const feedRuns = join(only, `pass-${String(passes.length).padStart(3, "0")}`, "feed", "runs", passes.at(-1).runs.feed);
    const index = JSON.parse(readFileSync(join(feedRuns, "results.json"), "utf8"));
    const q = index.quantities.find((x: any) => x.name === "temperature_fuel_mean");
    expect(JSON.parse(readFileSync(join(only, `pass-${String(passes.length).padStart(3, "0")}`, "feed", q.data.path), "utf8")).value).toBeCloseTo(T, 9);

    // the project is as it was
    expect(readFileSync(join(project, "models/pin.openmc-studio.json"), "utf8")).toBe(omText);
    expect(readFileSync(join(project, "models/pin.case.json"), "utf8")).toBe(feedText);
    expect((openProject(project) as any).value.manifest.artifacts.map((a: any) => a.revision.hash)).toEqual([sha256Hex(omText), sha256Hex(feedText)]);
  }, 1_500_000);
});
