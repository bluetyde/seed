"use strict";
// SEED adapter for SNEED (PRA), transport "CLI per verb": the request is JSON on stdin, one seed.adapter-reply/0.1 JSON object goes to
// stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps SNEED's headless runner (dist/node/cli/headless.js: describe, validate, run, cancel; docs/HEADLESS.md in the SNEED repository),
// which starts SCRAM inside WSL itself. Configuration comes from the host's environment, never from a project file or a request:
//   SEED_PRA_REPO      absolute path of the SNEED checkout, built with `npm run build:cli`
//   SEED_PRA_NODE      optional, absolute path of the Node binary that runs the runner (default: the one running this adapter)
//   SEED_PRA_ORACLES   optional, absolute path of SNEED's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client). Project files are not trusted: every path in a request is
// checked again here, state folders must be real folders inside the run folder, and a process is only killed after its command line shows it
// is this adapter's. Structure follows adapters/openmc (runner-first cancel); the model is a data file, so nothing is regenerated.

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

const ADAPTER = { id: "pra", version: "0.1.0" };
const RUN_ID = "pra";












// ---- configuration and launching -------------------------------------------------------------------------------------------------

/** The configured parts, or {setup: message}. Nothing is installed or guessed. */
function config() {
  const repo = process.env.SEED_PRA_REPO;
  if (!repo || !path.isAbsolute(repo)) return { setup: "set SEED_PRA_REPO to the absolute path of the SNEED checkout (built with npm run build:cli)" };
  const runner = path.join(repo, "dist", "node", "cli", "headless.js");
  try {
    if (!fs.statSync(runner).isFile()) throw new Error("missing");
  } catch {
    return { setup: "SEED_PRA_REPO does not hold dist/node/cli/headless.js: run npm run build:cli in the SNEED checkout" };
  }
  const node = process.env.SEED_PRA_NODE || process.execPath;
  if (!path.isAbsolute(node) || !fs.existsSync(node)) return { setup: "SEED_PRA_NODE must be the absolute path of a Node binary" };
  return { repo, runner, node };
}

/** The launch spec {command, args} for one runner verb. SCRAM runs inside WSL under the runner's own control. */
function launchSpec(cfg, verbArgs) {
  return { command: cfg.node, args: [cfg.runner, ...verbArgs] };
}

/** Run a spec to completion (bounded); stdout/stderr captured. */
function runSpec(spec, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { env: spec.env ? { ...process.env, ...spec.env } : process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

/** The last line of stdout as JSON, or null. */
function parseLast(text) {
  const lines = String(text).trim().split(String.fromCharCode(10));
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

const setupError = (message) => typed("E_SETUP_REQUIRED", "", "the SNEED runner is not configured: " + message);


/** SNEED's codes: E_SCHEMA is SEED's E_SCHEMA_INVALID; its other E_ codes (E_CYCLE, E_PROB_RANGE, ...) are adapter codes and pass through. */
function mapCode(code) {
  if (code === "E_SCHEMA") return "E_SCHEMA_INVALID";
  return typeof code === "string" && /^E_[A-Z0-9_]{1,60}$/.test(code) ? code : "E_APP_FAILED";
}

/** Typed errors from the runner. Messages quote ids from the model, so they are app content and sanitized by typed(). */
function mapErrors(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => typed(mapCode(e && e.code), e && typeof e.field === "string" ? e.field : "", e && e.message, "app-content"));
}

function mapWarnings(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((w) => {
    const raw = w && typeof w.code === "string" && w.code ? w.code : "PRA_WARNING";
    const code = raw.startsWith("W_") ? raw : "W_PRA_" + raw.replace(/^E_/, "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    return typed(code, w && typeof w.field === "string" ? w.field : "", w && typeof w === "object" ? w.message : String(w), "app-content");
  });
}

// ---- jobs ------------------------------------------------------------------------------------------------------------------------








/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_PRA_ORACLES;
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
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const res = await runSpec(launchSpec(cfg, ["describe"]), 120000);
  const d = parseLast(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true || !d.engine || !d.modelFormat || !Array.isArray(d.quantities)) return fail(appFailed("the SNEED runner could not describe itself", res));
  const scram = d.scram && typeof d.scram === "object" ? d.scram : {};
  // The runner says which engine it uses by default and which are available; an older runner has SCRAM only.
  const engines = d.engines && typeof d.engines === "object" ? d.engines : null;
  const builtin = engines && engines.builtin && typeof engines.builtin === "object" ? engines.builtin : null;
  const useBuiltin = !!engines && engines.default === "builtin" && !!builtin && builtin.available === true && typeof builtin.name === "string";
  const available = [...(builtin && builtin.available === true ? ["builtin"] : []), ...(scram.installed === true ? ["scram"] : [])];
  const warnings = useBuiltin || scram.installed === true ? [] : [typed("W_SOLVER_MISSING", "", "no analysis engine is available: the SCRAM runtime is not installed and the runner reports no built-in engine; validate works, run will be refused", "seed")];
  const methods = Array.isArray(d.methods) ? d.methods.map(String) : [];
  reply({
    ok: true,
    warnings,
    result: {
      app: { id: "pra", name: "SNEED", version: String(d.engine.version) },
      engine: useBuiltin ? { name: String(builtin.name).slice(0, 80), version: String(builtin.version || "unknown").slice(0, 40) } : { name: "SCRAM", version: String(scram.version || "not installed") },
      formats: [{ id: String(d.modelFormat.format), version: String(d.modelFormat.version) }],
      capabilities: [...(Array.isArray(d.capabilities) ? d.capabilities.map(String) : []), "validate", "run", "cancel", "collect"],
      parameters: [
        { id: "method", type: "string", enum: methods },
        { id: "limitOrder", type: "integer", min: 1, max: 1000 },
        // Omitted: the runner's default engine (reported as the describe engine). Named: that engine or a refusal.
        { id: "engine", type: "string", enum: engines ? available : ["scram"] },
        ...(Array.isArray(d.parameters) ? d.parameters.filter((p) => p && p.id === "event.probability").map((p) => ({ id: "event.probability", type: "number", unit: "1", min: 0, max: 1 })) : []),
      ],
      quantities: d.quantities.map((q) => ({ name: String(q.name), unit: String(q.unit), normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the model path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the model file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the model file does not match the revision named in the request"));
  }
  const res = await runSpec(launchSpec(cfg, ["validate", art.abs]), 120000);
  const out = parseLast(res.stdout);
  if (!out || (res.code !== 0 && res.code !== 2)) return fail(appFailed("the SNEED runner could not validate the model", res));
  let refused = false;
  if (out.ok === true) {
    problems.push(...mapWarnings(out.warnings));
  } else {
    refused = true;
    const mapped = mapErrors(out.errors);
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]), ...mapWarnings(out.warnings));
  }
  if (refused && !problems.some((p) => p.code.startsWith("E_"))) problems.push(typed("E_APP_FAILED", "", "the runner refused the model; its reasons were only warnings", "app-content"));
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

const METHODS = ["exact", "rare-event", "mcub"];
const ENGINES = ["builtin", "scram"];
/** A requested engine and the engine a result names: SCRAM is named "SCRAM"; the built-in engine is anything else the runner calls itself. */
const engineMatches = (requested, name) => (requested === "scram" ? name === "SCRAM" : name !== "SCRAM");

async function run(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
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
  const unknown = Object.keys(settings).find((k) => !["model", "method", "limitOrder", "engine"].includes(k));
  if (unknown !== undefined) return fail(typed("E_UNSUPPORTED", "/settings/" + unknown, "unknown setting; this adapter takes model, method, limitOrder and engine"));
  // The analysis is deterministic: there is no seed to set.
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "the analysis is deterministic; a seed does nothing, so a request that sets one is refused"));
  let modelPath = typeof settings.model === "string" ? settings.model : null;
  if (modelPath === null && inputs.length === 1) modelPath = inputs[0].path;
  if (modelPath === null) return fail(typed("E_PROP_MISSING", "/settings/model", "name the model file with settings.model (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === modelPath)) return fail(typed("E_PROP_MISSING", "/settings/model", "settings.model is not one of the snapshot inputs"));
  const method = settings.method === undefined ? "exact" : settings.method;
  if (!METHODS.includes(method)) return fail(typed("E_UNSUPPORTED", "/settings/method", "method must be one of " + METHODS.join(", ")));
  let limitOrder;
  if (settings.limitOrder !== undefined) {
    if (!Number.isInteger(settings.limitOrder) || settings.limitOrder < 1 || settings.limitOrder > 1000) return fail(typed("E_BOUNDS_EXCEEDED", "/settings/limitOrder", "limitOrder must be a whole number from 1 to 1000"));
    limitOrder = settings.limitOrder;
  }
  if (settings.engine !== undefined && !ENGINES.includes(settings.engine)) return fail(typed("E_UNSUPPORTED", "/settings/engine", "engine must be one of " + ENGINES.join(", ")));
  const engine = settings.engine;
  // Only the wall-clock budget is enforced (SCRAM is single-threaded; memory and disk are not limited by the runner).
  const budget = request.budget || {};
  const timeoutSeconds = Math.min(Math.max(Number.isInteger(budget.maxWallSeconds) ? budget.maxWallSeconds : 60, 10), 86400);

  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const modelAbs = path.join(absRunDir, "inputs", modelPath);
  if (!readJson(modelAbs)) return fail(typed("E_APP_FAILED", "/settings/model", "the snapshot copy of the model is not JSON"));

  // The runner's own refusals (invalid model) before anything is reserved.
  const pre = await runSpec(launchSpec(cfg, ["validate", modelAbs]), 120000);
  const preOut = parseLast(pre.stdout);
  if (!preOut || (pre.code !== 0 && pre.code !== 2)) return fail(appFailed("the SNEED runner could not check the model", pre));
  if (preOut.ok !== true) return fail(...(mapErrors(preOut.errors).length > 0 ? mapErrors(preOut.errors) : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]));

  const outAbs = path.join(absRunDir, "native", "out");
  const runArgs = ["run", modelAbs, "--out", outAbs, "--run-id", RUN_ID, "--method", method, ...(engine !== undefined ? ["--engine", engine] : []), ...(limitOrder !== undefined ? ["--limit-order", String(limitOrder)] : []), "--timeout-seconds", String(timeoutSeconds)];
  return startJob({
    root, request, absRunDir, reply, fail,
    record: { model: modelPath, method, limitOrder, engine, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) },
    runSpec: launchSpec(cfg, runArgs),
    cancelSpec: launchSpec(cfg, ["cancel", "--out", outAbs]),
    stopNative: () => stopNative(cfg, path.join(absRunDir, "native")),
  });
}

function status(request, root, reply, fail) {
  return statusJob({ request, root, reply, fail });
}



/** A Node runner left behind by a dead wrapper: ours only when its command line runs headless.js `run` on this run folder's own files. */
function ownsRunner(cfg, j, pid) {
  const cl = commandLine(pid);
  if (cl === null) return false;
  const args = argvOf(cl).map(normPath);
  return args.includes(normPath(cfg.runner)) && args.includes("run") && args.includes(normPath(path.join(j.absRunDir, "native", "out")));
}

/** Ask the runner to cancel this job's native run: it kills the processes carrying the run's owner tag (SCRAM in WSL) and checks none is left.
 *  {confirmed, stoppedOne, notOwned}. The folder is this job's own, never taken from the request. */
async function stopNative(cfg, nativeDir) {
  const res = await runSpec(launchSpec(cfg, ["cancel", "--out", path.join(nativeDir, "out")]), 60000);
  const out = parseLast(res.stdout);
  if (!out) return { confirmed: false, stoppedOne: false };
  if (out.ok === true) {
    if (out.cancelled !== true) return { confirmed: true, stoppedOne: false }; // nothing was recorded for this folder (yet)
    return { confirmed: out.nativeStopped === true, stoppedOne: true };
  }
  const code = out.errors && out.errors[0] && out.errors[0].code;
  if (code === "E_NOT_OWNED") return { confirmed: false, stoppedOne: false, notOwned: true };
  return { confirmed: false, stoppedOne: false };
}

async function cancel(request, root, reply, fail) {
  const cfg = config();
  if (cfg.setup) return fail(setupError(cfg.setup));
  return cancelJob({ request, root, reply, fail, stopNative: (j) => stopNative(cfg, j.nativeDir), ownsRunner: (j, pid) => ownsRunner(cfg, j, pid) });
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const prob = (v) => finite(v) && v >= 0 && v <= 1;

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
  const outDir = path.join(nativeDir, "out", RUN_ID);
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "sneed-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) return incomplete("the SNEED run folder has no completed manifest");
  if (JSON.stringify(manifest.files.map((f) => f && f.path).sort()) !== JSON.stringify(["model.json", "results.json"])) return incomplete("the SNEED manifest does not list exactly model.json and results.json");
  for (const f of manifest.files) {
    let bytes;
    try {
      if (!containedBelow(found.abs, path.join(outDir, f.path))) return incomplete(f.path + " resolves outside the run folder");
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
  }
  // The run must have used exactly the snapshot's model (SNEED's document hash is the sha256 of the saved bytes).
  const snapshotSha = (job.inputs.find((i) => i.path === job.model) || {}).sha256;
  const modelEntry = manifest.files.find((f) => f.path === "model.json");
  if (!snapshotSha || modelEntry.sha256 !== snapshotSha || manifest.modelSha256 !== snapshotSha) return incomplete("the run did not use the snapshot's model");

  const results = readJson(path.join(outDir, "results.json"));
  if (!results || results.schema_version !== 1) return incomplete("results.json is not a SNEED result record");
  // Truncated, failed, cancelled and incomplete results are never indexed.
  if (results.status !== "completed" || results.completeness !== "complete") return incomplete("the result is not a completed, complete analysis");
  if (!results.input_hashes || results.input_hashes.document_hash !== snapshotSha) return incomplete("the result names a different model than the snapshot");
  if (!results.settings || results.settings.method !== job.method || (job.limitOrder !== undefined && results.settings.limitOrder !== job.limitOrder)) return incomplete("the result was made with other settings than the request");
  if (!prob(results.top_event_probability)) return incomplete("the top event probability is missing or outside [0, 1]", "/top_event_probability");
  const sets = Array.isArray(results.minimal_cut_sets) ? results.minimal_cut_sets : null;
  if (!sets || sets.length > 100000 || sets.some((c) => !c || !Array.isArray(c.events) || c.events.length === 0 || c.events.some((e) => typeof e !== "string") || !prob(c.probability))) {
    return incomplete("the minimal cut sets are missing or malformed", "/minimal_cut_sets");
  }
  const approximation = results.approximation_value;
  if (job.method !== "exact" && !finite(approximation)) return incomplete("the approximation value is missing for method " + job.method, "/approximation_value");
  if (job.method === "exact" && approximation !== null && approximation !== undefined) return incomplete("an exact result carries an approximation value", "/approximation_value");

  const qDir = path.join(nativeDir, "quantities");
  try {
    fs.mkdirSync(qDir, { recursive: true });
    if (fs.lstatSync(qDir).isSymbolicLink() || !containedBelow(found.abs, qDir)) return incomplete("the quantities folder is a link or leaves the run folder");
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "cannot prepare the quantities folder: " + (err && err.code ? err.code : err)));
  }
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  const addQuantity = (name, body, extra = {}) => {
    const text = json(body);
    const fileName = String(quantities.length).padStart(3, "0") + ".json";
    atomicWrite(path.join(qDir, fileName), text);
    quantities.push({
      name,
      unit: "1",
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/quantities/" + fileName, sha256: sha256(text) },
      verification: "unverified",
      ...extra,
    });
  };
  addQuantity("top_event_probability", { quantity: "top_event_probability", method: job.method, unit: "1", value: results.top_event_probability });
  addQuantity("minimal_cut_sets", { quantity: "minimal_cut_sets", unit: "1", cutSets: sets.map((c) => ({ events: c.events, probability: c.probability })) }, { coordinates: { system: "cut-set-index", axes: [{ name: "cut set", unit: "1" }] } });
  if (job.method !== "exact") addQuantity("approximation_value", { quantity: "approximation_value", method: job.method, unit: "1", value: approximation, note: "an approximation can exceed 1; it is not a probability then" });

  const caveats = Array.isArray(results.caveats) ? results.caveats.map((c) => String(c).slice(0, 300)).slice(0, 20) : [];
  const warnings = [...mapWarnings(results.warnings), ...caveats.map((c) => typed("W_PRA_CAVEAT", "", c, "app-content"))];
  // The engine is what the result says it was made by, not what this adapter expects: the runner's default can change.
  const eng = results.engine && typeof results.engine === "object" ? results.engine : {};
  const meng = manifest.engine && typeof manifest.engine === "object" ? manifest.engine : {};
  if (typeof eng.name !== "string" || eng.name.length === 0 || eng.name.length > 80 || typeof eng.version !== "string" || eng.version.length === 0 || eng.version.length > 40) return incomplete("the result does not name its engine and version", "/engine");
  if (meng.name !== eng.name || meng.version !== eng.version) return incomplete("the manifest and the result name different engines", "/engine");
  if (job.engine !== undefined && !engineMatches(job.engine, eng.name)) return incomplete("the result was made by " + eng.name + ", not the requested engine " + job.engine, "/engine");
  const index = {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: eng.name, version: eng.version },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "SNEED " + job.method + " analysis completed: " + sets.length + " minimal cut sets" },
    quantities,
    extensions: {
      pra: {
        method: job.method,
        limitOrder: results.settings.limitOrder,
        modelHash: results.input_hashes.model_hash,
        documentHash: results.input_hashes.document_hash,
        runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        assumptions: results.assumptions,
        caveats,
        engine: eng,
        exporterVersion: results.exporter_version,
        parserVersion: results.parser_version,
        meaning: "A probability under stated assumptions (constant probabilities, independent basic events). Not a frequency and not a plant risk figure.",
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, warnings, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

serve({ describe: (_request, _root, reply, fail) => describe(reply, fail), validate, run, status, cancel, collect }, "SNEED's editor is its web page; this headless adapter does not open it");
