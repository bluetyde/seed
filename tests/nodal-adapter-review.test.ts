import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";
import { validate } from "../src/core/validate";

// Regression tests for the Codex review of the NODAL adapter (2026-10-05). Same requirements as nodal-adapter.test.ts: the NODAL repo
// (SEED_NODAL_REPO, default a sibling folder pipe-studio) on a branch with the runner's JSON modes, and its Python (SEED_NODAL_PYTHON).
const repo = process.env.SEED_NODAL_REPO ?? [join(__dirname, "..", "..", "nodal-seed"), join(__dirname, "..", "..", "pipe-studio")].find(p => existsSync(join(p, "nodal_studio", "run.py"))) ?? join(__dirname, "..", "..", "pipe-studio");
const python = [process.env.SEED_NODAL_PYTHON, join(repo, ".venv", "Scripts", "python.exe"), join(repo, ".venv", "bin", "python"), join(__dirname, "..", "..", "pipe-studio", ".venv", "Scripts", "python.exe"), join(__dirname, "..", "..", "pipe-studio", ".venv", "bin", "python")].find(p => p && existsSync(p)) ?? "";
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
});

function tmpDir(prefix = "seed-nodal-rev-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function nodalProject(name = "steady-pipe", editModel: (m: Vec) => void = () => {}) {
  const root = tmpDir();
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  const g: Vec = JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8"));
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
  return { root, g, modelPath, inputs, settings, artifact: { path: modelPath, revision: { hash: sha256Hex(modelText), counter: 1 } } };
}
const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 60000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; warnings: { code: string }[]; result?: any };
};
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const longModel = (m: Vec) => {
  m.timeSteps[m.timeSteps.length - 1].endTime = 1e7;
};
const sleepingProcess = () => {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  p.unref();
  pids.push(p.pid!);
  return p.pid!;
};
const prepareRunDir = (root: string, inputs: { path: string }[], runDir: string) => {
  for (const i of inputs) {
    mkdirSync(join(root, runDir, "inputs", dirname(i.path)), { recursive: true });
    writeFileSync(join(root, runDir, "inputs", i.path), readFileSync(join(root, i.path)));
  }
};
const runRequest = (inputs: { path: string; sha256: string }[], requestId: string, runDir: string, settings: Record<string, unknown>) => ({ verb: "run", requestId, snapshot: { inputs }, runDir, budget, settings });
const longSettings = (p: { settings: Record<string, unknown> }) => ({ ...p.settings, recordDt: 1000 });
const track = (root: string, runDir: string) => {
  const job = read(join(root, runDir, "native", "job.json"));
  const child = read(join(root, runDir, "native", "child.json"));
  pids.push(job.pid, child.pid);
  return { job, child };
};

describe.skipIf(!haveNodal)("NODAL adapter: review fixes (Codex, 2026-10-05)", () => {
  it("a request id already bound to another run folder is refused, and the first job keeps its registry entry", async () => {
    const p = nodalProject("pumped-loop", longModel);
    prepareRunDir(p.root, p.inputs, "runs/original");
    prepareRunDir(p.root, p.inputs, "runs/second");
    const first = okReply(await ask(p.root, runRequest(p.inputs, "req-dup", "runs/original", longSettings(p))));
    expect(first.ok).toBe(true);
    await new Promise(r => setTimeout(r, 800));
    track(p.root, "runs/original");
    const second = okReply(await ask(p.root, runRequest(p.inputs, "req-dup", "runs/second", longSettings(p))));
    expect(second.ok).toBe(false);
    expect(second.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    expect(existsSync(join(p.root, "runs", "second", "native", "job.json"))).toBe(false);
    expect(okReply(await ask(p.root, { verb: "status", jobId: first.result.jobId })).result.lifecycle).toBe("running");
    expect(okReply(await ask(p.root, { verb: "cancel", jobId: first.result.jobId })).result.cancelled).toBe(true);
  }, 120000);

  it("cancel after the wrapper died stops the runner it left behind, and refuses a process it cannot show is its own", async () => {
    const p = nodalProject("pumped-loop", longModel);
    prepareRunDir(p.root, p.inputs, "runs/r-orphan");
    const r = okReply(await ask(p.root, runRequest(p.inputs, "req-orphan", "runs/r-orphan", longSettings(p))));
    expect(r.ok).toBe(true);
    await new Promise(res => setTimeout(res, 800));
    const { job, child } = track(p.root, "runs/r-orphan");
    process.kill(job.pid); // the wrapper alone: its runner survives
    const deadline = Date.now() + 10000;
    while (isAlive(job.pid) && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
    expect(isAlive(child.pid)).toBe(true);
    const c = okReply(await ask(p.root, { verb: "cancel", jobId: r.result.jobId }));
    expect(c.ok).toBe(true);
    expect(c.result).toMatchObject({ lifecycle: "failed", cancelled: false, nativeStopped: true });
    expect(isAlive(child.pid)).toBe(false);

    // A live process that is not this run's runner: refused, and it survives.
    prepareRunDir(p.root, p.inputs, "runs/r-forged");
    const other = sleepingProcess();
    const native = join(p.root, "runs", "r-forged", "native");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-forged", requestId: "req-forged", pid: 2_000_000_000, token: "t", model: p.modelPath, inputs: p.inputs }));
    writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(native, "child.json"), JSON.stringify({ pid: other }));
    mkdirSync(join(p.root, ".seed", "jobs"), { recursive: true });
    writeFileSync(join(p.root, ".seed", "jobs", "job-forged.json"), JSON.stringify({ runDir: "runs/r-forged" }));
    const f = okReply(await ask(p.root, { verb: "cancel", jobId: "job-forged" }));
    expect(f.errors[0]?.code).toBe("E_NOT_OWNED");
    expect(isAlive(other)).toBe(true);
  }, 120000);

  it("a process whose command line only starts like this run's folder is not its job wrapper", async () => {
    const p = nodalProject("pumped-loop", longModel);
    prepareRunDir(p.root, p.inputs, "runs/r");
    const absRun = join(p.root, "runs", "r");
    const lookalike = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(__dirname, "..", "adapters", "nodal", "job.cjs"), absRun + "-longer"], { stdio: "ignore", detached: true });
    lookalike.unref();
    pids.push(lookalike.pid!);
    const native = join(absRun, "native");
    mkdirSync(native, { recursive: true });
    const token = "look-token";
    writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-look", requestId: "req-look", pid: lookalike.pid, token, model: p.modelPath, inputs: p.inputs }));
    writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: new Date().toISOString() }));
    mkdirSync(join(p.root, ".seed", "jobs"), { recursive: true });
    writeFileSync(join(p.root, ".seed", "jobs", "job-look.json"), JSON.stringify({ runDir: "runs/r" }));
    const r = okReply(await ask(p.root, { verb: "cancel", jobId: "job-look" }));
    expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
    expect(isAlive(lookalike.pid!)).toBe(true);
  }, 60000);

  it("a rejected command comes back as a warning with its code and text, and the run still completes", async () => {
    const p = nodalProject("commands");
    const commands = JSON.parse(readFileSync(join(p.root, p.settings.commands as string), "utf8"));
    commands.push({ atStep: 90, command: { type: "bc.override", part: "no-such-part", pressure: 1.0e6 } });
    const text = JSON.stringify(commands);
    writeFileSync(join(p.root, p.settings.commands as string), text);
    const inputs = p.inputs.map(i => (i.path === p.settings.commands ? { ...i, sha256: sha256Hex(text) } : i));
    const out = await manager(p.root).start({ requestId: "req-rejected", actor, artifact: p.artifact, inputs, budget, settings: p.settings });
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.state).toBe("completed");
    const jobId = read(join(p.root, "runs", out.runId, "native", "job.json")).jobId;
    const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r.ok).toBe(true);
    expect(r.warnings.find(x => x.code.startsWith("W_NODAL_"))).toBeDefined();
    expect(JSON.stringify(r.warnings)).toContain("command bc.override rejected");
    expect(validate("adapter-reply", { schema: "seed.adapter-reply/0.1", verb: "collect", requestId: "x", ok: true, errors: [], warnings: r.warnings, result: r.result })).toEqual({ ok: true });
  }, 120000);

  it("collect refuses results that miss an output the model asked for, or do not start at the initial state", async () => {
    const rewrite = (dir: string, m: Vec, res: Vec) => {
      const text = JSON.stringify(res);
      writeFileSync(join(dir, "results.json"), text);
      m.files.find((f: { path: string }) => f.path === "results.json").sha256 = sha256Hex(text);
    };
    const edits: [string, (dir: string, m: Vec, res: Vec) => void, string][] = [
      ["a missing channel (re-hashed)", (dir, m, res) => {
        const gone = res.channels.pop();
        delete res.data[gone.name];
        rewrite(dir, m, res);
      }, "not the outputs the model asked for"],
      ["a history without its first samples (re-hashed)", (dir, m, res) => {
        res.time = res.time.slice(2);
        for (const k of Object.keys(res.data)) res.data[k] = res.data[k].slice(2);
        rewrite(dir, m, res);
      }, "initial state"],
    ];
    for (const [what, edit, message] of edits) {
      const p = nodalProject("rising-pipe");
      const out = await manager(p.root).start({ requestId: "req-miss", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
      if (!out.ok) throw new Error("refused");
      const dir = join(p.root, "runs", out.runId, "native", "out", "nodal");
      const m = read(join(dir, "manifest.json"));
      edit(dir, m, read(join(dir, "results.json")));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      const jobId = read(join(p.root, "runs", out.runId, "native", "job.json")).jobId;
      const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
      expect(r.errors[0]?.message, what).toContain(message);
    }
  }, 240000);

  it("a linked series folder is refused at collect, and a linked output folder keeps the job from writing outside", async () => {
    const p = nodalProject("rising-pipe");
    const out = await manager(p.root).start({ requestId: "req-serieslink", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings });
    if (!out.ok) throw new Error("refused");
    const native = join(p.root, "runs", out.runId, "native");
    rmSync(join(native, "series"), { recursive: true, force: true });
    const outside = tmpDir("seed-nodal-series-");
    try {
      symlinkSync(outside, join(native, "series"), "junction");
    } catch {
      return; // links are not permitted in this environment
    }
    const jobId = read(join(native, "job.json")).jobId;
    const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
    expect(r.errors[0]).toMatchObject({ code: "E_OUTPUT_INCOMPLETE" });
    expect(r.errors[0]?.message).toContain("link");
    expect(readdirSync(outside)).toEqual([]);

    prepareRunDir(p.root, p.inputs, "runs/r-outlink");
    const outDir = tmpDir("seed-nodal-out-");
    mkdirSync(join(p.root, "runs", "r-outlink", "native"), { recursive: true });
    symlinkSync(outDir, join(p.root, "runs", "r-outlink", "native", "out"), "junction");
    const started = okReply(await ask(p.root, runRequest(p.inputs, "req-outlink", "runs/r-outlink", p.settings)));
    if (started.ok) {
      await new Promise(res => setTimeout(res, 2000));
      expect(okReply(await ask(p.root, { verb: "status", jobId: started.result.jobId })).result.lifecycle).not.toBe("completed");
    }
    expect(readdirSync(outDir)).toEqual([]);
  }, 120000);
});
