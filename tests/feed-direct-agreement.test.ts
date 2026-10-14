// @covers R-ADAPT-02, R-ORA-04
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { loadOracleEntries, type OracleEntry } from "../src/core/oracle";
import { RunManager } from "../src/core/runManager";
import { appDir } from "./helpers/appDir";

// Standalone versus workspace (plan 05 acceptance 4, FEED's TODO "standalone vs workspace equivalence"): the same immutable case, run once with FEED's own
// headless runner and once through SEED (the adapter and the run manager), gives the same computation. "The same" is checked on FEED's own native files,
// not on what the adapter makes of them: results.json, derived.json and case.json of the two runs must be byte for byte identical. Needs the FEED repo with
// `npm run build`, its oracle cases and the feed-solver WSL distro (SEED_FEED_REPO); skipped otherwise, loudly. By default it runs a representative set of
// cases; SEED_FEED_AGREEMENT_ALL=1 runs every distinct case of FEED's oracle set (about 40 minutes).
const repo = [process.env.SEED_FEED_REPO, appDir("feed")].find((p) => p && existsSync(join(p, "dist", "cli", "headless.js"))) ?? appDir("feed");
const bundle = join(repo, "dist", "cli", "headless.js");
const base = join(repo, "oracles", "seed");
const solverUp = (() => {
  if (!existsSync(bundle)) return false;
  const r = spawnSync(process.execPath, [bundle, "describe"], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(r.stdout.trim()).solver.available === true; } catch { return false; }
})();
const have = solverUp && existsSync(join(base, "entries"));
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "feed", "cli.cjs")], id: "feed", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "direct-agreement", model: "deterministic-test" };
const budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const saved = process.env.SEED_FEED_HEADLESS;
beforeAll(() => { process.env.SEED_FEED_HEADLESS = bundle; });
afterAll(() => {
  if (saved === undefined) delete process.env.SEED_FEED_HEADLESS; else process.env.SEED_FEED_HEADLESS = saved;
  if (!have) console.warn(`FEED headless runner, solver or oracle entries not found under ${repo}: the FEED direct-agreement tests were skipped`);
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** FEED's own runner, called the way a person would call it (the standalone side). */
function direct(args: string[], expectStatus: number): any {
  const r = spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr + r.stdout).toBe(expectStatus);
  return JSON.parse(r.stdout);
}
const sha = (file: string) => sha256Hex(readFileSync(file));

const loaded = have ? loadOracleEntries(join(base, "entries")) : { entries: [], errors: [] };
const byCase = new Map<string, OracleEntry>();
for (const { entry } of loaded.entries) if (!byCase.has(entry.inputs[0]!.path)) byCase.set(entry.inputs[0]!.path, entry);
const REPRESENTATIVE = [
  "synthetic-const", "annular-synthetic-pin", "ksu-triga-1p25mw-film-limits", "lwr-uo2-burnup-40", "mechanics-gap-closure", "mechanics-axially-fixed",
  "synthetic-pulse-nordheim-fuchs", "synthetic-lumped-film-step", "ga7882-pulse-5-dollar",
];
const REFUSALS = ["bad-boundary-bulk-only", "bad-burnup-above-range", "bad-conductivity-missing"];
const all = process.env.SEED_FEED_AGREEMENT_ALL === "1";
const chosen = (tag: string, names: string[]) => [...byCase.values()].filter((e) => e.tag === tag && (all || names.some((n) => e.inputs[0]!.path === `models/${n}.case.json`)));
const goodCases = chosen("good", REPRESENTATIVE);
const badCases = chosen("bad-input", REFUSALS);

describe.skipIf(!have)("FEED standalone versus SEED (same runtime, same immutable input)", () => {
  it("covers the cases it says it covers (the lumped boundary-history case exists only in FEED's 101-entry set)", () => {
    expect(loaded.errors).toEqual([]);
    const names = goodCases.map((e) => e.inputs[0]!.path.replace(/^models\/|\.case\.json$/g, ""));
    for (const n of REPRESENTATIVE.filter((x) => x !== "synthetic-lumped-film-step")) expect(names, `case ${n} is missing from FEED's oracle set`).toContain(n);
    expect(badCases.length).toBeGreaterThanOrEqual(all ? 1 : 2);
  });

  for (const entry of goodCases) {
    const casePath = entry.inputs[0]!.path;
    it(`${casePath}: the standalone run and the SEED run have the same native results, byte for byte`, async () => {
      const root = mkdtempSync(join(tmpdir(), "seed-feed-agreement-")); dirs.push(root);
      for (const input of entry.inputs) {
        const source = join(base, input.path);
        expect(sha(source)).toBe(input.sha256);
        mkdirSync(dirname(join(root, input.path)), { recursive: true });
        cpSync(source, join(root, input.path));
      }
      mkdirSync(join(root, "runs"), { recursive: true });
      const artifact = { path: casePath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };

      // standalone: FEED's own runner, its own output folder
      const native = direct(["run", join(root, casePath), "--out", join(root, "direct"), "--run-id", "feed", "--timeout-seconds", "300"], 0);
      expect(native.ok).toBe(true);
      expect(native.status).toBe("completed");

      // workspace: the same file through the adapter and the run manager
      const manager = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 60000 });
      const outcome = await manager.start({ requestId: "agreement", actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
      expect(outcome.state).toBe("completed");

      const standalone = join(root, "direct", "feed");
      const workspace = join(root, "runs", outcome.runId, "native", "out", "feed");
      for (const file of ["results.json", "derived.json", "case.json"]) {
        expect(existsSync(join(standalone, file)), `standalone ${file}`).toBe(true);
        expect(existsSync(join(workspace, file)), `workspace ${file}`).toBe(true);
        expect(sha(join(workspace, file)), `${file} differs between the standalone run and the SEED run`).toBe(sha(join(standalone, file)));
      }
      // the input the two runs read was not touched
      expect(sha(join(root, casePath))).toBe(entry.inputs[0]!.sha256);
      // and what SEED handed back to the project names exactly the inputs it was given
      const record = JSON.parse(readFileSync(join(root, "runs", outcome.runId, "run-record.json"), "utf8"));
      expect(record.inputs).toEqual(entry.inputs);
    }, 300000);
  }

  for (const entry of badCases) {
    const casePath = entry.inputs[0]!.path;
    it(`${casePath}: both refuse the case with the same codes, in the same order`, async () => {
      const root = mkdtempSync(join(tmpdir(), "seed-feed-agreement-")); dirs.push(root);
      mkdirSync(dirname(join(root, casePath)), { recursive: true });
      cpSync(join(base, casePath), join(root, casePath));
      const artifact = { path: casePath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
      const native = direct(["validate", join(root, casePath)], 2);
      expect(native.ok).toBe(false);
      const nativeCodes = native.errors.map((e: { code: string }) => e.code);
      const reply = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "validate-direct", actor, artifact }, { projectRoot: root, timeoutMs: 60000 });
      if (!reply.ok) throw new Error(JSON.stringify(reply.errors));
      const problems = (reply.reply as { result: { problems: { code: string }[] } }).result.problems;
      expect(problems.map((p) => p.code)).toEqual(nativeCodes);
      expect(nativeCodes).toContain(entry.expected.refusalCode);
    }, 120000);
  }

  it("two standalone runs of one case are themselves byte-identical (the reason the comparison above can be exact)", () => {
    const e = goodCases[0]!;
    const out = (n: string) => { const d = mkdtempSync(join(tmpdir(), "seed-feed-twice-")); dirs.push(d); direct(["run", join(base, e.inputs[0]!.path), "--out", d, "--run-id", "feed", "--timeout-seconds", "300"], 0); return join(d, "feed", n); };
    expect(sha(out("results.json"))).toBe(sha(out("results.json")));
  }, 120000);
});
