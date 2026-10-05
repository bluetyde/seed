import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { loadOracleEntries, runOracleSet, unverifiedQuantities, type Observed, type OracleEntry } from "../src/core/oracle";
import { RunManager, type Budget } from "../src/core/runManager";

// FEED's own oracle entries (oracles/seed in the FEED repo, closed-form expected values) run through the adapter and the run
// manager against the real headless runner and the real OFFBEAT solver. Needs the FEED repo with `npm run build`, its entries,
// and the feed-solver WSL distro; skipped otherwise, loudly. Set SEED_FEED_REPO to the FEED checkout.
const repo = process.env.SEED_FEED_REPO ?? join(__dirname, "..", "..", "fuel-performance-studio");
const bundle = join(repo, "dist", "cli", "headless.js");
const base = join(repo, "oracles", "seed");
const solverUp = (() => {
  if (!existsSync(bundle)) return false;
  const r = spawnSync(process.execPath, [bundle, "describe"], { encoding: "utf8", timeout: 60000 });
  try {
    return JSON.parse(r.stdout.trim()).solver.available === true;
  } catch {
    return false;
  }
})();
const have = solverUp && existsSync(join(base, "entries"));
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "feed", "cli.cjs")], id: "feed", version: "0.1.0" };
const actor = { kind: "agent" as const, name: "oracle-runner", model: "test-model" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const dirs: string[] = [];
const saved = { h: process.env.SEED_FEED_HEADLESS, o: process.env.SEED_FEED_ORACLES };

const appCommit = (() => {
  const r = spawnSync("git", ["-c", "safe.directory=" + repo.replaceAll("\\", "/"), "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
})();

beforeAll(() => {
  process.env.SEED_FEED_HEADLESS = bundle;
  process.env.SEED_FEED_ORACLES = join(base, "entries");
});
afterAll(() => {
  for (const [k, v] of [["SEED_FEED_HEADLESS", saved.h], ["SEED_FEED_ORACLES", saved.o]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!have) console.warn(`FEED headless runner, solver or oracle entries not found under ${repo}: the FEED oracle tests were skipped`);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run one entry the way a host would: bad-input through the validate verb, good and known-limit through the run manager. */
async function observe(entry: OracleEntry): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), "seed-feed-oracle-"));
  dirs.push(root);
  for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
  for (const i of entry.inputs) {
    mkdirSync(join(root, dirname(i.path)), { recursive: true });
    cpSync(join(base, i.path), join(root, i.path));
  }
  const casePath = entry.inputs[0]!.path;
  const artifact = { path: casePath, revision: { hash: entry.inputs[0]!.sha256, counter: 1 } };
  if (entry.tag === "bad-input") {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: root, timeoutMs: 30000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const r = o.reply as { ok: boolean; result?: { problems: { code: string }[] } };
    const first = r.result?.problems[0];
    return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
  }
  const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 60000 });
  const out = await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
  if (!out.ok) throw new Error("run refused: " + JSON.stringify(out.errors));
  if (entry.tag === "known-limit") {
    // The solver finished; the adapter must refuse to hand over the result. Read its own refusal.
    if (out.state === "completed") return { kind: "verdict", verdict: "accepted" };
    const jobId = JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId;
    const c = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "collect", requestId: "req-c", actor, jobId, runDir: `runs/${out.runId}` }, { projectRoot: root, timeoutMs: 30000 });
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    const reply = c.reply as { ok: boolean; errors: { code: string }[] };
    return { kind: "refusal", code: reply.errors[0]?.code ?? "none" };
  }
  if (out.state !== "completed") throw new Error("run ended " + out.state);
  const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
  const q = index.quantities.find((x: { name: string }) => x.name === entry.expected.quantity);
  const data = JSON.parse(readFileSync(join(root, q.data.path), "utf8")) as { values: number[] };
  return { kind: "value", quantity: q.name, value: data.values[data.values.length - 1]!, unit: q.unit };
}

describe.skipIf(!have)("FEED oracle set through the SEED adapter (real OFFBEAT solver)", () => {
  it("loads 33 entries, all pinned and valid", () => {
    const r = loadOracleEntries(join(base, "entries"));
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(33);
    expect(r.entries.filter((i) => i.entry.tag === "good")).toHaveLength(22);
    expect(r.entries.filter((i) => i.entry.tag === "bad-input")).toHaveLength(9);
    expect(r.entries.filter((i) => i.entry.tag === "known-limit")).toHaveLength(2);
  });

  it("describe reports the coverage of the good entries", async () => {
    const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "req-d", actor }, { projectRoot: tmpdir(), timeoutMs: 60000 });
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    const cov = (o.reply as { result: { oracleCoverage: { quantity: string }[] } }).result.oracleCoverage;
    expect([...new Set(cov.map((c) => c.quantity))].sort()).toEqual(["energy_balance_residual", "energy_deposited", "heat_flux_outer", "temperature_peak", "temperature_peak_max", "temperature_surface"]);
  });

  it("the adapter passes every entry: set passes, inputs verified, not blocked", async () => {
    const { entries } = loadOracleEntries(join(base, "entries"));
    const set = await runOracleSet({ entries, adapter: { id: "feed", version: "0.1.0" }, appCommit, baseDir: base, run: (e) => observe(e) });
    expect(set.results.filter((r) => r.verdict !== "pass")).toEqual([]);
    expect(set.verdict).toBe("pass");
    expect(set.inputsVerified).toBe(true);
    expect(set.blocked).toBe(false);
    // what the oracles do not cover stays unverified
    expect(unverifiedQuantities(["temperature_peak", "temperature_surface", "heat_flux_outer", "energy_balance_residual", "temperature_fuel_surface", "temperature_clad_inner", "temperature_radial", "temperature_peak_max", "energy_deposited", "temperature_peak_history", "temperature_outer_wall_history", "time_of_peak", "energy_balance_gap"], set, entries)).toEqual(["temperature_fuel_surface", "temperature_clad_inner", "temperature_radial", "temperature_peak_history", "temperature_outer_wall_history", "time_of_peak", "energy_balance_gap"]);
  }, 1_800_000);
  it("cancel through the adapter stops the real solver in the WSL distro, not only the Node processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "seed-feed-cancel-")); dirs.push(root);
    for (const d of ["models", "runs"]) mkdirSync(join(root, d), { recursive: true });
    const doc = JSON.parse(readFileSync(join(base, "models", "synthetic-const.case.json"), "utf8"));
    doc.mesh = { fuelCells: 20000, claddingCells: 10000 };
    const text = JSON.stringify(doc, null, 2) + String.fromCharCode(10);
    const casePath = "models/big.case.json";
    writeFileSync(join(root, casePath), text);
    const hash = createHash("sha256").update(text).digest("hex");
    const mgr = new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 60000 });
    const started = mgr.start({ requestId: "req-big", actor, artifact: { path: casePath, revision: { hash, counter: 1 } }, inputs: [{ path: casePath, sha256: hash }], budget, settings: { case: casePath } });
    let runId = "", feedId = "";
    for (let i = 0; i < 400 && !feedId; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        runId = JSON.parse(readFileSync(join(root, "runs", "requests.json"), "utf8"))["req-big"].runId;
        feedId = JSON.parse(readFileSync(join(root, "runs", runId, "native", "out", "active-run.json"), "utf8")).feedRunId;
      } catch { /* not yet */ }
    }
    expect(feedId).toMatch(/^[0-9a-f]{12}$/);
    const probe = "for i in $(seq 1 400); do for p in $(pgrep -x offbeat); do if readlink /proc/$p/cwd 2>/dev/null | grep -q \"feed-$1\"; then echo found; exit 0; fi; done; sleep 0.05; done; echo timeout";
    const wsl = (script: string) => promisify(execFile)("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", script, "_", feedId], { encoding: "utf8" });
    expect((await wsl(probe)).stdout.trim()).toBe("found");
    const c = await mgr.cancel(runId);
    expect(c.ok && c.state).toBe("cancelled");
    const s = await started;
    expect(s.ok && s.state).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 2500));
    expect((await wsl("for p in /proc/[0-9]*; do readlink \"$p/cwd\" 2>/dev/null; done | grep -c \"feed-$1\" || true")).stdout.trim()).toBe("0");
    expect(existsSync(join(root, "runs", runId, "results.json"))).toBe(false);
  }, 240_000);
});
