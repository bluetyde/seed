"use strict";
// OpenMC Studio's runner as the host reaches it: where it is (the environment), how it is launched (WSL on Windows), how a verb is run to completion, and
// the two things SEED asks of Studio besides runs: its own generator of model.py from a project (regenerate) and its transfer command (studioTransfer).
// Shared by the adapter (cli.cjs) and the coupling loop's passes (src/core/couplingLumped.ts); nothing here reads a request or a project.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { BACKSLASH, MAX_CAPTURE, win, winDir, typed } = require("../shared/util.cjs");

// ---- configuration and launching -------------------------------------------------------------------------------------------------

/** A Windows drive path as WSL sees it (C:\a\b -> /mnt/c/a/b), or null (a UNC or relative path cannot be mapped). */
function toWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return "/mnt/" + m[1].toLowerCase() + "/" + m[2].split(BACKSLASH).join("/");
}

/** The configured parts, or {setup: message}. Nothing is installed or guessed. */
function config() {
  const repo = process.env.SEED_OPENMC_REPO;
  const electron = process.env.SEED_ELECTRON;
  const python = process.env.SEED_OPENMC_PYTHON;
  const data = process.env.SEED_OPENMC_DATA;
  if (!repo || !path.isAbsolute(repo)) return { setup: "set SEED_OPENMC_REPO to the absolute path of the openmc-studio checkout" };
  const regenScript = path.join(repo, "studio", "tools", "regen_script.cjs");
  const html = path.join(repo, "studio", "openmc_studio", "static", "index.html");
  try {
    if (!fs.statSync(regenScript).isFile() || !fs.statSync(html).isFile()) throw new Error("missing");
  } catch {
    return { setup: "SEED_OPENMC_REPO does not hold studio/tools/regen_script.cjs (an openmc-studio checkout with the SEED integration)" };
  }
  if (!electron || !path.isAbsolute(electron) || !fs.existsSync(electron)) return { setup: "set SEED_ELECTRON to the absolute path of SEED's Electron binary" };
  if (!python || !data) return { setup: "set SEED_OPENMC_PYTHON (Python with OpenMC, as the runtime sees it) and SEED_OPENMC_DATA (cross_sections.xml)" };
  const studioDir = path.join(repo, "studio");
  const cfg = { repo, electron, regenScript, html, python, data };
  if (win) {
    cfg.distro = process.env.SEED_OPENMC_WSL_DISTRO || "Ubuntu";
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(cfg.distro)) return { setup: "SEED_OPENMC_WSL_DISTRO is not a valid distro name" };
    cfg.studioRuntime = toWsl(studioDir);
    if (!cfg.studioRuntime || !python.startsWith("/") || !data.startsWith("/")) return { setup: "on Windows the repository must be on a drive letter and SEED_OPENMC_PYTHON / SEED_OPENMC_DATA must be WSL paths" };
  } else {
    cfg.studioRuntime = studioDir;
  }
  return cfg;
}

/** A project path as the runtime sees it. */
function rt(cfg, p) {
  if (!win) return p;
  const w = toWsl(p);
  if (!w) throw new Error("path cannot be mapped into WSL: " + p);
  return w;
}

/** The launch spec {command, args, env?} for one runner verb. WSL: wsl.exe --exec env VAR=... python -m openmc_studio.headless ... */
function launchSpec(cfg, verbArgs) {
  const vars = ["PYTHONPATH=" + cfg.studioRuntime, "PYTHONDONTWRITEBYTECODE=1", "PYTHONUTF8=1", "PYTHONIOENCODING=utf-8", "OPENMC_CROSS_SECTIONS=" + cfg.data];
  if (win) return { command: winDir() + "/System32/wsl.exe", args: ["-d", cfg.distro, "--cd", "/", "--exec", "/usr/bin/env", ...vars, cfg.python, "-m", "openmc_studio.headless", ...verbArgs] };
  const env = {};
  for (const v of vars) env[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
  return { command: cfg.python, args: ["-m", "openmc_studio.headless", ...verbArgs], env };
}

/** Run a spec to completion (bounded); stdout/stderr captured. */
function runSpec(spec, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { env: spec.env ? { ...process.env, ...spec.env } : process.env, stdio: [spec.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
      if (spec.input !== undefined) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(spec.input);
      }
    } catch (err) {
      return resolve({ code: null, stdout: "", stderr: String(err && err.message), timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err.message), timedOut: false });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** The last line of stdout as JSON (WSL may print notices first), or null. */
function parseLast(text) {
  const lines = String(text).trim().split(String.fromCharCode(10));
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Regenerate model.py from a project file with Studio's own page. Returns {script, problems} or {error}. */
async function regenerate(cfg, projectAbs, outAbs) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // that variable would make Electron a plain Node and the page would never load
  const res = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.electron, [cfg.regenScript, projectAbs, outAbs, cfg.html], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve({ code: null, stdout: "", stderr: String(err && err.message) });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 90000);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr + String(err.message) }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const reply = parseLast(res.stdout);
  if (!reply || (res.code !== 0 && res.code !== 3) || reply.ok !== true) {
    return { error: typed("E_SETUP_REQUIRED", "", "the script regeneration could not run: " + ((reply && reply.error) || (res.stderr || "").slice(-200) || "exit " + res.code), "seed") };
  }
  return { problems: Array.isArray(reply.problems) ? reply.problems.map(String) : [], sha256: reply.sha256, chrome: reply.chrome };
}


/**
 * Studio's own transfer command (`headless transfer`): a seed.transfer-request/0.2 on stdin, one reply line on stdout. Returns the parsed reply, or
 * {ok: false, errors} when the command could not run or did not answer in JSON.
 */
async function studioTransfer(cfg, request, timeoutMs = 120000) {
  const res = await runSpec({ ...launchSpec(cfg, ["transfer"]), input: JSON.stringify(request) }, timeoutMs);
  const reply = parseLast(res.stdout);
  if (reply && typeof reply === "object" && typeof reply.ok === "boolean") return reply;
  return { ok: false, errors: [{ code: "E_APP_FAILED", message: "the Studio transfer command did not answer: " + (res.timedOut ? "timed out" : ((res.stderr || "").slice(-200) || "exit " + res.code)) }] };
}

module.exports = { toWsl, config, rt, launchSpec, runSpec, parseLast, regenerate, studioTransfer };
