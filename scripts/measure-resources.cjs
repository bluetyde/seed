// Measures what a run of each real app costs through its SEED adapter, for describe.resources (E2 exit).
// Usage: node scripts/measure-resources.cjs <raft|feed|nodal|pra|openmc> [--out file.json]
// It runs every good oracle entry of the app (the same inputs the oracle tests use) one at a time through the run manager and records per
// run: wall seconds, bytes the run folder holds, peak memory. Memory is the peak of the summed working sets of everything below this
// process (Windows) and, for apps that run in WSL, the peak rise of the WSL VM's used memory (other WSL activity pollutes that number).
// Needs `npm run build` (it uses dist/) and the app set up as for its oracle test.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const app = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const root = path.join(__dirname, "..");
const home = path.join(root, "..");
const first = (...c) => c.find((p) => p && fs.existsSync(p));
// an app is looked up in this repository's apps folder (where the installer puts it), then beside this repository (decision D10)
const appDir = (folder) => first(path.join(root, "apps", folder), path.join(home, folder)) || path.join(home, folder);
const { RunManager } = require(path.join(root, "dist", "core", "runManager.js"));
const { loadOracleEntries } = require(path.join(root, "dist", "core", "oracle.js"));

const cfg = {
  raft: () => {
    const repo = process.env.SEED_RAFT_REPO || path.join(appDir("raft"));
    process.env.SEED_RAFT_HEADLESS = path.join(repo, "web", "dist-headless", "raft-headless.mjs");
    return { repo, settings: (e) => ({ case: e.inputs[0].path }), artifact: (e) => e.inputs[0], wsl: null };
  },
  feed: () => {
    const repo = first(process.env.SEED_FEED_REPO, path.join(appDir("feed")));
    process.env.SEED_FEED_HEADLESS = path.join(repo, "dist", "cli", "headless.js");
    return { repo, settings: (e) => ({ case: e.inputs[0].path }), artifact: (e) => e.inputs[0], wsl: process.env.SEED_FEED_WSL_DISTRO || "feed-solver" };
  },
  nodal: () => {
    const repo = first(process.env.SEED_NODAL_REPO, path.join(appDir("nodal-studio")));
    process.env.SEED_NODAL_REPO = repo;
    process.env.SEED_NODAL_PYTHON = first(process.env.SEED_NODAL_PYTHON, path.join(repo, ".venv", "Scripts", "python.exe"), path.join(appDir("nodal-studio"), ".venv", "Scripts", "python.exe"));
    return {
      repo,
      settings: (e) => {
        const commands = e.inputs.find((i) => i.path.endsWith(".commands.json"));
        return { model: e.inputs[0].path, ...(commands ? { commands: commands.path } : {}) };
      },
      artifact: (e) => e.inputs[0],
      wsl: null,
    };
  },
  pra: () => {
    const repo = first(process.env.SEED_PRA_REPO, path.join(appDir("sneed")));
    process.env.SEED_PRA_REPO = repo;
    return { repo, settings: (e) => ({ model: e.inputs[0].path }), artifact: (e) => e.inputs[0], wsl: null };
  },
  openmc: () => {
    const repo = first(process.env.SEED_OPENMC_REPO, path.join(appDir("openmc-studio")));
    const distro = process.env.SEED_OPENMC_WSL_DISTRO || "Ubuntu";
    Object.assign(process.env, {
      SEED_OPENMC_REPO: repo,
      SEED_ELECTRON: process.env.SEED_ELECTRON || path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"),
      SEED_OPENMC_PYTHON: process.env.SEED_OPENMC_PYTHON || "/root/miniconda3/envs/openmc-mcnp/bin/python",
      SEED_OPENMC_DATA: process.env.SEED_OPENMC_DATA || "/root/nuclear_data/endfb-viii.0-hdf5/cross_sections.xml",
      SEED_OPENMC_WSL_DISTRO: distro,
    });
    return {
      repo,
      settings: (e) => ({ project: e.inputs.find((i) => i.path.endsWith(".json")).path, ...(e.inputs.find((i) => i.path.endsWith(".py")) ? { model: e.inputs.find((i) => i.path.endsWith(".py")).path } : {}), threads: 1 }),
      artifact: (e) => e.inputs.find((i) => i.path.endsWith(".json")),
      wsl: distro,
    };
  },
};
if (!cfg[app]) {
  console.error("usage: node scripts/measure-resources.cjs <raft|feed|nodal|pra|openmc> [--out file.json]");
  process.exit(2);
}
const c = cfg[app]();
const entriesDir = path.join(c.repo, "oracles", "seed", "entries");
process.env["SEED_" + (app === "pra" ? "PRA" : app.toUpperCase()) + "_ORACLES"] = entriesDir;

const dirBytes = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
};

// Windows: peak of the summed working sets of this process's descendants
function startWinSampler() {
  if (process.platform !== "win32") return null;
  const ps = path.join(os.tmpdir(), "seed-measure-sampler.ps1");
  fs.writeFileSync(
    ps,
    `param([int]$root)\nwhile ($true) {\n  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize\n  $ids = @{ $root = $true }; $grew = $true\n  while ($grew) { $grew = $false; foreach ($p in $all) { if (-not $ids.ContainsKey([int]$p.ProcessId) -and $ids.ContainsKey([int]$p.ParentProcessId)) { $ids[[int]$p.ProcessId] = $true; $grew = $true } } }\n  $sum = 0; foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ProcessId) -and [int]$p.ProcessId -ne $root -and [int]$p.ProcessId -ne $PID) { $sum += [double]$p.WorkingSetSize } }\n  Write-Output ([math]::Round($sum / 1MB, 1))\n  Start-Sleep -Milliseconds 400\n}\n`
  );
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, String(process.pid)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let peak = 0;
  child.stdout.on("data", (d) => {
    for (const l of String(d).split(/\r?\n/)) {
      const v = Number(l.trim());
      if (l.trim() !== "" && Number.isFinite(v) && v > peak) peak = v;
    }
  });
  return { peak: () => peak, reset: () => (peak = 0), stop: () => spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]) };
}

// WSL: peak rise of used memory (MemTotal - MemAvailable) over the value when the run started
function startWslSampler(distro) {
  if (!distro || process.platform !== "win32") return null;
  const used = () => {
    const r = spawnSync("wsl.exe", ["-d", distro, "--exec", "/usr/bin/cat", "/proc/meminfo"], { encoding: "utf8" });
    const g = (k) => Number((new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(r.stdout || "") || [0, NaN])[1]);
    return (g("MemTotal") - g("MemAvailable")) / 1024;
  };
  let base = used();
  let peak = 0;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const u = used();
      if (Number.isFinite(u) && u - base > peak) peak = u - base;
      await new Promise((r) => setTimeout(r, 700));
    }
  };
  loop();
  return { peak: () => peak, reset: () => { base = used(); peak = 0; }, stop: () => { stopped = true; } };
}

(async () => {
  const { entries } = loadOracleEntries(entriesDir);
  const good = entries.filter((i) => i.entry.tag === "good").map((i) => i.entry);
  const baseDir = path.join(c.repo, "oracles", "seed");
  const spec = { command: process.execPath, args: [path.join(root, "adapters", app, "cli.cjs")], id: app, version: "0.1.0" };
  const actor = { kind: "agent", name: "measure", model: "measure" };
  const budget = { maxWallSeconds: 900, maxCores: 1, maxMemoryMB: 16384, maxDiskMB: 4096 };
  const win = startWinSampler();
  const wsl = startWslSampler(c.wsl);
  await new Promise((r) => setTimeout(r, 1500));
  const rows = [];
  for (const entry of good) {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "seed-measure-"));
    for (const d of ["models", "runs"]) fs.mkdirSync(path.join(proj, d), { recursive: true });
    for (const i of entry.inputs) {
      fs.mkdirSync(path.join(proj, path.dirname(i.path)), { recursive: true });
      fs.copyFileSync(path.join(baseDir, i.path), path.join(proj, i.path));
    }
    const a = c.artifact(entry);
    const mgr = new RunManager({ projectRoot: proj, runsFolder: "runs", adapter: spec, pollMs: 200, callTimeoutMs: 600000 });
    if (win) win.reset();
    if (wsl) wsl.reset();
    const t0 = Date.now();
    const out = await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact: { path: a.path, revision: { hash: a.sha256, counter: 1 } }, inputs: entry.inputs, budget, settings: c.settings(entry) });
    const wall = (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 800));
    const row = { oracleId: entry.oracleId, state: out.ok ? out.state : "refused", wallSeconds: Math.round(wall * 10) / 10, diskMB: out.ok ? Math.round((dirBytes(path.join(proj, "runs", out.runId)) / 1048576) * 100) / 100 : null, winPeakMB: win ? win.peak() : null, wslPeakRiseMB: wsl ? Math.round(wsl.peak()) : null };
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.rmSync(proj, { recursive: true, force: true });
  }
  if (win) win.stop();
  if (wsl) wsl.stop();
  const ok = rows.filter((r) => r.state === "completed");
  const max = (k) => ok.reduce((m, r) => (r[k] != null && r[k] > m ? r[k] : m), 0);
  const summary = {
    app,
    measuredAt: new Date().toISOString(),
    platform: process.platform + " " + os.release(),
    runs: rows.length,
    completed: ok.length,
    wallSecondsMax: max("wallSeconds"),
    wallSecondsMedian: ok.map((r) => r.wallSeconds).sort((x, y) => x - y)[Math.floor(ok.length / 2)] ?? null,
    diskMBMax: max("diskMB"),
    winPeakMBMax: max("winPeakMB"),
    wslPeakRiseMBMax: max("wslPeakRiseMB"),
    rows,
  };
  console.log("SUMMARY " + JSON.stringify({ ...summary, rows: undefined }));
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
})().catch((e) => { console.error(e); process.exit(1); });
