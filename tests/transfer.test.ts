import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import type { Actor, GateContext } from "../src/core/policy";
import {
  applyTransfer, checkPipeline, downstreamOf, evaluateTransfer, grantsFromApprovals, listApprovals, readRecipes, recipeDigest, recordApproval, selectSample,
  spawnTransferCommand, writeRecipe, type Approval, type Recipe, type TransferView
} from "../src/core/transfer";
import { validate } from "../src/core/validate";

const PIN_A = "a".repeat(64); // the input hash the fixture runs record (index.inputHashes)
const tmp = mkdtempSync(join(tmpdir(), "seed-transfer-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): { project: string; state: string } => {
  const base = join(tmp, "w" + n++);
  const project = join(base, "project"), state = join(base, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  return { project, state };
};

const agent: Actor = { kind: "agent", name: "claude", model: "opus" };
const human: Actor = { kind: "human", name: "John" };
const NOW = new Date("2026-10-06T12:00:00Z");
const gate = (over: Partial<GateContext> = {}): GateContext => ({
  study: { studyId: "study-1", tier: "A2", budget: { maxWallSeconds: 60, maxCores: 1, maxMemoryMB: 100, maxDiskMB: 100 }, parameters: [] },
  now: () => NOW, ...over
});

type Over = { index?: (i: any) => void; data?: (d: any) => void; recipe?: (r: any) => void; indexText?: (s: string) => string };
function world(over: Over = {}) {
  const dataDoc: any = {
    schema: "seed.quantity-data/0.2", quantity: "Fuel:heating", kind: "table", unit: "eV",
    columns: [{ name: "bin", unit: "1", role: "label" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }],
    rows: [[["a"], 1e6, 1e3], [["b"], 2e6, 1e3], [["c"], 3e6, 1e3]]
  };
  over.data?.(dataDoc);
  const dataText = JSON.stringify(dataDoc);
  const indexDoc: any = {
    schema: "seed.results-index/0.2", runId: "run-001", status: "completed", adapter: { id: "openmc", version: "1" }, engine: { name: "openmc", version: "0.15" },
    inputHashes: [{ path: "m.json", sha256: "a".repeat(64) }], nativeStatus: { status: "ok", detail: "ok" },
    quantities: [{ name: "Fuel:heating", unit: "eV", dimension: "energy", normalization: "per-source-particle", provenance: { runId: "run-001", inputRevisions: ["a".repeat(64)] }, data: { path: "runs/run-001/native/000.json", sha256: sha256Hex(dataText) }, verification: "unverified" }]
  };
  over.index?.(indexDoc);
  const indexText = JSON.stringify(indexDoc);
  const recipe: any = {
    schema: "seed.transfer-recipe/0.2", recipeId: "heat-to-pin-1", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
    source: { runId: "run-001", resultsSha256: sha256Hex(indexText), quantity: "Fuel:heating", dataSha256: sha256Hex(dataText), unit: "eV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-model", revision: PIN_A }] },
    target: { app: "feed", artifact: "pin-case", revision: "rev-d", field: "heating-to-pin" },
    units: { to: "W" },
    normalization: { kind: "source-rate", value: { value: 1.5e17, unit: "1/s" }, origin: "1 MW over 200 MeV per fission, from the model's power" },
    mapping: { spatial: { slices: [{ id: "s1", bins: ["a", "b"] }, { id: "s2", bins: ["c"] }] }, time: { kind: "steady" }, extrapolation: "refused" },
    tolerance: { conservation: 0.01, fixedBefore: "mapping" }
  };
  over.recipe?.(recipe);
  const w = fresh();
  const view = (extra: Partial<TransferView> = {}): TransferView => ({
    projectId: "proj-1", projectRoot: w.project, now: NOW,
    sourceIndex: over.indexText ? over.indexText(indexText) : indexText, sourceRunState: "completed",
    readData: (p) => (p === "runs/run-001/native/000.json" ? dataText : null),
    currentRevisions: { "openmc-model": PIN_A, "pin-case": "rev-d" },
    targetTransfers: [{ field: "heating-to-pin", accepts: [{ dimension: "energy", normalization: "per-source-particle" }] }],
    approvals: [], applied: [], artifactPaths: { "openmc-model": "m.json", "nodal-model": "m.json", "pin-case": "c.json" }, ...extra
  });
  const approve = (r: Recipe = recipe, id = "appr-1", expiresInH = 24): Approval => {
    const out = recordApproval({ stateRoot: w.state, projectRoot: w.project, projectId: "proj-1", studyId: "study-1", recipe: r, approver: human, grantedTo: agent, approvalId: id, now: NOW, expires: new Date(NOW.getTime() + expiresInH * 3600e3) });
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    return out.approval;
  };
  return { recipe: recipe as Recipe, view, approve, ...w, dataText, indexText };
}

const flat = (r: { errors: { code: string; field: string }[] }) => r.errors.map((e) => `${e.code} ${e.field}`);

describe("recipe states", () => {
  it("a recipe with no approval is proposed; with one it is approved; once applied it is applied", () => {
    const w = world();
    const p = evaluateTransfer(w.recipe, w.view());
    expect(p.state).toBe("proposed");
    expect(flat(p)).toEqual(["E_NOT_PERMITTED /approval"]);
    const a = w.approve();
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a] })).state).toBe("approved");
    const applied = [{ recipeId: w.recipe.recipeId, recipeDigest: recipeDigest(w.recipe), targetRevisionAfter: "rev-after" }];
    const after = { "openmc-model": PIN_A, "pin-case": "rev-after" };
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], applied, currentRevisions: after })).state).toBe("applied");
    // applied stands without a valid approval (it expired since), but not once the target moved on, nor once the source changed
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [], applied, currentRevisions: after })).state).toBe("applied");
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], applied, currentRevisions: { ...after, "pin-case": "rev-later" } })).state).toBe("stale");
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], applied, currentRevisions: { ...after, "openmc-model": "rev-new" } })).state).toBe("stale");
    // before the target changed, a recipe with an applied record is still at its pinned revision
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], applied })).state).toBe("applied");
  });

  it("editing the recipe after approval voids the approval", () => {
    const w = world();
    const a = w.approve();
    const edited = { ...w.recipe, tolerance: { ...w.recipe.tolerance, conservation: 0.5 } };
    const e = evaluateTransfer(edited, w.view({ approvals: [a] }));
    expect(e.state).toBe("proposed");
    expect(e.errors[0]!.message).toMatch(/changed after/);
  });

  it("an approval of another recipe is not this recipe's approval", () => {
    const w = world();
    const other = w.approve({ ...w.recipe, recipeId: "other-recipe" });
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [other] })).errors[0]!.message).toMatch(/no approval/);
  });

  it("an expired approval, another project's approval and an approval for other revisions do not count", () => {
    const w = world();
    const expired = w.approve(w.recipe, "appr-old", 1);
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [expired], now: new Date(NOW.getTime() + 2 * 3600e3) })).errors[0]!.message).toMatch(/expired/);
    const a = w.approve();
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], projectId: "proj-2" })).state).toBe("proposed");
    const other: Approval = { ...a, inputRevisions: [{ artifact: "openmc-model", revision: PIN_A }, { artifact: "pin-case", revision: "rev-x" }] };
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [other] })).errors[0]!.message).toMatch(/other revisions/);
    const byAgent = { ...a, approvedBy: { kind: "agent", name: "claude" } } as unknown as Approval;
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [byAgent] })).state).toBe("proposed");
  });

  it("a changed source or target revision makes it stale, never approved", () => {
    const w = world();
    const a = w.approve();
    for (const [artifact, field] of [["openmc-model", "/source/revisionPins/0"], ["pin-case", "/target/revision"]] as const) {
      const e = evaluateTransfer(w.recipe, w.view({ approvals: [a], currentRevisions: { "openmc-model": PIN_A, "pin-case": "rev-d", [artifact]: "rev-new" } }));
      expect(e.state).toBe("stale");
      expect(flat(e)).toEqual([`E_STALE_REVISION ${field}`]);
    }
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [a], currentRevisions: { "openmc-model": PIN_A } })).state).toBe("stale");
  });

  it("source results or data that differ from the pins are stale", () => {
    const w = world();
    const changed = evaluateTransfer(w.recipe, w.view({ sourceIndex: w.indexText.replace("0.15", "0.16") }));
    expect(changed.state).toBe("stale");
    expect(flat(changed)).toContain("E_STALE_REVISION /source/resultsSha256");
    const dataChanged = evaluateTransfer(w.recipe, w.view({ readData: () => w.dataText.replace("1000000", "1000001") }));
    expect(flat(dataChanged)).toContain("E_STALE_REVISION /source/dataSha256");
    expect(dataChanged.errors.find((e) => e.field === "/source/dataSha256")!.message).toMatch(/does not match the hash in the results index/);
    const pinned = world({ recipe: (r) => { r.source.dataSha256 = "f".repeat(64); } });
    const pe = evaluateTransfer(pinned.recipe, pinned.view());
    expect(pe.state).toBe("stale");
    expect(pe.errors.map((e) => e.message).join("|")).toMatch(/differ from the ones the recipe pinned/);
    const norm = world({ recipe: (r) => { r.source.normalization = "per-fission"; } });
    expect(flat(evaluateTransfer(norm.recipe, norm.view()))).toContain("E_STALE_REVISION /source/normalization");
  });
});

describe("refusals SEED makes from its own records", () => {
  const refused = (over: Over, code: string, field: string, extra: Partial<TransferView> = {}) => {
    const w = world(over);
    const e = evaluateTransfer(w.recipe, w.view(extra));
    expect(e.state, JSON.stringify(e.errors)).toBe("invalid");
    expect(flat(e)).toContain(`${code} ${field}`);
  };

  it("units: unknown unit, a unit of another dimension, a quantity with no dimension, a differing dimension or unit", () => {
    refused({ recipe: (r) => { r.source.unit = "furlong"; } }, "E_UNITS", "/source/unit");
    refused({ recipe: (r) => { r.source.unit = "W"; } }, "E_UNITS", "/source/unit");
    refused({ index: (i) => { delete i.quantities[0].dimension; } }, "E_UNITS", "/source/dimension");
    const nd = world({ index: (i) => { delete i.quantities[0].dimension; } });
    expect(evaluateTransfer(nd.recipe, nd.view()).errors.find((e) => e.field === "/source/dimension")!.message).toMatch(/declares no dimension/);
    refused({ recipe: (r) => { r.source.dimension = "power"; r.source.unit = "W"; } }, "E_UNITS", "/source/dimension");
    refused({ index: (i) => { i.quantities[0].unit = "keV"; } }, "E_UNITS", "/source/unit");
    refused({ recipe: (r) => { r.units.to = "W/m"; } }, "E_UNITS", "/units/to");
    refused({ recipe: (r) => { r.units.to = "furlong"; } }, "E_UNITS", "/units/to");
  });

  it("normalization: a per-source-particle score needs one, and an absolute score must not get one", () => {
    refused({ recipe: (r) => { r.normalization = { kind: "none" }; r.units.to = "eV"; } }, "E_NORMALIZATION_MISSING", "/normalization");
    refused({ recipe: (r) => { delete r.normalization.origin; } }, "E_NORMALIZATION_MISSING", "/normalization");
    refused({ recipe: (r) => { r.normalization.value.unit = "W"; } }, "E_UNITS", "/normalization/value/unit");
    refused({ recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 1e6, unit: "1/s" }, origin: "x" }; r.units.to = "W"; } }, "E_UNITS", "/normalization/value/unit");
    refused({ index: (i) => { i.quantities[0].normalization = "none"; }, recipe: (r) => { r.source.normalization = "none"; } }, "E_UNITS", "/normalization");
  });

  it("a source-rate cannot turn a length into something", () => {
    refused({ index: (i) => { i.quantities[0].unit = "cm"; i.quantities[0].dimension = "length"; }, recipe: (r) => { r.source.unit = "cm"; r.source.dimension = "length"; r.units.to = "W"; }, data: (d) => { d.unit = "cm"; d.columns[1].unit = "cm"; d.columns[2].unit = "cm"; } }, "E_UNITS", "/normalization");
  });

  it("a missing, incomplete or other quantity of the source run is refused", () => {
    refused({}, "E_OUTPUT_INCOMPLETE", "/source/runId", { sourceIndex: null });
    const w = world();
    expect(flat(evaluateTransfer(w.recipe, w.view({ sourceRunState: "failed" })))).toContain("E_OUTPUT_INCOMPLETE /source/runId");
    refused({ recipe: (r) => { r.source.quantity = "Nope:heating"; } }, "E_NOT_FOUND", "/source/quantity");
    refused({}, "E_OUTPUT_INCOMPLETE", "/source/dataSha256", { readData: () => null });
    refused({ data: (d) => { d.rows[0][1] = "x"; } }, "E_SCHEMA_INVALID", "/rows/0/1");
  });

  it("a total-power normalization maps to power, power per length or power per volume", () => {
    for (const to of ["W", "W/m", "W/m3", "kW/m"]) {
      const w = world({ recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 1e6, unit: "W" }, origin: "the model's power" }; r.units.to = to; } });
      expect(evaluateTransfer(w.recipe, w.view()).state, to).toBe("proposed");
    }
    refused({ recipe: (r) => { r.normalization = { kind: "total-power", value: { value: 1e6, unit: "W" }, origin: "x" }; r.units.to = "K"; } }, "E_UNITS", "/units/to");
  });

  it("the target must declare the transfer and accept this source", () => {
    refused({}, "E_UNSUPPORTED", "/target/field", { targetTransfers: [] });
    refused({}, "E_UNITS", "/target/field", { targetTransfers: [{ field: "heating-to-pin", accepts: [{ dimension: "power" }] }] });
    refused({}, "E_UNITS", "/target/field", { targetTransfers: [{ field: "heating-to-pin", accepts: [{ dimension: "energy", normalization: "none" }] }] });
  });

  it("a recipe that breaks its schema is invalid before anything else", () => {
    const w = world({ recipe: (r) => { r.mapping.extrapolation = "allowed"; } });
    const e = evaluateTransfer(w.recipe, w.view());
    expect(e.state).toBe("invalid");
    expect(e.errors[0]!.code).toBe("E_SCHEMA_INVALID");
  });
});

describe("who may do what", () => {
  it("an agent cannot approve; the approval needs a human and lives outside the project", () => {
    const w = world();
    const common = { stateRoot: w.state, projectRoot: w.project, projectId: "proj-1", studyId: "study-1", recipe: w.recipe, grantedTo: agent, approvalId: "x1", now: NOW, expires: new Date(NOW.getTime() + 3600e3) };
    const byAgent = recordApproval({ ...common, approver: agent });
    expect(byAgent.ok).toBe(false);
    if (!byAgent.ok) expect(byAgent.errors[0]!.code).toBe("E_NOT_PERMITTED");
    expect(recordApproval({ ...common, approver: { kind: "system", name: "host" } }).ok).toBe(false);
    mkdirSync(join(w.project, "state"));
    const inside = recordApproval({ ...common, approver: human, stateRoot: join(w.project, "state") });
    expect(inside.ok).toBe(false);
    expect(listApprovals(w.state, "proj-1", w.project).approvals).toEqual([]);
  });

  it("an approval cannot be written twice, and round-trips through the schema", () => {
    const w = world();
    const a = w.approve();
    expect(validate("transfer-approval", a).ok).toBe(true);
    const again = recordApproval({ stateRoot: w.state, projectRoot: w.project, projectId: "proj-1", studyId: "study-1", recipe: w.recipe, approver: human, grantedTo: agent, approvalId: "appr-1", now: NOW, expires: new Date(NOW.getTime() + 3600e3) });
    expect(again.ok).toBe(false);
    const listed = listApprovals(w.state, "proj-1", w.project);
    expect(listed.problems).toEqual([]);
    expect(listed.approvals).toEqual([a]);
    expect(listApprovals(w.state, "proj-2", w.project).approvals).toEqual([]);
  });

  it("an unreadable or foreign file in the approvals folder is reported, never trusted", () => {
    const w = world();
    const a = w.approve();
    const dir = join(w.state, "transfer-approvals", sha256Hex("proj-1\n" + w.project));
    writeFileSync(join(dir, "junk.json"), "{}");
    writeFileSync(join(dir, "appr-9.json"), JSON.stringify({ ...a, approvalId: "other" }));
    const listed = listApprovals(w.state, "proj-1", w.project);
    expect(listed.approvals).toEqual([a]);
    expect(listed.problems).toHaveLength(2);
  });

  it("the approvals work as grants for enable_transfer, only for this recipe content", () => {
    const w = world();
    const a = w.approve();
    expect(grantsFromApprovals([a], w.recipe)).toHaveLength(1);
    expect(grantsFromApprovals([a], { ...w.recipe, units: { to: "kW" } })).toHaveLength(0);
    expect(grantsFromApprovals([{ ...a, recipeId: "other" }], w.recipe)).toHaveLength(0);
  });

  it("writing a recipe needs the propose_transfer gate and the proposer's own name", () => {
    const w = world();
    const ok = writeRecipe({ projectRoot: w.project, recipe: w.recipe, actor: agent, gate: gate(), studyId: "study-1" });
    expect(ok.ok).toBe(true);
    expect(existsSync(join(w.project, "transfers", "heat-to-pin-1.json"))).toBe(true);
    const spoof = writeRecipe({ projectRoot: w.project, recipe: w.recipe, actor: { ...agent, name: "other" }, gate: gate(), studyId: "study-1" });
    expect(spoof.ok).toBe(false);
    const a0 = writeRecipe({ projectRoot: w.project, recipe: w.recipe, actor: agent, gate: gate({ study: { ...gate().study, tier: "A1" } }), studyId: "study-1" });
    expect(a0.ok).toBe(false);
    const blocked = writeRecipe({ projectRoot: w.project, recipe: w.recipe, actor: agent, gate: gate({ oracleBlocked: true }), studyId: "study-1" });
    expect(blocked.ok).toBe(false);
    writeFileSync(join(w.project, "transfers", "misnamed.json"), JSON.stringify(w.recipe));
    expect(readRecipes(w.project).problems.map((p) => p.field)).toEqual(["/misnamed.json"]);
    rmSync(join(w.project, "transfers", "misnamed.json"));
    const read = readRecipes(w.project);
    expect(read.problems).toEqual([]);
    expect(read.recipes).toEqual([w.recipe]);
  });

  it("reading recipes from a project without a transfers folder creates nothing", () => {
    const w = world();
    expect(readRecipes(w.project)).toEqual({ recipes: [], problems: [] });
    expect(existsSync(join(w.project, "transfers"))).toBe(false);
  });

  it("the transfers folder must be a real folder inside the project", () => {
    const w = world();
    const outside = join(tmp, "elsewhere");
    mkdirSync(outside, { recursive: true });
    try { symlinkSync(outside, join(w.project, "transfers"), "junction"); } catch { return; }
    expect(() => writeRecipe({ projectRoot: w.project, recipe: w.recipe, actor: agent, gate: gate(), studyId: "study-1" })).toThrow();
    expect(existsSync(join(outside, "heat-to-pin-1.json"))).toBe(false);
  });
});

describe("pipeline graph", () => {
  const rec = (id: string, from: string[], to: string): Recipe => {
    const w = world();
    return { ...w.recipe, recipeId: id, source: { ...w.recipe.source, revisionPins: from.map((a) => ({ artifact: a, revision: "r" })) }, target: { ...w.recipe.target, artifact: to } };
  };
  it("refuses a cycle at definition, and a self loop", () => {
    expect(checkPipeline([rec("a", ["x"], "y"), rec("b", ["y"], "z")])).toEqual([]);
    const cyc = checkPipeline([rec("a", ["x"], "y"), rec("b", ["y"], "z"), rec("c", ["z"], "x")]);
    expect(cyc).toHaveLength(1);
    expect(cyc[0]).toMatchObject({ code: "E_RECIPE_CYCLE" });
    expect(checkPipeline([rec("a", ["x"], "x")])[0]!.code).toBe("E_RECIPE_CYCLE");
  });
  it("an upstream change marks everything downstream, visibly", () => {
    const rs = [rec("a", ["x"], "y"), rec("b", ["y"], "z"), rec("c", ["q"], "r")];
    expect(downstreamOf(rs, ["x"])).toEqual({ recipeIds: ["a", "b"], artifacts: ["y", "z"] });
    expect(downstreamOf(rs, ["y"])).toEqual({ recipeIds: ["b"], artifacts: ["z"] });
    expect(downstreamOf(rs, ["r"])).toEqual({ recipeIds: [], artifacts: [] });
  });
});

describe("applying through the target command (fake apps)", () => {
  const target = join(__dirname, "fixtures", "fake-transfer", "target.cjs");
  const runWith = (mode: string) => (request: any) => { process.env.FAKE_TRANSFER_MODE = mode; return spawnTransferCommand(process.execPath, [target], request, 20000); };
  const apply = (w: ReturnType<typeof world>, mode: string, over: { actor?: Actor; approvals?: Approval[]; gateCtx?: GateContext; view?: Partial<TransferView> } = {}) =>
    applyTransfer({ recipe: w.recipe, view: w.view({ approvals: over.approvals ?? [w.approve()], ...over.view }), actor: over.actor ?? agent, gate: over.gateCtx ?? gate(), studyId: "study-1", targetContent: '{"pin":"pin-1"}\n', run: runWith(mode) });

  it("the good case: maps, conserves the total, and records the provenance", async () => {
    const w = world();
    const out = await apply(w, "good");
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const doc = JSON.parse(out.content);
    const total = (1e6 + 2e6 + 3e6) * 1.5e17 * 1.602176634e-19;
    expect(doc.powerW.s1 + doc.powerW.s2).toBeCloseTo(total, 3);
    expect(out.provenance).toMatchObject({ recipeId: "heat-to-pin-1", sourceRunId: "run-001", targetRevisionBefore: "rev-d", approvalId: "appr-1" });
    expect(out.provenance.targetRevisionAfter).toBe(sha256Hex(out.content));
    expect(out.provenance.recipeDigest).toBe(recipeDigest(w.recipe));
    expect(doc.from).toBe(recipeDigest(w.recipe));
  });

  it("a uniform field onto a uniform target reproduces the total exactly", async () => {
    const w = world({ data: (d) => { d.rows = [[["a"], 1e6, 0], [["b"], 1e6, 0], [["c"], 1e6, 0]]; } });
    w.recipe.mapping.spatial = { slices: [{ id: "s1", bins: ["a"] }, { id: "s2", bins: ["b"] }, { id: "s3", bins: ["c"] }] };
    const out = await apply(w, "good");
    expect(out.ok).toBe(true);
    if (out.ok) { const p = Object.values(JSON.parse(out.content).powerW) as number[]; expect(p[0]).toBe(p[1]); expect(p[1]).toBe(p[2]); }
  });

  it("a deliberately lossy mapping fails conservation, and the app's refusal is data with its own code", async () => {
    const out = await apply(world(), "lossy");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatchObject({ code: "E_CONSERVATION", source: "app-content" });
  });

  it("coverage: a bin the source does not have is refused, not extrapolated", async () => {
    const w = world();
    w.recipe.mapping.spatial = { slices: [{ id: "s1", bins: ["a", "zzz"] }] };
    const out = await applyTransfer({ recipe: w.recipe, view: w.view({ approvals: [w.approve(w.recipe)] }), actor: agent, gate: gate(), studyId: "study-1", targetContent: "{}", run: runWith("good") });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]!.code).toBe("E_COVERAGE");
  });

  it("app refusals keep valid codes, a bad code becomes E_APP_FAILED", async () => {
    const out = await apply(world(), "refuse");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.map((e) => e.code)).toEqual(["E_BOUNDARY_INCOMPLETE", "E_APP_FAILED"]);
  });

  it("a command that exits, answers garbage or changes nothing is a refusal", async () => {
    for (const mode of ["exit", "garbage", "nochange", "reply-then-exit"]) {
      const out = await apply(world(), mode);
      expect(out.ok, mode).toBe(false);
      if (!out.ok) expect(out.errors[0]!.code).toBe("E_APP_FAILED");
    }
    const none = await spawnTransferCommand("definitely-not-a-command-seed", [], {} as any, 5000);
    expect(none.ok).toBe(false);
  });

  it("nothing runs without a matching human approval: not approved, edited, another actor, expired, stale", async () => {
    const w = world();
    const calls: number[] = [];
    const spy = (r: any) => { calls.push(1); return runWith("good")(r); };
    const good = w.approve();
    const run = (over: Partial<Parameters<typeof applyTransfer>[0]>) => applyTransfer({ recipe: w.recipe, view: w.view({ approvals: [good] }), actor: agent, gate: gate(), studyId: "study-1", targetContent: "{}", run: spy, ...over });
    expect((await run({ view: w.view({ approvals: [] }) })).ok).toBe(false);
    const edited = { ...w.recipe, tolerance: { ...w.recipe.tolerance, conservation: 0.9 } };
    expect((await run({ recipe: edited })).ok).toBe(false);
    expect((await run({ actor: { ...agent, name: "someone-else" } })).ok).toBe(false);
    expect((await run({ view: w.view({ approvals: [w.approve(w.recipe, "appr-e", 1)], now: new Date(NOW.getTime() + 2 * 3600e3) }) })).ok).toBe(false);
    expect((await run({ view: w.view({ approvals: [w.approve(w.recipe, "appr-s")], currentRevisions: { "openmc-model": PIN_A, "pin-case": "rev-other" } }) })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("an applied recipe cannot be applied again", async () => {
    const w = world();
    const a = w.approve();
    const out = await applyTransfer({ recipe: w.recipe, view: w.view({ approvals: [a], applied: [{ recipeId: w.recipe.recipeId, recipeDigest: recipeDigest(w.recipe), targetRevisionAfter: "rev-after" }], currentRevisions: { "openmc-model": PIN_A, "pin-case": "rev-after" } }), actor: agent, gate: gate(), studyId: "study-1", targetContent: "{}", run: runWith("good") });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]!.code).toBe("E_EXISTS");
  });

  it("the request the app receives carries the typed source data, not the file", async () => {
    const w = world();
    let seen: any;
    await applyTransfer({ recipe: w.recipe, view: w.view({ approvals: [w.approve()] }), actor: agent, gate: gate(), studyId: "study-1", targetContent: "TARGET", run: async (r) => { seen = r; return { ok: false, errors: [{ code: "E_UNSUPPORTED", message: "stop" }] }; } });
    expect(seen.schema).toBe("seed.transfer-request/0.2");
    expect(seen.source.data.kind).toBe("table");
    expect(seen.source.quantity.dimension).toBe("energy");
    expect(seen.target).toEqual({ artifact: "pin-case", revision: "rev-d", content: "TARGET" });
    expect(readFileSync(target, "utf8")).toContain("FAKE_TRANSFER_MODE");
  });
});

describe("a coolant boundary: two quantities of one run and a chosen sample (fake apps)", () => {
  const boundaryCmd = join(__dirname, "fixtures", "fake-transfer", "boundary.cjs");
  const series = (quantity: string, unit: string, values: number[]) => ({ schema: "seed.quantity-data/0.2", quantity, kind: "series", unit, axis: { name: "t", unit: "s" }, x: [0, 10, 20], values });
  const accepts = [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", normalization: "none", additional: [{ role: "heat-transfer-coefficient", dimension: "heat-transfer-coefficient" }] }] }];

  function bworld(over: { recipe?: (r: any) => void; index?: (i: any) => void; targetTransfers?: any } = {}) {
    const T = JSON.stringify(series("coolant T", "K", [550, 560, 570])), H = JSON.stringify(series("wall htc", "W/m2/K", [30000, 31000, 32000]));
    const files: Record<string, string> = { "runs/run-001/native/000.json": T, "runs/run-001/native/001.json": H };
    const index: any = {
      schema: "seed.results-index/0.2", runId: "run-001", status: "completed", adapter: { id: "nodal", version: "1" }, engine: { name: "nodal", version: "1" },
      inputHashes: [{ path: "m.json", sha256: "a".repeat(64) }], nativeStatus: { status: "ok", detail: "ok" },
      quantities: [
        { name: "coolant T", unit: "K", dimension: "temperature", normalization: "none", provenance: { runId: "run-001", inputRevisions: ["a".repeat(64)] }, data: { path: "runs/run-001/native/000.json", sha256: sha256Hex(T) }, verification: "unverified" },
        { name: "wall htc", unit: "W/m2/K", dimension: "heat-transfer-coefficient", normalization: "none", provenance: { runId: "run-001", inputRevisions: ["a".repeat(64)] }, data: { path: "runs/run-001/native/001.json", sha256: sha256Hex(H) }, verification: "unverified" },
      ],
    };
    over.index?.(index);
    const indexText = JSON.stringify(index);
    const recipe: any = {
      schema: "seed.transfer-recipe/0.2", recipeId: "boundary-1", proposedBy: agent, proposedAt: "2026-10-06T10:00:00Z",
      source: {
        runId: "run-001", resultsSha256: sha256Hex(indexText), quantity: "coolant T", dataSha256: sha256Hex(T), unit: "K", dimension: "temperature", normalization: "none",
        revisionPins: [{ artifact: "nodal-model", revision: PIN_A }],
        additional: [{ role: "heat-transfer-coefficient", quantity: "wall htc", dataSha256: sha256Hex(H), unit: "W/m2/K", dimension: "heat-transfer-coefficient", normalization: "none", unitTo: "W/m2/K" }],
      },
      target: { app: "feed", artifact: "pin-case", revision: "rev-d", field: "coolant-boundary" },
      units: { to: "K" },
      normalization: { kind: "none" },
      mapping: { spatial: { region: { id: "core-mid", z: { min: 0.4, max: 0.6 } }, boundaryForm: "bulk-plus-h" }, time: { kind: "steady", select: { kind: "last" } }, extrapolation: "refused" },
      tolerance: { conservation: 0.01, fixedBefore: "mapping" },
    };
    over.recipe?.(recipe);
    const w = fresh();
    const view = (extra: Partial<TransferView> = {}): TransferView => ({
      projectId: "proj-1", projectRoot: w.project, now: NOW, sourceIndex: indexText, sourceRunState: "completed", readData: (p) => files[p] ?? null,
      currentRevisions: { "nodal-model": PIN_A, "pin-case": "rev-d" }, targetTransfers: over.targetTransfers ?? accepts, approvals: [], applied: [], artifactPaths: { "openmc-model": "m.json", "nodal-model": "m.json", "pin-case": "c.json" }, ...extra,
    });
    let given: Approval | undefined;
    const approve = (): Approval => {
      if (!given) {
        const o = recordApproval({ stateRoot: w.state, projectRoot: w.project, projectId: "proj-1", studyId: "study-1", recipe, approver: human, grantedTo: agent, approvalId: "appr-b", now: NOW, expires: new Date(NOW.getTime() + 3600e3) });
        if (!o.ok) throw new Error(JSON.stringify(o.errors));
        given = o.approval;
      }
      return given;
    };
    const apply = (run?: (r: any) => Promise<any>) => applyTransfer({ recipe, view: view({ approvals: [approve()] }), actor: agent, gate: gate(), studyId: "study-1", targetContent: "{}", run: run ?? ((r) => spawnTransferCommand(process.execPath, [boundaryCmd], r, 20000)) });
    return { recipe: recipe as Recipe, view, approve, apply };
  }

  it("the last sample of each series reaches the target by role, and the provenance says which samples were used", async () => {
    const w = bworld();
    expect(evaluateTransfer(w.recipe, w.view({ approvals: [w.approve()] })).state).toBe("approved");
    const out = await w.apply();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(JSON.parse(out.content).boundary).toMatchObject({ bulkTemperatureK: 570, heatTransferCoefficient: 32000, at: 20, interpolated: false, region: { id: "core-mid" } });
    expect(out.provenance.selected).toEqual([{ quantity: "coolant T", x: 20, value: 570, interpolated: false }, { quantity: "wall htc", x: 20, value: 32000, interpolated: false }]);
    expect(out.checks).toMatchObject({ sawRoles: ["heat-transfer-coefficient"], units: { T: "K", h: "W/m2/K" } });
  });

  it("at a time between samples is linear and flagged; at a sample time it is that sample", async () => {
    const between = await bworld({ recipe: (r) => { r.mapping.time.select = { kind: "at", t: 15 }; } }).apply();
    expect(between.ok).toBe(true);
    if (between.ok) {
      expect(JSON.parse(between.content).boundary).toMatchObject({ bulkTemperatureK: 565, heatTransferCoefficient: 31500, at: 15, interpolated: true });
      expect(between.provenance.selected!.every((x) => x.interpolated)).toBe(true);
    }
    const exact = await bworld({ recipe: (r) => { r.mapping.time.select = { kind: "at", t: 10 }; } }).apply();
    if (exact.ok) expect(JSON.parse(exact.content).boundary).toMatchObject({ bulkTemperatureK: 560, heatTransferCoefficient: 31000, interpolated: false });
    const first = await bworld({ recipe: (r) => { r.mapping.time.select = { kind: "at", t: 0 }; } }).apply();
    if (first.ok) expect(JSON.parse(first.content).boundary).toMatchObject({ bulkTemperatureK: 550, at: 0, interpolated: false });
  });

  it("selectSample on its own: last, at, between, outside, missing", () => {
    const sr = { x: [0, 10, 20], values: [1, 3, 7] };
    expect(selectSample(sr, { kind: "last" })).toEqual({ x: 20, value: 7, interpolated: false });
    expect(selectSample(sr, { kind: "at", t: 5 })).toEqual({ x: 5, value: 2, interpolated: true });
    expect(selectSample(sr, { kind: "at", t: 20 })).toEqual({ x: 20, value: 7, interpolated: false });
    for (const bad of [undefined, { kind: "at" as const }, { kind: "at" as const, t: -1 }, { kind: "at" as const, t: 21 }, { kind: "last" as const, t: 3 }, { kind: "at" as const, t: Number.NaN }]) {
      expect(typeof selectSample(sr, bad as any)).toBe("string");
    }
  });

  it.each<[string, (r: any) => void, string]>([
    ["a series with no way to pick a sample", (r) => { delete r.mapping.time.select; }, "E_TIME_MAPPING /mapping/time/select"],
    ["a time outside the series", (r) => { r.mapping.time.select = { kind: "at", t: 99 }; }, "E_TIME_MAPPING /mapping/time/select"],
    ["an additional quantity the run does not have", (r) => { r.source.additional[0].quantity = "nope"; }, "E_NOT_FOUND /source/additional/0/quantity"],
    ["an additional quantity of another dimension than the recipe says", (r) => { r.source.additional[0].dimension = "heat-flux"; }, "E_UNITS /source/additional/0/dimension"],
    ["an additional quantity in another unit than the recipe says", (r) => { r.source.additional[0].unit = "kW/m2/K"; }, "E_UNITS /source/additional/0/unit"],
    ["an additional quantity that is not absolute", (r) => { r.source.additional[0].normalization = "per-source-particle"; }, "E_UNITS /source/additional/0/normalization"],
    ["a unit to convert to that is another dimension", (r) => { r.source.additional[0].unitTo = "W/m2"; }, "E_UNITS /source/additional/0/unitTo"],
    ["the same quantity twice", (r) => { r.source.additional[0].quantity = "coolant T"; }, "E_SCHEMA_INVALID /source/additional/0/quantity"],
    ["data that is not the pinned data", (r) => { r.source.additional[0].dataSha256 = "f".repeat(64); }, "E_STALE_REVISION /source/additional/0/dataSha256"],
  ])("refuses %s", (_n, edit, expected) => {
    const w = bworld({ recipe: edit });
    const e = evaluateTransfer(w.recipe, w.view());
    expect(e.state).not.toBe("approved");
    expect(e.errors.map((x) => `${x.code} ${x.field}`)).toContain(expected);
  });

  it("a role used twice is refused", () => {
    const w = bworld({ recipe: (r) => { r.source.additional.push({ ...r.source.additional[0], quantity: "coolant T" }); } });
    expect(evaluateTransfer(w.recipe, w.view()).errors.map((x) => `${x.code} ${x.field}`)).toContain("E_SCHEMA_INVALID /source/additional/1/role");
  });

  it("the target must declare exactly the roles the recipe carries", () => {
    const none = bworld({ targetTransfers: [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", normalization: "none" }] }] });
    expect(evaluateTransfer(none.recipe, none.view()).errors.map((x) => x.field)).toContain("/target/field");
    const wrongDim = bworld({ targetTransfers: [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", additional: [{ role: "heat-transfer-coefficient", dimension: "heat-flux" }] }] }] });
    expect(evaluateTransfer(wrongDim.recipe, wrongDim.view()).state).toBe("invalid");
    const extraRole = bworld({ targetTransfers: [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", additional: [{ role: "heat-transfer-coefficient", dimension: "heat-transfer-coefficient" }, { role: "pressure", dimension: "pressure" }] }] }] });
    expect(evaluateTransfer(extraRole.recipe, extraRole.view()).state).toBe("invalid");
    // a heating-style target (no additional roles) does not take a recipe that carries one, and the reverse
    const w = world();
    expect(evaluateTransfer(w.recipe, w.view({ targetTransfers: [{ field: "heating-to-pin", accepts: [{ dimension: "energy", normalization: "per-source-particle", additional: [{ role: "x", dimension: "power" }] }] }] })).state).toBe("invalid");
  });

  it("the request the app gets carries the primary quantity, the additional ones by role and the chosen samples", async () => {
    const w = bworld({ recipe: (r) => { r.mapping.time.select = { kind: "at", t: 5 }; } });
    let seen: any;
    await w.apply(async (r) => { seen = r; return { ok: false, errors: [{ code: "E_UNSUPPORTED", message: "stop" }] }; });
    expect(seen.source.quantity.name).toBe("coolant T");
    expect(seen.source.data.kind).toBe("series");
    expect(seen.source.selected).toEqual({ x: 5, value: 555, interpolated: true });
    expect(seen.source.additional).toHaveLength(1);
    expect(seen.source.additional[0]).toMatchObject({ role: "heat-transfer-coefficient", selected: { x: 5, value: 30500, interpolated: true } });
    expect(seen.source.additional[0].quantity.dimension).toBe("heat-transfer-coefficient");
  });

  it("an app that cannot build a boundary from one temperature says so (a bulk temperature alone is not a convective boundary)", async () => {
    const w = bworld({ recipe: (r) => { r.source.additional = []; }, targetTransfers: [{ field: "coolant-boundary", accepts: [{ dimension: "temperature", normalization: "none" }] }] });
    const out = await w.apply();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatchObject({ code: "E_BOUNDARY_INCOMPLETE", source: "app-content" });
  });
});
