"use strict";
// SEED adapter for Fuel Performance Studio (FEED), transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps FEED's headless runner (dist/cli/headless.js, built by `npm run build` in the FEED repo). The runner's location
// comes from the environment of the host, never from a project file or a request:
//   SEED_FEED_HEADLESS   absolute path of dist/cli/headless.js
//   SEED_FEED_ORACLES    optional, absolute path of FEED's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).
//
// Project files are not trusted: every path in a request is checked here again (the client's schema check is not relied
// on), state folders must be real folders inside the run folder, and a process is only killed after its command line
// shows it is this adapter's job wrapper for that run folder.
//
// FEED is a THERMAL calculation only. Nothing this adapter returns says anything about stress, failure or fuel integrity.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ADAPTER = { id: "feed", version: "0.1.0" };
const THERMAL_ONLY = "Thermal calculation only. Not a stress, failure or integrity assessment.";
const MAX_CAPTURE = 1024 * 1024;
const MAX_CASE_BYTES = 1024 * 1024;
const HEARTBEAT_FRESH_MS = 5000;
const STARTUP_GRACE_MS = 15000;
const BACKSLASH = String.fromCharCode(92);

// Quantities of the results index. Peak and the two interface values are CELL-CENTRE values of the solver's mesh, not
// extrapolated to the axis or the interface; heat_flux_outer follows from the linear heat rate and the outer radius.
const QUANTITIES = [
  { name: "temperature_radial", unit: "K", radial: true },
  { name: "temperature_peak", unit: "K" },
  { name: "temperature_fuel_surface", unit: "K" },
  { name: "temperature_clad_inner", unit: "K" },
  { name: "temperature_surface", unit: "K" },
  { name: "heat_flux_outer", unit: "W/m2" },
  { name: "energy_balance_residual", unit: "1" },
];
const OUTPUT_FILES = ["case.json", "derived.json", "feed-manifest.json", "results.json", "run.json"];
const PARAMETERS = [
  { id: "power.linearHeatRate", type: "number", unit: "W/m", min: 1, max: 60000 },
  { id: "boundary.bulkTemperature", type: "number", unit: "K", min: 273, max: 1000 },
  { id: "boundary.heatTransferCoefficient", type: "number", unit: "W/m2/K", min: 1, max: 1000000 },
  { id: "boundary.surfaceTemperature", type: "number", unit: "K", min: 273, max: 1000 },
  { id: "gap.conductance", type: "number", unit: "W/m2/K", min: 1, max: 1000000 },
  { id: "mesh.fuelCells", type: "integer", min: 4, max: 20000 },
  { id: "mesh.claddingCells", type: "integer", min: 2, max: 10000 },
];

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const typed = (code, field, message, source = "seed") => ({ code, field, message: String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 900), source });
const win = process.platform === "win32";
const sameOrInside = (child, parent) => {
  const norm = (p) => (win ? p.toLowerCase() : p);
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return norm(child + path.sep).startsWith(norm(base));
};
/** System tools by absolute path: the working directory is the project, which must never supply an executable. */
const winDir = () => (process.env.SystemRoot || process.env.windir || "C:/Windows").split(BACKSLASH).join("/");

/** A portable relative path: no absolute path, drive letter, backslash, NUL, empty or dot segment. */
function portableRel(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (p.startsWith("/") || p.includes(BACKSLASH) || p.includes(":") || p.includes(String.fromCharCode(0))) return false;
  return p.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    if (err && err.code === "EPERM") return true;
    throw err;
  }
}

/** Command line of a process, or null when it cannot be read (then it is not treated as ours). */
function commandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (win) {
    const exe = winDir() + "/System32/WindowsPowerShell/v1.0/powershell.exe";
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return r.status === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : null;
  }
  const r = spawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : null;
}

/** Kill a process tree: taskkill /T on Windows, the process group on POSIX (the job is its own group leader). */
async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new RangeError("refusing to kill pid " + pid);
  if (win) {
    await new Promise((resolve) => {
      const cp = spawn(winDir() + "/System32/taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      cp.on("error", () => resolve());
      cp.on("close", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      if (!err || err.code !== "ESRCH") throw err;
      try {
        process.kill(pid, "SIGKILL");
      } catch (err2) {
        if (!err2 || err2.code !== "ESRCH") throw err2;
      }
    }
  }
}

async function waitDead(pid, ms) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !isAlive(pid);
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
const json = (v) => JSON.stringify(v, null, 2) + "\n";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Real path of `rel` under `root`, or {escaped}/{missing}: refuses a path that leaves the root lexically or through a link. */
function insideRoot(root, rel) {
  if (!portableRel(rel)) return { escaped: true };
  const abs = path.resolve(root, rel);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { escaped: true };
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true, abs };
    return { escaped: true };
  }
  return sameOrInside(real, realRoot) ? { abs: real } : { escaped: true };
}

/** `child` (an existing folder or file below `parentReal`) must resolve inside it: state folders may not be links. */
function containedBelow(parentReal, child) {
  try {
    return sameOrInside(fs.realpathSync(child), parentReal);
  } catch {
    return false;
  }
}

/** The state folder `.seed/jobs` under the root must be a real folder inside the project. */
function jobsDir(root, create) {
  const realRoot = fs.realpathSync(root);
  const dir = path.join(root, ".seed", "jobs");
  if (create) fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.lstatSync(path.join(root, ".seed")).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) return null;
    return containedBelow(realRoot, dir) ? dir : null;
  } catch {
    return null;
  }
}

function bundlePath() {
  const p = process.env.SEED_FEED_HEADLESS;
  if (!p || !path.isAbsolute(p)) return null;
  return fs.existsSync(p) ? p : null;
}

function runBundle(bundle, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

function parseJson(text) {
  try {
    return JSON.parse(text.trim().split("\n").pop());
  } catch {
    return null;
  }
}

/** FEED's own typed errors pass through with their codes (they match the pattern); text from the app is labelled app-content. */
function mapIssues(list, severity) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((e) => {
    let code = e && typeof e.code === "string" && /^[EW]_[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : severity === "E" ? "E_APP_FAILED" : "W_APP";
    if (!code.startsWith(severity + "_")) code = severity + "_" + code.slice(2);
    return {
      ...typed(code, e && typeof e.field === "string" ? e.field : "", e && e.message, "app-content"),
      ...(e && typeof e.unit === "string" && e.unit.length > 0 && e.unit.length <= 40 ? { unit: e.unit } : {}),
    };
  });
}

const setupError = () =>
  typed("E_SETUP_REQUIRED", "", "the FEED headless runner is not configured: set SEED_FEED_HEADLESS to the absolute path of dist/cli/headless.js (npm run build in the FEED repo)");

function appFailed(what, res) {
  const tail = (res.stderr || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(-300);
  return typed("E_APP_FAILED", "", what + (res.timedOut ? " (timed out)" : " (exit " + res.code + ")") + (tail ? ": " + tail : ""), tail ? "app-content" : "seed");
}

/** Job ids are unique per request id: a readable prefix plus a hash of the whole request id (no truncation collisions). */
function jobIdFor(requestId) {
  return "job-" + requestId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 36) + "-" + sha256(requestId).slice(0, 16);
}

function jobIndexPath(dir, jobId) {
  return path.join(dir, jobId + ".json");
}

function findJob(root, jobId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(jobId)) return null;
  const dir = jobsDir(root, false);
  if (!dir) return null;
  const idx = readJson(jobIndexPath(dir, jobId));
  if (!idx || typeof idx.runDir !== "string") return null;
  const found = insideRoot(root, idx.runDir);
  if (!found.abs) return null;
  const nativeDir = path.join(found.abs, "native");
  if (!containedBelow(found.abs, nativeDir)) return null;
  const job = readJson(path.join(nativeDir, "job.json"));
  if (!job || job.jobId !== jobId) return null;
  return { nativeDir, absRunDir: found.abs, runDir: idx.runDir, job };
}

function jobState(nativeDir, job) {
  const status = readJson(path.join(nativeDir, "status.json"));
  const heartbeatPath = path.join(nativeDir, "heartbeat.json");
  const hb = readJson(heartbeatPath);
  const tokenOk = !!hb && typeof job.token === "string" && job.token.length > 0 && hb.token === job.token;
  let fresh = false;
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(heartbeatPath).mtimeMs;
    fresh = ageMs <= HEARTBEAT_FRESH_MS;
  } catch {
    // no heartbeat yet or any more
  }
  let startedMs = 0;
  try {
    startedMs = fs.statSync(path.join(nativeDir, "job.json")).mtimeMs;
  } catch {
    // job.json vanished: treated as not starting
  }
  const value = status && status.status;
  const alive = Number.isInteger(job.pid) && isAlive(job.pid);
  const base = { status, alive, tokenOk, fresh };
  if (value === "finished") return { ...base, lifecycle: "completed", native: { status: "finished" } };
  if (value === "failed") return { ...base, lifecycle: "failed", native: { status: "failed", ...(status.detail ? { detail: String(status.detail) } : {}) } };
  if (value === "cancelled") return { ...base, lifecycle: "cancelled", native: { status: "cancelled" } };
  if (!value || value === "running") {
    // A live process with this job's token is running even when its heartbeat is late: only a confirmed death is a failure.
    if (alive && tokenOk) return { ...base, lifecycle: "running", native: { status: "running", ...(fresh ? {} : { detail: "no heartbeat for " + Math.round(ageMs / 1000) + " s" }) } };
    if (alive && !hb && Date.now() - startedMs < STARTUP_GRACE_MS) return { ...base, lifecycle: "running", native: { status: "running", detail: "starting" } };
    return { ...base, lifecycle: "failed", native: { status: "died", detail: "the job process ended without a final status" } };
  }
  return { ...base, lifecycle: "failed", native: { status: String(value).slice(0, 80) } };
}

/** Snapshot inputs must still hash to what was recorded (and requested), at run and at collect time. */
function snapshotProblem(absRunDir, inputs) {
  const realRun = fs.realpathSync(absRunDir);
  for (const i of inputs) {
    if (!portableRel(i.path)) return "input path is not a portable relative path: " + String(i.path).slice(0, 80);
    const p = path.join(absRunDir, "inputs", i.path);
    let bytes;
    try {
      if (!containedBelow(realRun, p)) return i.path + " resolves outside the run folder";
      bytes = fs.readFileSync(p);
    } catch {
      return i.path + " is missing from the snapshot";
    }
    if (sha256(bytes) !== i.sha256) return i.path + " no longer matches its recorded hash";
  }
  return null;
}

async function main() {
  const verb = process.argv[2];
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stderr.write("invalid JSON on stdin\n");
    process.exit(1);
  }
  const root = process.env.SEED_PROJECT_ROOT || process.cwd();
  const reply = (doc) => {
    const out = {
      schema: "seed.adapter-reply/0.1",
      verb,
      requestId: request && request.requestId ? request.requestId : "unknown",
      ok: doc.ok,
      errors: doc.errors || [],
      warnings: doc.warnings || [],
      ...(doc.result !== undefined ? { result: doc.result } : {}),
    };
    process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
  };
  const fail = (...errors) => reply({ ok: false, errors });

  try {
    if (!request || request.verb !== verb) return fail(typed("E_SCHEMA_INVALID", "/verb", "the request verb does not match the command"));
    if (verb === "describe") return await describe(reply, fail);
    if (verb === "open") return fail(typed("E_VERB_UNKNOWN", "/verb", "FEED's editor is its web app; this headless adapter does not open it"));
    if (verb === "validate") return await validate(request, root, reply, fail);
    if (verb === "run") return await run(request, root, reply, fail);
    if (verb === "status") return status(request, root, reply, fail);
    if (verb === "cancel") return await cancel(request, root, reply, fail);
    if (verb === "collect") return collect(request, root, reply, fail);
    return fail(typed("E_VERB_UNKNOWN", "/verb", "unknown verb"));
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "adapter failure: " + (err && err.message)));
  }
}

/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_FEED_ORACLES;
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
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const res = await runBundle(bundle, ["describe"]);
  const d = parseJson(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true) return fail(appFailed("the FEED runner could not describe itself", res));
  const warnings = d.solver && d.solver.available === false ? [typed("W_SOLVER_MISSING", "", "the FEED solver (WSL distro feed-solver) was not found: validate works, run will be refused")] : [];
  reply({
    ok: true,
    warnings,
    result: {
      app: { id: "feed", name: "Fuel Performance Studio (FEED)", version: d.engine.version },
      engine: { name: "feed-headless", version: d.engine.version },
      formats: [{ id: d.caseFormat.format, version: String(d.caseFormat.version) }],
      capabilities: [d.engine.capability, "validate", "run", "cancel", "collect", "thermal-only"],
      parameters: PARAMETERS,
      quantities: QUANTITIES.map((q) => ({ name: q.name, unit: q.unit, normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the case path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the case file does not exist")] } });
  const size = fs.statSync(art.abs).size;
  if (size > MAX_CASE_BYTES) return reply({ ok: true, result: { valid: false, problems: [typed("E_SCHEMA_INVALID", "/artifact/path", "the case file is larger than " + MAX_CASE_BYTES + " bytes")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the case file does not match the revision named in the request"));
  }
  const warnings = [];
  const res = await runBundle(bundle, ["validate", art.abs]);
  const out = parseJson(res.stdout);
  if (res.code === 0 && out && out.ok === true) {
    warnings.push(...mapIssues(out.warnings, "W"));
  } else if (res.code === 2 && out && out.ok === false) {
    const mapped = mapIssues(out.errors, "E");
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the case without giving a reason", "app-content")]));
    warnings.push(...mapIssues(out.warnings, "W"));
  } else {
    return fail(appFailed("the FEED runner could not validate the case", res));
  }
  reply({ ok: true, warnings: [], result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems: [...problems, ...warnings] } });
}

async function run(request, root, reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const found = insideRoot(root, request.runDir);
  if (found.escaped) return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the run folder leaves the project"));
  if (found.missing) return fail(typed("E_NOT_FOUND", "/runDir", "the run folder does not exist; the host creates it with the input snapshot first"));
  const absRunDir = found.abs;
  const inputs = Array.isArray(request.snapshot && request.snapshot.inputs) ? request.snapshot.inputs : [];
  if (inputs.length === 0) return fail(typed("E_PROP_MISSING", "/snapshot/inputs", "the snapshot has no inputs"));
  for (let i = 0; i < inputs.length; i++) {
    if (!portableRel(inputs[i] && inputs[i].path)) return fail(typed("E_PATH_INVALID", "/snapshot/inputs/" + i + "/path", "input paths must be portable relative paths"));
  }
  if (inputs.length !== 1) return fail(typed("E_UNSUPPORTED", "/snapshot/inputs", "a FEED case is one self-contained file (materials are inside it); the snapshot has " + inputs.length));
  const settings = request.settings || {};
  const casePath = inputs[0].path;
  if (settings.case !== undefined && settings.case !== casePath) return fail(typed("E_PROP_MISSING", "/settings/case", "settings.case is not the snapshot's input"));
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "FEED is deterministic and has no random seed"));
  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const caseAbs = path.join(absRunDir, "inputs", casePath);
  if (fs.statSync(caseAbs).size > MAX_CASE_BYTES) return fail(typed("E_SCHEMA_INVALID", "/snapshot/inputs/0/path", "the case file is larger than " + MAX_CASE_BYTES + " bytes"));

  // The solver must exist before a job is registered: a missing one is a setup problem, not a failed run.
  const info = parseJson((await runBundle(bundle, ["describe"])).stdout);
  if (!info || info.ok !== true) return fail(typed("E_APP_FAILED", "", "the FEED runner could not describe itself"));
  if (!info.solver || info.solver.available !== true) return fail(typed("E_SETUP_REQUIRED", "", "the FEED solver (WSL distro feed-solver) was not found", "seed"));

  const budgetSeconds = request.budget && Number.isInteger(request.budget.maxWallSeconds) ? request.budget.maxWallSeconds : 300;
  const timeoutSeconds = Math.min(86400, Math.max(10, budgetSeconds));

  const nativeDir = path.join(absRunDir, "native");
  const jobJsonPath = path.join(nativeDir, "job.json");
  const jobId = jobIdFor(request.requestId);
  fs.mkdirSync(nativeDir, { recursive: true });
  if (!containedBelow(absRunDir, nativeDir) || fs.lstatSync(nativeDir).isSymbolicLink()) {
    return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the native state folder is a link or leaves the run folder"));
  }
  const dir = jobsDir(root, true);
  if (!dir) return fail(typed("E_PATH_TRAVERSAL", "/.seed/jobs", "the job registry folder is a link or leaves the project"));

  // Reserve the run folder exclusively before anything is started: a concurrent start of the same request sees the
  // reservation, and another request is refused. The record is completed (with the process id) after the start.
  const token = crypto.randomBytes(16).toString("hex");
  const record = { jobId, requestId: request.requestId, pid: null, token, case: casePath, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) };
  try {
    fs.writeFileSync(jobJsonPath, json(record), { flag: "wx" });
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    const existing = readJson(jobJsonPath);
    if (existing && existing.requestId === request.requestId) {
      // A reservation without a process id is a launch that has not committed (or failed): it is not a running job.
      if (!Number.isInteger(existing.pid)) return fail(typed("E_REQUEST_CONFLICT", "", "the launch of this request is still being registered; retry shortly"));
      return reply({ ok: true, result: { jobId: existing.jobId, runDir: request.runDir, lifecycle: "running" } });
    }
    return fail(typed("E_REQUEST_CONFLICT", "", "this run folder already belongs to another request"));
  }

  // The job index is reserved before anything starts, and rollback removes only what THIS invocation created: the same
  // request id used for another run folder must never delete the first job's registry entry.
  const indexPath = jobIndexPath(dir, jobId);
  let createdIndex = false;
  const removeOwn = (...extra) => {
    for (const f of [jobJsonPath, ...(createdIndex ? [indexPath] : []), ...extra]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort: the folder is being abandoned
      }
    }
  };
  try {
    fs.writeFileSync(indexPath, json({ runDir: request.runDir }), { flag: "wx" });
    createdIndex = true;
  } catch (err) {
    removeOwn();
    if (err && err.code === "EEXIST") return fail(typed("E_REQUEST_CONFLICT", "/requestId", "this request id already belongs to a job in another run folder"));
    return fail(typed("E_INTERNAL", "", "could not register the job: " + (err && err.code ? err.code : err)));
  }

  const rollback = async (child, error) => {
    if (child && Number.isInteger(child.pid)) {
      let stopped = false;
      try {
        await killTree(child.pid);
        stopped = await waitDead(child.pid, 3000);
      } catch {
        stopped = false;
      }
      if (!stopped) {
        // The launch cannot be shown to be gone: keep the records so the job can still be found and cancelled.
        try {
          atomicWrite(jobJsonPath, json({ ...record, pid: child.pid }));
        } catch {
          // nothing more can be recorded
        }
        return fail(typed("E_APP_FAILED", "", "launch failed (" + error.message + ") and the job process could not be confirmed stopped; its records were kept (job " + jobId + ")"));
      }
    }
    removeOwn();
    return fail(error);
  };

  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "job.cjs"), absRunDir, caseAbs, bundle, token, String(timeoutSeconds)], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  } catch (err) {
    return rollback(null, typed("E_APP_FAILED", "", "could not start the job: " + (err && err.message)));
  }
  child.unref();
  const nativeIdentity = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message && message.token === token && Number.isSafeInteger(message.runnerPid) && message.runnerPid > 1 ? message.runnerPid : null);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (!Number.isInteger(child.pid)) return rollback(null, typed("E_APP_FAILED", "", "the job did not start"));
  try {
    atomicWrite(jobJsonPath, json({ ...record, pid: child.pid }));
  } catch (err) {
    return rollback(child, typed("E_INTERNAL", "", "could not register the job: " + (err && err.code ? err.code : err)));
  }
  const runnerPid = await nativeIdentity;
  if (!runnerPid) return rollback(child, typed("E_APP_FAILED", "", "native runner identity was not confirmed over launch IPC"));
  reply({ ok: true, result: { jobId, runDir: request.runDir, lifecycle: "running", nativeProcesses: [child.pid, runnerPid] } });
}

function status(request, root, reply, fail) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const s = jobState(j.nativeDir, j.job);
  reply({
    ok: true,
    result: {
      jobId: request.jobId,
      lifecycle: s.lifecycle,
      native: s.native,
      ...(s.status && s.status.startedAt ? { startedAt: s.status.startedAt } : {}),
      ...(s.status && s.status.finishedAt ? { finishedAt: s.status.finishedAt } : {}),
    },
  });
}

/** The pid in job.json comes from a project file: it is only trusted when the process really is this job's wrapper. */
function ownsProcess(j, s) {
  if (!s.tokenOk || !Number.isInteger(j.job.pid)) return false;
  const cl = commandLine(j.job.pid);
  if (cl === null) return false;
  const norm = (x) => (win ? x.split(BACKSLASH).join("/").toLowerCase() : x).split('"').join("");
  // The command line must hold, as whole arguments in order, THIS adapter's job.cjs, this run folder and this job's token
  // (the token is an argument of the wrapper, so another run's wrapper cannot match, nor can a longer folder name).
  const expected = [path.join(__dirname, "job.cjs"), j.absRunDir].map(norm).join(" ");
  const c = norm(cl);
  const at = c.indexOf(expected + " ");
  if (at < 0) return false;
  const tail = c.slice(at + expected.length + 1).split(" ");
  return typeof j.job.token === "string" && j.job.token.length > 0 && tail.includes(j.job.token);
}

/** Ask the runner to stop the solver of the run in `out`. `confirmed` means a solver was stopped or none was running. */
async function stopSolver(nativeDir) {
  const bundle = bundlePath();
  if (!bundle) return { confirmed: false, stoppedOne: false };
  const res = await runBundle(bundle, ["cancel", "--out", path.join(nativeDir, "out")], 60000);
  const out = parseJson(res.stdout);
  const ok = res.code === 0 && !!out && out.ok === true && typeof out.cancelled === "boolean";
  return { confirmed: ok, stoppedOne: ok && out.cancelled === true };
}

async function cancel(request, root, reply, fail) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const launch = request.extensions && request.extensions["seed.launch"];
  if (launch) {
    const child = readJson(path.join(j.nativeDir, "child.json"));
    const pids = launch.nativeProcesses;
    if (launch.runDir !== j.runDir || (pids !== undefined && (!Array.isArray(pids) || pids.length !== 2 || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2) || j.job.pid !== pids[0] || !child || child.pid !== pids[1]))) {
      return fail(typed("E_NOT_OWNED", "/extensions/seed.launch", "job differs from protected launch binding"));
    }
  }
  const s = jobState(j.nativeDir, j.job);
  if (s.lifecycle !== "running") {
    // already over (or died): nothing to stop, and nothing was cancelled by this call
    const child = readJson(path.join(j.nativeDir, "child.json"));
    let nativeStopped = !s.alive && !!child && Number.isInteger(child.pid) && child.pid > 1 && !isAlive(child.pid);
    // A job that failed or died may have left its solver in the WSL distro: the processes being gone says nothing about it.
    if (s.lifecycle === "failed") nativeStopped = nativeStopped && (await stopSolver(j.nativeDir)).confirmed;
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: s.lifecycle, cancelled: false, nativeStopped } });
  }
  if (!ownsProcess(j, s)) return fail(typed("E_NOT_OWNED", "/jobId", "the process behind this job is not owned by this run"));
  const child = readJson(path.join(j.nativeDir, "child.json"));

  // 1. Stop the SOLVER first: it runs in a WSL distro, outside the process tree that is killed below. The runner's own cancel
  //    verb writes the flag, signals that run's process group and confirms. If it cannot confirm, nothing is claimed.
  const first = await stopSolver(j.nativeDir);
  if (!first.confirmed) return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });

  // 2. Then the wrapper and the runner process, only after the command line proved they are this job's.
  await killTree(j.job.pid);
  const dead = await waitDead(j.job.pid, 5000);
  const childDead = child && Number.isInteger(child.pid) && child.pid > 1 ? await waitDead(child.pid, 5000) : true;
  if (!dead || !childDead) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  }
  // 3. If the first stop found no solver run registered yet, the runner may have been about to start one: with the runner
  //    dead no new run can appear, so ask again and require that answer to be confirmed too.
  if (!first.stoppedOne && !(await stopSolver(j.nativeDir)).confirmed) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "failed", cancelled: false, nativeStopped: false } });
  }
  atomicWrite(path.join(j.nativeDir, "status.json"), json({ status: "cancelled", startedAt: s.status && s.status.startedAt, finishedAt: new Date().toISOString() }));
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "cancelled", cancelled: true, nativeStopped: true } });
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
  const outDir = path.join(nativeDir, "out", "feed");
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "feed-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the FEED run folder has no completed manifest");
  }
  if (JSON.stringify(manifest.files.map((f) => f.path).sort()) !== JSON.stringify(OUTPUT_FILES)) return incomplete("the FEED manifest does not list exactly its five files");
  const bytesOf = {};
  for (const f of manifest.files) {
    let bytes;
    try {
      if (!containedBelow(found.abs, path.join(outDir, f.path))) return incomplete(f.path + " resolves outside the run folder");
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
    bytesOf[f.path] = bytes;
  }
  const snapshotCase = fs.readFileSync(path.join(found.abs, "inputs", job.case));
  if (sha256(bytesOf["case.json"]) !== sha256(snapshotCase) || manifest.caseSha256 !== sha256(snapshotCase)) return incomplete("the run did not use the snapshot's case");

  const results = JSON.parse(bytesOf["results.json"].toString("utf8"));
  const derived = JSON.parse(bytesOf["derived.json"].toString("utf8"));
  const record = JSON.parse(bytesOf["run.json"].toString("utf8"));
  if (!results || results.schema !== "feed.results/0.1" || !Array.isArray(results.radial) || results.radial.length === 0 || !results.summary || !Array.isArray(results.checks)) return incomplete("results.json is not a FEED result");
  if (!record || record.state !== "completed") return incomplete("run.json does not record a completed solver run");

  // A result whose own checks failed, or that used a property law outside its stated range, is not a result.
  // Evidence must be present, not assumed: every check carries a recognised verdict and the domain verdict is stated.
  if (results.checks.some((c) => !c || typeof c.id !== "string" || (c.verdict !== "pass" && c.verdict !== "fail"))) return incomplete("results.json has a check without a recognised verdict");
  if (!results.domain || (results.domain.verdict !== "in-domain" && results.domain.verdict !== "out-of-domain")) return incomplete("results.json states no domain verdict");
  const failing = results.checks.filter((c) => c.verdict === "fail");
  if (results.domain && results.domain.verdict === "out-of-domain") {
    return fail(typed("E_OUT_OF_DOMAIN", "/quantities", "a conductivity law was used outside the temperature range it is stated for; this is not a valid result"));
  }
  if (failing.length > 0) return incomplete("the run's own checks failed: " + failing.map((c) => String(c.id)).join(", "));
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  for (const p of results.radial) if (!p || !finite(p.r) || !finite(p.T)) return incomplete("radial samples are missing or not finite", "/quantities/temperature_radial");
  const balance = results.checks.find((c) => c.id === "energyBalance");
  const sm = results.summary;
  const scalars = {
    temperature_peak: sm.maxT,
    temperature_fuel_surface: sm.fuelSurfaceCellT,
    temperature_clad_inner: sm.claddingInnerCellT,
    temperature_surface: sm.claddingOuterWallT,
    heat_flux_outer: derived.heatFluxOuter,
    energy_balance_residual: balance ? balance.value : null,
  };
  for (const [name, v] of Object.entries(scalars)) if (!finite(v)) return incomplete("the value for " + name + " is missing or not finite", "/quantities/" + name);

  // The series folder is written below: it must be a real folder inside the run folder, not a link set up beforehand.
  const seriesDir = path.join(nativeDir, "series");
  try {
    fs.mkdirSync(seriesDir, { recursive: true });
    if (fs.lstatSync(seriesDir).isSymbolicLink() || !containedBelow(found.abs, seriesDir)) return incomplete("the series folder is a link or leaves the run folder");
  } catch (err) {
    return incomplete("cannot use the series folder: " + (err && err.code));
  }
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  for (const q of QUANTITIES) {
    const body = q.radial
      ? { quantity: q.name, unit: q.unit, r: results.radial.map((p) => p.r), values: results.radial.map((p) => p.T), region: results.radial.map((p) => p.region), note: "cell-centre values; r in metres from the pin axis" }
      : { quantity: q.name, unit: q.unit, values: [scalars[q.name]] };
    const text = json(body);
    atomicWrite(path.join(nativeDir, "series", q.name + ".json"), text);
    quantities.push({
      name: q.name,
      unit: q.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + q.name + ".json", sha256: sha256(text) },
      verification: "unverified",
      ...(q.radial ? { coordinates: { system: "radial", axes: [{ name: "r", unit: "m" }] } } : {}),
    });
  }
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: "feed-headless", version: String(manifest.version === 1 ? "0.1.0" : manifest.version) },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "FEED run completed (" + results.radial.length + " cells, solver exit " + (record.exitCode === undefined ? "n/a" : record.exitCode) + "). " + THERMAL_ONLY },
    quantities,
    extensions: {
      feed: {
        thermalOnly: THERMAL_ONLY,
        solver: String(record.solver || "").slice(0, 120),
        caseSha256: manifest.caseSha256,
        resultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        checks: results.checks.map((c) => ({ id: String(c.id), verdict: String(c.verdict) })),
        domain: results.domain.verdict,
        warnings: Array.isArray(derived.warnings) ? derived.warnings.map((w) => String(w.code)) : [],
        quantityNotes: "temperature_peak, temperature_fuel_surface and temperature_clad_inner are cell-centre values of the solver mesh; temperature_surface is the converged outer-wall patch value; energy_balance_residual is relative (flux through the cladding wall against the input linear heat rate).",
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

main();
