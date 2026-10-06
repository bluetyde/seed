import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import type { Actor, GateContext } from "../src/core/policy";
import { readQuantityData } from "../src/core/quantityData";
import { RunManager, type Budget } from "../src/core/runManager";
import { checkResultsIndex } from "../src/core/semantic";
import { applyTransfer, recordApproval, spawnTransferCommand, type Recipe, type TransferView } from "../src/core/transfer";
import { validate } from "../src/core/validate";

// Heating from real OpenMC as a transfer source (E4 step 2). The Studio oracle project b10-heating-profile (a 4 cm B-10 slab, a 0.0253 eV beam
// along +z, a cell heating tally and a 3 x 3 x 5 mesh tally, the beam down its middle voxel column) runs through the adapter and the run manager against real OpenMC in WSL. The mesh
// quantity must be a v0.2 table in the layout FEED's transfer reads, with each bin equal to the formula N kappa (integral of exp(-Sigma z)) within
// 4 sigma of its predicted statistical error plus 0.4 % (kappa, N and Sigma from the library, via oracles/seed/xs); the bins must add up to the
// cell tally; and, when FEED's build has a transfer command, a recipe on that table must set a real FEED case's heat rate to the value computed here.
const win = process.platform === "win32";
const candidates = [process.env.SEED_OPENMC_REPO, join(__dirname, "..", "..", "openmc-seed"), join(homedir(), "Claude Code Test", "openmc-studio")];
const repo = candidates.find((p) => p && existsSync(join(p, "oracles", "seed", "models", "b10-heating-profile.py")) && existsSync(join(p, "studio", "tools", "regen_script.cjs"))) ?? "";
const electron = process.env.SEED_ELECTRON ?? join(__dirname, "..", "node_modules", "electron", "dist", win ? "electron.exe" : "electron");
const distro = process.env.SEED_OPENMC_WSL_DISTRO ?? "Ubuntu";
const py = process.env.SEED_OPENMC_PYTHON ?? "/root/miniconda3/envs/openmc-mcnp/bin/python";
const data = process.env.SEED_OPENMC_DATA ?? "/root/nuclear_data/endfb-viii.0-hdf5/cross_sections.xml";
const probe = (args: string[]) => (win ? spawnSync("wsl.exe", ["-d", distro, "--exec", ...args], { encoding: "utf8" }) : spawnSync(args[0]!, args.slice(1), { encoding: "utf8" }));
const have = repo !== "" && existsSync(electron) && probe(["/usr/bin/test", "-f", data]).status === 0 && probe(["/usr/bin/test", "-x", py]).status === 0;
const base = join(repo, "oracles", "seed");

const feedRepo = [process.env.SEED_FEED_REPO, join(__dirname, "..", "..", "fuel-performance-studio"), join(homedir(), "Claude Code Test", "fuel-performance-studio")].find((p) => p && existsSync(join(p, "dist", "cli", "headless.js"))) ?? "";
const feedBundle = join(feedRepo, "dist", "cli", "headless.js");
const feedCase = join(feedRepo, "oracles", "seed", "models", "synthetic-const.case.json");
const feedDescribe: any = (() => {
  if (!feedRepo || !existsSync(feedCase)) return null;
  const r = spawnSync(process.execPath, [feedBundle, "describe"], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { return null; }
})();
const haveFeed = !!feedDescribe && Array.isArray(feedDescribe.transfers) && feedDescribe.transfers.length > 0;

const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "openmc", "cli.cjs")], id: "openmc", version: "0.1.0" };
const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };
const budget: Budget = { maxWallSeconds: 600, maxCores: 1, maxMemoryMB: 4096, maxDiskMB: 1024 };
const dirs: string[] = [];
const names = ["SEED_OPENMC_REPO", "SEED_ELECTRON", "SEED_OPENMC_PYTHON", "SEED_OPENMC_DATA", "SEED_OPENMC_WSL_DISTRO"] as const;
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));

beforeAll(() => {
  if (have) Object.assign(process.env, { SEED_OPENMC_REPO: repo, SEED_ELECTRON: electron, SEED_OPENMC_PYTHON: py, SEED_OPENMC_DATA: data, SEED_OPENMC_WSL_DISTRO: distro });
});
afterAll(() => {
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (!have) console.warn(`OpenMC runtime or the Studio heating oracle project not found (repo ${repo || "none"}): the heating tests were skipped`);
  if (have && !haveFeed) console.warn(`FEED build under ${feedRepo || "(none found)"} has no transfer command: the OpenMC to FEED test was skipped`);
});

let ran: Promise<{ root: string; runId: string; index: any; indexText: string }> | undefined;
function run() {
  ran ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "seed openmc heating "));
    dirs.push(root);
    for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
    const inputs = ["models/b10-heating-profile.openmc-studio.json", "models/b10-heating-profile.py"].map((p) => ({ path: p, sha256: sha256Hex(readFileSync(join(base, p))) }));
    for (const i of inputs) { mkdirSync(join(root, dirname(i.path)), { recursive: true }); cpSync(join(base, i.path), join(root, i.path)); }
    const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 180000 });
    const out = await mgr.start({ requestId: "req-heating", actor: agent, artifact: { path: inputs[0]!.path, revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, budget, settings: { project: inputs[0]!.path, model: inputs[1]!.path, threads: 1 } });
    if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
    if (out.state !== "completed") throw new Error("run ended " + out.state);
    const indexText = readFileSync(join(root, "runs", out.runId, "results.json"), "utf8");
    return { root, runId: out.runId, index: JSON.parse(indexText), indexText };
  })();
  return ran;
}

// The formula, from the library numbers the Studio generator read (no transport).
const XS = have ? JSON.parse(readFileSync(join(base, "xs", "b10-294K-0.0253eV.json"), "utf8")) : null;
const RHO = 1e-3, NZ = 5, T = 4, N_HIST = 200000;
function profileBin(k: number) {
  const N = (RHO * XS.avogadro_per_mol) / XS.atomic_mass_amu * 1e-24;
  const S = N * XS.sigma_total_b;
  const dz = T / NZ, z0 = k * dz;
  const mean = (Math.exp(-S * z0) - Math.exp(-S * (z0 + dz))) / S; // cm of track in the bin per source particle
  const second = (2 * Math.exp(-S * z0) * (1 - Math.exp(-S * dz) * (1 + S * dz))) / (S * S);
  return { value: N * XS.heating_eV_b * mean, rel: Math.sqrt(Math.max(second - mean * mean, 0) / N_HIST) / mean };
}

describe.skipIf(!have)("OpenMC heating as a transfer source (real OpenMC)", () => {
  it("the index is v0.2 with a dimension on every quantity, and valid", async () => {
    const { index, runId } = await run();
    expect(index.schema).toBe("seed.results-index/0.2");
    expect(validate("results-index", index)).toEqual({ ok: true });
    expect(checkResultsIndex(index)).toEqual([]);
    expect(index.quantities.map((q: any) => `${q.name} ${q.unit} ${q.dimension}`)).toEqual(["B-10 profile slab:heating eV energy", "B-10 profile mesh:heating eV energy"]);
    expect(index.quantities.every((q: any) => q.normalization === "per-source-particle")).toBe(true);
    expect(index.extensions.openmc.frame).toBe("openmc-model");
    expect(runId).toBeTruthy();
  }, 900000);

  it("the mesh quantity is a v0.2 table in FEED's layout, each bin follows the formula, the bins add up to the cell tally", async () => {
    const { root, index } = await run();
    const cell = index.quantities[0], mesh = index.quantities[1];
    const read = (q: any) => {
      const r = readQuantityData(readFileSync(join(root, q.data.path), "utf8"), q);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      expect(r.converted).toBe(false);
      return r.data;
    };
    const t = read(mesh);
    expect(t.kind).toBe("table");
    if (t.kind !== "table") return;
    expect(t.columns.map((c) => `${c.name}:${c.role}:${c.unit}`)).toEqual([
      "xy:label:1", "x_min:coordinate:cm", "x_max:coordinate:cm", "y_min:coordinate:cm", "y_max:coordinate:cm", "z_min:coordinate:cm", "z_max:coordinate:cm", "volume:coordinate:cm3", "mean:value:eV", "std:std:eV",
    ]);
    expect((t.meta as any).frame).toBe("openmc-model");
    expect(t.rows).toHaveLength(3 * 3 * NZ);
    // Row order: x fastest, then y, then z. The voxel edges are -20, -6.667, 6.667, 20 in x and y, and 0, 0.8, ..., 4 in z (cm): a voxel's height is not 1.
    const edge = [-20, -20 + 40 / 3, -20 + 80 / 3, 20];
    let sum = 0, beamColumn = 0;
    t.rows.forEach((row, n) => {
      const i = n % 3, j = Math.floor(n / 3) % 3, k = Math.floor(n / 9), dz = T / NZ;
      expect(row[0]).toBe(`${i + 1},${j + 1}`);
      [edge[i], edge[i + 1], edge[j], edge[j + 1], k * dz, (k + 1) * dz].forEach((want, c) => expect(Math.abs((row[c + 1] as number) - want), `voxel ${row[0]} z ${k} coordinate ${c}`).toBeLessThan(1e-9));
      expect(Math.abs((row[7] as number) - (40 / 3) ** 2 * dz)).toBeLessThan(1e-9);
      const got = row[8] as number;
      sum += got;
      if (i === 1 && j === 1) {
        // the beam column: each axial bin follows the formula
        const want = profileBin(k);
        beamColumn += got;
        expect(Math.abs(got - want.value) / want.value, `bin ${k}: ${got} against ${want.value}`).toBeLessThan(4 * want.rel + 0.004);
        expect(row[9] as number).toBeGreaterThan(0);
        expect(Math.abs(((row[9] as number) / got) - want.rel)).toBeLessThan(0.6 * want.rel); // the reported std is about the predicted one
      } else {
        // everywhere else only scattered neutrons can heat: a tiny fraction (the order of the elastic fraction, 0.06 % of collisions)
        expect(got, `voxel ${row[0]} z ${k}`).toBeLessThan(0.005 * profileBin(0).value);
      }
    });
    expect(beamColumn / sum).toBeGreaterThan(0.995);
    const c = read(cell);
    if (c.kind !== "table") return;
    expect(Math.abs(sum - (c.rows[0]![1] as number)) / sum).toBeLessThan(1e-9);
  }, 900000);

  it.skipIf(!haveFeed)("a recipe on that table sets a real FEED case's heat rate to the value computed from the bins", async () => {
    const { root, runId, index, indexText } = await run();
    const mesh = index.quantities[1];
    const dataText = readFileSync(join(root, mesh.data.path), "utf8");
    const bins = (JSON.parse(dataText).rows as any[]).filter((r) => r[0] === "2,2").map((r) => r[8] as number); // the beam column, in z order
    const NOW = new Date("2026-10-06T12:00:00Z");
    const gate: GateContext = { study: { studyId: "study-1", tier: "A2", budget, parameters: [] }, now: () => NOW };
    const rate = 5e13, EV_J = 1.602176634e-19;
    const recipe: Recipe = {
      schema: "seed.transfer-recipe/0.2", recipeId: "openmc-heat-1", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
      source: { runId, resultsSha256: sha256Hex(indexText), quantity: mesh.name, dataSha256: mesh.data.sha256, unit: "eV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-model", revision: index.inputHashes[0].sha256 }] },
      target: { app: "feed", artifact: "pin-case", revision: "rev-case", field: "heating-to-pin" },
      units: { to: "W" },
      normalization: { kind: "source-rate", value: { value: rate, unit: "1/s" }, origin: "a source rate chosen for the test" },
      mapping: { spatial: { pin: "2,2", frame: "openmc-model", slices: [{ id: "s1", z: { min: 0, max: 0.016 } }, { id: "s2", z: { min: 0.016, max: 0.04 } }], applyTo: "s1", columns: { pin: "xy" } }, time: { kind: "steady" }, extrapolation: "refused" },
      tolerance: { conservation: 1e-6, fixedBefore: "mapping" },
    };
    const stateRoot = mkdtempSync(join(tmpdir(), "seed openmc heating state "));
    dirs.push(stateRoot);
    const approval = recordApproval({ stateRoot, projectRoot: root, projectId: "proj-1", studyId: "study-1", recipe, approver: human, grantedTo: agent, approvalId: "appr-1", now: NOW, expires: new Date(NOW.getTime() + 3600e3) });
    if (!approval.ok) throw new Error(JSON.stringify(approval.errors));
    const view: TransferView = {
      projectId: "proj-1", projectRoot: root, now: NOW, sourceIndex: indexText, sourceRunState: "completed",
      readData: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
      currentRevisions: { "openmc-model": index.inputHashes[0].sha256, "pin-case": "rev-case" }, artifactPaths: { "openmc-model": index.inputHashes[0].path, "pin-case": "c.json" }, targetTransfers: feedDescribe.transfers, approvals: [approval.approval], applied: [],
    };
    const out = await applyTransfer({ recipe, view, actor: agent, gate, studyId: "study-1", targetContent: readFileSync(feedCase, "utf8"), run: (r) => spawnTransferCommand(process.execPath, [feedBundle, "transfer"], r, 60000) });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const expected = ((bins[0]! + bins[1]!) * rate * EV_J) / 0.016; // the first slice is the first two bins of 0.8 cm
    const got = JSON.parse(out.content).power.linearHeatRate;
    expect(got.unit).toBe("W/m");
    expect(Math.abs(got.value - expected) / expected).toBeLessThan(1e-9);
  }, 900000);
});
