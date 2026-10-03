"use strict";
// Job wrapper for the RAFT adapter: runs one headless RAFT case as a child, keeps a heartbeat, and writes
// native/status.json when the child ends. It is started detached by cli.cjs (verb "run") and killed as a tree by "cancel".
// Usage: node job.cjs <absRunDir> <absCasePath> <absBundlePath> <token>

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [absRunDir, caseAbs, bundle, token] = process.argv.slice(2);
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

fs.mkdirSync(nativeDir, { recursive: true });
const startedAt = new Date().toISOString();
atomicWrite(statusPath, json({ status: "running", startedAt }));
atomicWrite(heartbeatPath, json({ token, time: startedAt }));

const timer = setInterval(() => {
  try {
    atomicWrite(heartbeatPath, json({ token, time: new Date().toISOString() }));
  } catch (err) {
    // The run folder is gone (deleted or the disk failed): nothing is left to report to.
    process.stderr.write("heartbeat failed: " + (err && err.code) + "\n");
    process.exit(1);
  }
}, 200);

function finish(status, detail) {
  clearInterval(timer);
  try {
    atomicWrite(statusPath, json({ status, ...(detail ? { detail: String(detail).slice(0, 1500) } : {}), startedAt, finishedAt: new Date().toISOString() }));
  } catch (err) {
    process.stderr.write("could not write the final status: " + (err && err.code) + "\n");
    process.exit(1);
  }
  process.exit(0);
}

let child;
try {
  child = spawn(process.execPath, [bundle, "run", caseAbs, "--out", outDir, "--run-id", "raft"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
} catch (err) {
  finish("failed", "could not start the RAFT runner: " + (err && err.message));
}
atomicWrite(path.join(nativeDir, "child.json"), json({ pid: child.pid }));

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
});
child.stderr.on("data", (d) => {
  if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
});
child.on("error", (err) => finish("failed", "RAFT runner error: " + err.message));
child.on("close", (code, signal) => {
  try {
    fs.writeFileSync(path.join(nativeDir, "log.txt"), "exit " + code + " signal " + signal + "\n--- stdout\n" + stdout.slice(0, 20000) + "\n--- stderr\n" + stderr.slice(0, 20000) + "\n");
  } catch (err) {
    process.stderr.write("could not write log.txt: " + (err && err.code) + "\n");
  }
  let reply = null;
  try {
    reply = JSON.parse(stdout.trim());
  } catch {
    reply = null;
  }
  if (code === 0 && reply && reply.ok === true && reply.status === "completed") return finish("finished");
  if (reply && reply.ok === true && reply.reason) return finish("failed", "the run ended failed: " + reply.reason);
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return finish("failed", "the runner refused the case: " + reply.errors[0].code + " " + reply.errors[0].message);
  return finish("failed", "the runner exited with " + (signal || code) + (stderr ? ": " + stderr.trim().slice(-300) : ""));
});
