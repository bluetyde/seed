"use strict";
// Helpers shared by the SEED adapters (raft, feed, nodal, openmc, pra). Each adapter's cli.cjs requires this file; a change here changes
// every adapter, so the adapters' own test suites are the regression tests. Nothing in here knows an app: apps live in the adapters.
//
// What is here: the typed-error constructor, portable-path and containment checks (a project file is never trusted), the job registry
// (`.seed/jobs/<jobId>.json` -> run folder -> native/job.json), job state from the wrapper's status file, heartbeat and token, process
// helpers (command line, kill tree, wait), and the ownership test a cancel needs before it kills anything.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const BACKSLASH = String.fromCharCode(92);

const MAX_CAPTURE = 1024 * 1024;

const HEARTBEAT_FRESH_MS = 5000;

const STARTUP_GRACE_MS = 15000;

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

/**
 * Command line of a process, or null when it cannot be read (then it is not treated as ours). On Linux it is the exact argument list from
 * /proc (an array: nothing is lost to quoting, an argument with spaces stays one); elsewhere it is the text that `ps` or Windows gives.
 */
function commandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === "linux") {
    try {
      const parts = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split(String.fromCharCode(0));
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      if (parts.length > 0) return parts;
    } catch {
      // no /proc entry (the process is gone, or /proc is hidden): ask ps below
    }
  }
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

/** Snapshot inputs must still hash to what was recorded (and requested), at run and at collect time. */
function snapshotProblem(absRunDir, inputs) {
  const realRun = fs.realpathSync(absRunDir);
  for (const i of inputs) {
    if (!portableRel(i.path)) return "input path is not a portable relative path: " + String(i.path).slice(0, 80);
    const p = path.join(absRunDir, "inputs", i.path);
    let bytes;
    try {
      if (!fs.existsSync(p)) return i.path + " is missing from the snapshot";
      if (!containedBelow(realRun, p)) return i.path + " resolves outside the run folder";
      bytes = fs.readFileSync(p);
    } catch {
      return i.path + " is missing from the snapshot";
    }
    if (sha256(bytes) !== i.sha256) return i.path + " no longer matches its recorded hash";
  }
  return null;
}

function appFailed(what, res) {
  const tail = (res.stderr || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(-300);
  return typed("E_APP_FAILED", "", what + (res.timedOut ? " (timed out)" : " (exit " + res.code + ")") + (tail ? ": " + tail : ""), tail ? "app-content" : "seed");
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** The arguments of a command line: quoted parts stay whole, anything else splits at spaces. */
function argvOf(cl) {
  if (Array.isArray(cl)) return cl;
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

/**
 * True when `value` is one whole argument of the command line `cl`. On Linux `cl` is the exact argument list (from /proc) and nothing is
 * ambiguous. Windows quotes an argument that has a space, so the line is split with its
 * quotes. A POSIX `ps` prints the arguments joined by spaces with no quotes at all, so an argument with a space in it (a project under
 * "/Users/me/Claude Code Test") cannot be told from two: there the line is searched for the value between spaces. That stays a proof of
 * ownership because what is asked for is a job token, an absolute path (it starts with a slash or a drive letter, so it cannot begin in the middle
 * of another path) or a fixed word, never a loose fragment; a caller must not pass a relative fragment.
 */
function hasArg(cl, value) {
  if (Array.isArray(cl)) return cl.includes(value); // an exact argument list (Linux): whole arguments only, spaces cannot confuse it
  if (win) return argvOf(cl).map(normPath).includes(normPath(value));
  return (" " + cl + " ").includes(" " + value + " ");
}


/** Canonical JSON (sorted keys): two parsed documents are the same exactly when these strings are equal. */
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

/** SEED's typed error: field and message are bounded and stripped of control characters. `source` is "app-content" when the message quotes the app. */
const typed = (code, field, message, source = "seed") => ({ code, field: String(field).slice(0, 200), message: String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 900) || "(no message)", source });

/**
 * Job state from the wrapper's status file, heartbeat and token. `extraStatuses` maps an app's own final status words to SEED lifecycles
 * (NODAL: { tripped: "terminated-by-trip" }). A live process with this job's token is running even when its heartbeat is late: only a
 * confirmed death is a failure.
 */
function jobState(nativeDir, job, extraStatuses = {}) {
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
  const detail = status && status.detail ? { detail: String(status.detail) } : {};
  if (value === "finished") return { ...base, lifecycle: "completed", native: { status: "finished" } };
  if (value === "failed") return { ...base, lifecycle: "failed", native: { status: "failed", ...detail } };
  if (value === "cancelled") return { ...base, lifecycle: "cancelled", native: { status: "cancelled" } };
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(extraStatuses, value)) return { ...base, lifecycle: extraStatuses[value], native: { status: value, ...detail } };
  if (!value || value === "running") {
    if (alive && tokenOk) return { ...base, lifecycle: "running", native: { status: "running", ...(fresh ? {} : { detail: "no heartbeat for " + Math.round(ageMs / 1000) + " s" }) } };
    if (alive && !hb && Date.now() - startedMs < STARTUP_GRACE_MS) return { ...base, lifecycle: "running", native: { status: "running", detail: "starting" } };
    return { ...base, lifecycle: "failed", native: { status: "died", detail: "the job process ended without a final status" } };
  }
  return { ...base, lifecycle: "failed", native: { status: String(value).slice(0, 80) } };
}

/**
 * The pid in job.json comes from a project file: it is only trusted when the process really is this job's wrapper. Its command line must
 * hold, as whole arguments, the adapter's own wrapper script, exactly this run folder (a folder that merely starts with the same text does
 * not match) and this job's token (so another run's wrapper cannot match either).
 */
function ownsJobProcess(j, s, jobScript) {
  if (!s.tokenOk || !Number.isInteger(j.job.pid) || typeof j.job.token !== "string" || j.job.token.length === 0) return false;
  const cl = commandLine(j.job.pid);
  if (cl === null) return false;
  return hasArg(cl, jobScript) && hasArg(cl, j.absRunDir) && hasArg(cl, j.job.token);
}

module.exports = {
  BACKSLASH, MAX_CAPTURE, HEARTBEAT_FRESH_MS, STARTUP_GRACE_MS, win, sameOrInside, winDir, portableRel, isAlive, commandLine, killTree, waitDead,
  atomicWrite, json, readJson, insideRoot, containedBelow, jobsDir, jobIdFor, jobIndexPath, findJob, snapshotProblem, appFailed, sha256,
  argvOf, hasArg, normPath, canonical, typed, jobState, ownsJobProcess,
};
