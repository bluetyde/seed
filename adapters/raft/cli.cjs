"use strict";
// SEED adapter for Virtual Reactor (RAFT), transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps RAFT's headless runner (raft-headless.mjs, built by `npm run build:headless` in RAFT's web folder).
// The runner's location comes from the environment of the host, never from a project file or a request:
//   SEED_RAFT_HEADLESS   absolute path of raft-headless.mjs
//   SEED_RAFT_ORACLES    optional, absolute path of RAFT's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ADAPTER = { id: "raft", version: "0.1.0" };
const MAX_CAPTURE = 1024 * 1024;
const HEARTBEAT_FRESH_MS = 5000;
const QUANTITIES = [
  { name: "power", key: "power", unit: "W" },
  { name: "fuelTemp", key: "fuelTemp", unit: "K" },
  { name: "coolantTemp", key: "coolantTemp", unit: "K" },
  { name: "energy", key: "energy", unit: "J" },
  { name: "reactivityTotal", key: "reactivityTotal", unit: "dk/k" },
];
const CODE_MAP = {
  E_CASE_INVALID: "E_SCHEMA_INVALID",
  E_CASE_VERSION: "E_SCHEMA_VERSION",
  E_PATH_INVALID: "E_PATH_INVALID",
  E_NOT_FOUND: "E_NOT_FOUND",
  E_LIBRARY: "E_SCHEMA_INVALID",
  E_INIT_INVALID: "E_SCHEMA_INVALID",
  E_INIT_NO_EQUILIBRIUM: "E_OUT_OF_DOMAIN",
  E_EXISTS: "E_EXISTS",
};

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const typed = (code, field, message, source = "seed") => ({ code, field, message: String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 900), source });

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    if (err && err.code === "EPERM") return true;
    throw err;
  }
}

/** Kill a process tree: taskkill /T on Windows, the process group on POSIX (the job is its own group leader). */
async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new RangeError("refusing to kill pid " + pid);
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const cp = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      cp.on("error", () => resolve());
      cp.on("close", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      if (!err || err.code !== "ESRCH") throw err;
      try {
        process.kill(pid, "SIGKILL");
      } catch (err2) {
        if (!err2 || err2.code !== "ESRCH") throw err2;
      }
    }
  }
}

async function waitDead(pid, ms) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !isAlive(pid);
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
const json = (v) => JSON.stringify(v, null, 2) + "\n";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Real path of `rel` under `root`, or null when it leaves the root (lexically or through a link). Missing files give {missing: true}. */
function insideRoot(root, rel) {
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return { escaped: true };
  const abs = path.resolve(root, rel);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { escaped: true };
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true, abs };
    return { escaped: true };
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b));
  return same(real + path.sep, prefix) ? { abs: real } : { escaped: true };
}

function bundlePath() {
  const p = process.env.SEED_RAFT_HEADLESS;
  if (!p || !path.isAbsolute(p)) return null;
  return fs.existsSync(p) ? p : null;
}

function runBundle(bundle, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function mapErrors(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 20).map((e) => {
    const raft = e && typeof e.code === "string" ? e.code : "E_APP_FAILED";
    const code = CODE_MAP[raft] || "E_APP_FAILED";
    return typed(code, e && typeof e.field === "string" ? e.field : "", raft + ": " + (e && e.message), "app-content");
  });
}

const setupError = () =>
  typed("E_SETUP_REQUIRED", "", "the RAFT headless runner is not configured: set SEED_RAFT_HEADLESS to the absolute path of raft-headless.mjs (npm run build:headless in RAFT's web folder)");

function appFailed(what, res) {
  const tail = (res.stderr || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(-300);
  return typed("E_APP_FAILED", "", what + (res.timedOut ? " (timed out)" : " (exit " + res.code + ")") + (tail ? ": " + tail : ""), tail ? "app-content" : "seed");
}

function jobIndexPath(root, jobId) {
  return path.join(root, ".seed", "jobs", jobId + ".json");
}

function findJob(root, jobId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(jobId)) return null;
  const idx = readJson(jobIndexPath(root, jobId));
  if (!idx || typeof idx.runDir !== "string") return null;
  const found = insideRoot(root, idx.runDir);
  if (!found.abs) return null;
  const nativeDir = path.join(found.abs, "native");
  const job = readJson(path.join(nativeDir, "job.json"));
  if (!job || job.jobId !== jobId) return null;
  return { nativeDir, absRunDir: found.abs, runDir: idx.runDir, job };
}

function jobState(nativeDir, job) {
  const status = readJson(path.join(nativeDir, "status.json"));
  const heartbeatPath = path.join(nativeDir, "heartbeat.json");
  let fresh = false;
  let tokenOk = false;
  try {
    fresh = Date.now() - fs.statSync(heartbeatPath).mtimeMs <= HEARTBEAT_FRESH_MS;
    const hb = readJson(heartbeatPath);
    tokenOk = !!hb && hb.token === job.token;
  } catch {
    // no heartbeat yet or any more
  }
  const value = status && status.status;
  const alive = isAlive(job.pid);
  if (value === "finished") return { lifecycle: "completed", native: { status: "finished" }, status, alive, fresh, tokenOk };
  if (value === "failed") return { lifecycle: "failed", native: { status: "failed", ...(status.detail ? { detail: String(status.detail) } : {}) }, status, alive, fresh, tokenOk };
  if (value === "cancelled") return { lifecycle: "cancelled", native: { status: "cancelled" }, status, alive, fresh, tokenOk };
  if (!value || value === "running") {
    if (alive && fresh) return { lifecycle: "running", native: { status: "running" }, status, alive, fresh, tokenOk };
    return { lifecycle: "failed", native: { status: "died", detail: "the job process ended without a final status" }, status, alive, fresh, tokenOk };
  }
  return { lifecycle: "failed", native: { status: String(value).slice(0, 80) }, status, alive, fresh, tokenOk };
}

async function main() {
  const verb = process.argv[2];
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stderr.write("invalid JSON on stdin\n");
    process.exit(1);
  }
  const root = process.env.SEED_PROJECT_ROOT || process.cwd();
  const reply = (doc) => {
    const out = {
      schema: "seed.adapter-reply/0.1",
      verb,
      requestId: request && request.requestId ? request.requestId : "unknown",
      ok: doc.ok,
      errors: doc.errors || [],
      warnings: doc.warnings || [],
      ...(doc.result !== undefined ? { result: doc.result } : {}),
    };
    process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
  };
  const fail = (...errors) => reply({ ok: false, errors });

  try {
    if (!request || request.verb !== verb) return fail(typed("E_SCHEMA_INVALID", "/verb", "the request verb does not match the command"));
    if (verb === "describe") return await describe(reply, fail);
    if (verb === "open") return fail(typed("E_VERB_UNKNOWN", "/verb", "RAFT's editor is its web app; this headless adapter does not open it"));
    if (verb === "validate") return await validate(request, root, reply, fail);
    if (verb === "run") return await run(request, root, reply, fail);
    if (verb === "status") return status(request, root, reply, fail);
    if (verb === "cancel") return await cancel(request, root, reply, fail);
    if (verb === "collect") return collect(request, root, reply, fail);
    return fail(typed("E_VERB_UNKNOWN", "/verb", "unknown verb"));
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "adapter failure: " + (err && err.message)));
  }
}

/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_RAFT_ORACLES;
  if (!dir || !path.isAbsolute(dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const e = readJson(path.join(dir, n));
    if (!e || e.schema !== "seed.oracle/0.1" || e.tag !== "good" || e.adapter !== ADAPTER.id || !e.coverage) continue;
    for (const q of Array.isArray(e.coverage.quantities) ? e.coverage.quantities : []) {
      const key = q + "|" + e.coverage.domain;
      if (typeof q === "string" && typeof e.coverage.domain === "string" && !seen.has(key)) {
        seen.add(key);
        out.push({ quantity: q, domain: e.coverage.domain.slice(0, 500) });
      }
    }
  }
  return out;
}

async function describe(reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const res = await runBundle(bundle, ["describe"]);
  const d = parseJson(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true) return fail(appFailed("the RAFT runner could not describe itself", res));
  reply({
    ok: true,
    result: {
      app: { id: "raft", name: "Virtual Reactor (RAFT)", version: d.engine.version },
      engine: { name: "raft-engine", version: d.engine.version },
      formats: [{ id: d.caseFormat.format, version: String(d.caseFormat.version) }],
      capabilities: [d.engine.capability, "validate", "run", "cancel", "collect", "replay"],
      parameters: [{ id: "seed", type: "integer", min: 0 }],
      quantities: QUANTITIES.map((q) => ({ name: q.name, unit: q.unit, normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const problems = [];
  const art = insideRoot(root, request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the case path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the case file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the case file does not match the revision named in the request"));
  }
  const parsed = parseJson(bytes.toString("utf8"));
  if (parsed && typeof parsed.library === "string" && !path.isAbsolute(parsed.library) && !parsed.library.split(/[\\/]/).includes("..")) {
    const lib = insideRoot(root, path.relative(root, path.resolve(path.dirname(art.abs), parsed.library)));
    if (lib.escaped) problems.push(typed("E_PATH_TRAVERSAL", "/library", "the library folder leaves the project"));
  }
  if (problems.length === 0 || problems.every((p) => p.code === "E_STALE_REVISION")) {
    const res = await runBundle(bundle, ["validate", art.abs]);
    const out = parseJson(res.stdout);
    if (res.code === 0 && out && out.ok === true) {
      // fall through with whatever problems we already have
    } else if (res.code === 2 && out && out.ok === false) {
      problems.push(...mapErrors(out.errors));
    } else {
      return fail(appFailed("the RAFT runner could not validate the case", res));
    }
  }
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

async function run(request, root, reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const absRunDir = path.resolve(root, request.runDir);
  const found = insideRoot(root, request.runDir);
  if (found.escaped) return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the run folder leaves the project"));
  const nativeDir = path.join(absRunDir, "native");
  const jobJsonPath = path.join(nativeDir, "job.json");
  const inputs = request.snapshot.inputs;

  const settings = request.settings || {};
  let casePath = typeof settings.case === "string" ? settings.case : null;
  if (casePath === null) {
    const guesses = inputs.filter((i) => i.path.endsWith("case.json"));
    if (guesses.length === 1) casePath = guesses[0].path;
  }
  if (casePath === null) return fail(typed("E_PROP_MISSING", "/settings/case", "name the case file with settings.case (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === casePath)) return fail(typed("E_PROP_MISSING", "/settings/case", "settings.case is not one of the snapshot inputs"));
  const caseAbs = path.join(absRunDir, "inputs", casePath);
  const caseJson = readJson(caseAbs);
  if (!caseJson) return fail(typed("E_APP_FAILED", "/settings/case", "the snapshot copy of the case is missing or not JSON"));
  if (request.seed !== undefined && request.seed !== caseJson.seed) {
    return fail(typed("E_REQUEST_CONFLICT", "/seed", "the request seed differs from the seed in the case; change the case instead"));
  }

  if (fs.existsSync(jobJsonPath)) {
    const existing = readJson(jobJsonPath);
    if (existing && existing.requestId === request.requestId) {
      return reply({ ok: true, result: { jobId: existing.jobId, runDir: request.runDir, lifecycle: "running" } });
    }
    return fail(typed("E_REQUEST_CONFLICT", "", "this run folder already belongs to another request"));
  }

  fs.mkdirSync(nativeDir, { recursive: true });
  const jobId = ("job-" + request.requestId.replace(/[^A-Za-z0-9._-]/g, "_")).slice(0, 59);
  const token = crypto.randomBytes(8).toString("hex");
  const child = spawn(process.execPath, [path.join(__dirname, "job.cjs"), absRunDir, caseAbs, bundle, token], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  atomicWrite(
    jobJsonPath,
    json({ jobId, requestId: request.requestId, pid: child.pid, token, case: casePath, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) })
  );
  atomicWrite(jobIndexPath(root, jobId), json({ runDir: request.runDir }));
  reply({ ok: true, result: { jobId, runDir: request.runDir, lifecycle: "running" } });
}

function status(request, root, reply, fail) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const s = jobState(j.nativeDir, j.job);
  reply({
    ok: true,
    result: {
      jobId: request.jobId,
      lifecycle: s.lifecycle,
      native: s.native,
      ...(s.status && s.status.startedAt ? { startedAt: s.status.startedAt } : {}),
      ...(s.status && s.status.finishedAt ? { finishedAt: s.status.finishedAt } : {}),
    },
  });
}

async function cancel(request, root, reply, fail) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const s = jobState(j.nativeDir, j.job);
  if (s.lifecycle !== "running") {
    // already over (or died): nothing to stop, and nothing was cancelled by this call
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: s.lifecycle, cancelled: false } });
  }
  // Own the process before killing it: the heartbeat carries the token only this job knows (guards against pid reuse).
  if (!s.tokenOk) return fail(typed("E_NOT_OWNED", "/jobId", "the process behind this job is not owned by this run"));
  const child = readJson(path.join(j.nativeDir, "child.json"));
  await killTree(j.job.pid);
  const dead = await waitDead(j.job.pid, 5000);
  const childDead = child && Number.isInteger(child.pid) ? await waitDead(child.pid, 5000) : true;
  if (!dead || !childDead) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  }
  atomicWrite(path.join(j.nativeDir, "status.json"), json({ status: "cancelled", startedAt: s.status && s.status.startedAt, finishedAt: new Date().toISOString() }));
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "cancelled", cancelled: true } });
}

function collect(request, root, reply, fail) {
  const incomplete = (message, field = "") => fail(typed("E_OUTPUT_INCOMPLETE", field, message));
  const found = insideRoot(root, request.runDir);
  if (found.escaped || found.missing) return incomplete("the run folder is not available");
  const nativeDir = path.join(found.abs, "native");
  const job = readJson(path.join(nativeDir, "job.json"));
  if (!job) return incomplete("job not found");
  const s = jobState(nativeDir, job);
  if (s.lifecycle !== "completed") return incomplete("job is not completed");

  const outDir = path.join(nativeDir, "out", "raft");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "raft-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the RAFT run folder has no completed manifest");
  }
  const expected = ["case.json", "results.json", "session.json"];
  if (JSON.stringify(manifest.files.map((f) => f.path).sort()) !== JSON.stringify(expected)) return incomplete("the RAFT manifest does not list exactly its three files");
  for (const f of manifest.files) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
  }
  const results = readJson(path.join(outDir, "results.json"));
  if (!results || results.format !== "raft-headless-results" || !results.completion || results.completion.status !== "completed") return incomplete("results.json is not a completed result");
  const usedCase = fs.readFileSync(path.join(outDir, "case.json"));
  const snapshotCase = fs.readFileSync(path.join(found.abs, "inputs", job.case));
  if (sha256(usedCase) !== sha256(snapshotCase) || results.caseSha256 !== sha256(snapshotCase)) return incomplete("the run did not use the snapshot's case");
  if (!Array.isArray(results.samples) || results.samples.length === 0) return incomplete("results.json has no samples");

  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  for (const q of QUANTITIES) {
    const t = [];
    const values = [];
    for (const sample of results.samples) {
      if (typeof sample.t !== "number" || !Number.isFinite(sample.t) || typeof sample[q.key] !== "number" || !Number.isFinite(sample[q.key])) {
        return incomplete("sample values for " + q.name + " are missing or not finite", "/quantities/" + q.name);
      }
      t.push(sample.t);
      values.push(sample[q.key]);
    }
    const text = json({ quantity: q.name, unit: q.unit, t, values });
    const rel = request.runDir + "/native/series/" + q.name + ".json";
    atomicWrite(path.join(nativeDir, "series", q.name + ".json"), text);
    quantities.push({
      name: q.name,
      unit: q.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: rel, sha256: sha256(text) },
      verification: "unverified",
      coordinates: { system: "time", axes: [{ name: "t", unit: "s" }] },
    });
  }
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: "raft-engine", version: results.engine.version },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "RAFT run completed: " + results.completion.stepsRun + " steps, " + results.samples.length + " samples" },
    seed: Number.isInteger(readJson(path.join(found.abs, "inputs", job.case)).seed) ? readJson(path.join(found.abs, "inputs", job.case)).seed : undefined,
    quantities,
    extensions: { raft: { libraryDigest: results.libraryDigest, caseSha256: results.caseSha256, runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256 } },
  };
  if (index.seed === undefined) delete index.seed;
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

main();
