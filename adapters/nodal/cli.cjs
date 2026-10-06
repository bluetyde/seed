"use strict";
// SEED adapter for NODAL Studio, transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps NODAL's command-line runner (`python -m nodal_studio.run`, its --describe, --validate and --json modes, docs/headless.md
// in the NODAL repo). The runner's location comes from the environment of the host, never from a project file or a request:
//   SEED_NODAL_PYTHON   absolute path of the Python that has NODAL's solver requirements installed
//   SEED_NODAL_REPO     absolute path of the nodal-studio checkout (contains nodal_studio/run.py)
//   SEED_NODAL_ORACLES  optional, absolute path of NODAL's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).
//
// Project files are not trusted: every path in a request is checked here again (the client's schema check is not
// relied on), state folders must be real folders inside the run folder, and a process is only killed after its
// command line shows it is this adapter's job wrapper for that run folder. Structure follows adapters/raft.

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
  canonical,
  typed,
  jobState,
} = require("../shared/util.cjs");
const { serve, startJob, statusJob, cancelJob } = require("../shared/flow.cjs");

const ADAPTER = { id: "nodal", version: "0.1.0" };
const MAX_CHANNELS = 200;













/** The configured runner: an absolute Python that exists and an absolute repository holding nodal_studio/run.py, or null. */
function runnerConfig() {
  const python = process.env.SEED_NODAL_PYTHON;
  const repo = process.env.SEED_NODAL_REPO;
  if (!python || !repo || !path.isAbsolute(python) || !path.isAbsolute(repo)) return null;
  try {
    if (!fs.statSync(python).isFile() || !fs.statSync(path.join(repo, "nodal_studio", "run.py")).isFile()) return null;
  } catch {
    return null;
  }
  return { python, repo };
}

function runnerEnv(repo) {
  // No bytecode is written into the repository; UTF-8 everywhere so the JSON replies are read the same on every platform.
  return { ...process.env, PYTHONPATH: repo, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
}

function runPython(cfg, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cfg.python, ["-m", "nodal_studio.run", ...args], { cwd: cfg.repo, env: runnerEnv(cfg.repo), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

/** NODAL's codes mapped to SEED's; the original code stays in the message. Unknown codes are model problems (E_SCHEMA_INVALID), not app failures. */
function mapCode(code) {
  if (code === "E_NOT_FOUND" || code === "E_EXISTS") return code;
  if (typeof code === "string" && (code.startsWith("E_GATE") || code.includes("UNSUPPORTED") || code.includes("NOT_MODELED"))) return "E_UNSUPPORTED";
  if (typeof code === "string" && (code.includes("DOMAIN") || code.includes("OUT_OF_RANGE"))) return "E_OUT_OF_DOMAIN";
  return "E_SCHEMA_INVALID";
}

function mapIssues(list, prefix) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => {
    const raw = e && typeof e.code === "string" ? e.code : "E_APP_FAILED";
    const warn = raw.startsWith("W_");
    return typed(warn ? raw : mapCode(raw), e && typeof e.field === "string" ? e.field : "", (prefix || "") + raw + ": " + (e && e.message), "app-content");
  });
}

const setupError = () =>
  typed("E_SETUP_REQUIRED", "", "the NODAL runner is not configured: set SEED_NODAL_PYTHON (Python with NODAL's solver requirements) and SEED_NODAL_REPO (the nodal-studio checkout) to absolute paths");








/** NODAL's own final status "tripped" (the model's stop-advancement trip) is a lifecycle of its own. */
const EXTRA_STATUSES = { tripped: "terminated-by-trip" };


/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_NODAL_ORACLES;
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
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
  const res = await runPython(cfg, ["--describe"]);
  const d = parseJson(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true || !d.engine || !d.quantities) return fail(appFailed("the NODAL runner could not describe itself", res));
  reply({
    ok: true,
    result: {
      app: { id: "nodal", name: "NODAL Studio", version: String(d.engine.version) },
      engine: { name: String(d.engine.name), version: String(d.engine.version) },
      formats: [{ id: String(d.modelFormat.format), version: "0.1" }],
      capabilities: [...(Array.isArray(d.capabilities) ? d.capabilities : []).map(String), "validate", "run", "cancel", "collect"],
      parameters: [{ id: "recordDt", type: "number", unit: "s", min: 0 }],
      // These are the quantity kinds a model output can have; a result carries the outputs the model names.
      quantities: Object.keys(d.quantities).sort().map((q) => ({ name: q, unit: String(d.quantities[q]), normalization: "none" })),
      oracleCoverage: oracleCoverage(),
    },
  });
}

async function validate(request, root, reply, fail) {
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
  const problems = [];
  const art = insideRoot(root, request.artifact && request.artifact.path);
  if (art.escaped) return reply({ ok: true, result: { valid: false, problems: [typed("E_PATH_TRAVERSAL", "/artifact/path", "the model path leaves the project")] } });
  if (art.missing) return reply({ ok: true, result: { valid: false, problems: [typed("E_NOT_FOUND", "/artifact/path", "the model file does not exist")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the model file does not match the revision named in the request"));
  }
  const res = await runPython(cfg, [art.abs, "--validate"]);
  const out = parseJson(res.stdout);
  let refused = false;
  if (res.code === 0 && out && out.ok === true) {
    problems.push(...mapIssues(out.warnings));
  } else if (res.code === 2 && out && out.ok === false) {
    refused = true;
    const mapped = mapIssues(out.errors);
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the model without giving a reason", "app-content")]), ...mapIssues(out.warnings));
  } else {
    return fail(appFailed("the NODAL runner could not validate the model", res));
  }
  // The runner's refusal decides, not the codes it happens to list (a list of only W_ codes is still a refusal).
  if (refused && !problems.some((p) => p.code.startsWith("E_"))) problems.push(typed("E_APP_FAILED", "", "the runner refused the model; its reasons were only warnings", "app-content"));
  reply({ ok: true, result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems } });
}

async function run(request, root, reply, fail) {
  const cfg = runnerConfig();
  if (!cfg) return fail(setupError());
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
  const knownSettings = ["model", "commands", "recordDt"];
  const unknown = Object.keys(settings).find((k) => !knownSettings.includes(k));
  if (unknown !== undefined) return fail(typed("E_UNSUPPORTED", "/settings/" + unknown, "unknown setting; this adapter takes model, commands and recordDt"));
  // NODAL is deterministic: there is no seed to set.
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "NODAL is deterministic; a seed does nothing, so a request that sets one is refused"));
  let modelPath = typeof settings.model === "string" ? settings.model : null;
  if (modelPath === null && inputs.length === 1) modelPath = inputs[0].path;
  if (modelPath === null) return fail(typed("E_PROP_MISSING", "/settings/model", "name the model file with settings.model (one of the snapshot inputs)"));
  if (!inputs.some((i) => i.path === modelPath)) return fail(typed("E_PROP_MISSING", "/settings/model", "settings.model is not one of the snapshot inputs"));
  const extra = [];
  if (settings.recordDt !== undefined) {
    if (typeof settings.recordDt !== "number" || !Number.isFinite(settings.recordDt) || settings.recordDt <= 0) {
      return fail(typed("E_BOUNDS_EXCEEDED", "/settings/recordDt", "recordDt must be a positive finite number of seconds"));
    }
    extra.push("--record-dt", String(settings.recordDt));
  }
  let commandsAbs = null;
  if (settings.commands !== undefined) {
    if (typeof settings.commands !== "string" || !inputs.some((i) => i.path === settings.commands)) {
      return fail(typed("E_PROP_MISSING", "/settings/commands", "settings.commands is not one of the snapshot inputs"));
    }
    commandsAbs = path.join(absRunDir, "inputs", settings.commands);
    extra.push("--commands", commandsAbs);
  }
  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const modelAbs = path.join(absRunDir, "inputs", modelPath);
  if (!readJson(modelAbs)) return fail(typed("E_APP_FAILED", "/settings/model", "the snapshot copy of the model is not JSON"));

  const runArgs = ["-m", "nodal_studio.run", modelAbs, "--out", path.join(absRunDir, "native", "out"), "--run-id", "nodal", "--json", ...extra];
  return startJob({
    root, request, absRunDir, reply, fail,
    record: { model: modelPath, recordDt: settings.recordDt, commands: settings.commands, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) },
    // The repository is read-only for the run: no bytecode is written into it; UTF-8 everywhere so the JSON reply reads the same on every platform.
    runSpec: { command: cfg.python, args: runArgs, cwd: cfg.repo, env: { PYTHONPATH: cfg.repo, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    outcome: path.join(__dirname, "outcome.cjs"),
  });
}

function status(request, root, reply, fail) {
  return statusJob({ request, root, reply, fail, extraStatuses: EXTRA_STATUSES });
}



/** A runner process left behind by a dead wrapper: it is ours only when it runs nodal_studio.run on this run folder's own files. */
function ownsRunner(j, pid) {
  const cl = commandLine(pid);
  if (cl === null) return false;
  const args = argvOf(cl).map(normPath);
  const model = normPath(path.join(j.absRunDir, "inputs", j.job.model));
  return args.includes("nodal_studio.run") && args.includes(model);
}

async function cancel(request, root, reply, fail) {
  return cancelJob({ request, root, reply, fail, ownsRunner, extraStatuses: EXTRA_STATUSES });
}

/**
 * The dimension (docs/contracts-v0.2-data-shapes.md) of a recorded channel, from its quantity kind and unit; null when the pair is not one this
 * adapter knows (the unit stays free text and the quantity is not offered to transfers).
 */
function channelDimension(kind, unit) {
  const table = {
    temperature: ["temperature", ["K", "degC"]], wallTemperature: ["temperature", ["K", "degC"]], HTTEMP: ["temperature", ["K", "degC"]], HTVAT: ["temperature", ["K", "degC"]],
    pressure: ["pressure", ["Pa", "kPa", "MPa"]], massFlow: ["mass-flow", ["kg/s"]], HTHTC: ["heat-transfer-coefficient", ["W/m2/K"]], TIME: ["time", ["s"]],
  };
  const row = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : null;
  return row && row[1].includes(unit) ? row[0] : null;
}

function finiteNumbers(a) {
  return Array.isArray(a) && a.every((v) => typeof v === "number" && Number.isFinite(v));
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
  const s = jobState(nativeDir, job, EXTRA_STATUSES);
  if (s.lifecycle !== "completed") return incomplete("job is not completed");

  const snapshotIssue = snapshotProblem(found.abs, job.inputs);
  if (snapshotIssue) return incomplete("the snapshot changed after the run was registered: " + snapshotIssue);
  const outDir = path.join(nativeDir, "out", "nodal");
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "nodal-studio-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the NODAL run folder has no completed manifest");
  }
  const expected = ["model.json", "results.json", "session.json"];
  if (JSON.stringify(manifest.files.map((f) => f.path).sort()) !== JSON.stringify(expected)) return incomplete("the NODAL manifest does not list exactly its three files");
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
  if (!results || results.format !== "nodal-studio-results" || !results.completion || results.completion.status !== "completed") return incomplete("results.json is not a completed result");
  // The run must have used exactly the snapshot's model.
  const usedModel = readJson(path.join(outDir, "model.json"));
  const snapshotModel = readJson(path.join(found.abs, "inputs", job.model));
  if (!usedModel || !snapshotModel || canonical(usedModel) !== canonical(snapshotModel)) return incomplete("the run did not use the snapshot's model");
  if (!results.model || results.model.hash !== (manifest.model && manifest.model.hash)) return incomplete("results.json and the manifest name different models");

  // The run must have covered the whole time-step schedule, and every series must be complete and finite.
  const steps = Array.isArray(snapshotModel.timeSteps) ? snapshotModel.timeSteps : [];
  const endTime = steps.length > 0 ? steps[steps.length - 1].endTime : undefined;
  const time = results.time;
  if (!finiteNumbers(time) || time.length < 2) return incomplete("results.json has no time series");
  for (let i = 1; i < time.length; i++) if (!(time[i] > time[i - 1])) return incomplete("the time series is not strictly increasing");
  if (typeof endTime !== "number" || results.completion.endTime !== endTime || time[time.length - 1] !== endTime || !Number.isInteger(results.completion.steps) || results.completion.steps < 1) {
    return incomplete("the run did not reach the end of the model's time-step schedule");
  }
  if (time[0] !== 0) return incomplete("the recorded history does not start at the initial state (t = 0)");
  const channels = Array.isArray(results.channels) ? results.channels : [];
  const outputs = Array.isArray(snapshotModel.outputs) ? snapshotModel.outputs : [];
  if (channels.length === 0 || channels.length > MAX_CHANNELS) return incomplete("results.json has no recorded channels (the model names no outputs) or too many");
  // The results must hold exactly the outputs the model asked for, in order, with the same quantity and location.
  if (channels.length !== outputs.length || channels.some((ch, k) => !ch || !outputs[k] || ch.name !== outputs[k].name || ch.quantity !== outputs[k].quantity || ch.location !== outputs[k].location)) {
    return incomplete("the recorded channels are not the outputs the model asked for");
  }
  const seriesDir = path.join(nativeDir, "series");
  try {
    fs.mkdirSync(seriesDir, { recursive: true });
    if (fs.lstatSync(seriesDir).isSymbolicLink() || !containedBelow(found.abs, seriesDir)) return incomplete("the series folder is a link or leaves the run folder");
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "cannot prepare the series folder: " + (err && err.code ? err.code : err)));
  }
  const names = new Set();
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  for (let k = 0; k < channels.length; k++) {
    const ch = channels[k];
    const name = ch && typeof ch.name === "string" ? ch.name : "";
    const series = results.data && Object.prototype.hasOwnProperty.call(results.data, name) ? results.data[name] : undefined;
    if (!name || name.length > 80 || names.has(name) || typeof ch.unit !== "string" || !ch.unit || ch.unit.length > 40 || !finiteNumbers(series) || series.length !== time.length) {
      return incomplete("a recorded channel is missing, duplicated, not finite or not as long as the time series", "/channels/" + k);
    }
    names.add(name);
    // A seed.quantity-data/0.2 series over time (docs/contracts-v0.2-data-shapes.md); the channel's kind and location stay in meta.
    const fileBody = { schema: "seed.quantity-data/0.2", quantity: name, kind: "series", unit: ch.unit, axis: { name: "t", unit: "s" }, x: time, values: series, meta: { kind: ch.quantity, location: ch.location } };
    const env = results.envelope && Object.prototype.hasOwnProperty.call(results.envelope, name) ? results.envelope[name] : undefined;
    if (env && finiteNumbers(env.min) && finiteNumbers(env.max) && env.min.length === time.length && env.max.length === time.length) {
      fileBody.min = env.min;
      fileBody.max = env.max;
    }
    const text = json(fileBody);
    const fileName = String(k).padStart(3, "0") + ".json";
    atomicWrite(path.join(nativeDir, "series", fileName), text);
    const dimension = channelDimension(ch.quantity, ch.unit);
    quantities.push({
      name,
      unit: ch.unit,
      ...(dimension ? { dimension } : {}),
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + fileName, sha256: sha256(text) },
      verification: "unverified",
      coordinates: { system: "time", axes: [{ name: "t", unit: "s" }] },
    });
  }

  const messages = Array.isArray(results.messages) ? results.messages : [];
  // Every message NODAL marks as a warning is passed on (a rejected command is one, with an E_ code): the original code and text stay in the
  // message, and the SEED code is always a W_ code.
  const warnings = messages
    .filter((m) => m && m.level === "warning")
    .slice(0, 20)
    .map((m) => {
      const raw = typeof m.code === "string" && m.code ? m.code : "NODAL_WARNING";
      const code = raw.startsWith("W_") ? raw : "W_NODAL_" + raw.replace(/^E_/, "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
      return typed(code, "", raw + ": " + (m.text || raw), "app-content");
    });
  const index = {
    schema: "seed.results-index/0.2",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: String(results.engine.name), version: String(results.engine.version) },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "NODAL run completed: " + results.completion.steps + " steps, " + time.length + " samples" },
    quantities,
    extensions: {
      nodal: {
        modelHash: results.model.hash,
        runnerResultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        language: results.engine.language,
        settings: results.settings,
        recording: results.recording,
        messages: messages.slice(0, 20).map((m) => ({ level: m && m.level, code: m && m.code, text: m && typeof m.text === "string" ? m.text.slice(0, 300) : undefined })),
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, warnings, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

serve({ describe: (_request, _root, reply, fail) => describe(reply, fail), validate, run, status, cancel, collect }, "NODAL's editor is its web app; this headless adapter does not open it");
