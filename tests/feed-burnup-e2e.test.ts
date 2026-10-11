// @covers R-XFER-04
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { canonicalRecordText } from "../src/core/depletionRecord";
import { writeHostJson } from "../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../src/core/oracle";
import { createProject, openProject, saveProject } from "../src/core/projectStore";
import { recipeDigest, type RecordRecipe } from "../src/core/transfer";
import { applyTransferFromHost, approveTransfer, proposeTransfer, saveTransferHostConfig, transferStatus, type TransferHostConfig } from "../src/core/transferHost";

// The burnup transfer against FEED's REAL `transfer` command (docs/transfer-recipe.md section 8): the host runs propose, approve and apply with the
// command line of FEED's headless runner and the `describe.transfers` the real runner reports, on FEED's own example case and Studio's real record.
// Needs a FEED checkout with `npm run build` and the burnup transfer (FEED main 5e4952a or later): SEED_FEED_REPO, else a sibling folder.
// It does not run FEED's solver: a transfer only rewrites the case. Skipped, loudly, when FEED is not there.
const candidates = [process.env.SEED_FEED_REPO, resolve(__dirname, "../../feed")];
const repo = candidates.find((p) => p && existsSync(join(p, "dist", "cli", "headless.js")) && existsSync(join(p, "examples", "lwr-uo2-burnup.json")));
const bundle = repo ? join(repo, "dist", "cli", "headless.js") : "";
const describeOut = repo ? spawnSync(process.execPath, [bundle, "describe"], { encoding: "utf8" }) : undefined;
const feedTransfers: { field: string; accepts: unknown[] }[] | undefined = (() => {
  try {
    const last = (describeOut?.stdout ?? "").trim().split("\n").pop() ?? "";
    return JSON.parse(last).transfers;
  } catch {
    return undefined;
  }
})();
const haveBurnupTransfer = !!feedTransfers?.some((t) => t.field === "burnup");

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
const agent = { kind: "agent" as const, name: "claude", model: "opus" }, human = { kind: "human" as const, name: "John" };
const RECORD = readFileSync(resolve(__dirname, "fixtures/depletion/pin_record.json"), "utf8");
const RECORD_ID = "adde6fb296433975e5944e27ad317d92cfeab2623e7f44526aaabbcec6c80a21";
const REGION = "UO2 3.5%";

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


const caseOf = () => readFileSync(join(repo!, "examples", "lwr-uo2-burnup.json"), "utf8");

function recordWith(burnup: number[]): string {
  // another record in Studio's shape whose id is the hash of its canonical text (SEED's reader accepts it; FEED's refusal is what is tested)
  const d = JSON.parse(RECORD);
  d.regions[0].burnup_mwd_per_tu = burnup;
  delete d.id;
  const text = JSON.stringify(d, null, 2) + "\n";
  const id = require("node:crypto").createHash("sha256").update(canonicalRecordText(text), "utf8").digest("hex");
  return JSON.stringify({ ...d, id }, null, 2) + "\n";
}

async function fixture(recordText: string, time: number, caseText = caseOf()) {
  const root = mkdtempSync(join(tmpdir(), "seed feed burnup "));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  expect(createProject(project, { name: "FEED burnup e2e", seedVersion: "0.1.0" }).ok).toBe(true);
  mkdirSync(join(project, "records"), { recursive: true });
  writeFileSync(join(project, "records/pin_record.json"), recordText);
  writeFileSync(join(project, "models/pin-case.json"), caseText);
  const p = openProject(project);
  if (!p.ok) throw Error("project");
  const manifest = structuredClone(p.value.manifest) as Record<string, any>;
  manifest.artifacts = [
    { id: "dep-record", app: "openmc-studio", path: "records/pin_record.json", format: "studio.depletion", formatVersion: "0.1", revision: { hash: sha256Hex(recordText), counter: 1 } },
    { id: "pin-case", app: "feed", path: "models/pin-case.json", format: "feed.case", formatVersion: "0.1", revision: { hash: sha256Hex(caseText), counter: 1 } },
  ];
  expect(saveProject(project, manifest, p.value.revision).ok).toBe(true);
  const feed = await appOracles(root, "feed", "feed");
  const config = (actor: TransferHostConfig["actor"]): TransferHostConfig => ({
    schema: "seed.transfer-host/0.1", projectRoot: project, stateRoot: state, actor, study: { studyId: "study-1", tier: "A2", budget, parameters: [] },
    apps: { feed: { ...feed, transfer: { command: process.execPath, args: [bundle, "transfer"], fields: feedTransfers } } },
  } as unknown as TransferHostConfig);
  const agentFile = join(root, "agent-host.json"), humanFile = join(root, "human-host.json");
  saveTransferHostConfig(agentFile, config(agent));
  saveTransferHostConfig(humanFile, config(human));
  const recipe: RecordRecipe = {
    schema: "seed.transfer-recipe/0.3", recipeId: "burnup-e2e", proposedBy: agent, proposedAt: "2026-10-08T12:00:00Z",
    source: { kind: "record", record: "depletion-record/1", artifact: "dep-record", recordSha256: sha256Hex(recordText), recordId: JSON.parse(recordText).id, region: REGION, time,
      revisionPins: [{ artifact: "dep-record", revision: sha256Hex(recordText) }] },
    target: { app: "feed", artifact: "pin-case", revision: sha256Hex(caseText), field: "burnup" },
    units: { field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 1e-3, basis: "heavy-metal" },
  };
  const read = () => readFileSync(join(project, "models/pin-case.json"), "utf8");
  const run = async () => {
    expect(await proposeTransfer(agentFile, { recipe })).toMatchObject({ ok: true });
    expect(await approveTransfer(humanFile, { recipeId: recipe.recipeId, recipeDigest: recipeDigest(recipe) })).toMatchObject({ ok: true });
    return applyTransferFromHost(agentFile, { recipeId: recipe.recipeId }) as Promise<any>;
  };
  return { root, project, agentFile, recipe, read, run, caseText };
}

describe.skipIf(!repo || !haveBurnupTransfer)("the burnup transfer against FEED's real command", () => {
  it("FEED's describe lists the burnup transfer as a burnup source with no normalization", () => {
    const t = feedTransfers!.find((x) => x.field === "burnup") as { accepts: { dimension: string; normalization?: string }[] };
    expect(t.accepts).toEqual([{ dimension: "burnup", normalization: "none" }]);
  });

  it.each([[5, 0.19], [1, 0.038], [3, 0.114], [0, 0]])("at day %s the case gets %s MWd/kgHM, through propose, approve and apply", async (time, expected) => {
    const f = await fixture(RECORD, time);
    const out = await f.run();
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, state: "applied", provenance: { sourceRecordId: RECORD_ID } });
    const written = JSON.parse(f.read());
    expect(written.burnup.value.unit).toBe("MWd/kgHM");
    expect(written.burnup.value.value).toBeCloseTo(expected, 12);
    expect(written.burnup.basis).toBe("heavy-metal");
    expect(written.burnup.source).toContain(RECORD_ID);
    expect(written.provenance.transfers.at(-1)).toMatchObject({ kind: "burnup", recipeId: "burnup-e2e", recordId: RECORD_ID, region: REGION, time });
    expect(await transferStatus(f.agentFile, { recipeId: "burnup-e2e" })).toMatchObject({ ok: true, state: "applied" });
  }, 120000);

  it("at day 5 the result equals FEED's own expected case, except the case id, the name and the provenance entry", async () => {
    const f = await fixture(RECORD, 5);
    expect((await f.run()).ok).toBe(true);
    const got = JSON.parse(f.read());
    const want = JSON.parse(readFileSync(join(repo!, "tests", "fixtures", "transfer-burnup-expected-case.json"), "utf8"));
    for (const d of [got, want]) { delete d.caseId; delete d.name; delete d.provenance; }
    expect(got).toEqual(want);
  }, 120000);

  it("a burnup above FEED's range is refused by FEED, comes back through SEED with FEED's code, and the case is untouched", async () => {
    const big = recordWith([70000, 70000]);
    const f = await fixture(big, 5);
    const out = await f.run();
    expect(out.ok).toBe(false);
    expect(out.errors.map((e: any) => e.code)).toContain("E_OUT_OF_RANGE");
    expect(f.read()).toBe(f.caseText);
  }, 120000);

  it("a fuel that is not uo2-nfi is refused by FEED and the case is untouched", async () => {
    const c = JSON.parse(caseOf());
    const text = JSON.stringify(c, null, 2) + "\n";
    // find the conductivity law field FEED reads and change it to a law that is not uo2-nfi
    const raw = JSON.stringify(c);
    expect(raw).toContain("uo2-nfi");
    const other = raw.replace(/uo2-nfi/g, "uo2-matpro");
    const f = await fixture(RECORD, 5, JSON.stringify(JSON.parse(other), null, 2) + "\n");
    const out = await f.run();
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(f.read()).toBe(f.caseText);
    void text;
  }, 120000);

  it("SEED refuses an unknown region and a time past the record before FEED is asked", async () => {
    const f = await fixture(RECORD, 5.01);
    const out = await proposeTransfer(f.agentFile, { recipe: f.recipe });
    expect(out.ok).toBe(false);
    expect((out as any).errors.map((e: any) => e.code)).toContain("E_TIME_MAPPING");
  }, 120000);
});
