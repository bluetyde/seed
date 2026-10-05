"use strict";
// SEED adapter for OpenMC Studio, transport "CLI per verb": the request is JSON on stdin, one seed.adapter-reply/0.1 JSON object goes to
// stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// Two parts of the OpenMC repository are used (docs/adapter-openmc.md in this repository):
//   studio/tools/regen_script.cjs   regenerates model.py from project.json with Studio's own page in SEED's Electron (nothing from the
//                                   project is executed); run refuses a model.py that differs from that regeneration
//   openmc_studio.headless          the runner (describe, validate, run, cancel); on Windows it runs inside a WSL distro
// Configuration comes from the host's environment, never from a project file or a request:
//   SEED_OPENMC_REPO         absolute path of the openmc-studio checkout (studio/ inside it holds the package and the tools)
//   SEED_ELECTRON            absolute path of an Electron binary (SEED's own)
//   SEED_OPENMC_PYTHON       Python that has OpenMC: a WSL path on Windows (e.g. /root/miniconda3/envs/openmc-mcnp/bin/python), else native
//   SEED_OPENMC_DATA         cross_sections.xml as the runtime sees it (the nuclear data identity is recorded with every run)
//   SEED_OPENMC_WSL_DISTRO   Windows only, default "Ubuntu"
//   SEED_OPENMC_ORACLES      optional absolute path of OpenMC's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client). Project files are not trusted: every path in a request is
// checked again here, state folders must be real folders inside the run folder, and a process is only killed after its command line shows it
// is this adapter's. Structure follows adapters/nodal; cancel follows adapters/feed (the app's runner stops the native run first).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const {
  BACKSLASH,
  MAX_CAPTURE,
  win,
  winDir,
  portableRel,
  commandLine,
  atomicWrite,
  json,
  readJson,
  insideRoot,
  containedBelow,
  findJob,
  snapshotProblem,
  appFailed,
  sha256,
  argvOf,
  typed,
  jobState,
} = require("../shared/util.cjs");
const { serve, startJob, statusJob, cancelJob } = require("../shared/flow.cjs");

const ADAPTER = { id: "openmc", version: "0.1.0" };
const MAX_QUANTITIES = 400;
const MAX_THREADS = 16;
const RUN_ID = "openmc";












// ---- configuration and launching -------------------------------------------------------------------------------------------------

/** A Windows drive path as WSL sees it (C:\a\b -> /mnt/c/a/b), or null (a UNC or relative path cannot be mapped). */
function toWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return "/mnt/" + m[1].toLowerCase() + "/" + m[2].split(BACKSLASH).join("/");
}

/** The configured parts, or {setup: message}. Nothing is installed or guessed. */
function config() {
  const repo = process.env.SEED_OPENMC_REPO;
  const electron = process.env.SEED_ELECTRON;
  const python = process.env.SEED_OPENMC_PYTHON;
  const data = process.env.SEED_OPENMC_DATA;
  if (!repo || !path.isAbsolute(repo)) return { setup: "set SEED_OPENMC_REPO to the absolute path of the openmc-studio checkout" };
  const regenScript = path.join(repo, "studio", "tools", "regen_script.cjs");
  const html = path.join(repo, "studio", "openmc_studio", "static", "index.html");
  try {
    if (!fs.statSync(regenScript).isFile() || !fs.statSync(html).isFile()) throw new Error("missing");
  } catch {
    return { setup: "SEED_OPENMC_REPO does not hold studio/tools/regen_script.cjs (an openmc-studio checkout with the SEED integration)" };
  }
  if (!electron || !path.isAbsolute(electron) || !fs.existsSync(electron)) return { setup: "set SEED_ELECTRON to the absolute path of SEED's Electron binary" };
  if (!python || !data) return { setup: "set SEED_OPENMC_PYTHON (Python with OpenMC, as the runtime sees it) and SEED_OPENMC_DATA (cross_sections.xml)" };
  const studioDir = path.join(repo, "studio");
  const cfg = { repo, electron, regenScript, html, python, data };
  if (win) {
    cfg.distro = process.env.SEED_OPENMC_WSL_DISTRO || "Ubuntu";
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(cfg.distro)) return { setup: "SEED_OPENMC_WSL_DISTRO is not a valid distro name" };
    cfg.studioRuntime = toWsl(studioDir);
    if (!cfg.studioRuntime || !python.startsWith("/") || !data.startsWith("/")) return { setup: "on Windows the repository must be on a drive letter and SEED_OPENMC_PYTHON / SEED_OPENMC_DATA must be WSL paths" };
  } else {
    cfg.studioRuntime = studioDir;
  }
  return cfg;
}

/** A project path as the runtime sees it. */
function rt(cfg, p) {
  if (!win) return p;
  const w = toWsl(p);
  if (!w) throw new Error("path cannot be mapped into WSL: " + p);
  return w;
}

/** The launch spec {command, args, env?} for one runner verb. WSL: wsl.exe --exec env VAR=... python -m openmc_studio.headless ... */
function launchSpec(cfg, verbArgs) {
  const vars = ["PYTHONPATH=" + cfg.studioRuntime, "PYTHONDONTWRITEBYTECODE=1", "PYTHONUTF8=1", "PYTHONIOENCODING=utf-8", "OPENMC_CROSS_SECTIONS=" + cfg.data];
  if (win) return { command: winDir() + "/System32/wsl.exe", args: ["-d", cfg.distro, "--cd", "/", "--exec", "/usr/bin/env", ...vars, cfg.python, "-m", "openmc_studio.headless", ...verbArgs] };
  const env = {};
  for (const v of vars) env[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
  return { command: cfg.python, args: ["-m", "openmc_studio.headless", ...verbArgs], env };
}

/** Run a spec to completion (bounded); stdout/stderr captured. */
function runSpec(spec, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { env: spec.env ? { ...process.env, ...spec.env } : process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve({ code: null, stdout: "", stderr: String(err && err.message), timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err.message), timedOut: false });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** The last line of stdout as JSON (WSL may print notices first), or null. */
function parseLast(text) {
  const lines = String(text).trim().split(String.fromCharCode(10));
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Regenerate model.py from a project file with Studio's own page. Returns {script, problems} or {error}. */
async function regenerate(cfg, projectAbs, outAbs) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // that variable would make Electron a plain Node and the page would never load
  const res = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.electron, [cfg.regenScript, projectAbs, outAbs, cfg.html], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve({ code: null, stdout: "", stderr: String(err && err.message) });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 90000);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr + String(err.message) }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const reply = parseLast(res.stdout);
  if (!reply || (res.code !== 0 && res.code !== 3) || reply.ok !== true) {
    return { error: typed("E_SETUP_REQUIRED", "", "the script regeneration could not run: " + ((reply && reply.error) || (res.stderr || "").slice(-200) || "exit " + res.code), "seed") };
  }
  return { problems: Array.isArray(reply.problems) ? reply.problems.map(String) : [], sha256: reply.sha256, chrome: reply.chrome };
}

/** First differing line of two scripts (line endings ignored), for the refusal message. */
function firstDifference(a, b) {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return "line " + (i + 1) + ": the script has " + JSON.stringify(String(x[i] === undefined ? "(nothing)" : x[i]).slice(0, 80)) + ", Studio generates " + JSON.stringify(String(y[i] === undefined ? "(nothing)" : y[i]).slice(0, 80));
  }
  return "the scripts differ";
}

const setupError = (message) => typed("E_SETUP_REQUIRED", "", "the OpenMC runner is not configured: " + message);


function mapProblems(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => {
    const code = e && typeof e.code === "string" ? e.code : "E_APP_FAILED";
    const known = ["E_UNSUPPORTED", "E_LIMIT", "E_SCHEMA_INVALID", "E_SETUP_REQUIRED", "E_EXISTS", "E_NOT_FOUND", "E_TIMEOUT"].includes(code);
    return typed(code === "E_LIMIT" ? "E_BOUNDS_EXCEEDED" : known ? code : "E_SCHEMA_INVALID", e && typeof e.path === "string" ? e.path : "", (known ? "" : code + ": ") + (e && e.message), "app-content");
  });
}

// ---- jobs ------------------------------------------------------------------------------------------------------------------------








/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_OPENMC_ORACLES;
  if (!dir || !path.isAbsolute(dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const e = readJson(path.join(dir, n));
    if (!e || e.schema !== "seed.oracle/0.1" || e.tag !== "good" || e.adapter !== ADAPTER.id || !e.coverage) continue;
    for (const q of Array.isArray(e.coverage.quantities) ? e.coverage.quantities : []) {
      const key = q + "|" + e.coverage.domain;
      if (typeof q === "string" && typeof e.coverage.domain === "string" && !seen.has(key)) {
        seen.add(key);
        out.push({ quantity: q, domain: e.coverage.domain.slice(0, 500) });
      }
    }
  }
  return out;
}

async function describe(reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const res = await runSpec(launchSpec(cfg, ["describe"]), 120000);
  const d = parseLast(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true || d.format !== "openmc-studio-headless-run") return fail(appFailed("the OpenMC runner could not describe itself", res));
  if (!d.openmc) return fail(setupError("openmc is not importable in the configured Python"));
  const warnings = [];
  if (!d.nuclearData || !d.nuclearData.sha256) warnings.push(typed("W_DATA_MISSING", "", "the nuclear data file was not found: run will be refused", "seed"));
  reply({
    ok: true,
    warnings,
    result: {
      app: { id: "openmc-studio", name: "OpenMC Studio", version: String(d.version) },
      engine: { name: "OpenMC", version: String(d.openmc) },
      formats: [{ id: "openmc-studio-project", version: "1" }],
      capabilities: ["validate", "run", "cancel", "collect", "fixed-source"],
      parameters: [{ id: "threads", type: "integer", min: 1, max: MAX_THREADS }],
      // Tally results are per source particle; the unit follows the score (see scoreUnit).
      quantities: [
        { name: "tally:flux", unit: "cm", normalization: "per-source-particle" },
        { name: "tally:reaction", unit: "reaction", normalization: "per-source-particle" },
        { name: "tally:energy", unit: "eV", normalization: "per-source-particle" },
      ],
      oracleCoverage: oracleCoverage(),
    },
  });
}

/** The unit of a tally score per source particle, or null when the adapter does not know it (then collect refuses instead of guessing). */
function scoreUnit(score) {
  if (typeof score !== "string") return null;
  if (score === "flux") return "cm";
  if (score === "current") return "particle";
  if (score === "events") return "event";
  if (score === "nu-fission") return "neutron";
  if (["heating", "heating-local", "kappa-fission", "fission-q-prompt", "fission-q-recoverable", "damage-energy"].includes(score)) return "eV";
  if (["absorption", "scatter", "total", "elastic", "inelastic", "fission"].includes(score) || /^\(n,[^)]+\)$/.test(score)) return "reaction";
  return null;
}

async function validate(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the project path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the project file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the project file does not match the revision named in the request"));
  }
  // The runner's checks (first-slice limits, tallies, setup) on the project. Nothing is executed.
  let projectRt;
  try {
    projectRt = rt(cfg, art.abs);
  } catch (err) {
    return fail(typed("E_PATH_UNMAPPABLE", "", err.message));
  }
  const res = await runSpec(launchSpec(cfg, ["validate", projectRt]), 120000);
  const out = parseLast(res.stdout);
  if (!out || (res.code !== 0 && res.code !== 1)) return fail(appFailed("the OpenMC runner could not validate the project", res));
  problems.push(...mapProblems(out.problems), ...mapProblems(out.setup));
  // The page's own generator must accept the project (error-level Studio problems are refused exactly as the Run button does).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-openmc-regen-"));
  try {
    const regen = await regenerate(cfg, art.abs, path.join(tmp, "model.py"));
    if (regen.error) return fail(regen.error);
    for (const p of regen.problems.slice(0, 20)) problems.push(typed("E_SCHEMA_INVALID", "", "Studio problem: " + p, "app-content"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

async function run(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const found = insideRoot(root, request.runDir);
  if (found.escaped) return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the run folder leaves the project"));
  if (found.missing) return fail(typed("E_NOT_FOUND", "/runDir", "the run folder does not exist; the host creates it with the input snapshot first"));
  const absRunDir = found.abs;
  const inputs = Array.isArray(request.snapshot && request.snapshot.inputs) ? request.snapshot.inputs : [];
  if (inputs.length === 0) return fail(typed("E_PROP_MISSING", "/snapshot/inputs", "the snapshot has no inputs"));
  for (let i = 0; i < inputs.length; i++) {
    if (!portableRel(inputs[i] && inputs[i].path)) return fail(typed("E_PATH_INVALID", "/snapshot/inputs/" + i + "/path", "input paths must be portable relative paths"));
  }

  const settings = request.settings || {};
  const unknown = Object.keys(settings).find((k) => !["project", "model", "threads"].includes(k));
  if (unknown !== undefined) return fail(typed("E_UNSUPPORTED", "/settings/" + unknown, "unknown setting; this adapter takes project, model and threads"));
  const need = (key) => {
    if (typeof settings[key] !== "string" || !inputs.some((i) => i.path === settings[key])) return null;
    return settings[key];
  };
  const projectPath = need("project");
  const modelPath = need("model");
  if (!projectPath) return fail(typed("E_PROP_MISSING", "/settings/project", "settings.project must name the project file (one of the snapshot inputs)"));
  if (!modelPath) return fail(typed("E_PROP_MISSING", "/settings/model", "settings.model must name the model.py (one of the snapshot inputs)"));
  const threads = settings.threads === undefined ? 1 : settings.threads;
  const budget = request.budget || {};
  if (!Number.isInteger(threads) || threads < 1 || threads > MAX_THREADS) return fail(typed("E_BOUNDS_EXCEEDED", "/settings/threads", "threads must be a whole number from 1 to " + MAX_THREADS));
  if (Number.isInteger(budget.maxCores) && threads > budget.maxCores) return fail(typed("E_BOUNDS_EXCEEDED", "/settings/threads", "threads " + threads + " is over the budget of " + budget.maxCores + " cores"));
  const timeoutSeconds = Math.min(Number.isInteger(budget.maxWallSeconds) ? budget.maxWallSeconds : 3600, 86400);

  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const projectAbs = path.join(absRunDir, "inputs", projectPath);
  const modelAbs = path.join(absRunDir, "inputs", modelPath);
  const project = readJson(projectAbs);
  if (!project) return fail(typed("E_APP_FAILED", "/settings/project", "the snapshot copy of the project is not JSON"));
  // The seed is part of the project (it is hashed with it). A request may state it, and then it must be the project's own: another seed would be
  // another project revision, not a different run of this one.
  if (request.seed !== undefined && !(project.settings && project.settings.seed === request.seed)) {
    return fail(typed("E_REQUEST_CONFLICT", "/seed", "the request seed differs from the seed in the project; change the project instead"));
  }

  // The script must be exactly what Studio's generator makes of the project: nothing else is run.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "seed-openmc-regen-"));
  let regen;
  try {
    regen = await regenerate(cfg, projectAbs, path.join(scratch, "model.py"));
    if (regen.error) return fail(regen.error);
    if (regen.problems.length > 0) return fail(...regen.problems.slice(0, 10).map((p) => typed("E_SCHEMA_INVALID", "/settings/project", "Studio problem: " + p, "app-content")));
    const generated = fs.readFileSync(path.join(scratch, "model.py"), "utf8");
    const given = fs.readFileSync(modelAbs, "utf8");
    if (generated.replace(/\r\n/g, "\n") !== given.replace(/\r\n/g, "\n")) {
      return fail(typed("E_STALE_REVISION", "/settings/model", "the model script is not what Studio generates for this project (SCRIPT_MISMATCH): " + firstDifference(given, generated)));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // The runner's own refusals (first-slice limits, missing data) before anything is reserved.
  let projectRt;
  let outRt;
  try {
    projectRt = rt(cfg, projectAbs);
    outRt = rt(cfg, path.join(absRunDir, "native", "out"));
  } catch (err) {
    return fail(typed("E_PATH_UNMAPPABLE", "", err.message));
  }
  const pre = await runSpec(launchSpec(cfg, ["validate", projectRt]), 120000);
  const preOut = parseLast(pre.stdout);
  if (!preOut || (pre.code !== 0 && pre.code !== 1)) return fail(appFailed("the OpenMC runner could not check the project", pre));
  const refusals = [...mapProblems(preOut.problems), ...mapProblems(preOut.setup)].filter((p) => p.code.startsWith("E_"));
  if (refusals.length > 0) return fail(...refusals);

  const runArgs = ["run", rt(cfg, modelAbs), projectRt, "--out", outRt, "--run-id", RUN_ID, "--timeout", String(timeoutSeconds), "--threads", String(threads)];
  return startJob({
    root, request, absRunDir, reply, fail,
    record: {
      project: projectPath, model: modelPath, threads,
      scriptSha256: regen.sha256, generator: { name: "studio-page", chromium: regen.chrome },
      inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    },
    runSpec: launchSpec(cfg, runArgs),
    cancelSpec: launchSpec(cfg, ["cancel", outRt + "/" + RUN_ID]),
    stopNative: () => stopNative(cfg, path.join(absRunDir, "native")),
  });
}

function status(request, root, reply, fail) {
  return statusJob({ request, root, reply, fail });
}



/** A launcher process (wsl.exe or python) left behind by a dead wrapper: ours only when its command line runs the headless runner on this
 *  run folder's own output folder (as the runtime sees it). */
function ownsRunner(cfg, j, pid) {
  const cl = commandLine(pid);
  if (cl === null) return false;
  const args = argvOf(cl);
  let out;
  try {
    out = rt(cfg, path.join(j.absRunDir, "native", "out"));
  } catch {
    return false;
  }
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  return args.includes("openmc_studio.headless") && args.includes("run") && args.some((a) => same(a, out));
}

/** Ask the runner to cancel this job's native run. {confirmed, stoppedOne, notOwned}: confirmed when nothing of this run is left running in
 *  the runtime; stoppedOne when a running child was found and stopped. The folder is this job's own, never taken from the request. */
async function stopNative(cfg, nativeDir) {
  let target;
  try {
    target = rt(cfg, path.join(nativeDir, "out")) + "/" + RUN_ID;
  } catch {
    return { confirmed: false, stoppedOne: false };
  }
  const res = await runSpec(launchSpec(cfg, ["cancel", target]), 60000);
  const out = parseLast(res.stdout);
  if (!out) return { confirmed: false, stoppedOne: false };
  if (out.ok === true) return { confirmed: out.stopped === true || out.cancelled === true || out.status !== "running", stoppedOne: out.cancelled === true };
  const code = out.errors && out.errors[0] && out.errors[0].code;
  if (code === "E_NOT_FOUND") return { confirmed: true, stoppedOne: false }; // no run registered there (yet)
  if (code === "E_NOT_OWNED") return { confirmed: false, stoppedOne: false, notOwned: true };
  return { confirmed: false, stoppedOne: false };
}

async function cancel(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  return cancelJob({ request, root, reply, fail, stopNative: (j) => stopNative(cfg, j.nativeDir), ownsRunner: (j, pid) => ownsRunner(cfg, j, pid) });
}

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function collect(request, root, reply, fail) {
  const incomplete = (message, field = "") => fail(typed("E_OUTPUT_INCOMPLETE", field, message));
  const found = insideRoot(root, request.runDir);
  if (found.escaped || found.missing) return incomplete("the run folder is not available");
  // The job named in the request must be the one registered for this run folder.
  const j = findJob(root, request.jobId);
  if (!j || j.absRunDir !== found.abs) return incomplete("the job is not registered for this run folder");
  const nativeDir = j.nativeDir;
  const job = j.job;
  const s = jobState(nativeDir, job);
  if (s.lifecycle !== "completed") return incomplete("job is not completed");

  const snapshotIssue = snapshotProblem(found.abs, job.inputs);
  if (snapshotIssue) return incomplete("the snapshot changed after the run was registered: " + snapshotIssue);
  const outDir = path.join(nativeDir, "out", RUN_ID);
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "openmc-studio-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the OpenMC run folder has no completed manifest");
  }
  const byPath = new Map();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== "string" || !portableRel(f.path) || f.path.includes("/") || byPath.has(f.path)) return incomplete("the manifest lists a bad or repeated file name");
    let bytes;
    try {
      if (!containedBelow(found.abs, path.join(outDir, f.path))) return incomplete(f.path + " resolves outside the run folder");
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
    byPath.set(f.path, f);
  }
  for (const need of ["model.py", "project.json", "results.json", "provenance.json"]) if (!byPath.has(need)) return incomplete("the manifest does not list " + need);
  const statepoints = [...byPath.keys()].filter((n) => /^statepoint\.\d+\.h5$/.test(n));
  if (statepoints.length !== 1) return incomplete("the run must have exactly one statepoint file");
  // The run used exactly the snapshot's script and project.
  const sha = (name) => (job.inputs.find((i) => i.path === name) || {}).sha256;
  if (byPath.get("model.py").sha256 !== sha(job.model) || byPath.get("project.json").sha256 !== sha(job.project)) return incomplete("the run did not use the snapshot's model script and project");

  const results = readJson(path.join(outDir, "results.json"));
  const project = readJson(path.join(found.abs, "inputs", job.project));
  if (!results || !results.summary || !Array.isArray(results.tallies) || !project || !project.settings) return incomplete("results.json is not a result of this project");
  const sm = results.summary;
  const st = project.settings;
  if (sm.run_mode !== "fixed source" || sm.particles !== st.particles || sm.batches !== st.batches || sm.seed !== st.seed) {
    return incomplete("the statepoint does not match the project's run mode, particles, batches and seed");
  }
  if (results.tallies.length === 0) return incomplete("the run has no tallies");
  const prov = readJson(path.join(outDir, "provenance.json"));
  const env = prov && prov.environment ? prov.environment : {};

  const dirName = "quantities";
  const qDir = path.join(nativeDir, dirName);
  try {
    fs.mkdirSync(qDir, { recursive: true });
    if (fs.lstatSync(qDir).isSymbolicLink() || !containedBelow(found.abs, qDir)) return incomplete("the quantities folder is a link or leaves the run folder");
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "cannot prepare the quantities folder: " + (err && err.code ? err.code : err)));
  }
  const names = new Set();
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  const warnings = [];
  let k = 0;
  for (const t of results.tallies) {
    if (!t || t.kind !== "table" || !Array.isArray(t.rows) || !Array.isArray(t.scores)) return fail(typed("E_UNSUPPORTED", "", "tally " + JSON.stringify(String(t && t.name).slice(0, 60)) + " is not a table tally (mesh and dose tallies are not supported in this adapter version)"));
    for (const score of t.scores) {
      const unit = scoreUnit(score);
      if (!unit) return fail(typed("E_UNSUPPORTED", "", "the score " + JSON.stringify(String(score).slice(0, 40)) + " has no unit mapping in this adapter version"));
      const rows = t.rows.filter((r) => r && r.score === score);
      if (rows.length === 0 || rows.some((r) => !finite(r.mean) || !finite(r.std) || !Array.isArray(r.labels))) return incomplete("tally " + JSON.stringify(String(t.name).slice(0, 60)) + " has missing or non-finite values for " + score);
      const name = (String(t.name || "tally") + ":" + score).slice(0, 80);
      if (names.has(name)) return incomplete("two tally results are named " + name);
      names.add(name);
      if (quantities.length >= MAX_QUANTITIES) return incomplete("too many quantities");
      const body = { quantity: name, tally: t.name, score, unit, normalization: "per-source-particle", filters: t.filters, bins: rows.map((r) => ({ labels: r.labels, mean: r.mean, std: r.std })) };
      const text = json(body);
      const fileName = String(k++).padStart(3, "0") + ".json";
      atomicWrite(path.join(qDir, fileName), text);
      quantities.push({
        name,
        unit,
        normalization: "per-source-particle",
        provenance: { runId, inputRevisions },
        data: { path: request.runDir + "/native/" + dirName + "/" + fileName, sha256: sha256(text) },
        verification: "unverified",
        coordinates: { system: "tally-bins", axes: [{ name: "bin", unit: "1" }] },
        ...(rows.length === 1 ? { uncertainty: { kind: "statistical", value: rows[0].std, unit } } : {}),
      });
    }
  }
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: "OpenMC", version: String(env.openmc && env.openmc.python ? env.openmc.python : "unknown") },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "OpenMC fixed-source run: " + sm.batches + " batches of " + sm.particles + " particles, seed " + sm.seed },
    quantities,
    extensions: {
      openmc: {
        runnerResultsSha256: byPath.get("results.json").sha256,
        statepoint: { path: statepoints[0], sha256: byPath.get(statepoints[0]).sha256 },
        threads: job.threads,
        scriptSha256: job.scriptSha256,
        generator: job.generator,
        nuclearData: env.nuclear_data,
        runtime: { platform: env.platform, python: env.python, openmc: env.openmc },
        normalization: "per source particle; a physical rate needs an explicit source strength",
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, warnings, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

serve({ describe: (_request, _root, reply, fail) => describe(reply, fail), validate, run, status, cancel, collect }, "OpenMC Studio's editor is its web app; this headless adapter does not open it");
