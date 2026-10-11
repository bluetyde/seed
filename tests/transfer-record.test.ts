// @covers R-XFER-04
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { burnupAt, canonicalRecordText, parseDepletion } from "../src/core/depletionRecord";
import { readAdmissions, writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import { applyTransfer, evaluateTransfer, recipeDigest, validateRecipe, type Approval, type RecordRecipe, type TransferRequest, type TransferView } from "../src/core/transfer";
import { applyTransferFromHost, approveTransfer, proposeTransfer, saveTransferHostConfig, transferStatus, type TransferHostConfig } from "../src/core/transferHost";

// A transfer whose source is a depletion record (docs/transfer-recipe.md section 8): the record is Studio's real fixture (id from Studio's writer,
// so the id rule is checked against the writer, not against a copy of itself); the target is a fake app with FEED's burnup rules.
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { delete process.env.FAKE_BURNUP_MODE; });
const target = resolve(__dirname, "fixtures/fake-transfer/burnup-target.cjs");
const RECORD = readFileSync(resolve(__dirname, "fixtures/depletion/pin_record.json"), "utf8");
const RECORD_ID = "adde6fb296433975e5944e27ad317d92cfeab2623e7f44526aaabbcec6c80a21";
const REGION = "UO2 3.5%";
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const agent = { kind: "agent" as const, name: "claude", model: "opus" }, human = { kind: "human" as const, name: "John" };

async function appOracles(root: string, name: string, adapterId: string, over: { blocked?: boolean } = {}) {
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
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  expect(indexed.errors).toEqual([]);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: adapterId, version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...(over.blocked ? { quantity: "q", value: 2, unit: "1" } : expected) }) });
  const evidence = join(root, name + "-evidence.json");
  writeHostJson(evidence, result);
  return { adapter: { id: adapterId, version: "0.1.0" }, oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) }, acceptedPins: result.pins };
}


// ---- the record -----------------------------------------------------------------------------------------------------------------------------

describe("the depletion record as a source", () => {
  const parsed = () => { const p = parseDepletion(RECORD); if (!p.ok) throw Error(JSON.stringify(p.errors)); return p.record; };
  const edit = (f: (d: any) => void, keepId = true) => { const d = JSON.parse(RECORD); f(d); if (!keepId) delete d.id; return JSON.stringify(d); };

  it("Studio's own record passes: its id is the hash of its canonical text as Studio wrote it", () => {
    expect(parsed()).toMatchObject({ recordId: RECORD_ID, timeStepsDays: [1, 4] });
    expect(parsed().regions.map((r) => r.name)).toEqual([REGION]);
  });

  it("the id does not depend on whitespace or key order, and does depend on a number's printed form", () => {
    // whitespace between tokens does not matter
    const spaced = RECORD.replace(/,\n/g, ",\n\n\t  ").replace(/:/g, " :  ");
    expect(parseDepletion(spaced)).toMatchObject({ ok: true });
    expect(canonicalRecordText(spaced)).toBe(canonicalRecordText(RECORD));
    // keys are sorted, the top-level id is left out, a number keeps the form it was written in
    expect(canonicalRecordText('{"b":1.0,"a":[2.50, {"d":1,"c":2}],"id":"x"}')).toBe('{"a":[2.50,{"c":2,"d":1}],"b":1.0}');
    expect(canonicalRecordText('{"a":{"id":1,"z":0}}')).toBe('{"a":{"id":1,"z":0}}');
    // 190.0 written as 190 is another token: the text was not the one the id was made from
    expect(RECORD).toContain("190.0");
    expect(parseDepletion(RECORD.replace("190.0", "190"))).toMatchObject({ ok: false, errors: [{ code: "E_RECORD_ID" }] });
  });

  it.each([
    ["a changed burnup", () => RECORD.replace("190.0", "191.0"), "E_RECORD_ID"],
    ["a changed time step", () => RECORD.replace(/("time_steps_days":\s*\[\s*1\.0,\s*)4\.0/, "$15.0"), "E_RECORD_ID"],
    ["no id", () => edit(() => {}, false), "E_RECORD_INVALID"],
    ["an id that is not hex", () => edit((d) => { d.id = "xyz"; }), "E_RECORD_INVALID"],
    ["another schema", () => edit((d) => { d.schema = "studio.depletion/0.2"; }), "E_RECORD_INVALID"],
    ["not JSON", () => "{not json", "E_RECORD_INVALID"],
    ["not an object", () => "[1, 2]", "E_RECORD_INVALID"],
    ["text after the record", () => RECORD.trimEnd() + " 1", "E_RECORD_INVALID"],
  ])("refuses %s", (_n, make, code) => {
    const p = parseDepletion(make());
    expect(p.ok ? [] : p.errors.map((e) => e.code)).toEqual([code]);
  });

  it.each<[string, (d: any) => void]>([
    ["no steps", (d) => { d.time_steps_days = []; }],
    ["a step of zero days", (d) => { d.time_steps_days = [0, 4]; }],
    ["a region with a burnup list of the wrong length", (d) => { d.regions[0].burnup_mwd_per_tu = [1]; }],
    ["a negative burnup", (d) => { d.regions[0].burnup_mwd_per_tu = [-1, 2]; }],
    ["a burnup that is not a number", (d) => { d.regions[0].burnup_mwd_per_tu = ["a", 2]; }],
    ["two regions with one name", (d) => { d.regions.push(structuredClone(d.regions[0])); }],
    ["no unit declaration", (d) => { delete d.provenance.units; }],
    ["a burnup declared in another unit", (d) => { d.provenance.units.burnup_mwd_per_tu = "MWd per kilogram of heavy metal"; }],
    ["times declared in another unit", (d) => { d.provenance.units.time_steps_days = "hours"; }],
    ["a burnup that decreases", (d) => { d.regions[0].burnup_mwd_per_tu = [100, 50]; }],
    ["steps whose sum is more than a number can hold", (d) => { d.time_steps_days = [1e308, 1e308]; }],
    ["no regions", (d) => { d.regions = []; }],
    ["a region with no name", (d) => { d.regions[0].name = ""; }],
  ])("refuses, with a valid id, a record with %s", (_n, f) => {
    // an edit changes the content, so the id must be recomputed for the shape check to be the one that fires: make the id match the edited text
    const d = JSON.parse(RECORD);
    f(d);
    delete d.id;
    const text = JSON.stringify(d);
    const id = require("node:crypto").createHash("sha256").update(canonicalRecordText(text), "utf8").digest("hex");
    const p = parseDepletion(JSON.stringify({ ...d, id }));
    expect(p.ok ? [] : p.errors.map((e) => e.code)).toEqual(["E_RECORD_INVALID"]);
  });

  it("text that was not valid UTF-8 (read as U+FFFD) is refused: its file hash would not stand for these bytes", () => {
    const p = parseDepletion(RECORD.replace('"UO2 3.5%"', '"UO2 3.5%' + String.fromCharCode(0xfffd) + '"'));
    expect(p.ok ? [] : p.errors.map((e) => e.code)).toEqual(["E_RECORD_INVALID"]);
  });

  it("the burnup at a time: cumulative at the end of each step, linear inside, 0 at the start, never outside", () => {
    const at = (t: number) => { const b = burnupAt(parsed(), REGION, t); if (!b.ok) throw Error(JSON.stringify(b.errors)); return b; };
    expect(at(5)).toMatchObject({ value: 190, interpolated: false });
    expect(at(1).value).toBeCloseTo(38, 12);
    expect(at(3)).toMatchObject({ interpolated: true });
    expect(at(3).value).toBeCloseTo(114, 12);
    expect(at(0)).toEqual({ ok: true, value: 0, interpolated: false });
    expect(at(0.5).value).toBeCloseTo(19, 12);
    for (const t of [5.01, -0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = burnupAt(parsed(), REGION, t);
      expect(b.ok ? [] : b.errors.map((e) => e.code)).toEqual(["E_TIME_MAPPING"]);
    }
    const u = burnupAt(parsed(), "no such region", 1);
    expect(u.ok ? [] : u.errors.map((e) => e.code)).toEqual(["E_REGION_UNKNOWN"]);
  });
});

// ---- evaluating and applying a record recipe -------------------------------------------------------------------------------------------------

const CASE = JSON.stringify({ fuel: "uo2-nfi", name: "pin" }, null, 2) + "\n";
const recipeOf = (over: Partial<RecordRecipe["source"]> = {}): RecordRecipe => ({
  schema: "seed.transfer-recipe/0.3", recipeId: "burnup-1", proposedBy: agent, proposedAt: "2026-10-08T12:00:00Z",
  source: { kind: "record", record: "depletion-record/1", artifact: "dep-record", recordSha256: sha256Hex(RECORD), recordId: RECORD_ID, region: REGION, time: 5,
    revisionPins: [{ artifact: "dep-record", revision: sha256Hex(RECORD) }], ...over },
  target: { app: "dstapp", artifact: "dst-case", revision: sha256Hex(CASE), field: "burnup" },
  units: { field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 1e-3, basis: "heavy-metal" },
});
const viewOf = (over: Partial<TransferView> = {}): TransferView => ({
  projectId: "p1", projectRoot: "/p", now: new Date("2026-10-08T13:00:00Z"), sourceIndex: null, sourceRunState: null,
  readData: (rel) => (rel === "records/pin_record.json" ? RECORD : null),
  currentRevisions: { "dep-record": sha256Hex(RECORD), "dst-case": sha256Hex(CASE) },
  artifactPaths: { "dep-record": "records/pin_record.json", "dst-case": "models/dst-case.json" },
  targetTransfers: [{ field: "burnup", accepts: [{ dimension: "burnup", normalization: "none" }] }],
  approvals: [], applied: [], ...over,
});
const approvalFor = (r: RecordRecipe): Approval => ({
  schema: "seed.transfer-approval/0.2", approvalId: "appr-1", projectId: "p1", projectRoot: "/p", studyId: "s1", recipeId: r.recipeId, recipeDigest: recipeDigest(r),
  inputRevisions: [...r.source.revisionPins, { artifact: r.target.artifact, revision: r.target.revision }], approvedBy: human, grantedTo: agent,
  approvedAt: "2026-10-08T12:30:00Z", expires: "2026-10-09T12:30:00Z", grantId: "grant-appr-1",
});
const ecodes = (e: { errors: { code: string; field: string }[] }) => e.errors.map((x) => `${x.code} ${x.field}`);

describe("evaluating a record recipe", () => {
  it("a good recipe is a proposal; with an approval it is approved", () => {
    const r = recipeOf();
    expect(validateRecipe(r)).toEqual({ ok: true });
    expect(evaluateTransfer(r, viewOf())).toMatchObject({ state: "proposed", errors: [{ code: "E_NOT_PERMITTED", field: "/approval" }] });
    expect(evaluateTransfer(r, viewOf({ approvals: [approvalFor(r)] }))).toMatchObject({ state: "approved", errors: [] });
  });

  it.each<[string, (r: any) => void, string]>([
    ["a conversion factor that is not SEED's", (r) => { r.units.factor = 1e-6; }, "E_UNITS /units"],
    ["a pin that is not the record's artifact at its hash", (r) => { r.source.revisionPins[0].revision = "a".repeat(64); }, "E_SCHEMA_INVALID /source/revisionPins"],
    ["a region the record does not have", (r) => { r.source.region = "UO2 5%"; }, "E_REGION_UNKNOWN /source/region"],
    ["a time past the last step", (r) => { r.source.time = 5.01; }, "E_TIME_MAPPING /source/time"],
    ["a field the target does not declare", (r) => { r.target.field = "heating-to-pin"; }, "E_UNSUPPORTED /target/field"],
  ])("is invalid with %s", (_n, edit, expected) => {
    const r: any = structuredClone(recipeOf());
    edit(r);
    const ev = evaluateTransfer(r, viewOf());
    expect(ev.state).toBe("invalid");
    expect(ecodes(ev)).toContain(expected);
  });

  it("is invalid when the target accepts another dimension, or the artifact or the file is missing", () => {
    expect(ecodes(evaluateTransfer(recipeOf(), viewOf({ targetTransfers: [{ field: "burnup", accepts: [{ dimension: "energy", normalization: "none" }] }] })))).toEqual(["E_UNITS /target/field"]);
    expect(ecodes(evaluateTransfer(recipeOf(), viewOf({ artifactPaths: { "dst-case": "x" } })))).toContain("E_NOT_FOUND /source/artifact");
    expect(ecodes(evaluateTransfer(recipeOf(), viewOf({ readData: () => null })))).toContain("E_OUTPUT_INCOMPLETE /source/artifact");
  });

  it("a record whose id does not match its content is invalid, and a record that was swapped is stale", () => {
    const broken = RECORD.replace("190.0", "191.0");
    const r = recipeOf({ recordSha256: sha256Hex(broken), revisionPins: [{ artifact: "dep-record", revision: sha256Hex(broken) }] });
    const ev = evaluateTransfer(r, viewOf({ readData: () => broken, currentRevisions: { "dep-record": sha256Hex(broken), "dst-case": sha256Hex(CASE) } }));
    expect(ev.state).toBe("invalid");
    expect(ecodes(ev)).toContain("E_RECORD_ID /id");
    const swapped = JSON.stringify({ ...JSON.parse(RECORD), regions: JSON.parse(RECORD).regions });
    const ev2 = evaluateTransfer(recipeOf(), viewOf({ readData: () => swapped }));
    expect(ev2.state).toBe("stale");
    expect(ecodes(ev2)).toContain("E_STALE_REVISION /source/recordSha256");
  });

  it("a record that is another valid record with the same file hash pinned to another id is stale", () => {
    expect(evaluateTransfer(recipeOf({ recordId: "b".repeat(64) }), viewOf())).toMatchObject({ state: "stale", errors: [{ code: "E_STALE_REVISION", field: "/source/recordId" }] });
  });

  it("is stale when the record artifact or the target moved on, and a pipeline cycle through the record is refused elsewhere", () => {
    expect(evaluateTransfer(recipeOf(), viewOf({ currentRevisions: { "dep-record": "c".repeat(64), "dst-case": sha256Hex(CASE) } })).state).toBe("stale");
    expect(evaluateTransfer(recipeOf(), viewOf({ currentRevisions: { "dep-record": sha256Hex(RECORD), "dst-case": "d".repeat(64) } })).state).toBe("stale");
  });

  it("schema: a record recipe with a surprise property, a second pin, or another record kind is refused", () => {
    const r: any = structuredClone(recipeOf());
    expect(validateRecipe({ ...r, surprise: 1 })).toMatchObject({ ok: false });
    expect(validateRecipe({ ...r, source: { ...r.source, revisionPins: [...r.source.revisionPins, ...r.source.revisionPins] } })).toMatchObject({ ok: false });
    expect(validateRecipe({ ...r, source: { ...r.source, record: "other/1" } })).toMatchObject({ ok: false });
    expect(validateRecipe({ ...r, source: { ...r.source, time: -1 } })).toMatchObject({ ok: false });
    expect(validateRecipe({ ...r, schema: "seed.transfer-recipe/0.4" })).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_VERSION" }] });
  });
});

describe("applying a record recipe", () => {
  const apply = (r: RecordRecipe, run: (req: TransferRequest) => Promise<any>, view = viewOf({ approvals: [approvalFor(r)] })) =>
    applyTransfer({ recipe: r, view, actor: agent, gate: { study: { studyId: "s1", tier: "A1", budget, parameters: [] }, now: () => view.now }, studyId: "s1", targetContent: CASE, run });
  const ok = (content: string) => async () => ({ ok: true, output: { content }, checks: { n: 1 } });

  it.each([[5, 0.19, false], [1, 0.038, false], [3, 0.114, true], [0, 0, false]])("at day %s the target is handed %s MWd/kgHM (interpolated: %s) and the provenance names the record", async (time, expectedValue, interpolated) => {
    let seen: any;
    const out = await apply(recipeOf({ time }), async (req) => { seen = req; return { ok: true, output: { content: CASE + " " }, checks: {} }; });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    expect(seen.schema).toBe("seed.transfer-request/0.3");
    expect(seen.source).toMatchObject({ kind: "record", recordId: RECORD_ID, recordSha256: sha256Hex(RECORD), region: REGION, time, interpolated, quantity: { name: "burnup", dimension: "burnup", unit: "MWd/kgHM", basis: "heavy-metal" }, original: { unit: "MWd/tU" } });
    expect(seen.source.quantity.value).toBeCloseTo(expectedValue, 12);
    expect(seen.target.content).toBe(CASE);
    expect((out as any).provenance).toMatchObject({ recipeId: "burnup-1", approvalId: "appr-1", sourceRecordId: RECORD_ID, sourceRecordSha256: sha256Hex(RECORD), targetRevisionBefore: sha256Hex(CASE) });
    expect((out as any).provenance.sourceRunId).toBeUndefined();
  });

  it("without an approval nothing is sent", async () => {
    let called = false;
    const out = await apply(recipeOf(), async () => { called = true; return { ok: true, output: { content: "x" } }; }, viewOf());
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("the target's own refusal is passed on with its codes, a reply that changes nothing is refused, and a bad reply is refused", async () => {
    const refused = await apply(recipeOf(), async () => ({ ok: false, errors: [{ code: "E_UNSUPPORTED", field: "/fuel", message: "the fuel's conductivity must be uo2-nfi" }, { code: "bad code", message: "x" }] }));
    expect(refused.ok ? [] : refused.errors.map((e) => e.code)).toEqual(["E_UNSUPPORTED", "E_APP_FAILED"]);
    const same = await apply(recipeOf(), ok(CASE));
    expect(same.ok ? [] : same.errors.map((e) => e.field)).toEqual(["/output"]);
    const bad = await apply(recipeOf(), async () => ({ nonsense: true }));
    expect(bad.ok).toBe(false);
  });

  it("a record that is another valid record at the second read is not sent to the target (the approved one is what is sent)", async () => {
    const d = JSON.parse(RECORD);
    d.regions[0].burnup_mwd_per_tu = [38, 999];
    delete d.id;
    const id = require("node:crypto").createHash("sha256").update(canonicalRecordText(JSON.stringify(d)), "utf8").digest("hex");
    const other = JSON.stringify({ ...d, id });
    expect(parseDepletion(other)).toMatchObject({ ok: true });
    let reads = 0, called = false;
    const r = recipeOf();
    const base = viewOf({ approvals: [approvalFor(r)] });
    const out = await apply(r, async () => { called = true; return { ok: true, output: { content: "x" } }; }, { ...base, readData: () => (++reads === 1 ? RECORD : other) });
    expect(out.ok).toBe(false);
    expect(out.ok ? [] : out.errors.map((e) => e.code)).toEqual(["E_STALE_REVISION"]);
    expect(called).toBe(false);
    expect(reads).toBeGreaterThan(1);
  });

  it("a record that was damaged since the approval is not sent to the target", async () => {
    let called = false;
    const damaged = RECORD.replace("190.0", "191.0");
    const r = recipeOf();
    const out = await apply(r, async () => { called = true; return { ok: true, output: { content: "x" } }; }, viewOf({ approvals: [approvalFor(r)], readData: () => damaged }));
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});

// ---- through the trusted host ---------------------------------------------------------------------------------------------------------------


async function fixture(over: { tier?: "A0" | "A1" | "A2" | "A3" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seed record transfer "));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  expect(createProject(project, { name: "Record transfer fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  mkdirSync(join(project, "records"), { recursive: true });
  writeFileSync(join(project, "records/pin_record.json"), RECORD);
  writeFileSync(join(project, "models/dst-case.json"), CASE);
  const p = openProject(project);
  if (!p.ok) throw Error("project");
  const manifest = structuredClone(p.value.manifest) as Record<string, any>;
  manifest.artifacts = [
    { id: "dep-record", app: "openmc-studio", path: "records/pin_record.json", format: "studio.depletion", formatVersion: "0.1", revision: { hash: sha256Hex(RECORD), counter: 1 } },
    { id: "dst-case", app: "dstapp", path: "models/dst-case.json", format: "dst.case", formatVersion: "1", revision: { hash: sha256Hex(CASE), counter: 1 } },
  ];
  expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);
  const dst = await appOracles(root, "dst", "dstapp");
  const config = (actor: TransferHostConfig["actor"]): TransferHostConfig => ({
    schema: "seed.transfer-host/0.1", projectRoot: project, stateRoot: state, actor, study: { studyId: "study-1", tier: over.tier ?? "A2", budget, parameters: [] },
    apps: { dstapp: { ...dst, transfer: { command: process.execPath, args: [target], fields: [{ field: "burnup", parameters: { region: "the record's region name", time: "days from the start of the record" }, accepts: [{ dimension: "burnup", normalization: "none" }] }] } } },
  } as unknown as TransferHostConfig);
  const agentFile = join(root, "agent-host.json"), humanFile = join(root, "human-host.json");
  saveTransferHostConfig(agentFile, config(agent));
  saveTransferHostConfig(humanFile, config(human));
  return { root, project, state, agentFile, humanFile, recipe: recipeOf(), journal: () => readAdmissions(join(state, "transfer-journal")) };
}
type F = Awaited<ReturnType<typeof fixture>>;
const codes = (r: { ok: boolean; errors?: { code: string; field: string }[] }) => (r.ok ? [] : r.errors!.map((e) => `${e.code} ${e.field}`));
const approve = (f: F, extra: Record<string, unknown> = {}) => approveTransfer(f.humanFile, { recipeId: f.recipe.recipeId, recipeDigest: recipeDigest(f.recipe), ...extra });
const dstText = (f: F) => readFileSync(join(f.project, "models/dst-case.json"), "utf8");
const dstRevision = (f: F) => (openProject(f.project) as any).value.manifest.artifacts.find((a: any) => a.id === "dst-case").revision;

describe("a record recipe through the host", () => {
  it("propose, approve, apply: the target file gets the burnup, the revision moves, the provenance names the record", async () => {
    const f = await fixture();
    expect(await proposeTransfer(f.agentFile, { recipe: f.recipe })).toMatchObject({ ok: true, state: "proposed", digest: recipeDigest(f.recipe) });
    expect(existsSync(join(f.project, "transfers/burnup-1.json"))).toBe(true);
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-1" })).toMatchObject({ ok: true, state: "proposed" });
    expect(await approve(f)).toMatchObject({ ok: true });
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-1" })).toMatchObject({ ok: true, state: "approved" });
    const out: any = await applyTransferFromHost(f.agentFile, { recipeId: "burnup-1" });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, state: "applied", provenance: { sourceRecordId: RECORD_ID, sourceRecordSha256: sha256Hex(RECORD) } });
    const written = JSON.parse(dstText(f));
    expect(written.burnup.value.value).toBeCloseTo(0.19, 12);
    expect(written.burnup).toMatchObject({ basis: "heavy-metal", value: { unit: "MWd/kgHM" }, source: "depletion-record/1 " + RECORD_ID });
    expect(dstRevision(f)).toEqual({ hash: sha256Hex(dstText(f)), counter: 2 });
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-1" })).toMatchObject({ ok: true, state: "applied" });
    expect(f.journal().map((r: any) => r.event.phase)).toEqual(expect.arrayContaining(["propose-outcome", "approve-outcome", "apply-request", "apply-outcome"]));
    // a second apply is refused: it was applied
    expect(codes(await applyTransferFromHost(f.agentFile, { recipeId: "burnup-1" }) as any)).toEqual(["E_EXISTS /recipeId"]);
  });

  it("a recipe with a region the record does not have is refused at the proposal, and nothing is written", async () => {
    const f = await fixture();
    const out = await proposeTransfer(f.agentFile, { recipe: recipeOf({ region: "UO2 9%" }) });
    expect(codes(out as any)).toContain("E_REGION_UNKNOWN /source/region");
    expect(existsSync(join(f.project, "transfers"))).toBe(false);
  });

  it("an agent cannot approve; an approval names this recipe's content, so an edited recipe is not approved", async () => {
    const f = await fixture();
    await proposeTransfer(f.agentFile, { recipe: f.recipe });
    expect((await approveTransfer(f.agentFile, { recipeId: "burnup-1", recipeDigest: recipeDigest(f.recipe) })).ok).toBe(false);
    expect(await approve(f)).toMatchObject({ ok: true });
    const edited = recipeOf({ time: 3 });
    writeFileSync(join(f.project, "transfers/burnup-1.json"), JSON.stringify(edited, null, 2) + "\n");
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-1" })).toMatchObject({ ok: true, state: "proposed" });
    expect((await applyTransferFromHost(f.agentFile, { recipeId: "burnup-1" })).ok).toBe(false);
  });

  it("the record changing after the approval makes the recipe stale and nothing is applied", async () => {
    const f = await fixture();
    await proposeTransfer(f.agentFile, { recipe: f.recipe });
    await approve(f);
    const p = openProject(f.project) as any;
    const changed = RECORD.replace("190.0", "191.0");
    writeFileSync(join(f.project, "records/pin_record.json"), changed);
    const manifest = structuredClone(p.value.manifest);
    manifest.artifacts.find((a: any) => a.id === "dep-record").revision = { hash: sha256Hex(changed), counter: 2 };
    expect(saveProject(f.project, manifest, p.value.revision).ok).toBe(true);
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-1" })).toMatchObject({ ok: true, state: "stale" });
    expect((await applyTransferFromHost(f.agentFile, { recipeId: "burnup-1" })).ok).toBe(false);
    expect(dstText(f)).toBe(CASE);
  });

  it("the target's refusal reaches the caller and the target file is untouched", async () => {
    const f = await fixture();
    const other = JSON.stringify({ fuel: "other", name: "pin" }, null, 2) + "\n";
    const p = openProject(f.project) as any;
    writeFileSync(join(f.project, "models/dst-case.json"), other);
    const manifest = structuredClone(p.value.manifest);
    manifest.artifacts.find((a: any) => a.id === "dst-case").revision = { hash: sha256Hex(other), counter: 2 };
    expect(saveProject(f.project, manifest, p.value.revision).ok).toBe(true);
    const recipe = { ...f.recipe, target: { ...f.recipe.target, revision: sha256Hex(other) } };
    f.recipe = recipe;
    expect(await proposeTransfer(f.agentFile, { recipe })).toMatchObject({ ok: true });
    await approve(f);
    const out = await applyTransferFromHost(f.agentFile, { recipeId: "burnup-1" });
    expect(codes(out as any)).toEqual(["E_UNSUPPORTED /fuel"]);
    expect(dstText(f)).toBe(other);
  });

  it("a tier below A2 cannot propose", async () => {
    const f = await fixture({ tier: "A1" });
    expect((await proposeTransfer(f.agentFile, { recipe: f.recipe })).ok).toBe(false);
    expect(existsSync(join(f.project, "transfers"))).toBe(false);
  });
});
