// A stand-in for the SEED host in the process-lifecycle tests (W3): it runs the real ProcessManager from dist/ with a process-owner store, opens one app,
// prints READY and then waits to be killed. The test kills it from outside, the way a crashed or force-closed host dies, and then recovers its records.
// Usage: node fake-host.cjs <json: { ownersDir, app }>
const path = require("node:path");
const dist = path.join(__dirname, "..", "..", "dist");
const { ProcessManager } = require(path.join(dist, "main", "processes.js"));
const { OwnerStore } = require(path.join(dist, "core", "ownerStore.js"));

const cfg = JSON.parse(process.argv[2]);
// On Windows Node ties every child that is not detached to its parent with a job object, so a plain worker dies with a killed host. A worker that escapes
// that job (a detached process, the Linux process behind wsl.exe) is the one a restarted host has to find: this host spawns its worker detached on purpose.
const { spawn } = require("node:child_process");
const { freePort, killTree } = require(path.join(dist, "main", "processes.js"));
const deps = {
  spawn: (command, args, options) => spawn(command, args, { ...options, detached: true }),
  freePort,
  fetchStatus: async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).status,
  kill: killTree,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const pm = new ProcessManager(deps, new OwnerStore(cfg.ownersDir));
pm.ensure(cfg.app).then((running) => {
  process.stdout.write(`READY ${JSON.stringify({ pid: process.pid, url: running.url, owned: running.owned })}\n`);
  setInterval(() => {}, 1000);
}, (e) => { process.stdout.write(`FAILED ${e && e.message}\n`); process.exit(1); });
