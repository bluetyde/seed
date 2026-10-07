// Stress test of the project writer lock (src/core/projectStore.ts, withProjectLock). Usage:
//   node scripts/stress-project-lock.cjs [rounds] [--load N] [--takeover] [--abandoned-guard] [--workers W] [--count C]
// Needs `npm run build`. Run it while the machine is busy: --load N starts N busy-loop processes for the duration (default 12 when the
// flag is given without a number). Without --takeover every round is plain contention (acquire, work, release by W workers). With
// --takeover each round starts on a dead holder's lock, so all workers race to take it over under the takeover guard.
// --abandoned-guard (implies --takeover) also leaves a guard folder older than graceMs, as a crashed contender would, so every worker races to clear it.
// A round fails when the counter is not W*C, a worker exits non-zero (a lock error), or two workers were inside at once; the first
// failing round prints the trace analysis and keeps the trace file. Same method as stress-request-log.cjs (C-01 in docs/corrections.md).
const fs = require("fs"), os = require("os"), cp = require("child_process"), path = require("path");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? Number(args[i + 1]) : d; };
const ROUNDS = Number(args.find((a) => /^\d+$/.test(a)) || 30);
const WORKERS = val("--workers", 4), COUNT = val("--count", 30);
const LOAD = flag("--load") ? val("--load", 12) : 0, ABANDONED = flag("--abandoned-guard"), TAKEOVER = flag("--takeover") || ABANDONED;
const lib = path.resolve(__dirname, "..", "dist", "core", "projectStore.js");
const worker = path.join(__dirname, "stress-project-lock-worker.cjs");
(async () => {
  const hogs = [];
  for (let i = 0; i < LOAD; i++) hogs.push(cp.spawn(process.execPath, ["-e", "const e=Date.now()+3600000;while(Date.now()<e){}"], { stdio: "ignore" }));
  const stopHogs = () => { for (const h of hogs) { try { h.kill(); } catch {} } };
  let bad = 0, errors = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const D = fs.mkdtempSync(path.join(os.tmpdir(), "plock-"));
    const traceFile = D + "/trace.jsonl";
    fs.writeFileSync(traceFile, "");
    if (TAKEOVER) {
      fs.mkdirSync(D + "/.seed/lock", { recursive: true });
      const dead = cp.spawnSync(process.execPath, ["-e", "0"]).pid;
      fs.writeFileSync(D + "/.seed/lock/owner.json", JSON.stringify({ ownerId: "dead", pid: dead, host: os.hostname(), acquiredAt: new Date().toISOString(), token: "dead" }));
    }
    if (ABANDONED) {
      fs.mkdirSync(D + "/.seed/takeover");
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(D + "/.seed/takeover", old, old);
    }
    const names = Array.from({ length: WORKERS }, (_, i) => String.fromCharCode(97 + i));
    const res = await Promise.all(names.map((p) => new Promise((r) => { const c = cp.spawn(process.execPath, [worker, lib, D, p, String(COUNT), traceFile, "60000"], { stdio: "ignore" }); c.on("exit", (code) => r(code)); })));
    let n = 0;
    try { n = JSON.parse(fs.readFileSync(D + "/counter.json", "utf8")).n; } catch {}
    const ev = fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).sort((x, y) => x.t - y.t);
    const problems = [];
    let open = null, prevAfter = 0;
    for (const e of ev) {
      if (e.ev === "enter") {
        if (open) problems.push("OVERLAP: " + e.p + " entered at " + e.t.toFixed(1) + " while " + open.p + " (i=" + open.i + ", entered " + open.t.toFixed(1) + ") was inside");
        open = e;
      } else if (e.ev === "exit") {
        if (e.before !== prevAfter) problems.push("LOST-UPDATE: " + e.p + " i=" + e.i + " read " + e.before + " but the previous exit wrote " + prevAfter);
        prevAfter = e.after;
        if (open && open.p === e.p && open.i === e.i) open = null;
      } else if (e.ev === "error") { errors++; problems.push("ERROR in " + e.p + " i=" + e.i + ": " + e.codes + " " + e.message); }
    }
    if (n !== WORKERS * COUNT || res.some((c) => c !== 0) || problems.length) {
      bad++;
      console.log("ROUND", round, "counter", n, "of", WORKERS * COUNT, "exit codes", JSON.stringify(res));
      for (const p of problems.slice(0, 12)) console.log("  " + p);
      console.log("  trace kept at " + traceFile);
      if (bad >= 3) break;
    } else fs.rmSync(D, { recursive: true, force: true });
  }
  stopHogs();
  console.log(bad ? bad + " failing round(s) (" + errors + " lock errors)" : "no failure in " + ROUNDS + " rounds", "| mode:", ABANDONED ? "abandoned-guard" : TAKEOVER ? "takeover" : "contention", "| load:", LOAD, "| workers:", WORKERS, "x", COUNT);
  process.exit(0);
})();
