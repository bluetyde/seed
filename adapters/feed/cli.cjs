"use strict";
// SEED adapter for Fuel Performance Studio (FEED), transport "CLI per verb": the request is JSON on stdin, one
// seed.adapter-reply/0.1 JSON object goes to stdout, exit 0 means a reply was produced. Usage: node cli.cjs <verb>
//
// It wraps FEED's headless runner (dist/cli/headless.js, built by `npm run build` in the FEED repo). The runner's location
// comes from the environment of the host, never from a project file or a request:
//   SEED_FEED_HEADLESS   absolute path of dist/cli/headless.js
//   SEED_FEED_ORACLES    optional, absolute path of FEED's oracles/seed/entries folder: describe reports the coverage of its good entries
// The project root comes from SEED_PROJECT_ROOT (set by the adapter client).
//
// Project files are not trusted: every path in a request is checked here again (the client's schema check is not relied
// on), state folders must be real folders inside the run folder, and a process is only killed after its command line
// shows it is this adapter's job wrapper for that run folder.
//
// FEED is a THERMAL calculation only. Nothing this adapter returns says anything about stress, failure or fuel integrity.

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
  hasArg,
  normPath,
  typed,
  jobState,
  cleanTransfers,
} = require("../shared/util.cjs");
const { resourcesFor } = require("../shared/resources.cjs");
const { serve, startJob, statusJob, cancelJob } = require("../shared/flow.cjs");

const ADAPTER = { id: "feed", version: "0.1.0" };
const THERMAL_ONLY = "Thermal calculation only. Not a stress, failure or integrity assessment.";
const MAX_CASE_BYTES = 1024 * 1024;

// Quantities of the results index. Peak and the two interface values are CELL-CENTRE values of the solver's mesh, not
// extrapolated to the axis or the interface; heat_flux_outer follows from the linear heat rate and the outer radius.
const QUANTITIES = [
  { name: "temperature_radial", unit: "K", radial: true },
  { name: "temperature_peak", unit: "K" },
  { name: "temperature_fuel_surface", unit: "K" },
  { name: "temperature_clad_inner", unit: "K" },
  { name: "temperature_surface", unit: "K" },
  { name: "heat_flux_outer", unit: "W/m2" },
  { name: "energy_balance_residual", unit: "1" },
];
// A steady run whose result carries `fuelTemperature` (feed.fuel-temperature/0.1, docs/seed-fuel-temperature.md in FEED) adds these four, all in K, absolute,
// dimension temperature: the volume-mean fuel temperature of each axial slice (a series against z) and three single numbers from it. Only a steady stack or
// a one-slice case whose heat rate a heating transfer set has it; a number that is not shown to agree with its slices is refused, never passed on.
const FUEL_TEMPERATURE_QUANTITIES = [
  { name: "temperature_fuel_mean_by_slice", unit: "K", slices: true },
  { name: "temperature_fuel_mean_slice_max", unit: "K" },
  { name: "temperature_fuel_mean_slice_min", unit: "K" },
  { name: "temperature_fuel_mean", unit: "K" },
];
// A transient run (feed.results/0.2) has these instead: time series carry their time axis in "t", scalars are one value.
// temperature_peak_max is the hottest cell-centre value over the whole run; energy_balance_gap is the largest relative gap
// between the energy deposited and stored plus rejected, which includes the first-order error of the time stepping.
const TRANSIENT_QUANTITIES = [
  { name: "temperature_peak_history", unit: "K", series: true },
  { name: "temperature_outer_wall_history", unit: "K", series: true },
  { name: "temperature_peak_max", unit: "K" },
  { name: "time_of_peak", unit: "s" },
  { name: "energy_deposited", unit: "J/m" },
  { name: "energy_balance_gap", unit: "1" },
];
// A case may state temperature limits; FEED then reports one check per rule (temperatureLimit1, 2, ...) whose value is the smallest
// margin in kelvin (limit minus hottest cell; negative when exceeded) and no value when the rule never applied. A FAILED limit check is a
// failed check on a COMPLETED run: it is a result about the case, not a broken run, so collect keeps the run and the margin goes out as this
// quantity (the smallest margin over the rules that applied; each rule's own margin is in extensions.feed.limits). No rule in force: no quantity.
const LIMIT_QUANTITY = { name: "temperature_limit_margin", unit: "K" };
const LIMIT_CHECK = /^temperatureLimit[1-9][0-9]{0,1}$/;
// A case may also state mechanics (thermo-elastic: small strain, linear elastic, one radial slice); the result then carries a `mechanics` record
// next to the thermal one. These are values read from it, all in SI: displacements and stresses at cell centres of the solver's mesh, the contact
// pressure at the gap (0 when open), the gas pressure the case works out. A stress limit is a check `stressLimit:<name>` with the smallest margin in Pa
// (strength minus von Mises; negative when exceeded); like a temperature limit, a failed one is a failed check on a COMPLETED run, not a broken
// run: it fails too when cells lie outside the strength table (nothing is extrapolated), with or without a margin.
const MECHANICS_QUANTITIES = [
  { name: "displacement_radial_fuel_last_cell", unit: "m" },
  { name: "displacement_radial_clad_last_cell", unit: "m" },
  { name: "stress_axial_fuel_min", unit: "Pa" },
  { name: "stress_hoop_clad_first_cell", unit: "Pa" },
  { name: "contact_pressure", unit: "Pa" },
  { name: "gas_pressure", unit: "Pa" },
];
const STRESS_LIMIT_QUANTITY = { name: "stress_limit_margin", unit: "Pa" };
const STRESS_LIMIT_CHECK = /^stressLimit:[A-Za-z0-9._-]{1,64}$/;
const THERMO_ELASTIC_PREFIX = "Thermo-elastic result:";
const OUTPUT_FILES = ["case.json", "derived.json", "feed-manifest.json", "results.json", "run.json"];
const PARAMETERS = [
  { id: "power.linearHeatRate", type: "number", unit: "W/m", min: 1, max: 60000 },
  { id: "boundary.bulkTemperature", type: "number", unit: "K", min: 273, max: 1000 },
  { id: "boundary.heatTransferCoefficient", type: "number", unit: "W/m2/K", min: 1, max: 1000000 },
  { id: "boundary.surfaceTemperature", type: "number", unit: "K", min: 273, max: 1000 },
  { id: "gap.conductance", type: "number", unit: "W/m2/K", min: 1, max: 1000000 },
  { id: "mesh.fuelCells", type: "integer", min: 4, max: 20000 },
  { id: "mesh.claddingCells", type: "integer", min: 2, max: 10000 },
];












function bundlePath() {
  const p = process.env.SEED_FEED_HEADLESS;
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
    return JSON.parse(text.trim().split("\n").pop());
  } catch {
    return null;
  }
}

/** FEED's own typed errors pass through with their codes (they match the pattern); text from the app is labelled app-content. */
function mapIssues(list, severity) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((e) => {
    let code = e && typeof e.code === "string" && /^[EW]_[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : severity === "E" ? "E_APP_FAILED" : "W_APP";
    if (!code.startsWith(severity + "_")) code = severity + "_" + code.slice(2);
    return {
      ...typed(code, e && typeof e.field === "string" ? e.field : "", e && e.message, "app-content"),
      ...(e && typeof e.unit === "string" && e.unit.length > 0 && e.unit.length <= 40 ? { unit: e.unit } : {}),
    };
  });
}

const setupError = () =>
  typed("E_SETUP_REQUIRED", "", "the FEED headless runner is not configured: set SEED_FEED_HEADLESS to the absolute path of dist/cli/headless.js (npm run build in the FEED repo)");









/** Quantities and domains the oracle entries claim (good entries only), or [] when no entries folder is configured. */
function oracleCoverage() {
  const dir = process.env.SEED_FEED_ORACLES;
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

/**
 * The fuel temperature record of a steady result, checked: the schema and kind, K and absolute, the slices in order and not overlapping with finite
 * volume means, and the three scalars equal to what the slices say (max, min and the length-weighted mean). A string is what is wrong. The scalars are
 * recomputed here and compared, so a number FEED reports that its own slices do not support is never passed on as a result.
 */
function fuelTemperatureOf(ft) {
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  if (!ft || ft.schema !== "feed.fuel-temperature/0.1" || ft.unit !== "K" || ft.dimension !== "temperature" || ft.normalization !== "none") return "the fuel temperature record is not feed.fuel-temperature/0.1 in K, dimension temperature, normalization none";
  if (!ft.axis || ft.axis.name !== "z" || ft.axis.unit !== "m" || typeof ft.axis.origin !== "string") return "the fuel temperature axis is not z in metres with a stated origin";
  if (ft.state !== "steady-state") return "the fuel temperature is for a steady state only";
  if (!Array.isArray(ft.slices) || ft.slices.length < 1 || ft.slices.length > 1000) return "the fuel temperature has no slices";
  let last = -Infinity;
  for (const s of ft.slices) {
    if (!s || !finite(s.zMin) || !finite(s.zMax) || !(s.zMax > s.zMin) || s.zMin < last - 1e-12 || !finite(s.volumeMean) || !(s.volumeMean > 0)) return "a slice of the fuel temperature has no usable bounds or volume mean";
    last = s.zMax;
  }
  const values = ft.slices.map((s) => s.volumeMean), lengths = ft.slices.map((s) => s.zMax - s.zMin);
  const total = lengths.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, v, i) => a + v * lengths[i], 0) / total;
  const want = { temperature_fuel_mean_slice_max: Math.max(...values), temperature_fuel_mean_slice_min: Math.min(...values), temperature_fuel_mean: mean };
  const scalars = {};
  for (const [name, expected] of Object.entries(want)) {
    const got = ft.scalars && ft.scalars[name] && ft.scalars[name].value;
    if (!finite(got) || Math.abs(got - expected) > 1e-9 * Math.max(1, Math.abs(expected))) return "the fuel temperature scalar " + name + " does not agree with its slices";
    scalars[name] = got;
  }
  if (typeof ft.meaning !== "string" || !/volume/i.test(ft.meaning)) return "the fuel temperature does not state its meaning (the volume mean)";
  return { slices: ft.slices, scalars, origin: ft.axis.origin, frame: ft.axis.frame === undefined ? null : ft.axis.frame, geometry: ft.geometry ?? null, meaning: ft.meaning.slice(0, 1000), final: typeof ft.final === "string" ? ft.final.slice(0, 500) : null };
}

async function describe(reply, fail) {
  const bundle = bundlePath();
  if (!bundle) return fail(setupError());
  const res = await runBundle(bundle, ["describe"]);
  const d = parseJson(res.stdout);
  if (res.code !== 0 || !d || d.ok !== true) return fail(appFailed("the FEED runner could not describe itself", res));
  const warnings = d.solver && d.solver.available === false ? [typed("W_SOLVER_MISSING", "", "the FEED solver (WSL distro feed-solver) was not found: validate works, run will be refused")] : [];
  reply({
    ok: true,
    warnings,
    result: {
      app: { id: "feed", name: "Fuel Performance Studio (FEED)", version: d.engine.version },
      engine: { name: "feed-headless", version: d.engine.version },
      formats: [{ id: d.caseFormat.format, version: String(d.caseFormat.version) }],
      capabilities: [d.engine.capability, "validate", "run", "cancel", "collect", "thermal-only", "thermo-elastic", "transient-pulse"],
      parameters: PARAMETERS,
      quantities: QUANTITIES.concat(FUEL_TEMPERATURE_QUANTITIES, TRANSIENT_QUANTITIES, [LIMIT_QUANTITY], MECHANICS_QUANTITIES, [STRESS_LIMIT_QUANTITY]).map((q) => ({ name: q.name, unit: q.unit, normalization: "none" })),
      oracleCoverage: oracleCoverage(),
      resources: resourcesFor("feed"),
      ...(cleanTransfers(d.transfers).length > 0 ? { transfers: cleanTransfers(d.transfers) } : {}),
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
  const size = fs.statSync(art.abs).size;
  if (size > MAX_CASE_BYTES) return reply({ ok: true, result: { valid: false, problems: [typed("E_SCHEMA_INVALID", "/artifact/path", "the case file is larger than " + MAX_CASE_BYTES + " bytes")] } });
  const bytes = fs.readFileSync(art.abs);
  if (sha256(bytes) !== request.artifact.revision.hash) {
    problems.push(typed("E_STALE_REVISION", "/artifact/revision/hash", "the case file does not match the revision named in the request"));
  }
  const warnings = [];
  const res = await runBundle(bundle, ["validate", art.abs]);
  const out = parseJson(res.stdout);
  if (res.code === 0 && out && out.ok === true) {
    warnings.push(...mapIssues(out.warnings, "W"));
  } else if (res.code === 2 && out && out.ok === false) {
    const mapped = mapIssues(out.errors, "E");
    // A refusal without a usable reason is still a refusal: never let it pass as valid.
    problems.push(...(mapped.length > 0 ? mapped : [typed("E_APP_FAILED", "", "the runner refused the case without giving a reason", "app-content")]));
    warnings.push(...mapIssues(out.warnings, "W"));
  } else {
    return fail(appFailed("the FEED runner could not validate the case", res));
  }
  reply({ ok: true, warnings: [], result: { valid: !problems.some((p) => p.code.startsWith("E_")), problems: [...problems, ...warnings] } });
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
  if (inputs.length !== 1) return fail(typed("E_UNSUPPORTED", "/snapshot/inputs", "a FEED case is one self-contained file (materials are inside it); the snapshot has " + inputs.length));
  const settings = request.settings || {};
  const casePath = inputs[0].path;
  if (settings.case !== undefined && settings.case !== casePath) return fail(typed("E_PROP_MISSING", "/settings/case", "settings.case is not the snapshot's input"));
  if (request.seed !== undefined) return fail(typed("E_UNSUPPORTED", "/seed", "FEED is deterministic and has no random seed"));
  const problem = snapshotProblem(absRunDir, inputs);
  if (problem) return fail(typed("E_STALE_REVISION", "/snapshot/inputs", problem));
  const caseAbs = path.join(absRunDir, "inputs", casePath);
  if (fs.statSync(caseAbs).size > MAX_CASE_BYTES) return fail(typed("E_SCHEMA_INVALID", "/snapshot/inputs/0/path", "the case file is larger than " + MAX_CASE_BYTES + " bytes"));

  // The solver must exist before a job is registered: a missing one is a setup problem, not a failed run.
  const info = parseJson((await runBundle(bundle, ["describe"])).stdout);
  if (!info || info.ok !== true) return fail(typed("E_APP_FAILED", "", "the FEED runner could not describe itself"));
  if (!info.solver || info.solver.available !== true) return fail(typed("E_SETUP_REQUIRED", "", "the FEED solver (WSL distro feed-solver) was not found", "seed"));

  const budgetSeconds = request.budget && Number.isInteger(request.budget.maxWallSeconds) ? request.budget.maxWallSeconds : 300;
  const timeoutSeconds = Math.min(86400, Math.max(10, budgetSeconds));

  const outDir = path.join(absRunDir, "native", "out");
  return startJob({
    root, request, absRunDir, reply, fail,
    record: { case: casePath, inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })) },
    runSpec: { command: process.execPath, args: [bundle, "run", caseAbs, "--out", outDir, "--run-id", "feed", "--timeout-seconds", String(timeoutSeconds)] },
    // the runner's own cancel stops the solver in its WSL distro, which no process tree of ours reaches
    cancelSpec: { command: process.execPath, args: [bundle, "cancel", "--out", outDir] },
    stopNative: () => stopSolver(path.join(absRunDir, "native")),
  });
}

function status(request, root, reply, fail) {
  return statusJob({ request, root, reply, fail });
}


/** Ask the runner to stop the solver of the run in `out`. `confirmed` means a solver was stopped or none was running. */
async function stopSolver(nativeDir) {
  const bundle = bundlePath();
  if (!bundle) return { confirmed: false, stoppedOne: false };
  const res = await runBundle(bundle, ["cancel", "--out", path.join(nativeDir, "out")], 60000);
  const out = parseJson(res.stdout);
  const ok = res.code === 0 && !!out && out.ok === true && typeof out.cancelled === "boolean";
  return { confirmed: ok, stoppedOne: ok && out.cancelled === true };
}

/** A runner left behind by a dead wrapper: ours only when its command line runs the headless bundle's `run` on this run folder's own output folder. */
function ownsRunner(j, pid) {
  const bundle = bundlePath();
  const cl = commandLine(pid);
  if (!bundle || cl === null) return false;
  return hasArg(cl, bundle) && hasArg(cl, "run") && hasArg(cl, path.join(j.absRunDir, "native", "out"));
}

async function cancel(request, root, reply, fail) {
  return cancelJob({ request, root, reply, fail, stopNative: (j) => stopSolver(j.nativeDir), ownsRunner });
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
  const outDir = path.join(nativeDir, "out", "feed");
  if (!containedBelow(found.abs, outDir)) return incomplete("the runner output folder is not inside the run folder");
  const manifest = readJson(path.join(outDir, "manifest.json"));
  if (!manifest || manifest.format !== "feed-headless-run" || manifest.status !== "completed" || !Array.isArray(manifest.files)) {
    return incomplete("the FEED run folder has no completed manifest");
  }
  if (JSON.stringify(manifest.files.map((f) => f.path).sort()) !== JSON.stringify(OUTPUT_FILES)) return incomplete("the FEED manifest does not list exactly its five files");
  const bytesOf = {};
  for (const f of manifest.files) {
    let bytes;
    try {
      if (!containedBelow(found.abs, path.join(outDir, f.path))) return incomplete(f.path + " resolves outside the run folder");
      bytes = fs.readFileSync(path.join(outDir, f.path));
    } catch {
      return incomplete(f.path + " is missing");
    }
    if (sha256(bytes) !== f.sha256) return incomplete(f.path + " does not match its manifest hash");
    bytesOf[f.path] = bytes;
  }
  const snapshotCase = fs.readFileSync(path.join(found.abs, "inputs", job.case));
  if (sha256(bytesOf["case.json"]) !== sha256(snapshotCase) || manifest.caseSha256 !== sha256(snapshotCase)) return incomplete("the run did not use the snapshot's case");

  const results = JSON.parse(bytesOf["results.json"].toString("utf8"));
  const derived = JSON.parse(bytesOf["derived.json"].toString("utf8"));
  const record = JSON.parse(bytesOf["run.json"].toString("utf8"));
  const isTransient = !!results && results.schema === "feed.results/0.2" && results.kind === "transient";
  const wellFormed = !!results && !!results.summary && Array.isArray(results.checks) && (isTransient ? Array.isArray(results.times) && results.times.length >= 2 && !!results.series : results.schema === "feed.results/0.1" && Array.isArray(results.radial) && results.radial.length > 0);
  if (!wellFormed) return incomplete("results.json is not a FEED result");
  if (!record || record.state !== "completed") return incomplete("run.json does not record a completed solver run");

  // A result whose own checks failed, or that used a property law outside its stated range, is not a result.
  // Evidence must be present, not assumed: every check carries a recognised verdict and the domain verdict is stated.
  if (results.checks.some((c) => !c || typeof c.id !== "string" || (c.verdict !== "pass" && c.verdict !== "fail"))) return incomplete("results.json has a check without a recognised verdict");
  if (!results.domain || (results.domain.verdict !== "in-domain" && results.domain.verdict !== "out-of-domain")) return incomplete("results.json states no domain verdict");
  // A limit check must say what it means: a margin (a number) with pass at zero or more and fail below, or no margin and pass.
  const limitChecks = results.checks.filter((c) => LIMIT_CHECK.test(c.id));
  for (const c of limitChecks) {
    const m = c.value;
    const coherent = m === null ? c.verdict === "pass" : typeof m === "number" && Number.isFinite(m) && c.verdict === (m >= 0 ? "pass" : "fail");
    if (!coherent) return incomplete("the limit check " + c.id + " does not state a margin that agrees with its verdict", "/quantities/temperature_limit_margin");
  }
  // A stress limit says: a margin (a number) or none; a pass needs a margin of zero or more or none; a fail may carry any margin or none.
  const stressChecks = results.checks.filter((c) => STRESS_LIMIT_CHECK.test(c.id));
  for (const c of stressChecks) {
    const m = c.value;
    const coherent = (m === null || (typeof m === "number" && Number.isFinite(m))) && (c.verdict === "fail" || m === null || m >= 0);
    if (!coherent) return incomplete("the stress limit check " + c.id + " does not state a margin that agrees with its verdict", "/quantities/stress_limit_margin");
  }
  const failing = results.checks.filter((c) => c.verdict === "fail" && !LIMIT_CHECK.test(c.id) && !STRESS_LIMIT_CHECK.test(c.id));
  if (results.domain && results.domain.verdict === "out-of-domain") {
    return fail(typed("E_OUT_OF_DOMAIN", "/quantities", "a conductivity law was used outside the temperature range it is stated for; this is not a valid result"));
  }
  if (failing.length > 0) return incomplete("the run's own checks failed: " + failing.map((c) => String(c.id)).join(", "));
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  if (!isTransient) for (const p of results.radial) if (!p || !finite(p.r) || !finite(p.T)) return incomplete("radial samples are missing or not finite", "/quantities/temperature_radial");
  const balance = results.checks.find((c) => c.id === "energyBalance");
  const sm = results.summary;
  let scalars;
  if (isTransient) {
    const n = results.times.length;
    const ser = results.series;
    const times = results.times;
    if (times[0] !== 0 || times.some((t, i) => !finite(t) || (i > 0 && !(t > times[i - 1])))) return incomplete("the output times are not finite and increasing from 0", "/quantities/temperature_peak_history");
    for (const key of ["time", "power", "deposited", "peakT", "claddingOuterWallT"]) {
      if (!Array.isArray(ser[key]) || ser[key].length !== n || ser[key].some((x) => !finite(x))) return incomplete("the series " + key + " is missing, the wrong length or not finite", "/quantities/" + key);
    }
    scalars = {
      temperature_peak_max: sm.maxT,
      time_of_peak: sm.timeOfMaxT,
      energy_deposited: ser.deposited[n - 1],
      energy_balance_gap: balance ? balance.value : null,
    };
  } else {
    scalars = {
      temperature_peak: sm.maxT,
      temperature_fuel_surface: sm.fuelSurfaceCellT,
      temperature_clad_inner: sm.claddingInnerCellT,
      temperature_surface: sm.claddingOuterWallT,
      heat_flux_outer: derived.heatFluxOuter,
      energy_balance_residual: balance ? balance.value : null,
    };
  }
  for (const [name, v] of Object.entries(scalars)) if (!finite(v)) return incomplete("the value for " + name + " is missing or not finite", "/quantities/" + name);
  const mech = results.mechanics;
  let mechScalars = null;
  let mechStatement = null;
  if (mech !== undefined) {
    if (isTransient) return incomplete("a transient result with mechanics is not supported by this adapter");
    const nf = derived.fuelCells, nc = derived.claddingCells;
    const pts = mech && mech.points;
    const sum = mech && mech.summary;
    const sound = !!mech && Number.isInteger(nf) && nf >= 1 && Number.isInteger(nc) && nc >= 1 && Array.isArray(pts) && pts.length === nf + nc
      && pts.every((q) => !!q && finite(q.ur) && finite(q.sigmaTheta))
      && !!sum && !!sum.fuel && Array.isArray(sum.fuel.axial) && sum.fuel.axial.length === 2 && sum.fuel.axial.every(finite)
      && finite(sum.contactPressure) && finite(mech.internalPressure);
    if (!sound) return incomplete("the mechanics record of results.json is missing a value or is not of the shape the cell counts say", "/quantities/displacement_radial_fuel_last_cell");
    // FEED's own statement of what such a result is (and is not) goes out unchanged, so the index never calls a thermo-elastic result thermal only
    if (typeof results.thermalOnly !== "string" || !results.thermalOnly.startsWith(THERMO_ELASTIC_PREFIX)) return incomplete("a mechanics result must carry FEED's thermo-elastic statement", "/extensions/feed/thermalOnly");
    mechStatement = results.thermalOnly.slice(0, 1500);
    mechScalars = {
      displacement_radial_fuel_last_cell: pts[nf - 1].ur,
      displacement_radial_clad_last_cell: pts[pts.length - 1].ur,
      stress_axial_fuel_min: sum.fuel.axial[0],
      stress_hoop_clad_first_cell: pts[nf].sigmaTheta,
      contact_pressure: sum.contactPressure,
      gas_pressure: mech.internalPressure,
    };
  } else if (stressChecks.length > 0) {
    return incomplete("a stress limit check without a mechanics result", "/quantities/stress_limit_margin");
  }

  // The series folder is written below: it must be a real folder inside the run folder, not a link set up beforehand.
  const seriesDir = path.join(nativeDir, "series");
  try {
    fs.mkdirSync(seriesDir, { recursive: true });
    if (fs.lstatSync(seriesDir).isSymbolicLink() || !containedBelow(found.abs, seriesDir)) return incomplete("the series folder is a link or leaves the run folder");
  } catch (err) {
    return incomplete("cannot use the series folder: " + (err && err.code));
  }
  const runId = path.basename(request.runDir);
  const inputRevisions = [...new Set(job.inputs.map((i) => i.sha256))];
  const quantities = [];
  const seriesOf = { temperature_peak_history: "peakT", temperature_outer_wall_history: "claddingOuterWallT" };
  for (const q of isTransient ? TRANSIENT_QUANTITIES : QUANTITIES) {
    const body = q.series
      ? { quantity: q.name, unit: q.unit, t: results.times, values: results.series[seriesOf[q.name]], note: "temperature_peak_history is the hottest cell centre at each output time; the outer wall is the patch value; t in seconds" }
      : q.radial
        ? { quantity: q.name, unit: q.unit, r: results.radial.map((p) => p.r), values: results.radial.map((p) => p.T), region: results.radial.map((p) => p.region), note: "cell-centre values; r in metres from the pin axis" }
        : { quantity: q.name, unit: q.unit, values: [scalars[q.name]] };
    const text = json(body);
    atomicWrite(path.join(nativeDir, "series", q.name + ".json"), text);
    quantities.push({
      name: q.name,
      unit: q.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + q.name + ".json", sha256: sha256(text) },
      verification: "unverified",
      ...(q.radial ? { coordinates: { system: "radial", axes: [{ name: "r", unit: "m" }] } } : {}),
      ...(q.series ? { coordinates: { system: "time", axes: [{ name: "t", unit: "s" }] } } : {}),
    });
  }
  if (mechScalars) {
    for (const q of MECHANICS_QUANTITIES) {
      const text = json({ quantity: q.name, unit: q.unit, values: [mechScalars[q.name]], note: "thermo-elastic, small strain, linear elastic; a cell-centre value of the solver's mesh (the contact and gas pressures are values of the case); see extensions.feed.thermalOnly for what the result is not" });
      atomicWrite(path.join(nativeDir, "series", q.name + ".json"), text);
      quantities.push({
        name: q.name,
        unit: q.unit,
        normalization: "none",
        provenance: { runId, inputRevisions },
        data: { path: request.runDir + "/native/series/" + q.name + ".json", sha256: sha256(text) },
        verification: "unverified",
      });
    }
  }
  // the fuel temperature by slice (steady only): the slices are written as a series against z, the three numbers as scalars, after they are shown to agree
  if (results.fuelTemperature !== undefined) {
    if (isTransient) return incomplete("a transient result with a fuel temperature is not supported by this adapter", "/quantities/temperature_fuel_mean_by_slice");
    const ft = fuelTemperatureOf(results.fuelTemperature);
    if (typeof ft === "string") return incomplete(ft, "/quantities/temperature_fuel_mean_by_slice");
    for (const q of FUEL_TEMPERATURE_QUANTITIES) {
      const common = { schema: "seed.quantity-data/0.2", quantity: q.name, unit: "K" };
      const body = q.slices
        ? { ...common, kind: "series", axis: { name: "z", unit: "m" }, x: ft.slices.map((s) => (s.zMin + s.zMax) / 2), values: ft.slices.map((s) => s.volumeMean),
            meta: { slices: ft.slices.map((s) => ({ zMin: s.zMin, zMax: s.zMax })), origin: ft.origin, frame: ft.frame, geometry: ft.geometry, meaning: ft.meaning, final: ft.final, note: "x is the middle of each slice; the volume mean of the fuel in the slice, absolute, not a Doppler-effective temperature" } }
        : { ...common, kind: "scalar", value: ft.scalars[q.name], meta: { meaning: ft.meaning, final: ft.final } };
      const text = json(body);
      atomicWrite(path.join(nativeDir, "series", q.name + ".json"), text);
      quantities.push({
        name: q.name, unit: q.unit, normalization: "none", dimension: "temperature",
        provenance: { runId, inputRevisions },
        data: { path: request.runDir + "/native/series/" + q.name + ".json", sha256: sha256(text) },
        verification: "unverified",
        ...(q.slices ? { coordinates: { system: "axial", axes: [{ name: "z", unit: "m" }] } } : {}),
      });
    }
  }
  const margins = limitChecks.filter((c) => c.value !== null).map((c) => c.value);
  if (margins.length > 0) {
    const text = json({ quantity: LIMIT_QUANTITY.name, unit: LIMIT_QUANTITY.unit, values: [Math.min(...margins)], note: "the smallest margin over the limit rules that applied in this run (limit minus hottest cell, K); negative means exceeded; each rule's own margin is in extensions.feed.limits; not an integrity assessment" });
    atomicWrite(path.join(nativeDir, "series", LIMIT_QUANTITY.name + ".json"), text);
    quantities.push({
      name: LIMIT_QUANTITY.name,
      unit: LIMIT_QUANTITY.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + LIMIT_QUANTITY.name + ".json", sha256: sha256(text) },
      verification: "unverified",
    });
  }
  const stressMargins = stressChecks.filter((c) => c.value !== null).map((c) => c.value);
  if (stressMargins.length > 0) {
    const text = json({ quantity: STRESS_LIMIT_QUANTITY.name, unit: STRESS_LIMIT_QUANTITY.unit, values: [Math.min(...stressMargins)], note: "the smallest margin over the stress limits that gave one in this run (strength minus von Mises stress, Pa); negative means a limit was exceeded; each limit's own margin and verdict is in extensions.feed.stressLimits" });
    atomicWrite(path.join(nativeDir, "series", STRESS_LIMIT_QUANTITY.name + ".json"), text);
    quantities.push({
      name: STRESS_LIMIT_QUANTITY.name,
      unit: STRESS_LIMIT_QUANTITY.unit,
      normalization: "none",
      provenance: { runId, inputRevisions },
      data: { path: request.runDir + "/native/series/" + STRESS_LIMIT_QUANTITY.name + ".json", sha256: sha256(text) },
      verification: "unverified",
    });
  }
  const index = {
    // a quantity dimension (the fuel temperature has one, so a transfer can use it) needs the 0.2 index; a result without one stays 0.1
    schema: quantities.some((q) => q.dimension !== undefined) ? "seed.results-index/0.2" : "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: ADAPTER,
    engine: { name: "feed-headless", version: String(manifest.version === 1 ? "0.1.0" : manifest.version) },
    inputHashes: job.inputs.map((i) => ({ path: i.path, sha256: i.sha256 })),
    nativeStatus: { status: "finished", detail: "FEED run completed (" + (isTransient ? results.times.length + " output times" : results.radial.length + " cells") + ", solver exit " + (record.exitCode === undefined ? "n/a" : record.exitCode) + "). " + THERMAL_ONLY },
    quantities,
    extensions: {
      feed: {
        thermalOnly: mechStatement || THERMAL_ONLY,
        ...(mechScalars ? { thermoElastic: true } : {}),
        kind: isTransient ? "transient" : "steady",
        solver: String(record.solver || "").slice(0, 120),
        caseSha256: manifest.caseSha256,
        resultsSha256: manifest.files.find((f) => f.path === "results.json").sha256,
        checks: results.checks.map((c) => ({ id: String(c.id), verdict: String(c.verdict) })),
        ...(stressChecks.length > 0 ? { stressLimits: stressChecks.map((c) => ({ id: String(c.id), verdict: String(c.verdict), marginPa: c.value })) } : {}),
        ...(limitChecks.length > 0 ? { limits: limitChecks.map((c) => ({ id: String(c.id), verdict: String(c.verdict), marginK: c.value })) } : {}),
        domain: results.domain.verdict,
        warnings: Array.isArray(derived.warnings) ? derived.warnings.map((w) => String(w.code)) : [],
        quantityNotes: isTransient ? "temperature_peak_max is the hottest cell-centre value over the whole run (the interior of a short pulse is adiabatic); the power history is an input, not a result; the time step is first order, so the checks include the independent solution and the step-halving estimate; energy_balance_gap includes the first-order error of the time stepping." : "temperature_peak, temperature_fuel_surface and temperature_clad_inner are cell-centre values of the solver mesh; temperature_surface is the converged outer-wall patch value; energy_balance_residual is relative (flux through the cladding wall against the input linear heat rate).",
      },
    },
  };
  const text = json(index);
  atomicWrite(path.join(found.abs, "results.json"), text);
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "completed", resultsIndex: request.runDir + "/results.json", resultsSha256: sha256(text) } });
}

serve({ describe: (_request, _root, reply, fail) => describe(reply, fail), validate, run, status, cancel, collect }, "FEED's editor is its web app; this headless adapter does not open it");
