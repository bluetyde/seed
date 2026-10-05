"use strict";
// Job wrapper for the FEED adapter: runs one headless FEED case as a child, keeps a heartbeat, and writes
// native/status.json when the child ends. It is started detached by cli.cjs (verb "run") and killed as a tree by "cancel".
// If the wrapper can no longer report (heartbeat or state writes fail), it stops the runner before it exits, so
// no simulation is left running that nothing can find or cancel. (The solver itself lives in a WSL distro outside this
// process tree; the adapter's cancel verb stops it through the runner's own cancel verb, and the runner's time limit
// bounds it if everything else is gone.)
// Usage: node job.cjs <absRunDir> <absCasePath> <absBundlePath> <token> <timeoutSeconds>

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [absRunDir, caseAbs, bundle, token, timeoutSeconds] = process.argv.slice(2);
const nativeDir = path.join(absRunDir, "native");
const outDir = path.join(nativeDir, "out");
const MAX_CAPTURE = 1024 * 1024;

function atomicWrite(target, content) {
  const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
const json = (v) => JSON.stringify(v, null, 2) + "\n";
const statusPath = path.join(nativeDir, "status.json");
const heartbeatPath = path.join(nativeDir, "heartbeat.json");
let child = null;
let timer = null;

/** Stop the runner (if started) and leave. The reason is written where it can be found, best effort. */
function abort(reason) {
  if (timer) clearInterval(timer);
  if (child && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    fs.writeFileSync(path.join(absRunDir, "native", "job-error.txt"), String(reason).slice(0, 2000) + "\n");
  } catch {
    // nowhere left to write: the exit status is the only report
  }
  process.exit(1);
}

try {
  fs.mkdirSync(nativeDir, { recursive: true });
  const real = fs.realpathSync(nativeDir);
  const realRun = fs.realpathSync(absRunDir);
  if (fs.lstatSync(nativeDir).isSymbolicLink() || path.dirname(real).toLowerCase() !== realRun.toLowerCase()) {
    process.stderr.write("the native folder is a link or leaves the run folder\n");
    process.exit(1);
  }
} catch (err) {
  process.stderr.write("cannot use the run folder: " + (err && err.code) + "\n");
  process.exit(1);
}

const startedAt = new Date().toISOString();
try {
  atomicWrite(statusPath, json({ status: "running", startedAt }));
  atomicWrite(heartbeatPath, json({ token, time: startedAt }));
} catch (err) {
  abort("cannot write the initial state: " + (err && err.code));
}

timer = setInterval(() => {
  try {
    atomicWrite(heartbeatPath, json({ token, time: new Date().toISOString() }));
  } catch (err) {
    abort("heartbeat write failed: " + (err && err.code));
  }
}, 200);

function finish(status, detail) {
  clearInterval(timer);
  try {
    atomicWrite(statusPath, json({ status, ...(detail ? { detail: String(detail).slice(0, 1500) } : {}), startedAt, finishedAt: new Date().toISOString() }));
  } catch (err) {
    abort("could not write the final status: " + (err && err.code));
  }
  process.exit(0);
}

try {
  child = spawn(process.execPath, [bundle, "run", caseAbs, "--out", outDir, "--run-id", "feed", "--timeout-seconds", String(timeoutSeconds || 300)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
} catch (err) {
  finish("failed", "could not start the FEED runner: " + (err && err.message));
}
try {
  atomicWrite(path.join(nativeDir, "child.json"), json({ pid: child.pid }));
  if (process.send) process.send({ token, runnerPid: child.pid }, () => { if (process.connected) process.disconnect(); });
} catch (err) {
  abort("could not record the runner process id: " + (err && err.code));
}

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
});
child.stderr.on("data", (d) => {
  if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
});
child.on("error", (err) => finish("failed", "FEED runner error: " + err.message));
child.on("close", (code, signal) => {
  try {
    // never write through an existing link or hard link: replace the name itself
    fs.rmSync(path.join(nativeDir, "log.txt"), { force: true });
    fs.writeFileSync(path.join(nativeDir, "log.txt"),  "exit " + code + " signal " + signal + "\n--- stdout\n" + stdout.slice(0, 20000) + "\n--- stderr\n" + stderr.slice(0, 20000) + "\n");
  } catch (err) {
    process.stderr.write("could not write log.txt: " + (err && err.code) + "\n");
  }
  let reply = null;
  try {
    reply = JSON.parse(stdout.trim().split("\n").pop());
  } catch {
    reply = null;
  }
  if (code === 0 && reply && reply.ok === true && reply.status === "completed") return finish("finished");
  // a run the user or the host cancelled is reported by the adapter's cancel verb; the runner says so too
  if (reply && reply.ok === true && reply.status === "cancelled") return finish("cancelled");
  if (reply && reply.ok === true && reply.reason) return finish("failed", "the run ended " + (reply.status || "failed") + ": " + reply.reason);
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return finish("failed", "the runner refused the case: " + reply.errors[0].code + " " + reply.errors[0].message);
  return finish("failed", "the runner exited with " + (signal || code) + (stderr ? ": " + stderr.trim().slice(-300) : ""));
});
