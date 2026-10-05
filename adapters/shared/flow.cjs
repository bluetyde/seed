"use strict";
// The verbs every SEED adapter implements the same way, on top of adapters/shared/util.cjs: the stdin/stdout scaffolding (`serve`), starting
// a detached job (`startJob`), `status` and `cancel`. An adapter supplies what is its own: describe, validate, parsing and checking a run
// request, the launch spec of its runner, and collect.
//
// Rules this file enforces for every adapter (each was a review finding in at least one of them):
//  - one request id belongs to one run folder; a start for another folder is refused before anything is created;
//  - the run folder is reserved exclusively (`wx`) before anything starts, and the job index too; a failed start removes only what THIS call created;
//  - a failed start that cannot be shown to have stopped the job keeps its records, so the job can still be found and cancelled;
//  - cancel kills only a process whose command line proves it is this job's (util.ownsJobProcess), and stops the app's native run first
//    when the app keeps one outside the process tree (WSL, a solver distro); `cancelled: true` only on confirmation.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  typed, json, readJson, atomicWrite, canonical, sha256, jobsDir, jobIdFor, jobIndexPath, findJob, jobState, containedBelow, isAlive, killTree, waitDead, ownsJobProcess,
} = require("./util.cjs");

/** The wrapper every adapter starts. Its path is part of the ownership check, so it is one constant for all of them. */
const SHARED_JOB = path.join(__dirname, "job.cjs");

/**
 * The process scaffolding of an adapter: `node cli.cjs <verb>` reads one request from stdin, calls the handler, and writes one
 * seed.adapter-reply/0.1 to stdout (exit 0 means a reply was produced). handlers: {describe, validate, run, status, cancel, collect, open?}, each
 * (request, root, reply, fail) => void | Promise. `openMessage` is the refusal text for the verb `open` when there is no handler.
 */
async function serve(handlers, openMessage) {
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
    if (verb === "open" && !handlers.open) return fail(typed("E_VERB_UNKNOWN", "/verb", openMessage || "this adapter does not open an editor"));
    if (!["describe", "open", "validate", "run", "status", "cancel", "collect"].includes(verb) || typeof handlers[verb] !== "function") return fail(typed("E_VERB_UNKNOWN", "/verb", "unknown verb"));
    return await handlers[verb](request, root, reply, fail);
  } catch (err) {
    return fail(typed("E_INTERNAL", "", "adapter failure: " + (err && err.message)));
  }
}

/**
 * Start a job for a run request the adapter has already checked. `record` is the adapter's own job fields (what collect needs later: the model
 * path, settings, snapshot inputs). `runSpec`/`cancelSpec` are launch specs {command, args, env?, cwd?}; `cancelSpec` is the app's own cancel verb
 * (null when the runner has nothing outside its process tree); `outcome` optionally names the adapter's outcome module. `stopNative` (async,
 * optional) stops the app's native run when a failed start has to be rolled back.
 */
async function startJob({ root, request, absRunDir, record: extra, runSpec, cancelSpec = null, outcome = "", stopNative = null, reply, fail }) {
  const nativeDir = path.join(absRunDir, "native");
  const jobJsonPath = path.join(nativeDir, "job.json");
  const jobId = jobIdFor(request.requestId);
  const dir = jobsDir(root, true);
  if (!dir) return fail(typed("E_PATH_TRAVERSAL", "/.seed/jobs", "the job registry folder is a link or leaves the project"));
  const indexPath = jobIndexPath(dir, jobId);
  // One request id belongs to one run folder: refuse a start that would reuse it elsewhere, before anything is created in the other folder.
  const bound = readJson(indexPath);
  if (bound && bound.runDir !== request.runDir) return fail(typed("E_REQUEST_CONFLICT", "/requestId", "this request id is already bound to another run folder"));
  fs.mkdirSync(nativeDir, { recursive: true });
  if (!containedBelow(absRunDir, nativeDir) || fs.lstatSync(nativeDir).isSymbolicLink()) {
    return fail(typed("E_PATH_TRAVERSAL", "/runDir", "the native state folder is a link or leaves the run folder"));
  }

  // Reserve the run folder exclusively before anything is started: a concurrent start of the same request sees the reservation, and another
  // request is refused. The record is completed (with the process id) after the start.
  const token = crypto.randomBytes(16).toString("hex");
  // What determines the run: the same request id with another payload is a different request (the host compares its whole start request; this
  // is the adapter's own guard for a client that reaches it directly). Budget and actor are not part of it.
  const payloadHash = sha256(canonical({
    inputs: ((request.snapshot && request.snapshot.inputs) || []).map((i) => ({ path: i.path, sha256: i.sha256 })),
    settings: request.settings || {},
    seed: request.seed === undefined ? null : request.seed,
  }));
  const record = { jobId, requestId: request.requestId, pid: null, token, payloadHash, ...extra };
  try {
    fs.writeFileSync(jobJsonPath, json(record), { flag: "wx" });
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    let existing = readJson(jobJsonPath);
    const differs = (e) => e && e.requestId === request.requestId && typeof e.payloadHash === "string" && e.payloadHash !== payloadHash;
    if (differs(existing)) return fail(typed("E_REQUEST_CONFLICT", "/requestId", "this request id was already used with a different payload (settings, seed or inputs)"));
    if (existing && existing.requestId === request.requestId) {
      // The request id is the idempotency key: the same request gives the same job. A reservation without a process id is a launch that has
      // not committed yet (another call of this request is starting it): wait for it, because answering "running" for a launch that then
      // fails would name a job that never existed.
      for (let waited = 0; waited < 20000 && existing && existing.requestId === request.requestId && !Number.isInteger(existing.pid); waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
        existing = readJson(jobJsonPath);
      }
      if (existing && existing.requestId === request.requestId && Number.isInteger(existing.pid)) {
        return reply({ ok: true, result: { jobId: existing.jobId, runDir: request.runDir, lifecycle: "running" } });
      }
      if (!existing) return fail(typed("E_REQUEST_CONFLICT", "", "the earlier launch of this request failed and was rolled back; start it again"));
      if (existing.requestId === request.requestId) return fail(typed("E_REQUEST_CONFLICT", "", "the launch of this request is still being registered; retry shortly"));
    }
    return fail(typed("E_REQUEST_CONFLICT", "", "this run folder already belongs to another request"));
  }

  // The job index is reserved before anything starts, and a failed start removes only what THIS invocation created: the same request id used
  // for another run folder must never delete the first job's registry entry.
  let createdIndex = false;
  const removeOwn = () => {
    for (const f of [jobJsonPath, ...(createdIndex ? [indexPath] : [])]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort: the folder is being abandoned
      }
    }
  };
  try {
    fs.writeFileSync(indexPath, json({ runDir: request.runDir }), { flag: "wx" });
    createdIndex = true;
  } catch (err) {
    // an index entry for this same run folder is a leftover of an earlier launch whose job.json is gone: reuse it, do not delete it
    if (!(err && err.code === "EEXIST" && readJson(indexPath) && readJson(indexPath).runDir === request.runDir)) {
      removeOwn();
      if (err && err.code === "EEXIST") return fail(typed("E_REQUEST_CONFLICT", "/requestId", "this request id already belongs to a job in another run folder"));
      return fail(typed("E_INTERNAL", "", "could not register the job: " + (err && err.code ? err.code : err)));
    }
  }

  const rollback = async (child, error) => {
    if (child && Number.isInteger(child.pid)) {
      let stopped = false;
      try {
        if (stopNative) await stopNative();
        await killTree(child.pid);
        stopped = await waitDead(child.pid, 3000);
      } catch {
        stopped = false;
      }
      if (!stopped) {
        // The launch cannot be shown to be gone: keep the records so the job can still be found and cancelled.
        try {
          atomicWrite(jobJsonPath, json({ ...record, pid: child.pid }));
        } catch {
          // nothing more can be recorded
        }
        return fail(typed("E_APP_FAILED", "", "launch failed (" + error.message + ") and the job process could not be confirmed stopped; its records were kept (job " + jobId + ")"));
      }
    }
    removeOwn();
    return fail(error);
  };

  let child;
  try {
    child = spawn(process.execPath, [SHARED_JOB, absRunDir, token, JSON.stringify(runSpec), JSON.stringify(cancelSpec), outcome], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  } catch (err) {
    return rollback(null, typed("E_APP_FAILED", "", "could not start the job: " + (err && err.message)));
  }
  child.unref();
  const nativeIdentity = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message && message.token === token && Number.isSafeInteger(message.runnerPid) && message.runnerPid > 1 ? message.runnerPid : null);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (!Number.isInteger(child.pid)) return rollback(null, typed("E_APP_FAILED", "", "the job did not start"));
  try {
    atomicWrite(jobJsonPath, json({ ...record, pid: child.pid }));
  } catch (err) {
    return rollback(child, typed("E_INTERNAL", "", "could not register the job, so it was stopped: " + (err && err.code ? err.code : err)));
  }
  const runnerPid = await nativeIdentity;
  if (!runnerPid) return rollback(child, typed("E_APP_FAILED", "", "native runner identity was not confirmed over launch IPC"));
  reply({ ok: true, result: { jobId, runDir: request.runDir, lifecycle: "running", nativeProcesses: [child.pid, runnerPid] } });
}

/** `status`: the lifecycle from the wrapper's status file, heartbeat and token. */
function statusJob({ request, root, reply, fail, extraStatuses = {} }) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const s = jobState(j.nativeDir, j.job, extraStatuses);
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

/**
 * `cancel`. Hooks (all optional):
 *  stopNative(j) -> {confirmed, stoppedOne, notOwned}  stops the app's native run (outside the process tree); `confirmed` only when nothing of the
 *      run is left, `stoppedOne` when it found and stopped a running one, `notOwned` when the app's own ownership check refused.
 *  ownsRunner(j, pid) -> boolean  true only when the process at `pid` is this run's runner (command line proof); without it a runner left behind
 *      by a dead wrapper is never killed.
 *  extraStatuses  the adapter's own final status words (see util.jobState).
 */
async function cancelJob({ request, root, reply, fail, stopNative = null, ownsRunner = null, extraStatuses = {} }) {
  const j = findJob(root, request.jobId);
  if (!j) return fail(typed("E_APP_FAILED", "/jobId", "job not found: " + request.jobId));
  const launch = request.extensions && request.extensions["seed.launch"];
  if (launch) {
    const child = readJson(path.join(j.nativeDir, "child.json"));
    const pids = launch.nativeProcesses;
    if (launch.runDir !== j.runDir || (pids !== undefined && (!Array.isArray(pids) || pids.length !== 2 ||
      pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2) || j.job.pid !== pids[0] || !child || child.pid !== pids[1]))) {
      return fail(typed("E_NOT_OWNED", "/extensions/seed.launch", "job differs from protected launch binding"));
    }
  }
  const s = jobState(j.nativeDir, j.job, extraStatuses);
  const child = readJson(path.join(j.nativeDir, "child.json"));
  const childPid = child && Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null;
  if (s.lifecycle !== "running") {
    // Already over (or died): nothing was cancelled by this call. A wrapper that died can leave the native run going outside any process tree:
    // ask the app (which proves its own child) and stop the runner only when it provably is ours.
    let nativeStopped = !s.alive && (childPid === null || !isAlive(childPid));
    // Only when the wrapper is gone: a live wrapper whose token or heartbeat does not match this job is not shown to be ours, and its run is left alone.
    if (s.lifecycle === "failed" && stopNative && !s.alive) {
      const n = await stopNative(j);
      if (n.notOwned) return fail(typed("E_NOT_OWNED", "/jobId", "a process of this run is still running and cannot be shown to be this run's own"));
      nativeStopped = nativeStopped && n.confirmed;
    }
    // Same rule for the runner: only one left behind by a dead wrapper. A live wrapper that is not running this job is left alone, with everything under it.
    if (!s.alive && childPid !== null && isAlive(childPid)) {
      if (!ownsRunner || !ownsRunner(j, childPid)) return fail(typed("E_NOT_OWNED", "/jobId", "a process from this job is still running and cannot be shown to be this run's runner"));
      await killTree(childPid);
      nativeStopped = nativeStopped && (await waitDead(childPid, 5000));
    }
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: s.lifecycle, cancelled: false, nativeStopped } });
  }
  if (!ownsJobProcess(j, s, SHARED_JOB)) return fail(typed("E_NOT_OWNED", "/jobId", "the process behind this job is not owned by this run"));

  // 1. The native run first, when the app has one outside the process tree.
  let first = { confirmed: true, stoppedOne: true };
  if (stopNative) {
    first = await stopNative(j);
    if (first.notOwned) return fail(typed("E_NOT_OWNED", "/jobId", "the native process of this run cannot be shown to be its own"));
    if (!first.confirmed) return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  }
  // 2. Then the wrapper and the runner, only after the command line proved they are this job's.
  await killTree(j.job.pid);
  const dead = await waitDead(j.job.pid, 5000);
  const childDead = childPid !== null ? await waitDead(childPid, 5000) : true;
  if (!dead || !childDead) return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "running", cancelled: false } });
  // 3. If the first stop found nothing registered yet, the runner may have been about to start the native run: with the runner dead no new
  //    one can appear, so ask again and require that answer to be confirmed too.
  if (stopNative && !first.stoppedOne && !(await stopNative(j)).confirmed) {
    return reply({ ok: true, result: { jobId: request.jobId, lifecycle: "failed", cancelled: false, nativeStopped: false } });
  }
  atomicWrite(path.join(j.nativeDir, "status.json"), json({ status: "cancelled", startedAt: s.status && s.status.startedAt, finishedAt: new Date().toISOString() }));
  reply({ ok: true, result: { jobId: request.jobId, lifecycle: "cancelled", cancelled: true, ...(stopNative ? { nativeStopped: true } : {}) } });
}

module.exports = { SHARED_JOB, serve, startJob, statusJob, cancelJob };
