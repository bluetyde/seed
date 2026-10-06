import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { callAdapter } from "../src/core/adapterClient";
import type { Actor, GateContext } from "../src/core/policy";
import { applyTransfer, evaluateTransfer, recordApproval, spawnTransferCommand, type Recipe, type TransferView } from "../src/core/transfer";

// FEED's real `transfer` command (docs/transfer-heating.md in the FEED repo) behind SEED's transfer core: the heating table of a
// source run is mapped onto the axial slices of a pin and sets one slice's linear heat rate in a real FEED case. Expected values
// are computed here from the bins, independently of FEED's code. Needs the FEED checkout built (`npm run build`), no solver.
// Set SEED_FEED_REPO to the FEED checkout. Skipped, loudly, when the build has no `transfer` command.
const repoCandidates = [process.env.SEED_FEED_REPO, join(__dirname, "..", "..", "fuel-performance-studio"), join(homedir(), "Claude Code Test", "fuel-performance-studio")];
const repo = repoCandidates.find((p) => p && existsSync(join(p, "dist", "cli", "headless.js"))) ?? "";
const bundle = join(repo, "dist", "cli", "headless.js");
const casePath = join(repo, "oracles", "seed", "models", "synthetic-const.case.json");
const runnerDescribe: any = (() => {
  if (!repo || !existsSync(casePath)) return null;
  const r = spawnSync(process.execPath, [bundle, "describe"], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { return null; }
})();
const have = !!runnerDescribe && Array.isArray(runnerDescribe.transfers) && runnerDescribe.transfers.length > 0;

const tmp = mkdtempSync(join(tmpdir(), "seed-feed-transfer-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (!have) console.warn(`FEED build under ${repo || "(none found)"} has no transfer command: the FEED transfer tests were skipped`);
});

const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };
const NOW = new Date("2026-10-06T12:00:00Z");
const gate: GateContext = { study: { studyId: "study-1", tier: "A2", budget: { maxWallSeconds: 60, maxCores: 1, maxMemoryMB: 100, maxDiskMB: 100 }, parameters: [] }, now: () => NOW };
const EV_J = 1.602176634e-19;
const RATE = 2e16;
const BINS = [[0, 0.25, 1e6], [0.25, 0.5, 2e6], [0.5, 0.75, 3e6], [0.75, 1, 4e6]] as const;

let n = 0;
function world(over: { table?: (t: any) => void; recipe?: (r: any) => void } = {}) {
  const base = join(tmp, "w" + n++);
  const project = join(base, "project"), state = join(base, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const table: any = {
    schema: "seed.quantity-data/0.2", quantity: "Fuel:heating", kind: "table", unit: "eV", meta: { frame: "core" },
    columns: [{ name: "pin", unit: "1", role: "label" }, { name: "z_min", unit: "m", role: "coordinate" }, { name: "z_max", unit: "m", role: "coordinate" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }],
    rows: [...BINS.map(([a, b, v]) => [["pin-1"], a, b, v, 1e3]), [["pin-2"], 0, 1, 9e9, 1]]
  };
  over.table?.(table);
  const dataText = JSON.stringify(table);
  const index: any = {
    schema: "seed.results-index/0.2", runId: "run-001", status: "completed", adapter: { id: "openmc", version: "1" }, engine: { name: "openmc", version: "0.15" },
    inputHashes: [{ path: "m.json", sha256: "a".repeat(64) }], nativeStatus: { status: "ok", detail: "ok" },
    quantities: [{ name: "Fuel:heating", unit: "eV", dimension: "energy", normalization: "per-source-particle", provenance: { runId: "run-001", inputRevisions: ["a".repeat(64)] }, data: { path: "runs/run-001/native/000.json", sha256: sha256Hex(dataText) }, verification: "unverified" }]
  };
  const indexText = JSON.stringify(index);
  const recipe: any = {
    schema: "seed.transfer-recipe/0.2", recipeId: "heat-to-pin-1", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
    source: { runId: "run-001", resultsSha256: sha256Hex(indexText), quantity: "Fuel:heating", dataSha256: sha256Hex(dataText), unit: "eV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-model", revision: "a".repeat(64) }] },
    target: { app: "feed", artifact: "pin-case", revision: "rev-d", field: "heating-to-pin" },
    units: { to: "W" },
    normalization: { kind: "source-rate", value: { value: RATE, unit: "1/s" }, origin: "a source rate chosen for the test" },
    mapping: { spatial: { pin: "pin-1", frame: "core", slices: [{ id: "s1", z: { min: 0, max: 0.5 } }, { id: "s2", z: { min: 0.5, max: 1 } }], applyTo: "s1" }, time: { kind: "steady" }, extrapolation: "refused" },
    tolerance: { conservation: 1e-6, fixedBefore: "mapping" }
  };
  over.recipe?.(recipe);
  const view = (approvals: TransferView["approvals"]): TransferView => ({
    projectId: "proj-1", projectRoot: project, now: NOW, sourceIndex: indexText, sourceRunState: "completed",
    readData: (p) => (p === "runs/run-001/native/000.json" ? dataText : null),
    currentRevisions: { "openmc-model": "a".repeat(64), "pin-case": "rev-d" }, artifactPaths: { "openmc-model": "m.json", "pin-case": "c.json" },
    targetTransfers: runnerDescribe.transfers, approvals, applied: []
  });
  let given: ReturnType<typeof recordApproval> | undefined;
  const approve = () => {
    given ??= recordApproval({ stateRoot: state, projectRoot: project, projectId: "proj-1", studyId: "study-1", recipe: recipe as Recipe, approver: human, grantedTo: agent, approvalId: "appr-1", now: NOW, expires: new Date(NOW.getTime() + 3600e3) });
    const out = given;
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    return out.approval;
  };
  const targetText = readFileSync(casePath, "utf8");
  const run = (request: any) => spawnTransferCommand(process.execPath, [bundle, "transfer"], request, 60000);
  const apply = () => applyTransfer({ recipe: recipe as Recipe, view: view([approve()]), actor: agent, gate, studyId: "study-1", targetContent: targetText, run });
  return { recipe: recipe as Recipe, view, approve, apply, targetText };
}

describe.skipIf(!have)("FEED transfer command behind the SEED transfer core (real runner, no solver)", () => {
  it("the FEED adapter passes the runner's transfers into describe", async () => {
    const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "feed", "cli.cjs")], id: "feed", version: "0.1.0" };
    process.env.SEED_FEED_HEADLESS = bundle;
    try {
      const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-d", actor: human, verb: "describe" }, { projectRoot: tmp, timeoutMs: 120000 });
      expect(o.ok).toBe(true);
      const reply = (o as any).reply;
      expect(reply.result.transfers.map((t: any) => t.field)).toEqual(["heating-to-pin"]);
      expect(reply.result.transfers[0].accepts).toContainEqual({ dimension: "energy", normalization: "per-source-particle" });
    } finally {
      delete process.env.SEED_FEED_HEADLESS;
    }
  }, 150000);

  it("source rate: the chosen slice gets exactly the heat of its bins, in W/m, and nothing else of the case changes", async () => {
    const w = world();
    expect(evaluateTransfer(w.recipe, w.view([w.approve()])).state).toBe("approved");
    const out = await w.apply();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const before = JSON.parse(w.targetText), after = JSON.parse(out.content);
    const expected = ((1e6 + 2e6) * RATE * EV_J) / 0.5;
    expect(after.power.linearHeatRate.unit).toBe("W/m");
    expect(Math.abs(after.power.linearHeatRate.value - expected) / expected).toBeLessThan(1e-12);
    expect(after.geometry).toEqual(before.geometry);
    expect(after.materials).toEqual(before.materials);
    expect(after.boundary).toEqual(before.boundary);
    expect(out.provenance).toMatchObject({ recipeId: "heat-to-pin-1", sourceRunId: "run-001", targetRevisionBefore: "rev-d" });
    expect(out.checks).toBeDefined();
  }, 120000);

  it("the other slice gets its own heat; rows of another pin are ignored", async () => {
    const w = world({ recipe: (r) => { r.mapping.spatial.applyTo = "s2"; } });
    const out = await w.apply();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (out.ok) {
      const expected = ((3e6 + 4e6) * RATE * EV_J) / 0.5;
      expect(Math.abs(JSON.parse(out.content).power.linearHeatRate.value - expected) / expected).toBeLessThan(1e-12);
    }
  }, 120000);

  it("total power is the pin's total shared out in proportion to the bins", async () => {
    const w = world({ recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 40000, unit: "W" }, origin: "the pin's power from the model" }; r.mapping.spatial.pinBinCount = 4; } });
    const out = await w.apply();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (out.ok) expect(JSON.parse(out.content).power.linearHeatRate.value).toBeCloseTo((40000 * 0.3) / 0.5, 6);
  }, 120000);

  it.each<[string, { table?: (t: any) => void; recipe?: (r: any) => void }, string]>([
    ["a coordinate frame that differs from the table's", { recipe: (r) => { r.mapping.spatial.frame = "other"; } }, "E_FRAME_MISMATCH"],
    ["a gap in the bins under a slice (never extrapolated)", { table: (t) => { t.rows.splice(1, 1); } }, "E_COVERAGE"],
    ["slices that do not span all of the pin's bins (conservation)", { recipe: (r) => { r.mapping.spatial.slices = [{ id: "s1", z: { min: 0, max: 0.5 } }]; } }, "E_CONSERVATION"],
    ["a total power without the bin count", { recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 40000, unit: "W" }, origin: "x" }; } }, "E_NORMALIZATION_MISSING"],
    ["a total power defined over another number of bins than the table has", { recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 40000, unit: "W" }, origin: "x" }; r.mapping.spatial.pinBinCount = 3; } }, "E_NORMALIZATION_DOMAIN"],
    ["an unknown spatial key", { recipe: (r) => { r.mapping.spatial.surprise = 1; } }, "E_RECIPE_INVALID"],
    ["a slice that is not the one to apply", { recipe: (r) => { r.mapping.spatial.applyTo = "s9"; } }, "E_RECIPE_INVALID"],
    ["a time series", { recipe: (r) => { r.mapping.time = { kind: "series" }; } }, "E_UNSUPPORTED"],
    ["overlapping bins", { table: (t) => { t.rows[1][1] = 0.2; } }, "E_SCHEMA_INVALID"],
  ])("refuses %s with %s as app content, and never writes a case", async (_name, over, code) => {
    const out = await world(over).apply();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.map((e) => e.code), JSON.stringify(out.errors)).toContain(code);
    if (!out.ok) expect(out.errors[0]!.source).toBe("app-content");
  }, 120000);

  it("SEED refuses before FEED is called: a unit FEED does not produce is still stopped by FEED itself", async () => {
    // W/m is a valid power-per-length unit for SEED; FEED only takes W, so the answer comes from FEED as E_UNITS.
    const w = world({ recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 40000, unit: "W" }, origin: "x" }; r.mapping.spatial.pinBinCount = 4; r.units.to = "W/m"; } });
    expect(evaluateTransfer(w.recipe, w.view([w.approve()])).state).toBe("approved");
    const out = await w.apply();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatchObject({ code: "E_UNITS", source: "app-content" });
  }, 120000);
});
