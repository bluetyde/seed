// Worker of scripts/stress-project-lock.cjs. Increments a counter file under the project writer lock (withProjectLock) and traces every critical section with a wall-clock time.
// usage: node stress-project-lock-worker.cjs <dist/core/projectStore.js> <project dir> <prefix> <count> <trace file> <waitMs>
"use strict";
const fs = require("fs");
const { performance } = require("perf_hooks");
const [, , lib, dir, prefix, count, traceFile, waitMs] = process.argv;
const watch = (p) => typeof p === "string" && (p.includes(path_sep(".seed", "lock")) || p.includes(path_sep(".seed", "takeover")));
function path_sep(a, b) { return a + require("path").sep + b; }
const short = (p) => String(p).replace(/^.*\.seed[\\/]/, "");
for (const name of ["mkdirSync", "rmSync", "renameSync", "writeFileSync"]) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    const w = watch(p);
    try {
      const r = orig.call(this, p, ...rest);
      if (w) trace({ ev: "fs", op: name, path: short(p), ok: true });
      return r;
    } catch (e) {
      if (w) trace({ ev: "fs", op: name, path: short(p), ok: false, code: e.code });
      throw e;
    }
  };
}
const { withProjectLock } = require(lib);
const now = () => performance.timeOrigin + performance.now();
function trace(o) { fs.appendFileSync(traceFile, JSON.stringify({ t: now(), pid: process.pid, p: prefix, ...o }) + "\n"); }
const counter = dir + "/counter.json";
for (let i = 0; i < Number(count); i++) {
  const r = withProjectLock(
    dir,
    () => {
      trace({ ev: "enter", i });
      let before = 0;
      try { before = JSON.parse(fs.readFileSync(counter, "utf8")).n; } catch (e) { if (e.code !== "ENOENT") throw e; }
      const tmp = counter + ".tmp-" + process.pid + "-" + i;
      fs.writeFileSync(tmp, JSON.stringify({ n: before + 1 }));
      fs.renameSync(tmp, counter);
      const after = JSON.parse(fs.readFileSync(counter, "utf8")).n;
      trace({ ev: "exit", i, before, after });
      return after;
    },
    { waitMs: Number(waitMs) }
  );
  if (!r.ok) {
    trace({ ev: "error", i, codes: r.errors.map((e) => e.code), message: String(r.errors[0] && r.errors[0].message).slice(0, 300) });
    process.exit(1);
  }
}
