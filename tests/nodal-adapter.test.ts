import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";
import { checkResultsAgainstRecord, checkResultsIndex } from "../src/core/semantic";
import { validate } from "../src/core/validate";

// The real tests need NODAL: SEED_NODAL_REPO (default: a sibling folder pipe-studio) on a branch that has the runner's
// --describe/--validate/--json modes, and a Python with its solver requirements (SEED_NODAL_PYTHON, default the repo's .venv).
// Without them the real-runner tests are skipped with a warning, and only the setup tests run.
const repo = process.env.SEED_NODAL_REPO ?? join(__dirname, "..", "..", "pipe-studio");
const pythonCandidates = [process.env.SEED_NODAL_PYTHON, join(repo, ".venv", "Scripts", "python.exe"), join(repo, ".venv", "bin", "python")];
const python = pythonCandidates.find(p => p && existsSync(p)) ?? "";
const haveNodal =
  python !== "" &&
  existsSync(join(repo, "nodal_studio", "run.py")) &&
  spawnSync(python, ["-m", "nodal_studio.run", "--describe"], { cwd: repo, env: { ...process.env, PYTHONPATH: repo }, encoding: "utf8" }).status === 0;
const goldenDir = join(repo, "schema", "vectors", "golden");
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "nodal", "cli.cjs")], id: "nodal", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
type Vec = Record<string, any>;

const dirs: string[] = [];
const pids: number[] = [];
const saved = { py: process.env.SEED_NODAL_PYTHON, repo: process.env.SEED_NODAL_REPO };
beforeEach(() => {
  if (haveNodal) {
    process.env.SEED_NODAL_PYTHON = python;
    process.env.SEED_NODAL_REPO = repo;
  }
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup of a test's leftovers
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [["SEED_NODAL_PYTHON", saved.py], ["SEED_NODAL_REPO", saved.repo]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!haveNodal) console.warn(`NODAL runner not usable (repo ${repo}, python ${python || "none"}): the real-runner tests were skipped`);
});

function tmpDir(prefix = "seed-nodal-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function newProject(): string {
  const root = tmpDir();
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  return root;
}
const golden = (name: string): Vec => JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8"));

/** A project holding one golden model (and its commands file, when it has commands). */
function nodalProject(name = "steady-pipe", editModel: (m: Vec) => void = () => {}) {
  const root = newProject();
  const g = golden(name);
  const model = structuredClone(g.model);
  editModel(model);
  const modelPath = `models/${name}.json`;
  const modelText = JSON.stringify(model, null, 2) + "\n";
  writeFileSync(join(root, modelPath), modelText);
  const inputs = [{ path: modelPath, sha256: sha256Hex(modelText) }];
  const settings: Record<string, unknown> = { model: modelPath, recordDt: g.recordDt };
  if (g.commands.length > 0) {
    const commandsPath = `models/${name}.commands.json`;
    const text = JSON.stringify(g.commands);
    writeFileSync(join(root, commandsPath), text);
    inputs.push({ path: commandsPath, sha256: sha256Hex(text) });
    settings.commands = commandsPath;
  }
  return { root, g, modelPath, modelText, inputs, settings, artifact: { path: modelPath, revision: { hash: sha256Hex(modelText), counter: 1 } } };
}

const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 60000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; warnings: { code: string }[]; result?: any };
};
const cli = (root: string, verb: string, request: unknown) =>
  spawnSync(process.execPath, [spec.args[0]!, verb], { input: JSON.stringify(request), encoding: "utf8", env: { ...process.env, SEED_PROJECT_ROOT: root } });
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 + 1e-9 * Math.abs(b);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const COMPLETED = ["steady-pipe", "pressure-pulse", "check-valve", "pumped-loop", "heated-pipe", "wall-reservoir", "t2-wet-flow", "commands"];
const longModel = (m: Vec) => {
  m.timeSteps[m.timeSteps.length - 1].endTime = 1e7;
};
const sleepingProcess = () => {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  p.unref();
  pids.push(p.pid!);
  return p.pid!;
};
const runIdOf = (root: string, requestId: string) => read(join(root, "runs", "requests.json"))[requestId]?.runId as string | undefined;
async function waitForChild(root: string, requestId: string): Promise<string> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const id = runIdOf(root, requestId);
      if (id && existsSync(join(root, "runs", id, "native", "child.json"))) return id;
    } catch {
      // requests.json not written yet
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("the job did not start");
}
function nodalProcessesFor(text: string): string {
  return process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*nodal_studio.run*' } | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" }).stdout
    : spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout.split("\n").filter(l => /python/.test(l.split(" ")[0] ?? "") && l.includes("nodal_studio.run")).join("\n");
}

describe("NODAL adapter: configuration and a misbehaving runner", () => {
  it.each([
    ["unset", undefined, undefined],
    ["relative python", "python", undefined],
    ["python that does not exist", join(tmpdir(), "no-such-python.exe"), undefined],
    ["repo that does not exist", undefined, join(tmpdir(), "no-such-repo")],
    ["repo without nodal_studio/run.py", undefined, tmpdir()],
  ])("without a usable runner (%s) describe, validate and run say setup is required", async (_n, py, rp) => {
    const root = newProject();
    process.env.SEED_NODAL_PYTHON = py ?? (haveNodal ? python : process.execPath);
    process.env.SEED_NODAL_REPO = rp ?? "";
    if (_n === "unset") {
      delete process.env.SEED_NODAL_PYTHON;
      delete process.env.SEED_NODAL_REPO;
    }
    writeFileSync(join(root, "models", "m.json"), "{}");
    const sha = sha256Hex("{}");
    for (const req of [
      { verb: "describe" },
      { verb: "validate", artifact: { path: "models/m.json", revision: { hash: sha, counter: 1 } } },
      { verb: "run", snapshot: { inputs: [{ path: "models/m.json", sha256: sha }] }, runDir: "runs/r-x", budget },
    ]) {
      const r = okReply(await ask(root, req));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.code).toBe("E_SETUP_REQUIRED");
    }
  });

  it("open is not supported", async () => {
    const root = newProject();
    const r = okReply(await ask(root, { verb: "open", artifact: { path: "models/m.json", revision: { hash: sha256Hex("x"), counter: 1 } } }));
    expect(r.errors[0]?.code).toBe("E_VERB_UNKNOWN");
  });
});

describe.skipIf(!haveNodal)("NODAL adapter against the real runner", () => {
  it("describe: engine, capabilities, quantity kinds with units, no oracle claims without entries", async () => {
    const r = okReply(await ask(newProject(), { verb: "describe" }));
    expect(r.ok).toBe(true);
    expect(r.result.app).toMatchObject({ id: "nodal", name: "NODAL Studio" });
    expect(r.result.engine.name).toBe("nodal-reference-py");
    expect(r.result.capabilities).toEqual(expect.arrayContaining(["hydro/single-phase-v1", "hydro/hem-v1", "run", "collect"]));
    expect(r.result.quantities.find((q: { name: string }) => q.name === "pressure")).toMatchObject({ unit: "Pa", normalization: "none" });
    expect(r.result.oracleCoverage).toEqual([]);
  });

  describe("validate", () => {
    it("a good model is valid", async () => {
      const { root, artifact } = nodalProject();
      expect(okReply(await ask(root, { verb: "validate", artifact }))).toMatchObject({ ok: true, result: { valid: true, problems: [] } });
    });

    it("a refused model gives typed problems labelled app-content; a warning does not refuse", async () => {
      const bad = nodalProject("steady-pipe", m => {
        m.heatStructures = [{ id: "hs1" }];
        m.capabilities = ["hydro/single-phase-v1", "heat/conduction-v1"];
      });
      const r = okReply(await ask(bad.root, { verb: "validate", artifact: bad.artifact }));
      expect(r.result.valid).toBe(false);
      expect(r.result.problems[0]).toMatchObject({ source: "app-content" });
      expect(r.result.problems[0].message).toContain("E_HEAT_STRUCTURE_INCOMPLETE");
      const warn = nodalProject("steady-pipe", m => {
        const j = m.parts.find((p: Vec) => p.kind === "junction");
        j.position = j.position.map((v: number) => v + 0.5);
      });
      const w = okReply(await ask(warn.root, { verb: "validate", artifact: warn.artifact }));
      expect(w.result.valid).toBe(true);
      expect(w.result.problems.map((p: { code: string }) => p.code)).toContain("W_LINK_GAP");
    });

    it("a stale revision, a missing file and a file that is not a model", async () => {
      const { root, artifact } = nodalProject();
      const stale = okReply(await ask(root, { verb: "validate", artifact: { ...artifact, revision: { hash: "0".repeat(64), counter: 1 } } }));
      expect(stale.result.problems.map((p: { code: string }) => p.code)).toContain("E_STALE_REVISION");
      expect(okReply(await ask(root, { verb: "validate", artifact: { ...artifact, path: "models/none.json" } })).result.problems[0]?.code).toBe("E_NOT_FOUND");
      writeFileSync(join(root, "models", "junk.json"), "{nope");
      const junk = okReply(await ask(root, { verb: "validate", artifact: { path: "models/junk.json", revision: { hash: sha256Hex("{nope"), counter: 1 } } }));
      expect(junk.result.valid).toBe(false);
      expect(junk.result.problems[0]).toMatchObject({ code: "E_SCHEMA_INVALID", source: "app-content" });
    });
  });

  describe("through the run manager (SEED lifecycle)", () => {
    it.each(COMPLETED)("%s: completed, valid index, series equal the direct run and the golden vector", async name => {
      const p = nodalProject(name);
      const out = await manager(p.root).start({ requestId: `req-${name}`, actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error(JSON.stringify(out.errors));
      expect(out.state).toBe("completed");
      const index = read(join(p.root, "runs", out.runId, "results.json"));
      expect(validate("results-index", index)).toEqual({ ok: true });
      expect(checkResultsIndex(index)).toEqual([]);
      expect(checkResultsAgainstRecord(index, out.record)).toEqual([]);
      expect(index.quantities.map((q: { name: string }) => q.name)).toEqual(p.g.model.outputs.map((o: Vec) => o.name));
      for (const q of index.quantities) expect(sha256Hex(readFileSync(join(p.root, q.data.path)))).toBe(q.data.sha256);

      // Parity: the same model run directly through the runner gives the same numbers, bit for bit.
      const directDir = tmpDir();
      const args = ["-m", "nodal_studio.run", join(p.root, p.modelPath), "--out", directDir, "--run-id", "d", "--record-dt", String(p.g.recordDt), "--json"];
      if (p.settings.commands) args.push("--commands", join(p.root, p.settings.commands as string));
      const direct = spawnSync(python, args, { cwd: repo, encoding: "utf8", env: { ...process.env, PYTHONPATH: repo } });
      expect(direct.status, direct.stderr).toBe(0);
      const directResults = read(join(directDir, "d", "results.json"));
      for (const q of index.quantities) {
        const series = read(join(p.root, q.data.path));
        expect(series.values).toEqual(directResults.data[q.name]);
        expect(series.t).toEqual(directResults.time);
        // Oracle agreement: the committed golden vector, within a tight relative tolerance.
        const want: number[] = p.g.expected.data[q.name];
        expect(series.values).toHaveLength(want.length);
        series.values.forEach((v: number, i: number) => expect(close(v, want[i]!), `${q.name}[${i}] ${v} vs ${want[i]}`).toBe(true));
      }
    }, 120000);

    it("the index names the runner's engine, model hash and units, and keeps every quantity unverified", async () => {
      const p = nodalProject("pressure-pulse");
      const out = await manager(p.root).start({ requestId: "req-units", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error("refused");
      const index = read(join(p.root, "runs", out.runId, "results.json"));
      expect(index.engine).toMatchObject({ name: "nodal-reference-py" });
      expect(index.extensions.nodal.modelHash).toMatch(/^[0-9a-f]{64}$/);
      const unitOf: Record<string, string> = { pressure: "Pa", temperature: "K", massFlow: "kg/s" };
      p.g.model.outputs.forEach((o: Vec, i: number) => {
        expect(index.quantities[i].unit).toBeTruthy();
        if (unitOf[o.quantity]) expect(index.quantities[i].unit).toBe(unitOf[o.quantity]);
      });
      expect(index.quantities.every((q: { verification: string }) => q.verification === "unverified")).toBe(true);
    }, 120000);

    it("a model that stops on its own stop-advancement trip ends terminated-by-trip, with no results collected", async () => {
      const p = nodalProject("trip-stop");
      const out = await manager(p.root).start({ requestId: "req-trip", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error(JSON.stringify(out.errors));
      expect(out.state).toBe("terminated-by-trip");
      expect(existsSync(join(p.root, "runs", out.runId, "results.json"))).toBe(false);
    }, 120000);

    it("a run the solver fails ends failed with the reason, and nothing is collected", async () => {
      const p = nodalProject("choking-guard-fire");
      const out = await manager(p.root).start({ requestId: "req-failed", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error(JSON.stringify(out.errors));
      expect(out.state).toBe("failed");
      expect(JSON.stringify(out.record)).toContain("the run ended failed");
      expect(existsSync(join(p.root, "runs", out.runId, "results.json"))).toBe(false);
    }, 120000);

    it("a model the runner refuses is refused at validation: no run folder, no process", async () => {
      const p = nodalProject("steady-pipe", m => {
        m.heatStructures = [{ id: "hs1" }];
        m.capabilities = ["hydro/single-phase-v1", "heat/conduction-v1"];
      });
      const out = await manager(p.root).start({ requestId: "req-bad", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors[0]).toMatchObject({ source: "app-content" });
      expect(readdirSync(join(p.root, "runs")).filter(n => n.startsWith("r-"))).toEqual([]);
    });

    it.each([
      ["a seed (NODAL is deterministic)", { seed: 7 }, {}, "E_UNSUPPORTED"],
      ["an unknown setting", {}, { extra: 1 }, "E_UNSUPPORTED"],
      ["a bad recordDt", {}, { recordDt: -1 }, "E_BOUNDS_EXCEEDED"],
      ["a model that is not an input", {}, { model: "models/none.json" }, "E_PROP_MISSING"],
      ["a commands file that is not an input", {}, { commands: "models/none.json" }, "E_PROP_MISSING"],
    ])("a request with %s is refused by the adapter and the run is recorded failed", async (_n, top, extraSettings, code) => {
      const p = nodalProject();
      const out = await manager(p.root).start({ requestId: "req-refuse", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { ...p.settings, ...extraSettings }, ...top });
      expect(out.ok && out.state).toBe("failed");
      expect(JSON.stringify(out.ok && out.record)).toContain(code);
    }, 120000);

    it("cancel: kills the job and the Python runner under it, collects nothing", async () => {
      const p = nodalProject("pumped-loop", longModel);
      const settings = { ...p.settings, recordDt: 1000 };
      const mgr = manager(p.root);
      const started = mgr.start({ requestId: "req-cancel", actor, artifact: p.artifact, inputs: p.inputs, budget, settings });
      const runId = await waitForChild(p.root, "req-cancel");
      const job = read(join(p.root, "runs", runId, "native", "job.json"));
      const child = read(join(p.root, "runs", runId, "native", "child.json"));
      pids.push(job.pid, child.pid);
      expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
      const c = await mgr.cancel(runId);
      expect(c.ok && c.state).toBe("cancelled");
      expect((await started).ok).toBe(true);
      expect(isAlive(job.pid)).toBe(false);
      expect(isAlive(child.pid)).toBe(false);
      expect(nodalProcessesFor(runId)).not.toContain(runId);
      expect(existsSync(join(p.root, "runs", runId, "results.json"))).toBe(false);
    }, 120000);

    it("collect refuses a run whose files, model or step coverage do not hold up", async () => {
      const edits: [string, (dir: string, m: Vec, res: Vec) => void, string][] = [
        ["a results file changed without its manifest hash", (dir) => writeFileSync(join(dir, "results.json"), readFileSync(join(dir, "results.json"), "utf8").replace('"completed"', '"completed" ')), "manifest hash"],
        ["a run folder model that is not the snapshot's", (dir, m) => {
          const model = read(join(dir, "model.json"));
          model.name = "swapped";
          writeFileSync(join(dir, "model.json"), JSON.stringify(model));
          const entry = m.files.find((f: { path: string }) => f.path === "model.json");
          entry.sha256 = sha256Hex(readFileSync(join(dir, "model.json")));
        }, "snapshot's model"],
        ["a results file that stops early (re-hashed)", (dir, m, res) => {
          res.time = res.time.slice(0, 3);
          for (const k of Object.keys(res.data)) res.data[k] = res.data[k].slice(0, 3);
          res.completion.endTime = res.time[2];
          const text = JSON.stringify(res);
          writeFileSync(join(dir, "results.json"), text);
          const entry = m.files.find((f: { path: string }) => f.path === "results.json");
          entry.sha256 = sha256Hex(text);
        }, "end of the model's time-step schedule"],
        ["a short series with the end time still claimed (re-hashed)", (dir, m, res) => {
          res.time = res.time.slice(0, 3);
          for (const k of Object.keys(res.data)) res.data[k] = res.data[k].slice(0, 3);
          const text = JSON.stringify(res);
          writeFileSync(join(dir, "results.json"), text);
          m.files.find((f: { path: string }) => f.path === "results.json").sha256 = sha256Hex(text);
        }, "end of the model's time-step schedule"],
        ["two channels with one name (re-hashed)", (dir, m, res) => {
          res.channels.push({ ...res.channels[0] });
          const text = JSON.stringify(res);
          writeFileSync(join(dir, "results.json"), text);
          m.files.find((f: { path: string }) => f.path === "results.json").sha256 = sha256Hex(text);
        }, "not the outputs the model asked for"],
        ["a channel shorter than the time series (re-hashed)", (dir, m, res) => {
          const k = Object.keys(res.data)[0]!;
          res.data[k] = res.data[k].slice(1);
          const text = JSON.stringify(res);
          writeFileSync(join(dir, "results.json"), text);
          m.files.find((f: { path: string }) => f.path === "results.json").sha256 = sha256Hex(text);
        }, "not as long as the time series"],
        ["a manifest that lists another file set", (_d, m) => (m.files = m.files.filter((f: { path: string }) => f.path !== "session.json")), "exactly its three files"],
      ];
      for (const [what, edit, message] of edits) {
        const p = nodalProject("rising-pipe");
        const out = await manager(p.root).start({ requestId: "req-tamper", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
        if (!out.ok) throw new Error("refused");
        const dir = join(p.root, "runs", out.runId, "native", "out", "nodal");
        const m = read(join(dir, "manifest.json"));
        edit(dir, m, read(join(dir, "results.json")));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
        const jobId = read(join(p.root, "runs", out.runId, "native", "job.json")).jobId;
        const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
        expect(r.ok, what).toBe(false);
        expect(r.errors[0]?.code, what).toBe("E_OUTPUT_INCOMPLETE");
        expect(r.errors[0]?.message, what).toContain(message);
      }
    }, 240000);

    it("collect refuses a run whose snapshot copy of the model was changed after it ran", async () => {
      const p = nodalProject("rising-pipe");
      const out = await manager(p.root).start({ requestId: "req-swap", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error("refused");
      const snap = join(p.root, "runs", out.runId, "inputs", p.modelPath);
      writeFileSync(snap, readFileSync(snap, "utf8") + " ");
      const jobId = read(join(p.root, "runs", out.runId, "native", "job.json")).jobId;
      const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.message).toContain("snapshot changed");
    }, 120000);

    it("collect and status bind the job to its run folder, and the same request is idempotent", async () => {
      const a = nodalProject("rising-pipe");
      const outA = await manager(a.root).start({ requestId: "req-a", actor, artifact: a.artifact, inputs: a.inputs, budget, settings: a.settings });
      const outB = await manager(a.root).start({ requestId: "req-b", actor, artifact: a.artifact, inputs: a.inputs, budget, settings: a.settings });
      if (!outA.ok || !outB.ok) throw new Error("refused");
      const jobA = read(join(a.root, "runs", outA.runId, "native", "job.json")).jobId;
      const wrong = okReply(await ask(a.root, { verb: "collect", jobId: jobA, runDir: `runs/${outB.runId}` }));
      expect(wrong.errors[0]?.message).toContain("not registered for this run folder");
      expect(okReply(await ask(a.root, { verb: "status", jobId: jobA })).result.lifecycle).toBe("completed");
      const again = okReply(await ask(a.root, { verb: "run", requestId: "req-a", snapshot: { inputs: a.inputs }, runDir: `runs/${outA.runId}`, budget, settings: a.settings }));
      expect(again.ok && again.result.jobId).toBe(jobA);
      const other = okReply(await ask(a.root, { verb: "run", requestId: "req-c", snapshot: { inputs: a.inputs }, runDir: `runs/${outA.runId}`, budget, settings: a.settings }));
      expect(other.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    }, 240000);
  });

  describe("review-grade guards (ported from the RAFT adapter)", () => {
    const prepareRunDir = (root: string, inputs: { path: string }[], runDir: string) => {
      for (const i of inputs) {
        mkdirSync(join(root, runDir, "inputs", dirname(i.path)), { recursive: true });
        writeFileSync(join(root, runDir, "inputs", i.path), readFileSync(join(root, i.path)));
      }
    };
    const runRequest = (inputs: { path: string; sha256: string }[], requestId: string, runDir: string, settings: Record<string, unknown>) => ({ verb: "run", requestId, snapshot: { inputs }, runDir, budget, settings });

    it("cancel kills only a process that really is this run's job wrapper, whatever the project files say", async () => {
      const p = nodalProject("pumped-loop", longModel);
      prepareRunDir(p.root, p.inputs, "runs/r-forged");
      const other = sleepingProcess();
      const native = join(p.root, "runs", "r-forged", "native");
      mkdirSync(native, { recursive: true });
      const token = "forged-token";
      writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-forged", requestId: "req-forged", pid: other, token, model: p.modelPath, inputs: p.inputs }));
      writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
      writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: new Date().toISOString() }));
      mkdirSync(join(p.root, ".seed", "jobs"), { recursive: true });
      writeFileSync(join(p.root, ".seed", "jobs", "job-forged.json"), JSON.stringify({ runDir: "runs/r-forged" }));
      const r = okReply(await ask(p.root, { verb: "cancel", jobId: "job-forged" }));
      expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
      expect(isAlive(other)).toBe(true);
    }, 60000);

    it("a live job with a late heartbeat is still running; only a confirmed death is a failure", async () => {
      const p = nodalProject();
      const live = sleepingProcess();
      const setup = (name: string, pid: number, heartbeatAgeMs: number | null, jobAgeMs: number) => {
        const native = join(p.root, "runs", name, "native");
        mkdirSync(native, { recursive: true });
        const token = "tok-" + name;
        writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-" + name, requestId: "r-" + name, pid, token, model: p.modelPath, inputs: p.inputs }));
        writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
        utimesSync(join(native, "job.json"), new Date(Date.now() - jobAgeMs), new Date(Date.now() - jobAgeMs));
        if (heartbeatAgeMs !== null) {
          writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: "x" }));
          utimesSync(join(native, "heartbeat.json"), new Date(Date.now() - heartbeatAgeMs), new Date(Date.now() - heartbeatAgeMs));
        }
        mkdirSync(join(p.root, ".seed", "jobs"), { recursive: true });
        writeFileSync(join(p.root, ".seed", "jobs", "job-" + name + ".json"), JSON.stringify({ runDir: `runs/${name}` }));
        return "job-" + name;
      };
      const state = async (id: string) => okReply(await ask(p.root, { verb: "status", jobId: id })).result;
      expect((await state(setup("late", live, 60_000, 120_000))).lifecycle).toBe("running");
      expect((await state(setup("starting", live, null, 1_000))).native.detail).toBe("starting");
      expect((await state(setup("neverstarted", live, null, 120_000))).lifecycle).toBe("failed");
      expect((await state(setup("dead", 2_000_000_000, 100, 120_000))).lifecycle).toBe("failed");
    });

    it("two starts of one request at once give one job; another request cannot take the run folder; job ids do not collide", async () => {
      const p = nodalProject("pumped-loop", longModel);
      prepareRunDir(p.root, p.inputs, "runs/r-one");
      const settings = { ...p.settings, recordDt: 1000 };
      const [a, b] = await Promise.all([ask(p.root, runRequest(p.inputs, "req-race", "runs/r-one", settings)), ask(p.root, runRequest(p.inputs, "req-race", "runs/r-one", settings))]);
      const ra = okReply(a);
      const rb = okReply(b);
      expect(ra.ok && rb.ok).toBe(true);
      expect(ra.result.jobId).toBe(rb.result.jobId);
      await new Promise(r => setTimeout(r, 800));
      const job = read(join(p.root, "runs", "r-one", "native", "job.json"));
      const child = read(join(p.root, "runs", "r-one", "native", "child.json"));
      pids.push(job.pid, child.pid);
      expect(okReply(await ask(p.root, runRequest(p.inputs, "req-other", "runs/r-one", settings))).errors[0]?.code).toBe("E_REQUEST_CONFLICT");
      expect(okReply(await ask(p.root, { verb: "cancel", jobId: ra.result.jobId })).result).toMatchObject({ lifecycle: "cancelled", cancelled: true });
      const prefix = "a".repeat(55);
      const ids = [prefix + "1", prefix + "2"].map(id => {
        prepareRunDir(p.root, p.inputs, "runs/r-" + id.slice(-1));
        return okReply(spawnToReply(p.root, runRequest(p.inputs, id, "runs/r-" + id.slice(-1), settings)));
      });
      expect(ids[0]!.result.jobId).not.toBe(ids[1]!.result.jobId);
      for (const r of ids) {
        const dir = join(p.root, "runs", "r-" + (r === ids[0] ? "1" : "2"), "native");
        await new Promise(res => setTimeout(res, 500));
        const j = read(join(dir, "job.json"));
        const c = readIfThere(join(dir, "child.json"));
        pids.push(j.pid);
        if (c) pids.push(c.pid);
      }
    }, 120000);

    it("direct calls of the adapter CLI re-check every path, and a linked state folder is refused", () => {
      const p = nodalProject();
      prepareRunDir(p.root, p.inputs, "runs/r-direct");
      const base = { schema: "seed.adapter-request/0.1", verb: "run", requestId: "req-direct", actor, runDir: "runs/r-direct", budget };
      const cases: [string, Record<string, unknown>, string][] = [
        ["case path outside", { snapshot: { inputs: [{ path: "../../etc/m.json", sha256: "0".repeat(64) }] }, settings: { model: "../../etc/m.json" } }, "E_PATH_INVALID"],
        ["run folder outside", { runDir: "../outside", snapshot: { inputs: p.inputs }, settings: p.settings }, "E_PATH_TRAVERSAL"],
        ["input that changed", { snapshot: { inputs: [{ ...p.inputs[0]!, sha256: "0".repeat(64) }] }, settings: p.settings }, "E_STALE_REVISION"],
      ];
      for (const [what, extra, code] of cases) {
        const r = cli(p.root, "run", { ...base, ...extra });
        expect(r.status, what).toBe(0);
        expect(JSON.parse(r.stdout).errors[0].code, what).toBe(code);
      }
      const outside = tmpDir("seed-nodal-outside-");
      try {
        symlinkSync(outside, join(p.root, "runs", "r-direct", "native"), "junction");
      } catch {
        return; // links are not permitted in this environment
      }
      const linked = JSON.parse(cli(p.root, "run", { ...base, snapshot: { inputs: p.inputs }, settings: p.settings }).stdout);
      expect(linked.errors[0].code).toBe("E_PATH_TRAVERSAL");
      expect(readdirSync(outside)).toEqual([]);
    });
  });

  it("no nodal_studio runner process is left behind", () => {
    expect(nodalProcessesFor("")).toBe("");
  });
});

function spawnToReply(root: string, request: Record<string, unknown>) {
  const r = cli(root, "run", { schema: "seed.adapter-request/0.1", requestId: "x", actor, ...request });
  return { ok: true as const, reply: JSON.parse(r.stdout) } as unknown as Awaited<ReturnType<typeof ask>>;
}
function readIfThere(p: string): { pid: number } | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
