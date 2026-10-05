"use strict";
// SEED adapter for NODAL Studio, transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps NODAL's command-line runner (`python -m nodal_studio.run`, its --describe, --validate and --json modes, docs/headless.md
// in the NODAL repo). The runner's location comes from the environment of the host, never from a project file or a request:
//   SEED_NODAL_PYTHON   absolute path of the Python that has NODAL's solver requirements installed
//   SEED_NODAL_REPO     absolute path of the nodal-studio checkout (contains nodal_studio/run.py)
//   SEED_NODAL_ORACLES  optional, absolute path of NODAL's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).
//
// Project files are not trusted: every path in a request is checked here again (the client's schema check is not
// relied on), state folders must be real folders inside the run folder, and a process is only killed after its
// command line shows it is this adapter's job wrapper for that run folder. Structure follows adapters/raft.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ADAPTER = { id: "nodal", version: "0.1.0" };
const MAX_CAPTURE = 1024 * 1024;
const HEARTBEAT_FRESH_MS = 5000;
const STARTUP_GRACE_MS = 15000;
const MAX_CHANNELS = 200;
const BACKSLASH = String.fromCharCode(92);

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

/** Canonical JSON (sorted keys): two parsed documents are the same exactly when these strings are equal. */
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
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

/** The configured runner: an absolute Python that exists and an absolute repository holding nodal_studio/run.py, or null. */
function runnerConfig() {
  const python = process.env.SEED_NODAL_PYTHON;
  const repo = process.env.SEED_NODAL_REPO;
  if (!python || !repo || !path.isAbsolute(python) || !path.isAbsolute(repo)) return null;
  try {
    if (!fs.statSync(python).isFile() || !fs.statSync(path.join(repo, "nodal_studio", "run.py")).isFile()) return null;
  } catch {
    return null;
  }
  return { python, repo };
}

function runnerEnv(repo) {
  // No bytecode is written into the repository; UTF-8 everywhere so the JSON replies are read the same on every platform.
  return { ...process.env, PYTHONPATH: repo, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
}

function runPython(cfg, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cfg.python, ["-m", "nodal_studio.run", ...args], { cwd: cfg.repo, env: runnerEnv(cfg.repo), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** NODAL's codes mapped to SEED's; the original code stays in the message. Unknown codes are model problems (E_SCHEMA_INVALID), not app failures. */
function mapCode(code) {
  if (code === "E_NOT_FOUND" || code === "E_EXISTS") return code;
  if (typeof code === "string" && (code.startsWith("E_GATE") || code.includes("UNSUPPORTED") || code.includes("NOT_MODELED"))) return "E_UNSUPPORTED";
  if (typeof code === "string" && (code.includes("DOMAIN") || code.includes("OUT_OF_RANGE"))) return "E_OUT_OF_DOMAIN";
  return "E_SCHEMA_INVALID";
}

function mapIssues(list, prefix) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => {
    const raw = e && typeof e.code === "string" ? e.code : "E_APP_FAILED";
    const warn = raw.startsWith("W_");
    return typed(warn ? raw : mapCode(raw), e && typeof e.field === "string" ? e.field : "", (prefix || "") + raw + ": " + (e && e.message), "app-content");
  });
}

const setupError = () =>
  typed("E_SETUP_REQUIRED", "", "the NODAL runner is not configured: set SEED_NODAL_PYTHON (Python with NODAL's solver requirements) and SEED_NODAL_REPO (the nodal-studio checkout) to absolute paths");

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
  if (value === "tripped") return { ...base, lifecycle: "terminated-by-trip", native: { status: "tripped", ...(status.detail ? { detail: String(status.detail) } : {}) } };
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
    if (verb === "open") return fail(typed("E_VERB_UNKNOWN", "/verb", "NODAL's editor is its web app; this headless adapter does not open it"));
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
  const dir = process.env.SEED_NODAL_ORACLES;
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
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
  const res = await runPython(cfg, ["--describe"]);
  const d = parseJson(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true || !d.engine || !d.quantities) return fail(appFailed("the NODAL runner could not describe itself", res));
  reply({
    ok: true,
    result: {
      app: { id: "nodal", name: "NODAL Studio", version: String(d.engine.version) },
      engine: { name: String(d.engine.name), version: String(d.engine.version) },
      formats: [{ id: String(d.modelFormat.format), version: "0.1" }],
      capabilities: [...(Array.isArray(d.capabilities) ? d.capabilities : []).map(String), "validate", "run", "cancel", "collect"],
      parameters: [{ id: "recordDt", type: "number", unit: "s", min: 0 }],
      // These are the quantity kinds a model output can have; a result carries the outputs the model names.
      quantities: Object.keys(d.quantities).sort().map((q) => ({ name: q, unit: String(d.quantities[q]), normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the model path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the model file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the model file does not match the revision named in the request"));
  }
  const res = await runPython(cfg, [art.abs, "--validate"]);
  const out = parseJson(res.stdout);
  if (res.code === 0 && out && out.ok === true) {
    problems.push(...mapIssues(out.warnings));
  } else if (res.code === 2 && out && out.ok === false) {
    const mapped = mapIssues(out.errors);
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]), ...mapIssues(out.warnings));
  } else {
    return fail(appFailed("the NODAL runner could not validate the model", res));
  }
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

async function run(request, root, reply, fail) {
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
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
  const knownSettings = ["model", "commands", "recordDt"];
  const unknown = Object.keys(settings).find((k) => !knownSettings.includes(k));
  if (unknown !== undefined) return fail(typed("E_UNSUPPORTED", "/settings/" + unknown, "unknown setting; this adapter takes model, commands and recordDt"));
  // NODAL is deterministic: there is no seed to set.
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "NODAL is deterministic; a seed does nothing, so a request that sets one is refused"));
  let modelPath = typeof settings.model === "string" ? settings.model : null;
  if (modelPath === null && inputs.length === 1) modelPath = inputs[0].path;
  if (modelPath === null) return fail(typed("E_PROP_MISSING", "/settings/model", "name the model file with settings.model (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === modelPath)) return fail(typed("E_PROP_MISSING", "/settings/model", "settings.model is not one of the snapshot inputs"));
  const extra = [];
  if (settings.recordDt !== undefined) {
    if (typeof settings.recordDt !== "number" || !Number.isFinite(settings.recordDt) || settings.recordDt <= 0) {
      return fail(typed("E_BOUNDS_EXCEEDED", "/settings/recordDt", "recordDt must be a positive finite number of seconds"));
    }
    extra.push("--record-dt", String(settings.recordDt));
  }
  let commandsAbs = null;
  if (settings.commands !== undefined) {
    if (typeof settings.commands !== "string" || !inputs.some((i) => i.path === settings.commands)) {
      return fail(typed("E_PROP_MISSING", "/settings/commands", "settings.commands is not one of the snapshot inputs"));
    }
    commandsAbs = path.join(absRunDir, "inputs", settings.commands);
    extra.push("--commands", commandsAbs);
  }
  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const modelAbs = path.join(absRunDir, "inputs", modelPath);
  if (!readJson(modelAbs)) return fail(typed("E_APP_FAILED", "/settings/model", "the snapshot copy of the model is not JSON"));

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
  const record = { jobId, requestId: request.requestId, pid: null, token, model: modelPath, recordDt: settings.recordDt, commands: settings.commands, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) };
  try {
    fs.writeFileSync(jobJsonPath, json(record), { flag: "wx" });
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    const existing = readJson(jobJsonPath);
    if (existing && existing.requestId === request.requestId) {
      return reply({ ok: true, result: { jobId: existing.jobId, runDir: request.runDir, lifecycle: "running" } });
    }
    return fail(typed("E_REQUEST_CONFLICT", "", "this run folder already belongs to another request"));
  }

  const rollback = async (child, error) => {
    if (child && Number.isInteger(child.pid)) {
      try {
        await killTree(child.pid);
        await waitDead(child.pid, 3000);
      } catch {
        // the failure being reported matters more
      }
    }
    for (const f of [jobJsonPath, jobIndexPath(dir, jobId)]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort: the folder is being abandoned
      }
    }
    return fail(error);
  };

  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "job.cjs"), absRunDir, modelAbs, cfg.python, cfg.repo, token, JSON.stringify(extra)], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
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
    fs.writeFileSync(jobIndexPath(dir, jobId), json({ runDir: request.runDir }), { flag: "wx" });
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

/** The pid in job.json comes from a project file: it is only trusted when the process really is this job's wrapper. */
function ownsProcess(j, s) {
  if (!s.tokenOk || !Number.isInteger(j.job.pid)) return false;
  const cl = commandLine(j.job.pid);
  if (cl === null) return false;
  const norm = (x) => (win ? x.split(BACKSLASH).join("/").toLowerCase() : x);
  return norm(cl).includes("job.cjs") && norm(cl).includes(norm(j.absRunDir));
}

async function cancel(request, root, reply, fail) {
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
  if (s.lifecycle !== "running") {
    // already over (or died): nothing to stop, and nothing was cancelled by this call
    const child = readJson(path.join(j.nativeDir, "child.json"));
    const nativeStopped = !s.alive && !!child && Number.isInteger(child.pid) && child.pid > 1 && !isAlive(child.pid);
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: s.lifecycle, cancelled: false, nativeStopped } });
  }
  if (!ownsProcess(j, s)) return fail(typed("E_NOT_OWNED", "/jobId", "the process behind this job is not owned by this run"));
  const child = readJson(path.join(j.nativeDir, "child.json"));
  await killTree(j.job.pid);
  const dead = await waitDead(j.job.pid, 5000);
  const childDead = child && Number.isInteger(child.pid) && child.pid > 1 ? await waitDead(child.pid, 5000) : true;
  if (!dead || !childDead) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  }
  atomicWrite(path.join(j.nativeDir, "status.json"), json({ status: "cancelled", startedAt: s.status && s.status.startedAt, finishedAt: new Date().toISOString() }));
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "cancelled", cancelled: true } });
}

function finiteNumbers(a) {
  return Array.isArray(a) && a.every((v) => typeof v === "number" && Number.isFinite(v));
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
  const outDir = path.join(nativeDir, "out", "nodal");
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "nodal-studio-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the NODAL run folder has no completed manifest");
  }
  const expected = ["model.json", "results.json", "session.json"];
  if (JSON.stringify(manifest.files.map((f) => f.path).sort()) !== JSON.stringify(expected)) return incomplete("the NODAL manifest does not list exactly its three files");
  for (const f of manifest.files) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
  }
  const results = readJson(path.join(outDir, "results.json"));
  if (!results || results.format !== "nodal-studio-results" || !results.completion || results.completion.status !== "completed") return incomplete("results.json is not a completed result");
  // The run must have used exactly the snapshot's model.
  const usedModel = readJson(path.join(outDir, "model.json"));
  const snapshotModel = readJson(path.join(found.abs, "inputs", job.model));
  if (!usedModel || !snapshotModel || canonical(usedModel) !== canonical(snapshotModel)) return incomplete("the run did not use the snapshot's model");
  if (!results.model || results.model.hash !== (manifest.model && manifest.model.hash)) return incomplete("results.json and the manifest name different models");

  // The run must have covered the whole time-step schedule, and every series must be complete and finite.
  const steps = Array.isArray(snapshotModel.timeSteps) ? snapshotModel.timeSteps : [];
  const endTime = steps.length > 0 ? steps[steps.length - 1].endTime : undefined;
  const time = results.time;
  if (!finiteNumbers(time) || time.length < 2) return incomplete("results.json has no time series");
  for (let i = 1; i < time.length; i++) if (!(time[i] > time[i - 1])) return incomplete("the time series is not strictly increasing");
  if (typeof endTime !== "number" || results.completion.endTime !== endTime || time[time.length - 1] !== endTime || !Number.isInteger(results.completion.steps) || results.completion.steps < 1) {
    return incomplete("the run did not reach the end of the model's time-step schedule");
  }
  const channels = Array.isArray(results.channels) ? results.channels : [];
  if (channels.length === 0 || channels.length > MAX_CHANNELS) return incomplete("results.json has no recorded channels (the model names no outputs) or too many");
  const names = new Set();
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  for (let k = 0; k < channels.length; k++) {
    const ch = channels[k];
    const name = ch && typeof ch.name === "string" ? ch.name : "";
    const series = results.data && Object.prototype.hasOwnProperty.call(results.data, name) ? results.data[name] : undefined;
    if (!name || name.length > 80 || names.has(name) || typeof ch.unit !== "string" || !ch.unit || ch.unit.length > 40 || !finiteNumbers(series) || series.length !== time.length) {
      return incomplete("a recorded channel is missing, duplicated, not finite or not as long as the time series", "/channels/" + k);
    }
    names.add(name);
    const fileBody = { quantity: name, kind: ch.quantity, location: ch.location, unit: ch.unit, t: time, values: series };
    const env = results.envelope && Object.prototype.hasOwnProperty.call(results.envelope, name) ? results.envelope[name] : undefined;
    if (env && finiteNumbers(env.min) && finiteNumbers(env.max) && env.min.length === time.length && env.max.length === time.length) {
      fileBody.min = env.min;
      fileBody.max = env.max;
    }
    const text = json(fileBody);
    const fileName = String(k).padStart(3, "0") + ".json";
    atomicWrite(path.join(nativeDir, "series", fileName), text);
    quantities.push({
      name,
      unit: ch.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + fileName, sha256: sha256(text) },
      verification: "unverified",
      coordinates: { system: "time", axes: [{ name: "t", unit: "s" }] },
    });
  }

  const messages = Array.isArray(results.messages) ? results.messages : [];
  const warnings = messages
    .filter((m) => m && typeof m.code === "string" && m.code.startsWith("W_"))
    .slice(0, 20)
    .map((m) => typed(m.code, "", m.text || m.code, "app-content"));
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: String(results.engine.name), version: String(results.engine.version) },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "NODAL run completed: " + results.completion.steps + " steps, " + time.length + " samples" },
    quantities,
    extensions: {
      nodal: {
        modelHash: results.model.hash,
        runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        language: results.engine.language,
        settings: results.settings,
        recording: results.recording,
        messages: messages.slice(0, 20).map((m) => ({ level: m && m.level, code: m && m.code })),
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, warnings, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

main();
