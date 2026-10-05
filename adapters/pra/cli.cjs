"use strict";
// SEED adapter for SNEED (PRA), transport "CLI per verb": the request is JSON on stdin, one seed.adapter-reply/0.1 JSON object goes to
// stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps SNEED's headless runner (dist/node/cli/headless.js: describe, validate, run, cancel; docs/HEADLESS.md in the SNEED repository),
// which starts SCRAM inside WSL itself. Configuration comes from the host's environment, never from a project file or a request:
//   SEED_PRA_REPO      absolute path of the SNEED checkout, built with `npm run build:cli`
//   SEED_PRA_NODE      optional, absolute path of the Node binary that runs the runner (default: the one running this adapter)
//   SEED_PRA_ORACLES   optional, absolute path of SNEED's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client). Project files are not trusted: every path in a request is
// checked again here, state folders must be real folders inside the run folder, and a process is only killed after its command line shows it
// is this adapter's. Structure follows adapters/openmc (runner-first cancel); the model is a data file, so nothing is regenerated.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ADAPTER = { id: "pra", version: "0.1.0" };
const MAX_CAPTURE = 1024 * 1024;
const HEARTBEAT_FRESH_MS = 5000;
const STARTUP_GRACE_MS = 15000;
const BACKSLASH = String.fromCharCode(92);
const RUN_ID = "pra";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const typed = (code, field, message, source = "seed") => ({ code, field: String(field).slice(0, 200), message: String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 900) || "(no message)", source });
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

// ---- configuration and launching -------------------------------------------------------------------------------------------------

/** The configured parts, or {setup: message}. Nothing is installed or guessed. */
function config() {
  const repo = process.env.SEED_PRA_REPO;
  if (!repo || !path.isAbsolute(repo)) return { setup: "set SEED_PRA_REPO to the absolute path of the SNEED checkout (built with npm run build:cli)" };
  const runner = path.join(repo, "dist", "node", "cli", "headless.js");
  try {
    if (!fs.statSync(runner).isFile()) throw new Error("missing");
  } catch {
    return { setup: "SEED_PRA_REPO does not hold dist/node/cli/headless.js: run npm run build:cli in the SNEED checkout" };
  }
  const node = process.env.SEED_PRA_NODE || process.execPath;
  if (!path.isAbsolute(node) || !fs.existsSync(node)) return { setup: "SEED_PRA_NODE must be the absolute path of a Node binary" };
  return { repo, runner, node };
}

/** The launch spec {command, args} for one runner verb. SCRAM runs inside WSL under the runner's own control. */
function launchSpec(cfg, verbArgs) {
  return { command: cfg.node, args: [cfg.runner, ...verbArgs] };
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

/** The last line of stdout as JSON, or null. */
function parseLast(text) {
  const lines = String(text).trim().split(String.fromCharCode(10));
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

const setupError = (message) => typed("E_SETUP_REQUIRED", "", "the SNEED runner is not configured: " + message);

function appFailed(what, res) {
  const tail = (res.stderr || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(-300);
  return typed("E_APP_FAILED", "", what + (res.timedOut ? " (timed out)" : " (exit " + res.code + ")") + (tail ? ": " + tail : ""), tail ? "app-content" : "seed");
}

/** SNEED's codes: E_SCHEMA is SEED's E_SCHEMA_INVALID; its other E_ codes (E_CYCLE, E_PROB_RANGE, ...) are adapter codes and pass through. */
function mapCode(code) {
  if (code === "E_SCHEMA") return "E_SCHEMA_INVALID";
  return typeof code === "string" && /^E_[A-Z0-9_]{1,60}$/.test(code) ? code : "E_APP_FAILED";
}

/** Typed errors from the runner. Messages quote ids from the model, so they are app content and sanitized by typed(). */
function mapErrors(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => typed(mapCode(e && e.code), e && typeof e.field === "string" ? e.field : "", e && e.message, "app-content"));
}

function mapWarnings(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((w) => {
    const raw = w && typeof w.code === "string" && w.code ? w.code : "PRA_WARNING";
    const code = raw.startsWith("W_") ? raw : "W_PRA_" + raw.replace(/^E_/, "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    return typed(code, w && typeof w.field === "string" ? w.field : "", w && typeof w === "object" ? w.message : String(w), "app-content");
  });
}

// ---- jobs ------------------------------------------------------------------------------------------------------------------------

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
    if (verb === "open") return fail(typed("E_VERB_UNKNOWN", "/verb", "SNEED's editor is its web page; this headless adapter does not open it"));
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
  const dir = process.env.SEED_PRA_ORACLES;
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
  if (res.code !== 0 || !d || d.ok !== true || !d.engine || !d.modelFormat || !Array.isArray(d.quantities)) return fail(appFailed("the SNEED runner could not describe itself", res));
  const scram = d.scram && typeof d.scram === "object" ? d.scram : {};
  const warnings = scram.installed === true ? [] : [typed("W_SOLVER_MISSING", "", "the SCRAM runtime is not installed: validate works, run will be refused", "seed")];
  const methods = Array.isArray(d.methods) ? d.methods.map(String) : [];
  reply({
    ok: true,
    warnings,
    result: {
      app: { id: "pra", name: "SNEED", version: String(d.engine.version) },
      engine: { name: "SCRAM", version: String(scram.version || "not installed") },
      formats: [{ id: String(d.modelFormat.format), version: String(d.modelFormat.version) }],
      capabilities: [...(Array.isArray(d.capabilities) ? d.capabilities.map(String) : []), "validate", "run", "cancel", "collect"],
      parameters: [
        { id: "method", type: "string", enum: methods },
        { id: "limitOrder", type: "integer", min: 1, max: 1000 },
        ...(Array.isArray(d.parameters) ? d.parameters.filter((p) => p && p.id === "event.probability").map((p) => ({ id: "event.probability", type: "number", unit: "1", min: 0, max: 1 })) : []),
      ],
      quantities: d.quantities.map((q) => ({ name: String(q.name), unit: String(q.unit), normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the model path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the model file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the model file does not match the revision named in the request"));
  }
  const res = await runSpec(launchSpec(cfg, ["validate", art.abs]), 120000);
  const out = parseLast(res.stdout);
  if (!out || (res.code !== 0 && res.code !== 2)) return fail(appFailed("the SNEED runner could not validate the model", res));
  let refused = false;
  if (out.ok === true) {
    problems.push(...mapWarnings(out.warnings));
  } else {
    refused = true;
    const mapped = mapErrors(out.errors);
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]), ...mapWarnings(out.warnings));
  }
  if (refused && !problems.some((p) => p.code.startsWith("E_"))) problems.push(typed("E_APP_FAILED", "", "the runner refused the model; its reasons were only warnings", "app-content"));
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

const METHODS = ["exact", "rare-event", "mcub"];

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
  const unknown = Object.keys(settings).find((k) => !["model", "method", "limitOrder"].includes(k));
  if (unknown !== undefined) return fail(typed("E_UNSUPPORTED", "/settings/" + unknown, "unknown setting; this adapter takes model, method and limitOrder"));
  // The analysis is deterministic: there is no seed to set.
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "the analysis is deterministic; a seed does nothing, so a request that sets one is refused"));
  let modelPath = typeof settings.model === "string" ? settings.model : null;
  if (modelPath === null && inputs.length === 1) modelPath = inputs[0].path;
  if (modelPath === null) return fail(typed("E_PROP_MISSING", "/settings/model", "name the model file with settings.model (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === modelPath)) return fail(typed("E_PROP_MISSING", "/settings/model", "settings.model is not one of the snapshot inputs"));
  const method = settings.method === undefined ? "exact" : settings.method;
  if (!METHODS.includes(method)) return fail(typed("E_UNSUPPORTED", "/settings/method", "method must be one of " + METHODS.join(", ")));
  let limitOrder;
  if (settings.limitOrder !== undefined) {
    if (!Number.isInteger(settings.limitOrder) || settings.limitOrder < 1 || settings.limitOrder > 1000) return fail(typed("E_BOUNDS_EXCEEDED", "/settings/limitOrder", "limitOrder must be a whole number from 1 to 1000"));
    limitOrder = settings.limitOrder;
  }
  // Only the wall-clock budget is enforced (SCRAM is single-threaded; memory and disk are not limited by the runner).
  const budget = request.budget || {};
  const timeoutSeconds = Math.min(Math.max(Number.isInteger(budget.maxWallSeconds) ? budget.maxWallSeconds : 60, 10), 86400);

  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const modelAbs = path.join(absRunDir, "inputs", modelPath);
  if (!readJson(modelAbs)) return fail(typed("E_APP_FAILED", "/settings/model", "the snapshot copy of the model is not JSON"));

  // The runner's own refusals (invalid model) before anything is reserved.
  const pre = await runSpec(launchSpec(cfg, ["validate", modelAbs]), 120000);
  const preOut = parseLast(pre.stdout);
  if (!preOut || (pre.code !== 0 && pre.code !== 2)) return fail(appFailed("the SNEED runner could not check the model", pre));
  if (preOut.ok !== true) return fail(...(mapErrors(preOut.errors).length > 0 ? mapErrors(preOut.errors) : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]));

  const nativeDir = path.join(absRunDir, "native");
  const jobJsonPath = path.join(nativeDir, "job.json");
  const jobId = jobIdFor(request.requestId);
  fs.mkdirSync(nativeDir, { recursive: true });
  if (!containedBelow(absRunDir, nativeDir) || fs.lstatSync(nativeDir).isSymbolicLink()) {
    return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the native state folder is a link or leaves the run folder"));
  }
  const dir = jobsDir(root, true);
  if (!dir) return fail(typed("E_PATH_TRAVERSAL", "/.seed/jobs", "the job registry folder is a link or leaves the project"));
  // One request id belongs to one run folder: refuse a start that would reuse it elsewhere, before anything is created or started.
  const bound = readJson(jobIndexPath(dir, jobId));
  if (bound && bound.runDir !== request.runDir) return fail(typed("E_REQUEST_CONFLICT", "/requestId", "this request id is already bound to another run folder"));

  // Reserve the run folder exclusively before anything is started; the record is completed (with the process id) after the start.
  const token = crypto.randomBytes(16).toString("hex");
  const record = { jobId, requestId: request.requestId, pid: null, token, model: modelPath, method, limitOrder, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) };
  const created = { job: false, index: false };
  try {
    fs.writeFileSync(jobJsonPath, json(record), { flag: "wx" });
    created.job = true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    const existing = readJson(jobJsonPath);
    if (existing && existing.requestId === request.requestId) {
      return reply({ ok: true, result: { jobId: existing.jobId, runDir: request.runDir, lifecycle: "running" } });
    }
    return fail(typed("E_REQUEST_CONFLICT", "", "this run folder already belongs to another request"));
  }

  const outAbs = path.join(nativeDir, "out");
  const rollback = async (child, error) => {
    if (child && Number.isInteger(child.pid)) {
      try {
        await stopNative(cfg, nativeDir);
        await killTree(child.pid);
        await waitDead(child.pid, 3000);
      } catch {
        // the failure being reported matters more
      }
    }
    for (const f of [created.job ? jobJsonPath : null, created.index ? jobIndexPath(dir, jobId) : null]) {
      if (f === null) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort: the folder is being abandoned
      }
    }
    return fail(error);
  };

  const runArgs = ["run", modelAbs, "--out", outAbs, "--run-id", RUN_ID, "--method", method, ...(limitOrder !== undefined ? ["--limit-order", String(limitOrder)] : []), "--timeout-seconds", String(timeoutSeconds)];
  const cancelArgs = ["cancel", "--out", outAbs];
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "job.cjs"), absRunDir, token, JSON.stringify(launchSpec(cfg, runArgs)), JSON.stringify(launchSpec(cfg, cancelArgs))], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  } catch (err) {
    return rollback(null, typed("E_APP_FAILED", "", "could not start the job: " + (err && err.message)));
  }
  child.unref();
  const nativeIdentity = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
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
    fs.writeFileSync(jobIndexPath(dir, jobId), json({ runDir: request.runDir }), { flag: "wx" });
    created.index = true;
    atomicWrite(jobJsonPath, json({ ...record, pid: child.pid }));
  } catch (err) {
    return rollback(child, typed("E_INTERNAL", "", "could not register the job, so it was stopped: " + (err && err.code ? err.code : err)));
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

/** The arguments of a command line: quoted parts stay whole, anything else splits at spaces. */
function argvOf(cl) {
  const out = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of cl) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (ch === " " && !quoted) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}
const normPath = (x) => (win ? x.split(BACKSLASH).join("/").toLowerCase() : x);

/** The pid in job.json comes from a project file: it is only trusted when the process really is this job's wrapper:
 *  this adapter's job.cjs, started with exactly this run folder as an argument (a run folder that merely starts with the same text does not match). */
function ownsProcess(j, s) {
  if (!s.tokenOk || !Number.isInteger(j.job.pid)) return false;
  const cl = commandLine(j.job.pid);
  if (cl === null) return false;
  const args = argvOf(cl).map(normPath);
  return args.includes(normPath(path.join(__dirname, "job.cjs"))) && args.includes(normPath(j.absRunDir));
}

/** A Node runner left behind by a dead wrapper: ours only when its command line runs headless.js `run` on this run folder's own files. */
function ownsRunner(cfg, j, pid) {
  const cl = commandLine(pid);
  if (cl === null) return false;
  const args = argvOf(cl).map(normPath);
  return args.includes(normPath(cfg.runner)) && args.includes("run") && args.includes(normPath(path.join(j.absRunDir, "native", "out")));
}

/** Ask the runner to cancel this job's native run: it kills the processes carrying the run's owner tag (SCRAM in WSL) and checks none is left.
 *  {confirmed, stoppedOne, notOwned}. The folder is this job's own, never taken from the request. */
async function stopNative(cfg, nativeDir) {
  const res = await runSpec(launchSpec(cfg, ["cancel", "--out", path.join(nativeDir, "out")]), 60000);
  const out = parseLast(res.stdout);
  if (!out) return { confirmed: false, stoppedOne: false };
  if (out.ok === true) {
    if (out.cancelled !== true) return { confirmed: true, stoppedOne: false }; // nothing was recorded for this folder (yet)
    return { confirmed: out.nativeStopped === true, stoppedOne: true };
  }
  const code = out.errors && out.errors[0] && out.errors[0].code;
  if (code === "E_NOT_OWNED") return { confirmed: false, stoppedOne: false, notOwned: true };
  return { confirmed: false, stoppedOne: false };
}

async function cancel(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const launch = request.extensions && request.extensions["seed.launch"];
  if (launch) {
    const child = readJson(path.join(j.nativeDir, "child.json"));
    const pids = launch.nativeProcesses;
    if (launch.runDir !== j.runDir || (pids !== undefined && (!Array.isArray(pids) || pids.length !== 2 ||
      pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2) || j.job.pid !== pids[0] || !child || child.pid !== pids[1]))) {
      return fail(typed("E_NOT_OWNED", "/extensions/seed.launch", "job differs from protected launch binding"));
    }
  }
  const s = jobState(j.nativeDir, j.job);
  const child = readJson(path.join(j.nativeDir, "child.json"));
  const childPid = child && Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null;
  if (s.lifecycle !== "running") {
    // Already over (or died): nothing was cancelled by this call. A wrapper that died can leave SCRAM running inside WSL (outside any
    // process tree): ask the runner, which only kills what carries this run's owner tag, and stop the Node runner only when it provably is ours.
    let nativeStopped = !s.alive && (childPid === null || !isAlive(childPid));
    if (s.lifecycle === "failed") {
      const n = await stopNative(cfg, j.nativeDir);
      if (n.notOwned) return fail(typed("E_NOT_OWNED", "/jobId", "a process of this run is still running and cannot be shown to be this run's"));
      nativeStopped = nativeStopped && n.confirmed;
    }
    if (childPid !== null && isAlive(childPid)) {
      if (!ownsRunner(cfg, j, childPid)) return fail(typed("E_NOT_OWNED", "/jobId", "a process from this job is still running and cannot be shown to be this run's runner"));
      await killTree(childPid);
      nativeStopped = nativeStopped && (await waitDead(childPid, 5000));
    }
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: s.lifecycle, cancelled: false, nativeStopped } });
  }
  if (!ownsProcess(j, s)) return fail(typed("E_NOT_OWNED", "/jobId", "the process behind this job is not owned by this run"));

  // 1. The native run first: SCRAM lives in WSL, outside the tree killed below.
  const first = await stopNative(cfg, j.nativeDir);
  if (first.notOwned) return fail(typed("E_NOT_OWNED", "/jobId", "the native process of this run cannot be shown to be its own"));
  if (!first.confirmed) return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  // 2. Then the wrapper and the Node runner, only after the command line proved they are this job's.
  await killTree(j.job.pid);
  const dead = await waitDead(j.job.pid, 5000);
  const childDead = childPid !== null ? await waitDead(childPid, 5000) : true;
  if (!dead || !childDead) return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  // 3. If the first stop found nothing recorded yet, the runner may have been about to start SCRAM: with it dead no new run can
  //    appear, so ask again and require that answer to be confirmed too.
  if (!first.stoppedOne && !(await stopNative(cfg, j.nativeDir)).confirmed) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "failed", cancelled: false, nativeStopped: false } });
  }
  atomicWrite(path.join(j.nativeDir, "status.json"), json({ status: "cancelled", startedAt: s.status && s.status.startedAt, finishedAt: new Date().toISOString() }));
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "cancelled", cancelled: true, nativeStopped: true } });
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const prob = (v) => finite(v) && v >= 0 && v <= 1;

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
  if (!manifest || manifest.format !== "sneed-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) return incomplete("the SNEED run folder has no completed manifest");
  if (JSON.stringify(manifest.files.map((f) => f && f.path).sort()) !== JSON.stringify(["model.json", "results.json"])) return incomplete("the SNEED manifest does not list exactly model.json and results.json");
  for (const f of manifest.files) {
    let bytes;
    try {
      if (!containedBelow(found.abs, path.join(outDir, f.path))) return incomplete(f.path + " resolves outside the run folder");
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
  }
  // The run must have used exactly the snapshot's model (SNEED's document hash is the sha256 of the saved bytes).
  const snapshotSha = (job.inputs.find((i) => i.path === job.model) || {}).sha256;
  const modelEntry = manifest.files.find((f) => f.path === "model.json");
  if (!snapshotSha || modelEntry.sha256 !== snapshotSha || manifest.modelSha256 !== snapshotSha) return incomplete("the run did not use the snapshot's model");

  const results = readJson(path.join(outDir, "results.json"));
  if (!results || results.schema_version !== 1) return incomplete("results.json is not a SNEED result record");
  // Truncated, failed, cancelled and incomplete results are never indexed.
  if (results.status !== "completed" || results.completeness !== "complete") return incomplete("the result is not a completed, complete analysis");
  if (!results.input_hashes || results.input_hashes.document_hash !== snapshotSha) return incomplete("the result names a different model than the snapshot");
  if (!results.settings || results.settings.method !== job.method || (job.limitOrder !== undefined && results.settings.limitOrder !== job.limitOrder)) return incomplete("the result was made with other settings than the request");
  if (!prob(results.top_event_probability)) return incomplete("the top event probability is missing or outside [0, 1]", "/top_event_probability");
  const sets = Array.isArray(results.minimal_cut_sets) ? results.minimal_cut_sets : null;
  if (!sets || sets.length > 100000 || sets.some((c) => !c || !Array.isArray(c.events) || c.events.length === 0 || c.events.some((e) => typeof e !== "string") || !prob(c.probability))) {
    return incomplete("the minimal cut sets are missing or malformed", "/minimal_cut_sets");
  }
  const approximation = results.approximation_value;
  if (job.method !== "exact" && !finite(approximation)) return incomplete("the approximation value is missing for method " + job.method, "/approximation_value");
  if (job.method === "exact" && approximation !== null && approximation !== undefined) return incomplete("an exact result carries an approximation value", "/approximation_value");

  const qDir = path.join(nativeDir, "quantities");
  try {
    fs.mkdirSync(qDir, { recursive: true });
    if (fs.lstatSync(qDir).isSymbolicLink() || !containedBelow(found.abs, qDir)) return incomplete("the quantities folder is a link or leaves the run folder");
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "cannot prepare the quantities folder: " + (err && err.code ? err.code : err)));
  }
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  const addQuantity = (name, body, extra = {}) => {
    const text = json(body);
    const fileName = String(quantities.length).padStart(3, "0") + ".json";
    atomicWrite(path.join(qDir, fileName), text);
    quantities.push({
      name,
      unit: "1",
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/quantities/" + fileName, sha256: sha256(text) },
      verification: "unverified",
      ...extra,
    });
  };
  addQuantity("top_event_probability", { quantity: "top_event_probability", method: job.method, unit: "1", value: results.top_event_probability });
  addQuantity("minimal_cut_sets", { quantity: "minimal_cut_sets", unit: "1", cutSets: sets.map((c) => ({ events: c.events, probability: c.probability })) }, { coordinates: { system: "cut-set-index", axes: [{ name: "cut set", unit: "1" }] } });
  if (job.method !== "exact") addQuantity("approximation_value", { quantity: "approximation_value", method: job.method, unit: "1", value: approximation, note: "an approximation can exceed 1; it is not a probability then" });

  const caveats = Array.isArray(results.caveats) ? results.caveats.map((c) => String(c).slice(0, 300)).slice(0, 20) : [];
  const warnings = [...mapWarnings(results.warnings), ...caveats.map((c) => typed("W_PRA_CAVEAT", "", c, "app-content"))];
  const eng = results.engine && typeof results.engine === "object" ? results.engine : {};
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: "SCRAM", version: String(eng.version || "unknown") },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "SNEED " + job.method + " analysis completed: " + sets.length + " minimal cut sets" },
    quantities,
    extensions: {
      pra: {
        method: job.method,
        limitOrder: results.settings.limitOrder,
        modelHash: results.input_hashes.model_hash,
        documentHash: results.input_hashes.document_hash,
        runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        assumptions: results.assumptions,
        caveats,
        engine: eng,
        exporterVersion: results.exporter_version,
        parserVersion: results.parser_version,
        meaning: "A probability under stated assumptions (constant probabilities, independent basic events). Not a frequency and not a plant risk figure.",
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, warnings, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

main();
