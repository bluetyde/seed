import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/core/canonical";
import { saveHostConfiguration, type HostConfiguration } from "../../src/core/fileRunHost";
import { writeHostJson } from "../../src/core/hostFiles";
import { loadOracleEntries, runOracleSet, type OracleEntry } from "../../src/core/oracle";
import { createProject } from "../../src/core/projectStore";

// The host fixture of the replay tests (the one of tests/sweep-host.test.ts): the fake adapter, one registered case, one sweep, a pinned oracle set.
/** Folders the fixture made: the test file removes them after each test. */
export const fixtureDirs: string[] = [];

export const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };

/** The fake-adapter host of tests/file-run-host.test.ts with one bounded parameter, delayMs, that a sweep can vary. */
export async function fixture(opts: { scenario?: string; tier?: "A0" | "A1"; maxCases?: number; values?: number[]; sweeps?: HostConfiguration["sweeps"]; samplings?: HostConfiguration["samplings"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seed sweep host "));
  fixtureDirs.push(root);
  const project = join(root, "project"), state = join(root, "state"), repo = join(root, "app-repo"), entries = join(repo, "entries");
  for (const d of [state, repo, entries]) mkdirSync(d, { recursive: true });
  expect(createProject(project, { name: "Sweep fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  const model = JSON.stringify({ name: "case", counter: 1, fake: { validate: "ok" } });
  mkdirSync(join(repo, "models"));
  writeFileSync(join(repo, "models/case.json"), model);
  writeFileSync(join(project, "models/case.json"), model);
  const inputs = [{ path: "models/case.json", sha256: sha256Hex(model) }];
  const expected = { quantity: "p_top", value: 0.02, unit: "1" }, tolerance = { abs: 1e-9, rel: 0 };
  const entry: OracleEntry = {
    schema: "seed.oracle/0.1", oracleId: "test-one", entryVersion: 1, adapter: "fake", adapterVersions: ["*"], tag: "good", inputs, expected, tolerance,
    source: { kind: "hand", text: "test", check: "independent fixture" }, coverage: { quantities: ["p_top"], domain: "fixture" },
    toleranceHash: sha256Hex(canonicalJson({ expected, tolerance }))
  };
  writeHostJson(join(entries, "one.json"), entry);
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const indexed = loadOracleEntries(entries);
  expect(indexed.errors).toEqual([]);
  const result = await runOracleSet({ entries: indexed.entries, adapter: { id: "fake", version: "0.1.0" }, appCommit: commit, baseDir: repo, run: async () => ({ kind: "value", ...expected }) });
  const evidence = join(root, "oracle-evidence.json");
  writeHostJson(evidence, result);
  const runtime = resolve(__dirname, "../fixtures/fake-adapter/cli.cjs");
  const config: HostConfiguration = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "fake", version: "0.1.0", command: process.execPath, args: [runtime] },
    actor: { kind: "agent", name: "test-agent", model: "fixture" },
    study: { studyId: "study", tier: opts.tier ?? "A1", budget: { ...budget, ...(opts.maxCases ? { maxCases: opts.maxCases } : {}) }, parameters: [{ id: "delayMs", min: 0, max: 1000 }] },
    cases: { approved: { artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, params: [{ id: "delayMs", value: 10 }], settings: { scenario: opts.scenario ?? "success", delayMs: 10 } } },
    sweeps: opts.sweeps ?? { t: { base: "approved", axes: [{ id: "delayMs", values: opts.values ?? [10, 20, 30] }] } },
    ...(opts.samplings ? { samplings: opts.samplings } : {}),
    runtime: { path: runtime, sha256: sha256Hex(readFileSync(runtime)) },
    oracles: { repository: repo, entriesDir: entries, inputsRoot: repo, evidenceFile: evidence, evidenceSha256: sha256Hex(readFileSync(evidence)) },
    acceptedPins: result.pins
  };
  const file = join(root, "host.json");
  saveHostConfiguration(file, config);
  return { root, project, state, file, config, request: { requestId: "sw1", sweepId: "t", budget } };
}
export const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : []);
export const runDirs = (project: string) => readdirSync(join(project, "runs")).filter((n) => n !== "requests.json" && !n.startsWith("requests.json") && !n.startsWith("."));

/** A folder of replay policies holding one for the fake adapter (or none when `policy` is null), the way adapters/<id>/replay.json holds the real ones. */
export function policyDir(policy: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), "seed replay policies "));
  fixtureDirs.push(dir);
  if (policy !== null) {
    mkdirSync(join(dir, "fake"));
    writeFileSync(join(dir, "fake", "replay.json"), JSON.stringify({ schema: "seed.replay-policy/0.1", adapter: "fake", policy, basis: "the fake adapter, for the tests of the replay verb" }));
  }
  return dir;
}
