// Worker of scripts/stress-request-log.cjs. Adds N entries under the request-log lock and traces every critical section (enter, what it read, exit) with a wall-clock time.
// usage: node stress-request-log-worker.cjs <dist/core/runManager.js> <requests.json> <prefix> <count> <trace file>
"use strict";
const fs = require("fs");
const { performance } = require("perf_hooks");
const [, , lib, file, prefix, count, traceFile] = process.argv;
const realFs = require("fs");
const watch = (pth) => typeof pth === "string" && (pth.includes("requests.json.lock") || pth.includes(".takeover-"));
const short = (pth) => String(pth).replace(/^.*runs[\/]/, "");
for (const name of ["mkdirSync", "rmSync", "writeFileSync"]) {
  const orig = realFs[name];
  realFs[name] = function (pth, ...rest) {
    const w = watch(pth);
    try {
      const r = orig.call(this, pth, ...rest);
      if (w) trace({ ev: "fs", op: name, path: short(pth), ok: true });
      return r;
    } catch (e) {
      if (w) trace({ ev: "fs", op: name, path: short(pth), ok: false, code: e.code });
      throw e;
    }
  };
}
const { withRequestsLock, readRequestsMap } = require(lib);
const now = () => performance.timeOrigin + performance.now();
const trace = (o) => fs.appendFileSync(traceFile, JSON.stringify({ t: now(), pid: process.pid, p: prefix, ...o }) + "\n");
const hash = "a".repeat(64);
for (let i = 0; i < Number(count); i++) {
  try {
    withRequestsLock(file, () => {
      trace({ ev: "enter", i });
      const r = readRequestsMap(file);
      if (!r.ok) {
        trace({ ev: "unreadable", i, message: r.message });
        throw new Error(r.message);
      }
      const before = Object.keys(r.map).length;
      r.map[prefix + "-" + i] = { payloadHash: hash, runId: "r-" + prefix + "-" + i };
      const tmp = file + ".tmp-" + process.pid + "-" + i;
      fs.writeFileSync(tmp, JSON.stringify(r.map));
      fs.renameSync(tmp, file);
      const after = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length;
      trace({ ev: "exit", i, before, after });
    });
  } catch (e) {
    trace({ ev: "error", i, message: String(e && e.message).slice(0, 300) });
    process.exit(1);
  }
}
