import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import type { Actor, GateContext } from "../src/core/policy";
import { RunManager, type Budget } from "../src/core/runManager";
import { applyTransfer, evaluateTransfer, recordApproval, spawnTransferCommand, type Recipe, type TransferView } from "../src/core/transfer";

// A real NODAL run as the source of a coolant boundary (E4, NODAL to FEED): the heated-pipe golden model records the coolant temperature at the
// pipe outlet (`t_out`, K) and the heat transfer coefficient at the wall surface (`h_surf`, W/m2/K). Through the adapter and the run manager, a
// recipe names the first as the primary quantity and the second as the additional quantity with the role heat-transfer-coefficient, with the last
// sample (or one at a time between samples) selected for a steady boundary. The fake boundary target (tests/fixtures/fake-transfer/boundary.cjs)
// writes what it received; the expected values come from the committed golden vector of the model, not from the run.
const repo = process.env.SEED_NODAL_REPO ?? [join(__dirname, "..", "..", "nodal-seed"), join(__dirname, "..", "..", "pipe-studio")].find((p) => existsSync(join(p, "nodal_studio", "run.py"))) ?? "";
const python = [process.env.SEED_NODAL_PYTHON, join(repo, ".venv", "Scripts", "python.exe"), join(repo, ".venv", "bin", "python"), join(__dirname, "..", "..", "pipe-studio", ".venv", "Scripts", "python.exe")].find((p) => p && existsSync(p)) ?? "";
const have = python !== "" && repo !== "" && existsSync(join(repo, "schema", "vectors", "golden", "heated-pipe.json")) &&
  spawnSync(python, ["-m", "nodal_studio.run", "--describe"], { cwd: repo, env: { ...process.env, PYTHONPATH: repo }, encoding: "utf8" }).status === 0;

const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "nodal", "cli.cjs")], id: "nodal", version: "0.1.0" };
const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const boundaryCmd = join(__dirname, "fixtures", "fake-transfer", "boundary.cjs");
const dirs: string[] = [];
const saved = { py: process.env.SEED_NODAL_PYTHON, repo: process.env.SEED_NODAL_REPO };
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [["SEED_NODAL_PYTHON", saved.py], ["SEED_NODAL_REPO", saved.repo]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!have) console.warn(`NODAL runner not usable (repo ${repo || "none"}, python ${python || "none"}): the NODAL boundary tests were skipped`);
});

let ran: Promise<{ root: string; runId: string; indexText: string; index: any; golden: any }> | undefined;
function run() {
  ran ??= (async () => {
    process.env.SEED_NODAL_PYTHON = python;
    process.env.SEED_NODAL_REPO = repo;
    const golden = JSON.parse(readFileSync(join(repo, "schema", "vectors", "golden", "heated-pipe.json"), "utf8"));
    const root = mkdtempSync(join(tmpdir(), "seed-nodal-boundary-"));
    dirs.push(root);
    for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
    const modelText = JSON.stringify(golden.model, null, 2) + "\n";
    writeFileSync(join(root, "models/heated-pipe.json"), modelText);
    const inputs = [{ path: "models/heated-pipe.json", sha256: sha256Hex(modelText) }];
    const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 });
    const out = await mgr.start({ requestId: "req-boundary", actor: human, artifact: { path: inputs[0]!.path, revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, budget, settings: { model: inputs[0]!.path, recordDt: golden.recordDt } });
    if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
    if (out.state !== "completed") throw new Error("run ended " + out.state);
    const indexText = readFileSync(join(root, "runs", out.runId, "results.json"), "utf8");
    return { root, runId: out.runId, indexText, index: JSON.parse(indexText), golden };
  })();
  return ran;
}

const NOW = new Date("2026-10-06T12:00:00Z");
const gate: GateContext = { study: { studyId: "study-1", tier: "A2", budget, parameters: [] }, now: () => NOW };
const accepts = [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", normalization: "none", additional: [{ role: "heat-transfer-coefficient", dimension: "heat-transfer-coefficient" }] }] }];

async function transfer(select: { kind: "last" | "at"; t?: number }) {
  const { root, runId, indexText, index, golden } = await run();
  const byName = (n: string) => index.quantities.find((q: any) => q.name === n);
  const T = byName("t_out"), H = byName("h_surf");
  const recipe: Recipe = {
    schema: "seed.transfer-recipe/0.2", recipeId: "boundary-nodal", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
    source: {
      runId, resultsSha256: sha256Hex(indexText), quantity: "t_out", dataSha256: T.data.sha256, unit: T.unit, dimension: T.dimension, normalization: "none", revisionPins: [{ artifact: "nodal-model", revision: "rev-n" }],
      additional: [{ role: "heat-transfer-coefficient", quantity: "h_surf", dataSha256: H.data.sha256, unit: H.unit, dimension: H.dimension, normalization: "none" }],
    },
    target: { app: "feed", artifact: "pin-case", revision: "rev-d", field: "coolant-boundary" },
    units: { to: "K" }, normalization: { kind: "none" },
    mapping: { spatial: { region: { id: "pipe1-outlet", z: { min: 0.8, max: 1 } }, boundaryForm: "bulk-plus-h" }, time: { kind: "steady", select }, extrapolation: "refused" },
    tolerance: { conservation: 0.01, fixedBefore: "mapping" },
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "seed-nodal-boundary-state-"));
  dirs.push(stateRoot);
  const a = recordApproval({ stateRoot, projectRoot: root, projectId: "proj-1", studyId: "study-1", recipe, approver: human, grantedTo: agent, approvalId: "appr-n", now: NOW, expires: new Date(NOW.getTime() + 3600e3) });
  if (!a.ok) throw new Error(JSON.stringify(a.errors));
  const view: TransferView = {
    projectId: "proj-1", projectRoot: root, now: NOW, sourceIndex: indexText, sourceRunState: "completed",
    readData: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null),
    currentRevisions: { "nodal-model": "rev-n", "pin-case": "rev-d" }, targetTransfers: accepts, approvals: [a.approval], applied: [],
  };
  const state = evaluateTransfer(recipe, view).state;
  const out = await applyTransfer({ recipe, view, actor: agent, gate, studyId: "study-1", targetContent: "{}", run: (r) => spawnTransferCommand(process.execPath, [boundaryCmd], r, 30000) });
  return { out, state, golden, T, H };
}

describe.skipIf(!have)("a real NODAL run as the source of a coolant boundary", () => {
  it("the recorded coolant temperature and wall coefficient carry dimensions and units a transfer accepts", async () => {
    const { index } = await run();
    expect(index.schema).toBe("seed.results-index/0.2");
    const t = index.quantities.find((q: any) => q.name === "t_out"), h = index.quantities.find((q: any) => q.name === "h_surf");
    expect(t).toMatchObject({ unit: "K", dimension: "temperature", normalization: "none" });
    expect(h).toMatchObject({ unit: "W/m2/K", dimension: "heat-transfer-coefficient", normalization: "none" });
  }, 300000);

  it("the last sample of both series reaches the target, equal to the golden vector's last values", async () => {
    const { out, state, golden } = await transfer({ kind: "last" });
    expect(state).toBe("approved");
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const b = JSON.parse(out.content).boundary;
    const last = (n: string) => golden.expected.data[n].at(-1) as number;
    expect(Math.abs(b.bulkTemperatureK - last("t_out"))).toBeLessThanOrEqual(1e-9 * Math.abs(last("t_out")) + 1e-12);
    expect(Math.abs(b.heatTransferCoefficient - last("h_surf"))).toBeLessThanOrEqual(1e-9 * Math.abs(last("h_surf")) + 1e-12);
    expect(b.at).toBe(golden.expected.time.at(-1));
    expect(b.interpolated).toBe(false);
    expect(out.provenance.selected).toHaveLength(2);
  }, 300000);

  it("a time between two samples is interpolated linearly from the golden vector", async () => {
    const { golden } = await run();
    const time: number[] = golden.expected.time;
    const i = Math.floor(time.length / 2);
    const t = (time[i]! + time[i + 1]!) / 2;
    const { out } = await transfer({ kind: "at", t });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const b = JSON.parse(out.content).boundary;
    const lin = (n: string) => (golden.expected.data[n][i] + golden.expected.data[n][i + 1]) / 2;
    expect(Math.abs(b.bulkTemperatureK - lin("t_out"))).toBeLessThanOrEqual(1e-9 * Math.abs(lin("t_out")) + 1e-12);
    expect(Math.abs(b.heatTransferCoefficient - lin("h_surf"))).toBeLessThanOrEqual(1e-9 * Math.abs(lin("h_surf")) + 1e-12);
    expect(b.interpolated).toBe(true);
  }, 300000);

  it("a time after the end of the run is refused, not extrapolated", async () => {
    const { golden } = await run();
    const end = golden.expected.time.at(-1) as number;
    const { out, state } = await transfer({ kind: "at", t: end + 1 });
    expect(state).toBe("invalid");
    expect(out.ok).toBe(false);
  }, 300000);
});
