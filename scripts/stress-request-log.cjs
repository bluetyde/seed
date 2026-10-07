// Stress test of the request-log lock (src/core/runManager.ts, withRequestsLock). Usage: node scripts/stress-request-log.cjs [rounds]
// Needs `npm run build`. Run it while the machine is busy (for example with a dozen busy-loop node processes): the defect it was written for
// (two processes inside the lock at once) never showed on a quiet machine. Runs rounds of four tracing workers that start by finding a dead holder's lock; on a round that loses entries, prints the analysis.
const fs = require("fs"), os = require("os"), cp = require("child_process"), path = require("path");
const ROUNDS = Number(process.argv[2] || 30);
(async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const D = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
    fs.mkdirSync(D + "/runs");
    const file = D + "/runs/requests.json";
    const traceFile = D + "/trace.jsonl";
    fs.writeFileSync(traceFile, "");
    fs.mkdirSync(file + ".lock");
    const dead = cp.spawnSync(process.execPath, ["-e", "0"]).pid;
    fs.writeFileSync(file + ".lock/owner.json", JSON.stringify({ pid: dead, host: os.hostname(), time: new Date().toISOString(), token: "dead" }));
    const lib = path.resolve(__dirname, "..", "dist", "core", "runManager.js");
    const w = path.join(__dirname, "stress-request-log-worker.cjs");
    const res = await Promise.all(["a", "b", "c", "d"].map((p) => new Promise((r) => { const c = cp.spawn(process.execPath, [w, lib, file, p, "30", traceFile], { stdio: "ignore" }); c.on("exit", (code) => r(code)); })));
    const n = fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length : 0;
    if (n !== 120 || res.some((c) => c !== 0)) {
      const ev = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((x, y) => x.t - y.t);
      console.log("ROUND", round, "entries", n, "exit codes", JSON.stringify(res), "events", ev.length);
      // overlap analysis: an enter while another section is open
      let open = null;
      let prevAfter = 0;
      for (const e of ev) {
        if (e.ev === "enter") {
          if (open) console.log("  OVERLAP: " + e.p + " entered at " + e.t.toFixed(1) + " while " + open.p + " (i=" + open.i + ", entered " + open.t.toFixed(1) + ") was inside");
          open = e;
        } else if (e.ev === "exit") {
          if (e.before !== prevAfter) console.log("  LOST-UPDATE: " + e.p + " i=" + e.i + " read " + e.before + " but the previous exit wrote " + prevAfter + " (at " + e.t.toFixed(1) + ")");
          prevAfter = e.after;
          if (open && open.p === e.p && open.i === e.i) open = null;
        } else console.log("  " + e.ev + " " + e.p + " i=" + e.i + " " + (e.message || ""));
      }
      console.log("  trace kept at " + traceFile);
      process.exit(0);
    }
    fs.rmSync(D, { recursive: true, force: true });
  }
  console.log("no loss in", ROUNDS, "rounds");
})();
