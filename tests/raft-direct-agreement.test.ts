import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { loadOracleEntries } from "../src/core/oracle";
import { RunManager } from "../src/core/runManager";

const repo = process.env.SEED_RAFT_REPO ?? join(__dirname, "..", "..", "virtual-reactor");
const bundle = join(repo, "web", "dist-headless", "raft-headless.mjs");
const base = join(repo, "oracles", "seed");
const available = existsSync(bundle) && existsSync(join(base, "entries"));
const adapter = { id: "raft", version: "0.1.0", command: process.execPath, args: [join(__dirname, "..", "adapters", "raft", "cli.cjs")] };
const actor = { kind: "agent" as const, name: "direct-agreement", model: "deterministic-test" };
const budget = { maxWallSeconds: 120, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const previous = process.env.SEED_RAFT_HEADLESS;
beforeAll(() => { process.env.SEED_RAFT_HEADLESS = bundle; });
afterAll(() => { if (previous === undefined) delete process.env.SEED_RAFT_HEADLESS; else process.env.SEED_RAFT_HEADLESS = previous; });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function direct(args: string[], status = 0): any {
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(status);
  return JSON.parse(result.stdout);
}

it("required E2 acceptance has a real RAFT runner and app-owned oracle entries", () => {
  if (process.env.SEED_REQUIRE_RAFT === "1") expect(available, "Set SEED_RAFT_REPO to a RAFT checkout with built headless runner and oracles/seed").toBe(true);
});

const loaded = available ? loadOracleEntries(join(base, "entries")) : { entries: [], errors: [] };
const cases = [...new Map(loaded.entries.map(({ entry }) => [entry.inputs[0]!.path, entry])).values()];
describe.skipIf(!available)("E2 direct RAFT versus SEED (same runtime and inputs)", () => {
  it("uses all six good cases and four refusal cases, with traceable runner evidence", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.entries).toHaveLength(22);
    expect(cases.filter(e => e.tag === "good")).toHaveLength(6);
    expect(cases.filter(e => e.tag === "bad-input")).toHaveLength(4);
    const revision = spawnSync("git", ["-c", "safe.directory=" + repo.replaceAll("\\", "/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(revision.status).toBe(0);
    console.info(JSON.stringify({ raftCommit: revision.stdout.trim(), runnerSha256: sha256Hex(readFileSync(bundle)), oracleFiles: loaded.entries.map(e => ({ file: e.file, sha256: e.fileSha256 })) }));
  });

  for (const entry of cases) it(entry.inputs[0]!.path, async () => {
    const root = mkdtempSync(join(tmpdir(), "seed-e2-agreement-")); dirs.push(root);
    for (const input of entry.inputs) {
      const source = join(base, input.path);
      expect(sha256Hex(readFileSync(source))).toBe(input.sha256);
      mkdirSync(dirname(join(root, input.path)), { recursive: true });
      cpSync(source, join(root, input.path));
    }
    const casePath = entry.inputs[0]!.path;
    const artifact = { path: casePath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
    if (entry.tag === "bad-input") {
      const native = direct(["validate", join(root, casePath)], 2);
      expect(native.ok).toBe(false);
      const expectedCodes: Record<string, string> = { E_CASE_INVALID: "E_SCHEMA_INVALID", E_CASE_VERSION: "E_SCHEMA_VERSION", E_INIT_NO_EQUILIBRIUM: "E_OUT_OF_DOMAIN" };
      const mapped = native.errors.map((e: { code: string }) => {
        expect(expectedCodes[e.code], "unexpected native refusal: " + e.code).toBeDefined();
        return expectedCodes[e.code];
      });
      const reply = await callAdapter(adapter, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "validate-direct", actor, artifact }, { projectRoot: root, timeoutMs: 30000 });
      expect(reply.ok).toBe(true);
      if (!reply.ok) throw new Error(JSON.stringify(reply.errors));
      const problems = (reply.reply as any).result.problems;
      expect(problems.map((e: { code: string }) => e.code)).toEqual(mapped);
      expect(mapped).toContain(entry.expected.refusalCode);
      return;
    }
    const native = direct(["run", join(root, casePath), "--out", join(root, "direct"), "--run-id", "reference"]);
    expect(native.status).toBe("completed");
    const reference = JSON.parse(readFileSync(join(root, "direct", "reference", "results.json"), "utf8"));
    const manager = new RunManager({ projectRoot: root, runsFolder: "runs", adapter, pollMs: 50, callTimeoutMs: 30000 });
    const outcome = await manager.start({ requestId: "agreement", actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
    expect(outcome.state).toBe("completed");
    const index = JSON.parse(readFileSync(join(root, "runs", outcome.runId, "results.json"), "utf8"));
    const units: Record<string, string> = { power: "W", fuelTemp: "K", coolantTemp: "K", energy: "J", reactivityTotal: "dk/k" };
    expect(index.quantities.map((q: any) => q.name).sort()).toEqual(Object.keys(units).sort());
    for (const quantity of index.quantities) {
      expect(quantity.unit).toBe(units[quantity.name]);
      const series = JSON.parse(readFileSync(join(root, quantity.data.path), "utf8"));
      expect(series.t).toEqual(reference.samples.map((s: any) => s.t));
      expect(series.values).toEqual(reference.samples.map((s: any) => s[quantity.name]));
    }
    expect(direct(["replay", join(root, "direct", "reference")]).identical).toBe(true);
  }, 180000);
});
