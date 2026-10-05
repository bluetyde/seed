"use strict";
// Prepares a real, human sign-off session for SEED's guarded RAFT lesson and conclusion review.
// It creates (outside any SEED project) a project, host configuration, oracle evidence, study header and reviewer
// file, and prints how to start the desktop. It does NOT run the lesson, draft a conclusion or accept anything:
// those are done in the desktop, and the final accept/reject is the reviewer's own click in the native dialog.
//
// Usage (after `npm run build`, with RAFT's headless runner built):
//   node scripts/setup-human-signoff.cjs --raft <RAFT repo> --out <empty folder> --name <reviewer name>
// The reviewer file names the operating-system account that runs this script as the only account allowed to use it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = (p) => require(path.join(root, "dist", p));
const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const raft = arg("raft") && path.resolve(arg("raft"));
const out = arg("out") && path.resolve(arg("out"));
const name = arg("name");
if (!raft || !out || !name || !name.trim() || name.length > 80) {
  console.error("usage: node scripts/setup-human-signoff.cjs --raft <RAFT repo> --out <empty folder> --name <reviewer name>");
  process.exit(2);
}
const bundle = path.join(raft, "web", "dist-headless", "raft-headless.mjs");
const base = path.join(raft, "oracles", "seed");
if (!fs.existsSync(bundle) || !fs.existsSync(path.join(base, "entries"))) {
  console.error("RAFT runner or oracle entries not found under " + raft + " (npm run build:headless in its web folder; oracles/seed in the repo)");
  process.exit(2);
}
if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
  console.error("--out must be a new or empty folder: " + out);
  process.exit(2);
}

const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
const { createProject, openProject } = dist("core/projectStore.js");
const { loadOracleEntries, runOracleSet } = dist("core/oracle.js");
const { RunManager } = dist("core/runManager.js");
const { callAdapter } = dist("core/adapterClient.js");
const { saveHostConfiguration } = dist("core/fileRunHost.js");
const { writeHostJson } = dist("core/hostFiles.js");

const spec = { command: process.execPath, args: [path.join(root, "adapters", "raft", "cli.cjs")], id: "raft", version: "0.1.0" };
const actor = { kind: "agent", name: "seed-lesson-agent", model: "claude-sonnet-5-5" };
const budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const study = { studyId: "signoff-lesson-1", tier: "A1", budget, parameters: [] };
const git = spawnSync("git", ["-C", raft, "rev-parse", "HEAD"], { encoding: "utf8" });
const appCommit = git.status === 0 ? git.stdout.trim() : "unknown";
if (!/^[0-9a-f]{40}$/.test(appCommit)) {
  console.error("cannot read the RAFT commit (git -C <raft> rev-parse HEAD failed; a safe.directory exception may be needed)");
  process.exit(2);
}
process.env.SEED_RAFT_HEADLESS = bundle;
process.env.SEED_RAFT_ORACLES = path.join(base, "entries");

/** Run one oracle entry the way the host does: bad-input through validate, good through the run manager. */
async function observe(entry) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-signoff-oracle-"));
  try {
    for (const d of ["models", "runs"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    for (const i of entry.inputs) {
      fs.mkdirSync(path.dirname(path.join(tmp, i.path)), { recursive: true });
      fs.copyFileSync(path.join(base, i.path), path.join(tmp, i.path));
    }
    const casePath = entry.inputs[0].path;
    const artifact = { path: casePath, revision: { hash: entry.inputs[0].sha256, counter: 1 } };
    if (entry.tag === "bad-input") {
      const o = await callAdapter(spec, { schema: "seed.adapter-request/0.1", verb: "validate", requestId: "req-v", actor, artifact }, { projectRoot: tmp, timeoutMs: 30000 });
      if (!o.ok) throw new Error(JSON.stringify(o.errors));
      const first = o.reply.result && o.reply.result.problems[0];
      return first ? { kind: "refusal", code: first.code } : { kind: "verdict", verdict: "accepted" };
    }
    const mgr = new RunManager({ projectRoot: tmp, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 30000 });
    const res = await mgr.start({ requestId: "req-" + entry.oracleId, actor, artifact, inputs: entry.inputs, budget, settings: { case: casePath } });
    if (!res.ok || res.state !== "completed") throw new Error("oracle run did not complete: " + JSON.stringify(res.errors || res.state));
    const index = JSON.parse(fs.readFileSync(path.join(tmp, "runs", res.runId, "results.json"), "utf8"));
    const q = index.quantities.find((x) => x.name === entry.expected.quantity);
    const values = JSON.parse(fs.readFileSync(path.join(tmp, q.data.path), "utf8")).values;
    return { kind: "value", quantity: q.name, value: values[values.length - 1], unit: q.unit };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  console.log("Running the RAFT oracle set (22 entries) through the adapter ...");
  const { entries, errors } = loadOracleEntries(path.join(base, "entries"));
  if (errors.length > 0) throw new Error("oracle entries do not load: " + JSON.stringify(errors[0]));
  const set = await runOracleSet({ entries, adapter: { id: "raft", version: "0.1.0" }, appCommit, baseDir: base, run: observe });
  if (set.blocked) throw new Error("the oracle set did not pass; not setting up a sign-off: " + JSON.stringify(set.results.filter((r) => r.verdict !== "pass")));
  console.log("Oracle set passed (" + set.results.length + " entries, none failed).");

  const project = path.join(out, "project");
  const state = path.join(out, "state");
  fs.mkdirSync(state);
  const created = createProject(project, { name: "SEED human sign-off lesson", seedVersion: "0.1.0" });
  if (!created.ok) throw new Error("project: " + JSON.stringify(created.errors));
  const entry = entries.find((e) => e.entry.oracleId === "raft-pulse-final-power").entry;
  for (const input of entry.inputs) {
    fs.mkdirSync(path.dirname(path.join(project, input.path)), { recursive: true });
    fs.copyFileSync(path.join(base, input.path), path.join(project, input.path));
  }
  const evidence = path.join(out, "oracle-result.json");
  writeHostJson(evidence, set);
  const artifact = { path: entry.inputs[0].path, revision: { hash: entry.inputs[0].sha256, counter: 1 } };
  const config = path.join(out, "host.json");
  saveHostConfiguration(config, {
    schema: "seed.host/0.1",
    projectRoot: project,
    stateRoot: state,
    adapter: spec,
    actor,
    study,
    cases: { "pulse-lesson": { artifact, inputs: entry.inputs, params: [], settings: { case: artifact.path } } },
    runtime: { path: bundle, sha256: sha(fs.readFileSync(bundle)) },
    oracles: { repository: raft, entriesDir: path.join(base, "entries"), inputsRoot: base, evidenceFile: evidence, evidenceSha256: sha(fs.readFileSync(evidence)) },
    acceptedPins: set.pins,
  });

  const opened = openProject(project);
  if (!opened.ok) throw new Error("project did not reopen");
  const projectId = opened.value.manifest.projectId;
  const header = path.join(out, "study-header.json");
  writeHostJson(header, {
    schema: "seed.study/0.1",
    type: "header",
    seq: 0,
    studyId: study.studyId,
    created: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    projectId,
    question: "How does reactor power respond to the registered pulse case on RAFT's synthetic core?",
    hypothesis: "Power rises sharply during the pulse and is then limited by fuel temperature feedback.",
    assumptions: [
      "Synthetic RAFT library (a test fixture, not a real reactor)",
      "Oracle coverage is limited to final power, fuel temperature and energy of six engine golden vectors",
      "Educational use only; not a safety analysis",
    ],
    parameters: [],
    budget,
    tier: study.tier,
    startRevisions: entry.inputs.map((i, n) => ({ artifact: "input-" + n, revision: i.sha256 })),
    setBy: { kind: "human", name },
  });
  const reviewer = path.join(out, "reviewer.json");
  writeHostJson(reviewer, {
    schema: "seed.reviewer/0.2",
    osUser: os.userInfo().username,
    projectId,
    studyId: study.studyId,
    actor: { kind: "human", name },
  });

  const env = { SEED_HOST_CONFIG: config, SEED_STUDY_HEADER: header, SEED_REVIEWER_CONFIG: reviewer };
  fs.writeFileSync(path.join(out, "environment.json"), JSON.stringify(env, null, 2) + "\n");
  console.log("\nSetup written to " + out);
  console.log("  project   " + project + "  (id " + projectId + ")");
  console.log("  reviewer  " + name + ", operating-system account " + os.userInfo().username);
  console.log("\nStart SEED with these variables set (see docs/manual-signoff.md):");
  for (const [k, v] of Object.entries(env)) console.log("  " + k + "=" + v);
})().catch((e) => {
  console.error("setup failed: " + (e && e.message ? e.message : e));
  process.exit(1);
});
