"use strict";
// Job wrapper for the OpenMC Studio adapter: runs Studio's headless runner (openmc_studio.headless, inside WSL on Windows) as a child, keeps
// a heartbeat, and writes native/status.json when the child ends. It is started detached by cli.cjs (verb "run") and stopped by "cancel".
// The runner and OpenMC live in a WSL distro, outside this process tree: killing wsl.exe does not stop them. So before the wrapper stops
// itself for any reason it asks the runner to cancel (the runner proves its own child and kills its process group).
// Usage: node job.cjs <absRunDir> <token> <runSpecJson> <cancelSpecJson>
// A spec is {command, args, env?} chosen by cli.cjs from the host configuration, never from the request text.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const [absRunDir, token, runSpecJson, cancelSpecJson] = process.argv.slice(2);
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

function parseSpec(text) {
  const spec = JSON.parse(text);
  if (!spec || typeof spec.command !== "string" || !path.isAbsolute(spec.command) || !Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string")) {
    throw new Error("bad launch spec");
  }
  return spec;
}
let runSpec;
let cancelSpec;
try {
  runSpec = parseSpec(runSpecJson);
  cancelSpec = parseSpec(cancelSpecJson);
} catch (err) {
  process.stderr.write("bad launch spec: " + (err && err.message) + "\n");
  process.exit(1);
}

/** Ask the runner to cancel its run (it kills the OpenMC process group inside WSL). Best effort, bounded: the caller goes on either way. */
function cancelNative() {
  try {
    const r = spawnSync(cancelSpec.command, cancelSpec.args, { env: cancelSpec.env ? { ...process.env, ...cancelSpec.env } : process.env, encoding: "utf8", windowsHide: true, timeout: 45000 });
    return r.status === 0 ? "native run cancelled" : "native cancel did not confirm (exit " + r.status + ")";
  } catch {
    return "native cancel could not run";
  }
}

/** Stop the launcher process (wsl.exe or python) and everything under it, and say whether it is gone. */
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

/** Stop the native run and the launcher (if started) and leave. What became of each is written where it can be found, best effort. */
function abort(reason) {
  if (timer) clearInterval(timer);
  const native = child ? cancelNative() : "no native run started";
  const outcome = stopRunner();
  try {
    atomicWrite(path.join(absRunDir, "native", "job-error.txt"), String(reason).slice(0, 1700) + " (" + native + "; " + outcome + ")" + String.fromCharCode(10));
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

try {
  // native/out receives the runner's files: it must be absent or a real folder inside native, never a link.
  const st = fs.lstatSync(outDir, { throwIfNoEntry: false });
  if (st && st.isSymbolicLink()) throw new Error("native/out is a link");
  fs.mkdirSync(outDir, { recursive: true });
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
  child = spawn(runSpec.command, runSpec.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: runSpec.env ? { ...process.env, ...runSpec.env } : process.env,
  });
} catch (err) {
  finish("failed", "could not start the OpenMC runner: " + (err && err.message));
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
child.on("error", (err) => finish("failed", "OpenMC runner launch error: " + err.message));
child.on("close", (code, signal) => {
  try {
    atomicWrite(path.join(nativeDir, "log.txt"), "exit " + code + " signal " + signal + "\n--- stdout\n" + stdout.slice(0, 20000) + "\n--- stderr\n" + stderr.slice(0, 20000) + "\n");
  } catch (err) {
    process.stderr.write("could not write log.txt: " + (err && err.code) + "\n");
  }
  let reply = null;
  try {
    reply = JSON.parse(stdout.trim().split(String.fromCharCode(10)).pop());
  } catch {
    reply = null;
  }
  if (reply && reply.ok === true && reply.status === "completed" && code === 0) return finish("finished");
  if (reply && reply.status === "cancelled") return finish("cancelled", "the runner reported the run cancelled");
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return finish("failed", "the runner reported " + reply.errors[0].code + ": " + String(reply.errors[0].message).slice(-600));
  if (reply && reply.status) return finish("failed", "the run ended " + reply.status);
  return finish("failed", "the runner exited with " + (signal || code) + (stderr ? ": " + stderr.trim().slice(-300) : ""));
});
