"use strict";

const fs = require("node:fs");
const path = require("node:path");

const absRunDir = path.resolve(process.argv[2]);
const scenario = process.argv[3] || "success";
const delayMs = Number(process.argv[4]) || 100;
const token = process.argv[5] || "";

const nativeDir = path.join(absRunDir, "native");
const statusPath = path.join(nativeDir, "status.json");
const heartbeatPath = path.join(nativeDir, "heartbeat.json");
const outPath = path.join(nativeDir, "out.json");

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

fs.mkdirSync(nativeDir, { recursive: true });

// "slow-start": the wrapper takes 1.5 s to write its first status and heartbeat, then hangs like "hang"
if (scenario === "slow-start") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);

const startedAt = new Date().toISOString();
atomicWrite(statusPath, JSON.stringify({ status: "running", startedAt }, null, 2) + "\n");
atomicWrite(heartbeatPath, JSON.stringify({ token, time: startedAt }, null, 2) + "\n");

const timer = setInterval(() => {
  try {
    if (!fs.existsSync(statusPath)) {
      clearInterval(timer);
      process.exit(0);
    }
    atomicWrite(heartbeatPath, JSON.stringify({ token, time: new Date().toISOString() }, null, 2) + "\n");
  } catch {
    clearInterval(timer);
    process.exit(0);
  }
}, 200);

if (scenario === "silent-exit") {
  clearInterval(timer);
  process.exit(0);
}

if (scenario === "crash") {
  atomicWrite(outPath, '{"values":[1,');
  clearInterval(timer);
  process.exit(3);
}

if (scenario === "hang" || scenario === "slow-start") {
  // Heartbeat forever; never finish
} else if (scenario === "success" || scenario === "slow") {
  setTimeout(() => {
    try {
      atomicWrite(outPath, JSON.stringify({ values: [1, 2, 3] }) + "\n");
      atomicWrite(
        statusPath,
        JSON.stringify(
          {
            status: "finished",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );
    } catch {
      // Ignore write errors if killed
    }
    clearInterval(timer);
    process.exit(0);
  }, delayMs);
} else if (scenario === "partial-output") {
  setTimeout(() => {
    try {
      atomicWrite(outPath, '{"values":[1,2');
      atomicWrite(
        statusPath,
        JSON.stringify(
          {
            status: "finished",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );
    } catch {}
    clearInterval(timer);
    process.exit(0);
  }, delayMs);
} else if (scenario === "nan-output") {
  setTimeout(() => {
    try {
      atomicWrite(outPath, JSON.stringify({ values: [1, "NaN"] }) + "\n");
      atomicWrite(
        statusPath,
        JSON.stringify(
          {
            status: "finished",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );
    } catch {}
    clearInterval(timer);
    process.exit(0);
  }, delayMs);
} else if (scenario === "trip") {
  setTimeout(() => {
    try {
      atomicWrite(outPath, '{"values":[1,');
      atomicWrite(
        statusPath,
        JSON.stringify(
          {
            status: "tripped",
            detail: "high flux trip",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );
    } catch {}
    clearInterval(timer);
    process.exit(0);
  }, delayMs);
}
