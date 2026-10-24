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
} else if (scenario === "success" || scenario === "slow" || scenario === "series" || scenario === "jitter" || scenario === "response" || scenario === "response-noise") {
  setTimeout(() => {
    try {
      // "series" and "jitter" write a series the shared data reader knows (a time axis and values); "jitter" makes the last value differ a little from run to run
      // (up to 1e-6), like a nondeterministic engine. The replay tests need both.
      // "response" and "response-noise" write a seed.quantity-data/0.2 series whose last value is a linear function of the case's delayMs (5 + 0.1 * delayMs),
      // so a sampling over delayMs has a known answer; "response-noise" also reports a deviation of 0.25 on that value (a Monte Carlo engine's error bar).
      if (scenario === "response" || scenario === "response-noise") {
        const doc = { schema: "seed.quantity-data/0.2", kind: "series", quantity: "out", unit: "1", axis: { name: "t", unit: "s" }, x: [0, 1, 2], values: [1, 2, 5 + 0.1 * delayMs] };
        if (scenario === "response-noise") doc.std = [0, 0, 0.25];
        atomicWrite(outPath, JSON.stringify(doc) + "\n");
      } else if (scenario === "series" || scenario === "jitter") {
        const last = scenario === "jitter" ? 3 + Number(process.hrtime.bigint() % 1000003n) * 1e-12 : 3;
        atomicWrite(outPath, JSON.stringify({ quantity: "out", unit: "1", t: [0, 1, 2], values: [1, 2, last] }) + "\n");
      } else {
        atomicWrite(outPath, JSON.stringify({ values: [1, 2, 3] }) + "\n");
      }
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
