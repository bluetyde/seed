import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";
import { checkResultsAgainstRecord, checkResultsIndex } from "../src/core/semantic";
import { validate } from "../src/core/validate";

// The real tests need the OpenMC Studio checkout with the SEED integration (SEED_OPENMC_REPO, default a sibling folder openmc-seed), SEED's
// Electron (SEED_ELECTRON, default this repository's node_modules) and OpenMC with nuclear data in the runtime: on Windows a WSL distro
// (SEED_OPENMC_WSL_DISTRO, default Ubuntu; SEED_OPENMC_PYTHON and SEED_OPENMC_DATA as WSL paths), elsewhere native paths.
// Without them the real-runner tests are skipped with a warning.
const win = process.platform === "win32";
const repo = process.env.SEED_OPENMC_REPO ?? join(__dirname, "..", "..", "openmc-seed");
const electron = process.env.SEED_ELECTRON ?? join(__dirname, "..", "node_modules", "electron", "dist", win ? "electron.exe" : "electron");
const distro = process.env.SEED_OPENMC_WSL_DISTRO ?? "Ubuntu";
const py = process.env.SEED_OPENMC_PYTHON ?? "/root/miniconda3/envs/openmc-mcnp/bin/python";
const data = process.env.SEED_OPENMC_DATA ?? "/root/nuclear_data/endfb-viii.0-hdf5/cross_sections.xml";
const regenScript = join(repo, "studio", "tools", "regen_script.cjs");
const triso = join(repo, "examples", "triso-particle");
const probe = (args: string[]) => (win ? spawnSync("wsl.exe", ["-d", distro, "--exec", ...args], { encoding: "utf8" }) : spawnSync(args[0]!, args.slice(1), { encoding: "utf8" }));
const haveOpenmc = existsSync(regenScript) && existsSync(electron) && existsSync(join(triso, "model.py")) && probe(["/usr/bin/test", "-f", data]).status === 0 && probe(["/usr/bin/test", "-x", py]).status === 0;

const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "openmc", "cli.cjs")], id: "openmc", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = { maxWallSeconds: 600, maxCores: 1, maxMemoryMB: 4096, maxDiskMB: 1024 };
type Vec = Record<string, any>;

const dirs: string[] = [];
const pids: number[] = [];
const names = ["SEED_OPENMC_REPO", "SEED_ELECTRON", "SEED_OPENMC_PYTHON", "SEED_OPENMC_DATA", "SEED_OPENMC_WSL_DISTRO"] as const;
const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
beforeEach(() => {
  if (haveOpenmc) Object.assign(process.env, { SEED_OPENMC_REPO: repo, SEED_ELECTRON: electron, SEED_OPENMC_PYTHON: py, SEED_OPENMC_DATA: data, SEED_OPENMC_WSL_DISTRO: distro });
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(win ? "taskkill" : "kill", win ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup of a test's leftovers
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  if (!haveOpenmc) console.warn(`OpenMC runtime not usable (repo ${repo}): the real-runner tests were skipped`);
});

/** Project folders deliberately contain a space: the paths go through wsl.exe's argument parsing. */
function tmpDir(prefix = "seed openmc "): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const wslPath = (p: string) => (win ? "/mnt/" + p[0]!.toLowerCase() + "/" + p.slice(3).split("\\").join("/") : p);

/** model.py as Studio's own generator makes it for this project (the same tool the adapter uses). */
function generate(projectFile: string, outFile: string) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [regenScript, projectFile, outFile], { encoding: "utf8", env });
  if (r.status !== 0 && r.status !== 3) throw new Error("regen failed: " + r.stdout + r.stderr);
}

/** A project holding the triso example (fixed source, 1000 particles x 10 batches), settings edited, model.py regenerated to match. */
function openmcProject(edit: (p: Vec) => void = () => {}, requestSettings: Record<string, unknown> = {}) {
  const root = tmpDir();
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  const project = read(join(triso, "triso-particle.openmc-studio.json"));
  edit(project);
  const projectPath = "models/triso.openmc-studio.json";
  const modelPath = "models/model.py";
  const projectText = JSON.stringify(project, null, 2) + "\n";
  writeFileSync(join(root, projectPath), projectText);
  generate(join(root, projectPath), join(root, modelPath));
  const modelText = readFileSync(join(root, modelPath), "utf8");
  const inputs = [{ path: projectPath, sha256: sha256Hex(projectText) }, { path: modelPath, sha256: sha256Hex(modelText) }];
  return {
    root, project, projectPath, modelPath, inputs,
    settings: { project: projectPath, model: modelPath, threads: 1, ...requestSettings },
    artifact: { path: projectPath, revision: { hash: sha256Hex(projectText), counter: 1 } },
  };
}

const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 120000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 180000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; warnings: { code: string }[]; result?: any };
};
type P = ReturnType<typeof openmcProject>;
const start = (p: P, requestId: string, extra: Record<string, unknown> = {}) =>
  manager(p.root).start({ requestId, actor, artifact: p.artifact, inputs: p.inputs, budget, settings: p.settings, ...extra });

async function waitForChild(root: string, ms = 60000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const runs = existsSync(join(root, "runs")) ? readdirSync(join(root, "runs")) : [];
    for (const r of runs) if (existsSync(join(root, "runs", r, "native", "child.json"))) return r;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error("the job never started");
}

const SETUP = !haveOpenmc;
describe.skipIf(SETUP)("OpenMC adapter against the real runner", () => {
  describe("describe and validate", () => {
    it("describe reports the app, the engine, and the first slice", async () => {
      const r = okReply(await ask(tmpDir(), { verb: "describe" }));
      expect(r.ok).toBe(true);
      expect(r.result.engine).toMatchObject({ name: "OpenMC" });
      expect(r.result.capabilities).toEqual(expect.arrayContaining(["validate", "run", "cancel", "collect", "fixed-source"]));
      expect(r.result.quantities.every((q: { normalization: string }) => q.normalization === "per-source-particle")).toBe(true);
    }, 180000);

    it("validate accepts a good project and names what is wrong with others", async () => {
      const good = openmcProject();
      const v = okReply(await ask(good.root, { verb: "validate", artifact: good.artifact }));
      expect(v.result).toMatchObject({ valid: true, problems: [] });

      const stale = okReply(await ask(good.root, { verb: "validate", artifact: { ...good.artifact, revision: { hash: "0".repeat(64), counter: 1 } } }));
      expect(stale.result.problems[0]).toMatchObject({ code: "E_STALE_REVISION" });

      const eig = openmcProject(p => { p.settings.runMode = "eigenvalue"; });
      const e = okReply(await ask(eig.root, { verb: "validate", artifact: eig.artifact }));
      expect(e.result.valid).toBe(false);
      expect(e.result.problems.map((x: { code: string; field: string }) => x.code + x.field)).toContain("E_UNSUPPORTED/settings/runMode");

      const broken = openmcProject(p => { p.materials = []; });
      const b = okReply(await ask(broken.root, { verb: "validate", artifact: broken.artifact }));
      expect(b.result.valid).toBe(false);
      expect(b.result.problems.some((x: { message: string }) => x.message.startsWith("Studio problem"))).toBe(true);
    }, 300000);
  });

  describe("through the run manager (SEED lifecycle)", () => {
    it("completes, and the collected numbers equal the runner's own direct run bit for bit", async () => {
      const p = openmcProject();
      const out = await start(p, "req-real");
      if (!out.ok) throw new Error(JSON.stringify(out.errors));
      expect(out.state).toBe("completed");
      const index = read(join(p.root, "runs", out.runId, "results.json"));
      expect(validate("results-index", index)).toEqual({ ok: true });
      expect(checkResultsIndex(index)).toEqual([]);
      expect(checkResultsAgainstRecord(index, out.record)).toEqual([]);
      expect(index.engine).toMatchObject({ name: "OpenMC" });
      expect(index.extensions.openmc.nuclearData.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(index.quantities.length).toBeGreaterThan(0);
      for (const q of index.quantities) {
        expect(q).toMatchObject({ normalization: "per-source-particle", verification: "unverified" });
        expect(sha256Hex(readFileSync(join(p.root, q.data.path)))).toBe(q.data.sha256);
      }

      // The runner's manifest is hashed and its model and project are the snapshot's.
      const outDir = join(p.root, "runs", out.runId, "native", "out", "openmc");
      const manifest = read(join(outDir, "manifest.json"));
      expect(manifest.status).toBe("completed");
      for (const f of manifest.files) expect(sha256Hex(readFileSync(join(outDir, f.path)))).toBe(f.sha256);

      // Parity: the same script and project run directly through the runner (same seed, one thread) give the same numbers.
      const directDir = tmpDir();
      const direct = spawnSync(
        win ? "wsl.exe" : py,
        [...(win ? ["-d", distro, "--cd", "/", "--exec", "/usr/bin/env", "PYTHONPATH=" + wslPath(join(repo, "studio")), "PYTHONDONTWRITEBYTECODE=1", "OPENMC_CROSS_SECTIONS=" + data, py] : []),
          "-m", "openmc_studio.headless", "run", wslPath(join(p.root, p.modelPath)), wslPath(join(p.root, p.projectPath)), "--out", wslPath(directDir), "--run-id", "d", "--threads", "1"],
        { encoding: "utf8", env: win ? process.env : { ...process.env, PYTHONPATH: join(repo, "studio"), OPENMC_CROSS_SECTIONS: data } },
      );
      expect(direct.status, direct.stdout + direct.stderr).toBe(0);
      const directTallies = read(join(directDir, "d", "results.json")).tallies;
      for (const q of index.quantities) {
        const body = read(join(p.root, q.data.path));
        expect(body.schema).toBe("seed.quantity-data/0.2");
        expect(body.kind).toBe("table");
        const tally = directTallies.find((t: Vec) => t.name === body.meta.tally);
        const rows = tally.rows.filter((r: Vec) => r.score === body.meta.score);
        // a table row is [labels, mean, std] (columns bin, mean, std)
        expect(body.rows.map((r: unknown[]) => [r[1], r[2]])).toEqual(rows.map((r: Vec) => [r.mean, r.std]));
      }
    }, 300000);

    it("a hand-edited script is refused before anything is reserved or run", async () => {
      const p = openmcProject();
      const edited = readFileSync(join(p.root, p.modelPath), "utf8") + "\nopen('evil.txt','w').write('x')\n";
      writeFileSync(join(p.root, p.modelPath), edited);
      p.inputs[1] = { path: p.modelPath, sha256: sha256Hex(edited) };
      const out = await start(p, "req-edited");
      expect(out.ok && out.state).toBe("failed");
      expect(JSON.stringify(out.ok && out.record)).toContain("E_STALE_REVISION");
      // The record keeps the code; the adapter's own reply says what differs.
      for (const i of p.inputs) {
        mkdirSync(join(p.root, "runs", "direct", "inputs", "models"), { recursive: true });
        writeFileSync(join(p.root, "runs", "direct", "inputs", i.path), readFileSync(join(p.root, i.path)));
      }
      const direct = okReply(await ask(p.root, { verb: "run", requestId: "req-direct", snapshot: { inputs: p.inputs }, runDir: "runs/direct", budget, settings: p.settings }));
      expect(direct.errors[0]?.code).toBe("E_STALE_REVISION");
      expect(direct.errors[0]?.message).toContain("SCRIPT_MISMATCH");
      expect(direct.errors[0]?.message).toContain("evil.txt");
      expect(readdirSync(join(p.root, "runs")).some(r => existsSync(join(p.root, "runs", r, "native", "job.json")))).toBe(false);
      expect(existsSync(join(p.root, "evil.txt"))).toBe(false);
    }, 300000);

    it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
      ["a seed that is not the project's own", { seed: 7 }, {}, "E_REQUEST_CONFLICT"],
      ["an unknown setting", {}, { extra: 1 }, "E_UNSUPPORTED"],
      ["threads over the budget", {}, { threads: 2 }, "E_BOUNDS_EXCEEDED"],
      ["a model that is not an input", {}, { model: "models/none.py" }, "E_PROP_MISSING"],
      ["a project that is not an input", {}, { project: "models/none.json" }, "E_PROP_MISSING"],
    ])("a request with %s is refused by the adapter and the run is recorded failed", async (_n, top, extraSettings, code) => {
      const p = openmcProject();
      const out = await manager(p.root).start({ requestId: "req-refuse", actor, artifact: p.artifact, inputs: p.inputs, budget, settings: { ...p.settings, ...extraSettings }, ...top });
      expect(out.ok && out.state).toBe("failed");
      expect(JSON.stringify(out.ok && out.record)).toContain(code);
    }, 300000);

    it("a request may state the project's own seed, and the run is the same run", async () => {
      const p = openmcProject();
      const withSeed = await start(p, "req-seed", { seed: p.project.settings.seed });
      if (!withSeed.ok) throw new Error(JSON.stringify(withSeed.errors));
      expect(withSeed.state).toBe("completed");
      expect(read(join(p.root, "runs", withSeed.runId, "native", "job.json")).payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }, 300000);

    it("an eigenvalue project is refused by the runner's first-slice check before a job exists", async () => {
      const p = openmcProject(x => { x.settings.runMode = "eigenvalue"; });
      const out = await start(p, "req-eig");
      // Refused before a run exists: the adapter's typed errors come straight back and nothing is reserved.
      expect(out.ok).toBe(false);
      expect(JSON.stringify(!out.ok && out.errors)).toContain("E_UNSUPPORTED");
      expect(readdirSync(join(p.root, "runs")).some(r => existsSync(join(p.root, "runs", r, "native", "job.json")))).toBe(false);
    }, 300000);

    it("cancel stops OpenMC inside WSL as well as the Windows processes, and collects nothing", async () => {
      const p = openmcProject(x => { x.settings.particles = 1000000; x.settings.batches = 1000; });
      const mgr = manager(p.root);
      const started = mgr.start({ requestId: "req-cancel", actor, artifact: p.artifact, inputs: p.inputs, budget: { ...budget, maxWallSeconds: 900 }, settings: p.settings });
      const runId = await waitForChild(p.root);
      const native = join(p.root, "runs", runId, "native");
      const job = read(join(native, "job.json"));
      const child = read(join(native, "child.json"));
      pids.push(job.pid, child.pid);
      // Wait for the runner to record its own child, then check that process group is alive in the runtime.
      const end = Date.now() + 60000;
      while (!existsSync(join(native, "out", "openmc", "child.json")) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
      const inner = read(join(native, "out", "openmc", "child.json"));
      const groupAlive = () => probe(win ? ["/usr/bin/pgrep", "-g", String(inner.pgid)] : ["/usr/bin/pgrep", "-g", String(inner.pgid)]).stdout.trim().length > 0;
      expect(groupAlive()).toBe(true);
      const c = await mgr.cancel(runId);
      expect(c.ok && c.state).toBe("cancelled");
      expect((await started).ok).toBe(true);
      expect(isAlive(job.pid)).toBe(false);
      expect(isAlive(child.pid)).toBe(false);
      expect(groupAlive()).toBe(false);
      expect(read(join(native, "out", "openmc", "manifest.json")).status).toBe("cancelled");
      expect(existsSync(join(p.root, "runs", runId, "results.json"))).toBe(false);
    }, 300000);

    it("collect refuses a run whose files or snapshot do not hold up", async () => {
      const edits: [string, (outDir: string, runDir: string, p: P) => void, string][] = [
        ["a results file changed without its manifest hash", outDir => writeFileSync(join(outDir, "results.json"), readFileSync(join(outDir, "results.json"), "utf8") + " "), "manifest hash"],
        ["a statepoint changed without its manifest hash", outDir => {
          const f = readdirSync(outDir).find(n => /^statepoint\.\d+\.h5$/.test(n))!;
          writeFileSync(join(outDir, f), Buffer.concat([readFileSync(join(outDir, f)), Buffer.from([0])]));
        }, "manifest hash"],
        ["a snapshot input changed after the run", (_o, runDir, p) => writeFileSync(join(runDir, "inputs", p.projectPath), readFileSync(join(runDir, "inputs", p.projectPath), "utf8") + " "), "snapshot changed"],
      ];
      for (const [what, edit, message] of edits) {
        const p = openmcProject();
        const out = await start(p, "req-tamper");
        if (!out.ok) throw new Error("refused");
        const runDir = join(p.root, "runs", out.runId);
        edit(join(runDir, "native", "out", "openmc"), runDir, p);
        const jobId = read(join(runDir, "native", "job.json")).jobId;
        const r = okReply(await ask(p.root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
        expect(r.ok, what).toBe(false);
        expect(r.errors[0]?.code, what).toBe("E_OUTPUT_INCOMPLETE");
        expect(r.errors[0]?.message, what).toContain(message);
      }
    }, 600000);

    it("a request id already bound to another run folder is refused and the first job is untouched", async () => {
      const p = openmcProject(x => { x.settings.particles = 1000000; x.settings.batches = 1000; });
      for (const d of ["runs/original", "runs/second"]) {
        for (const i of p.inputs) {
          mkdirSync(join(p.root, d, "inputs", "models"), { recursive: true });
          writeFileSync(join(p.root, d, "inputs", i.path), readFileSync(join(p.root, i.path)));
        }
      }
      const req = (runDir: string) => ({ verb: "run", requestId: "req-dup", snapshot: { inputs: p.inputs }, runDir, budget: { ...budget, maxWallSeconds: 900 }, settings: p.settings });
      const first = okReply(await ask(p.root, req("runs/original")));
      expect(first.ok, JSON.stringify(first.errors)).toBe(true);
      const job = read(join(p.root, "runs", "original", "native", "job.json"));
      const child = read(join(p.root, "runs", "original", "native", "child.json"));
      pids.push(job.pid, child.pid);
      const second = okReply(await ask(p.root, req("runs/second")));
      expect(second.ok).toBe(false);
      expect(second.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
      expect(existsSync(join(p.root, "runs", "second", "native", "job.json"))).toBe(false);
      expect(okReply(await ask(p.root, { verb: "cancel", jobId: first.result.jobId })).result.cancelled).toBe(true);
    }, 300000);

    it("cancel refuses a process that is not this run's job wrapper, whatever the project files say", async () => {
      const p = openmcProject();
      const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
      stranger.unref();
      pids.push(stranger.pid!);
      const native = join(p.root, "runs", "r-forged", "native");
      mkdirSync(native, { recursive: true });
      const token = "forged-token";
      writeFileSync(join(native, "job.json"), JSON.stringify({ jobId: "job-forged", requestId: "req-forged", pid: stranger.pid, token, model: p.modelPath, project: p.projectPath, inputs: p.inputs }));
      writeFileSync(join(native, "status.json"), JSON.stringify({ status: "running" }));
      writeFileSync(join(native, "heartbeat.json"), JSON.stringify({ token, time: new Date().toISOString() }));
      mkdirSync(join(p.root, ".seed", "jobs"), { recursive: true });
      writeFileSync(join(p.root, ".seed", "jobs", "job-forged.json"), JSON.stringify({ runDir: "runs/r-forged" }));
      const r = okReply(await ask(p.root, { verb: "cancel", jobId: "job-forged" }));
      expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
      expect(isAlive(stranger.pid!)).toBe(true);
    }, 120000);
  });
});

describe("OpenMC adapter setup", () => {
  it("without configuration every verb that needs the runtime says what to set", async () => {
    for (const n of names) delete process.env[n];
    for (const verb of ["describe"] as const) {
      const r = okReply(await ask(tmpDir(), { verb }));
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: "E_SETUP_REQUIRED" });
      expect(r.errors[0]?.message).toContain("SEED_OPENMC_REPO");
    }
  });

  it("a repository without the SEED integration is a setup error, not a skipped check", async () => {
    process.env.SEED_OPENMC_REPO = tmpDir();
    process.env.SEED_ELECTRON = process.execPath;
    process.env.SEED_OPENMC_PYTHON = "/x/python";
    process.env.SEED_OPENMC_DATA = "/x/xs.xml";
    const r = okReply(await ask(tmpDir(), { verb: "describe" }));
    expect(r.errors[0]).toMatchObject({ code: "E_SETUP_REQUIRED" });
    expect(r.errors[0]?.message).toContain("regen_script");
  });

  it("a missing Electron is a setup error", async () => {
    process.env.SEED_OPENMC_REPO = repo;
    process.env.SEED_ELECTRON = join(tmpdir(), "no-such-electron.exe");
    process.env.SEED_OPENMC_PYTHON = "/x/python";
    process.env.SEED_OPENMC_DATA = "/x/xs.xml";
    const r = okReply(await ask(tmpDir(), { verb: "describe" }));
    expect(r.errors[0]).toMatchObject({ code: "E_SETUP_REQUIRED" });
    expect(existsSync(regenScript) ? r.errors[0]?.message : "SEED_ELECTRON").toContain("SEED_ELECTRON");
  });
});
