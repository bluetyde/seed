"use strict";
// Job wrapper for the NODAL adapter: runs one NODAL model with the reference solver as a child, keeps a heartbeat, and writes
// native/status.json when the child ends. It is started detached by cli.cjs (verb "run") and killed as a tree by "cancel".
// If the wrapper can no longer report (heartbeat or state writes fail), it stops the runner before it exits, so
// no simulation is left running that nothing can find or cancel.
// Usage: node job.cjs <absRunDir> <absModelPath> <absPython> <absRepo> <token> <extraArgsJson>
// extraArgsJson is a JSON array of extra runner arguments chosen by cli.cjs (--record-dt, --commands), never by the request text.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const [absRunDir, modelAbs, python, repo, token, extraJson] = process.argv.slice(2);
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

/** Stop the runner and everything under it (the Windows virtualenv launcher starts the interpreter as a child), and say whether it is gone. */
function stopRunner() {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null) return "no runner running";
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      const root = (process.env.SystemRoot || process.env.windir || "C:/Windows").split(String.fromCharCode(92)).join("/");
      spawnSync(root + "/System32/taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else {
      process.kill(-process.pid, "SIGKILL"); // this wrapper leads its own process group: the runner and its children share it
    }
  } catch {
    // reported below by checking whether the runner is gone
  }
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err && err.code === "ESRCH") return "runner stopped";
      return "runner state unknown";
    }
    if (Date.now() >= deadline) return "runner STILL RUNNING (pid " + pid + ")";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** Stop the runner (if started) and leave. The reason and what became of the runner are written where they can be found, best effort. */
function abort(reason) {
  if (timer) clearInterval(timer);
  const outcome = stopRunner();
  try {
    atomicWrite(path.join(absRunDir, "native", "job-error.txt"), String(reason).slice(0, 1800) + " (" + outcome + ")" + String.fromCharCode(10));
  } catch {
    // nowhere left to write: the exit status is the only report
  }
  process.exit(1);
}

let extra = [];
try {
  extra = JSON.parse(extraJson || "[]");
  if (!Array.isArray(extra) || extra.some((x) => typeof x !== "string")) throw new Error("extra arguments must be strings");
} catch (err) {
  process.stderr.write("bad extra arguments: " + (err && err.message) + "\n");
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

try {
  // native/out receives the runner's files: it must be absent or a real folder inside native, never a link.
  if (fs.existsSync(outDir) || fs.lstatSync(outDir, { throwIfNoEntry: false })) {
    if (fs.lstatSync(outDir).isSymbolicLink()) throw new Error("native/out is a link");
  }
} catch (err) {
  process.stderr.write("cannot use the output folder: " + (err && err.message) + String.fromCharCode(10));
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
  child = spawn(python, ["-m", "nodal_studio.run", modelAbs, "--out", outDir, "--run-id", "nodal", "--json", ...extra], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // The repository is read-only for the run: no bytecode is written into it.
    env: { ...process.env, PYTHONPATH: repo, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
} catch (err) {
  finish("failed", "could not start the NODAL runner: " + (err && err.message));
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
child.on("error", (err) => finish("failed", "NODAL runner error: " + err.message));
child.on("close", (code, signal) => {
  try {
    atomicWrite(path.join(nativeDir, "log.txt"), "exit " + code + " signal " + signal + "\n--- stdout\n" + stdout.slice(0, 20000) + "\n--- stderr\n" + stderr.slice(0, 20000) + "\n");
  } catch (err) {
    process.stderr.write("could not write log.txt: " + (err && err.code) + "\n");
  }
  let reply = null;
  try {
    reply = JSON.parse(stdout.trim());
  } catch {
    reply = null;
  }
  const folderIssues = reply && Array.isArray(reply.folderIssues) ? reply.folderIssues : [];
  if (reply && reply.ok === true && reply.status === "completed") {
    if (code === 0 && folderIssues.length === 0) return finish("finished");
    return finish("failed", "the run folder did not validate: " + (folderIssues[0] ? folderIssues[0].code : "exit " + code));
  }
  // A run folder that did not validate is a failure whatever the status says.
  if (reply && reply.ok === true && folderIssues.length > 0) return finish("failed", "the run folder did not validate: " + folderIssues[0].code);
  // The model's own stop-advancement trip ends a run on purpose; it is reported as a trip, never as a result.
  if (reply && reply.ok === true && reply.status === "terminated-by-trip") return finish("tripped", "the run stopped on its stop-advancement trip");
  if (reply && reply.ok === true && reply.status) return finish("failed", "the run ended " + reply.status + (reply.reason ? ": " + reply.reason : ""));
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return finish("failed", "the runner refused the model: " + reply.errors[0].code + " " + reply.errors[0].message);
  return finish("failed", "the runner exited with " + (signal || code) + (stderr ? ": " + stderr.trim().slice(-300) : ""));
});
