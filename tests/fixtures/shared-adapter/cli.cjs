"use strict";
// A minimal adapter built only from adapters/shared/*, for testing the shared job wrapper and flows without any real app (tests/adapter-shared-flow.test.ts).
// The "runner" is runner.cjs; the request's settings.mode picks its behavior. The "native run" is a marker file: cancel.cjs writes it, which stands
// in for an app's own cancel verb stopping a run that lives outside our process tree.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { typed, insideRoot, argvOf, normPath, commandLine } = require("../../../adapters/shared/util.cjs");
const { serve, startJob, statusJob, cancelJob } = require("../../../adapters/shared/flow.cjs");

const RUNNER = path.join(__dirname, "runner.cjs");
const CANCELLER = path.join(__dirname, "cancel.cjs");
const spec = (script, args) => ({ command: process.execPath, args: [script, ...args] });

function run(request, root, reply, fail) {
  const found = insideRoot(root, request.runDir);
  if (!found.abs) return fail(typed("E_PATH_TRAVERSAL", "/runDir", "bad run folder"));
  const s = request.settings || {};
  const out = path.join(found.abs, "native", "out");
  const marker = path.join(found.abs, "native-cancelled.txt");
  return startJob({
    root, request, absRunDir: found.abs, reply, fail,
    record: { mode: s.mode, native: !!s.native, unprove: !!s.unprove, inputs: [] },
    runSpec: s.missingRunner ? { command: path.join(found.abs, "no-such-runner.exe"), args: [] } : spec(RUNNER, [s.mode || "ok", out]),
    cancelSpec: s.native ? spec(CANCELLER, [marker]) : null,
    stopNative: s.native ? () => stopNative(marker) : null,
  });
}

/** The app's own native stop: confirmed once the marker exists. */
async function stopNative(marker) {
  const r = spawnSync(process.execPath, [CANCELLER, marker], { encoding: "utf8" });
  return { confirmed: r.status === 0, stoppedOne: r.status === 0 };
}

const ownsRunner = (j, pid) => {
  const cl = commandLine(pid);
  return cl !== null && argvOf(cl).map(normPath).includes(normPath(RUNNER)) && argvOf(cl).map(normPath).includes(normPath(path.join(j.absRunDir, "native", "out")));
};

serve({
  describe: (_r, _root, reply) => reply({ ok: true, result: { app: { id: "shared-fixture", name: "fixture", version: "1" }, formats: [], capabilities: [], parameters: [], quantities: [] } }),
  validate: (_r, _root, reply) => reply({ ok: true, result: { valid: true, problems: [] } }),
  run,
  status: (request, root, reply, fail) => statusJob({ request, root, reply, fail }),
  cancel: (request, root, reply, fail) => cancelJob({
    request, root, reply, fail, ownsRunner,
    // the job record says whether this run has a native part outside the process tree
    stopNative: async (j) => {
      if (!j.job.native) return { confirmed: true, stoppedOne: false };
      const r = await stopNative(path.join(j.absRunDir, "native-cancelled.txt"));
      if (j.job.unprove) {
        // models a wrapper whose proof of ownership is gone by the time the native stop returns (it ended, its number may be reused)
        const hb = path.join(j.nativeDir, "heartbeat.json");
        fs.writeFileSync(hb, JSON.stringify({ ...JSON.parse(fs.readFileSync(hb, "utf8")), token: "no-longer-this-job" }));
      }
      return r;
    },
  }),
  collect: (_r, _root, _reply, fail) => fail(typed("E_UNSUPPORTED", "", "the fixture collects nothing")),
}, "the fixture has no editor");
