"use strict";
// SEED adapter for Virtual Reactor (RAFT), transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps RAFT's headless runner (raft-headless.mjs, built by `npm run build:headless` in RAFT's web folder).
// The runner's location comes from the environment of the host, never from a project file or a request:
//   SEED_RAFT_HEADLESS   absolute path of raft-headless.mjs
//   SEED_RAFT_ORACLES    optional, absolute path of RAFT's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).
//
// Project files are not trusted: every path in a request is checked here again (the client's schema check is not
// relied on), state folders must be real folders inside the run folder, and a process is only killed after its
// command line shows it is this adapter's job wrapper for that run folder.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const {
  MAX_CAPTURE,
  portableRel,
  commandLine,
  atomicWrite,
  json,
  readJson,
  insideRoot,
  containedBelow,
  findJob,
  snapshotProblem,
  appFailed,
  sha256,
  argvOf,
  normPath,
  typed,
  jobState,
} = require("../shared/util.cjs");
const { serve, startJob, statusJob, cancelJob } = require("../shared/flow.cjs");

const ADAPTER = { id: "raft", version: "0.1.0" };
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
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the case path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the case file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the case file does not match the revision named in the request"));
  }
  const parsed = parseJson(bytes.toString("utf8"));
  if (parsed && typeof parsed.library === "string" && portableRel(parsed.library)) {
    const lib = insideRoot(root, path.relative(root, path.resolve(path.dirname(art.abs), parsed.library)).split(path.sep).join("/"));
    if (lib.escaped) problems.push(typed("E_PATH_TRAVERSAL", "/library", "the library folder leaves the project"));
  }
  if (problems.every((p) => p.code === "E_STALE_REVISION")) {
    const res = await runBundle(bundle, ["validate", art.abs]);
    const out = parseJson(res.stdout);
    if (res.code === 0 && out && out.ok === true) {
      // the runner accepted the case: keep whatever problems we already have
    } else if (res.code === 2 && out && out.ok === false) {
      const mapped = mapErrors(out.errors);
      // A refusal without a usable reason is still a refusal: never let it pass as valid.
      problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the case without giving a reason", "app-content")]));
    } else {
      return fail(appFailed("the RAFT runner could not validate the case", res));
    }
  }
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

async function run(request, root, reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const found = insideRoot(root, request.runDir);
  if (found.escaped) return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the run folder leaves the project"));
  if (found.missing) return fail(typed("E_NOT_FOUND", "/runDir", "the run folder does not exist; the host creates it with the input snapshot first"));
  const absRunDir = found.abs;
  const inputs = Array.isArray(request.snapshot && request.snapshot.inputs) ? request.snapshot.inputs : [];
  if (inputs.length === 0) return fail(typed("E_PROP_MISSING", "/snapshot/inputs", "the snapshot has no inputs"));
  for (let i = 0; i < inputs.length; i++) {
    if (!portableRel(inputs[i] && inputs[i].path)) return fail(typed("E_PATH_INVALID", "/snapshot/inputs/" + i + "/path", "input paths must be portable relative paths"));
  }

  const settings = request.settings || {};
  let casePath = typeof settings.case === "string" ? settings.case : null;
  if (casePath === null) {
    const guesses = inputs.filter((i) => i.path.endsWith("case.json"));
    if (guesses.length === 1) casePath = guesses[0].path;
  }
  if (casePath === null) return fail(typed("E_PROP_MISSING", "/settings/case", "name the case file with settings.case (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === casePath)) return fail(typed("E_PROP_MISSING", "/settings/case", "settings.case is not one of the snapshot inputs"));
  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const caseAbs = path.join(absRunDir, "inputs", casePath);
  const caseJson = readJson(caseAbs);
  if (!caseJson) return fail(typed("E_APP_FAILED", "/settings/case", "the snapshot copy of the case is not JSON"));
  if (request.seed !== undefined && request.seed !== caseJson.seed) {
    return fail(typed("E_REQUEST_CONFLICT", "/seed", "the request seed differs from the seed in the case; change the case instead"));
  }

  const outDir = path.join(absRunDir, "native", "out");
  return startJob({
    root, request, absRunDir, reply, fail,
    record: { case: casePath, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) },
    runSpec: { command: process.execPath, args: [bundle, "run", caseAbs, "--out", outDir, "--run-id", "raft"] },
  });
}

function status(request, root, reply, fail) {
  return statusJob({ request, root, reply, fail });
}


/** A runner left behind by a dead wrapper: ours only when its command line runs the headless bundle's `run` on this run folder's own output folder. */
function ownsRunner(j, pid) {
  const bundle = bundlePath();
  const cl = commandLine(pid);
  if (!bundle || cl === null) return false;
  const args = argvOf(cl).map(normPath);
  return args.includes(normPath(bundle)) && args.includes("run") && args.includes(normPath(path.join(j.absRunDir, "native", "out")));
}

async function cancel(request, root, reply, fail) {
  return cancelJob({ request, root, reply, fail, ownsRunner });
}

function collect(request, root, reply, fail) {
  const incomplete = (message, field = "") => fail(typed("E_OUTPUT_INCOMPLETE", field, message));
  const found = insideRoot(root, request.runDir);
  if (found.escaped || found.missing) return incomplete("the run folder is not available");
  // The job named in the request must be the one registered for this run folder.
  const j = findJob(root, request.jobId);
  if (!j || j.absRunDir !== found.abs) return incomplete("the job is not registered for this run folder");
  const nativeDir = j.nativeDir;
  const job = j.job;
  const s = jobState(nativeDir, job);
  if (s.lifecycle !== "completed") return incomplete("job is not completed");

  const snapshotIssue = snapshotProblem(found.abs, job.inputs);
  if (snapshotIssue) return incomplete("the snapshot changed after the run was registered: " + snapshotIssue);
  const outDir = path.join(nativeDir, "out", "raft");
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
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
  const caseJson = readJson(path.join(found.abs, "inputs", job.case));
  if (!Array.isArray(results.samples) || results.samples.length === 0) return incomplete("results.json has no samples");
  // The run must have covered the whole case, and every count must agree.
  const last = results.samples[results.samples.length - 1];
  if (!caseJson || !Number.isInteger(caseJson.steps) || results.completion.steps !== caseJson.steps || results.completion.stepsRun !== caseJson.steps || manifest.stepsRun !== caseJson.steps || manifest.steps !== caseJson.steps || last.step !== caseJson.steps) {
    return incomplete("the run did not cover every step of the case");
  }

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
    ...(Number.isInteger(caseJson.seed) ? { seed: caseJson.seed } : {}),
    quantities,
    extensions: { raft: { libraryDigest: results.libraryDigest, caseSha256: results.caseSha256, runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256 } },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

serve({ describe: (_request, _root, reply, fail) => describe(reply, fail), validate, run, status, cancel, collect }, "RAFT's editor is its web app; this headless adapter does not open it");
