import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import { RunManager, type Budget } from "../src/core/runManager";
import { checkResultsAgainstRecord, checkResultsIndex } from "../src/core/semantic";
import { validate } from "../src/core/validate";

// The real tests need RAFT's headless runner: SEED_RAFT_REPO (default: a sibling folder named virtual-reactor) with
// `npm run build:headless` done in its web folder. Without it they are skipped, loudly, and only the stub tests run.
const repo = process.env.SEED_RAFT_REPO ?? join(__dirname, "..", "..", "virtual-reactor");
const realBundle = join(repo, "web", "dist-headless", "raft-headless.mjs");
const haveRaft = existsSync(realBundle);
const vectorsDir = join(repo, "schema", "engine-vectors");
const coreDir = join(repo, "schema", "vectors", "synthetic-core");
const stubBundle = join(__dirname, "fixtures", "raft-stub", "raft-headless.mjs");
const spec = { command: process.execPath, args: [join(__dirname, "..", "adapters", "raft", "cli.cjs")], id: "raft", version: "0.1.0" };
const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
const CASE = "models/raft/case.json";

const dirs: string[] = [];
const pids: number[] = [];
const savedEnv = process.env.SEED_RAFT_HEADLESS;
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      if (isAlive(pid)) spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(pid), "/T", "/F"] : ["-9", String(pid)]);
    } catch {
      // best effort cleanup of a test's leftovers
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.SEED_RAFT_HEADLESS;
  else process.env.SEED_RAFT_HEADLESS = savedEnv;
});
afterAll(() => {
  if (!haveRaft) console.warn(`RAFT headless runner not found at ${realBundle}: the real-runner tests were skipped`);
});
beforeEach(() => {
  if (haveRaft) process.env.SEED_RAFT_HEADLESS = realBundle;
});

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), "seed-raft-"));
  dirs.push(root);
  for (const d of ["models", "runs", "studies", "oracles"]) mkdirSync(join(root, d));
  return root;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

type Vec = Record<string, any>;
const vector = (name: string): Vec => JSON.parse(readFileSync(join(vectorsDir, `${name}.json`), "utf8"));

/** A project holding the synthetic library and one golden vector as a RAFT case. */
function raftProject(name = "scram", edit: (c: Record<string, any>) => void = () => {}) {
  const root = newProject();
  cpSync(coreDir, join(root, "models", "raft", "lib"), { recursive: true });
  const vec = vector(name);
  const c: Record<string, any> = {
    format: "raft-headless-case",
    version: 1,
    library: "lib",
    seed: vec.seed,
    init: vec.init,
    config: vec.config,
    steps: vec.steps,
    sampleEvery: vec.sampleEvery,
    script: vec.script.map((i: Vec) => ({ ...i, clientId: "local" })),
  };
  edit(c);
  const caseText = JSON.stringify(c, null, 2) + "\n";
  writeFileSync(join(root, CASE), caseText);
  const inputs = listFiles(join(root, "models", "raft")).map((p) => {
    const path = `models/raft/${p}`;
    return { path, sha256: sha256Hex(readFileSync(join(root, path))) };
  });
  const artifact = { path: CASE, revision: { hash: sha256Hex(caseText), counter: 1 } };
  return { root, vec, inputs, artifact, caseText };
}

const manager = (root: string) => new RunManager({ projectRoot: root, runsFolder: "runs", adapter: spec, pollMs: 100, callTimeoutMs: 20000 });
const ask = (root: string, request: Record<string, unknown>) =>
  callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 30000 });
const okReply = (o: Awaited<ReturnType<typeof ask>>) => {
  if (!o.ok) throw new Error("transport: " + JSON.stringify(o.errors));
  return o.reply as { ok: boolean; errors: { code: string; field: string; message: string; source: string }[]; result?: any };
};

function series(root: string, runId: string, name: string): { t: number[]; values: number[]; unit: string } {
  return JSON.parse(readFileSync(join(root, "runs", runId, "native", "series", `${name}.json`), "utf8"));
}

const close = (a: number, b: number, tol: { abs?: number; rel?: number }) => Math.abs(a - b) <= (tol.abs ?? 1e-12) + (tol.rel ?? 1e-9) * Math.abs(b);
const TOL_KEY: Record<string, string> = { power: "power", energy: "power", fuelTemp: "temperature", coolantTemp: "temperature" };

const VECTORS = haveRaft ? readdirSync(vectorsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")) : [];

describe.skipIf(!haveRaft)("RAFT adapter against the real headless runner", () => {
  it("describe: valid reply with the runner's engine version and no oracle claims yet", async () => {
    const root = newProject();
    const r = okReply(await ask(root, { verb: "describe" }));
    expect(r.ok).toBe(true);
    expect(r.result.app.id).toBe("raft");
    expect(r.result.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.result.quantities.map((q: { name: string }) => q.name)).toEqual(["power", "fuelTemp", "coolantTemp", "energy", "reactivityTotal"]);
    expect(r.result.oracleCoverage).toEqual([]);
  });

  it("open is not supported", async () => {
    const { root, artifact } = raftProject();
    const r = okReply(await ask(root, { verb: "open", artifact }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_VERB_UNKNOWN");
  });

  it("validate: a good case is valid", async () => {
    const { root, artifact } = raftProject();
    const r = okReply(await ask(root, { verb: "validate", artifact }));
    expect(r).toMatchObject({ ok: true, result: { valid: true, problems: [] } });
  });

  it.each([
    ["steps zero", (c: Vec) => (c.steps = 0), "E_SCHEMA_INVALID", "/steps"],
    ["outerDt zero", (c: Vec) => (c.config = { outerDt: 0 }), "E_SCHEMA_INVALID", "/config/outerDt"],
    ["future version", (c: Vec) => (c.version = 2), "E_SCHEMA_VERSION", "/version"],
    ["absolute library", (c: Vec) => (c.library = "/etc"), "E_PATH_INVALID", "/library"],
    ["missing library", (c: Vec) => (c.library = "nowhere"), "E_NOT_FOUND", "/library"],
    ["init without an equilibrium", (c: Vec) => (c.init = { rods: { safety: 1.0, regulating: 1.0, transient: 1.0 } }), "E_OUT_OF_DOMAIN", "/init"],
  ])("validate: %s gives a typed problem labelled as app content", async (_n, edit, code, field) => {
    const { root, artifact } = raftProject("scram", edit);
    const r = okReply(await ask(root, { verb: "validate", artifact }));
    expect(r.ok).toBe(true);
    expect(r.result.valid).toBe(false);
    expect(r.result.problems[0]).toMatchObject({ code, field, source: "app-content" });
  });

  it("validate: a stale revision and a library that leaves the project are problems", async () => {
    const { root, artifact } = raftProject();
    const stale = okReply(await ask(root, { verb: "validate", artifact: { ...artifact, revision: { hash: "0".repeat(64), counter: 1 } } }));
    expect(stale.result.problems.map((p: { code: string }) => p.code)).toContain("E_STALE_REVISION");
    const outside = newProject();
    cpSync(coreDir, join(outside, "lib"), { recursive: true });
    rmSync(join(root, "models", "raft", "lib"), { recursive: true });
    try {
      symlinkSync(join(outside, "lib"), join(root, "models", "raft", "lib"), "junction");
    } catch {
      return; // links are not permitted in this environment
    }
    const out = okReply(await ask(root, { verb: "validate", artifact }));
    expect(out.result.valid).toBe(false);
    expect(out.result.problems.map((p: { code: string }) => p.code)).toContain("E_PATH_TRAVERSAL");
  });

  it("validate: a missing case file and a path that leaves the project", async () => {
    const { root, artifact } = raftProject();
    const missing = okReply(await ask(root, { verb: "validate", artifact: { ...artifact, path: "models/raft/none.json" } }));
    expect(missing.result.problems[0]?.code).toBe("E_NOT_FOUND");
    // a path that leaves the project never reaches the adapter: the request schema refuses it
    const esc = await ask(root, { verb: "validate", artifact: { path: "../x.json", revision: artifact.revision } });
    expect(esc.ok).toBe(false);
  });

  describe("through the run manager (SEED lifecycle)", () => {
    it.each(VECTORS)("%s: completed, valid index, series equal the direct run and the golden vector", async (name) => {
      const { root, vec, inputs, artifact } = raftProject(name);
      const out = await manager(root).start({ requestId: `req-${name}`, actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error(JSON.stringify(out.errors));
      expect(out.state).toBe("completed");
      const dir = join(root, "runs", out.runId);
      const index = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
      expect(validate("results-index", index)).toEqual({ ok: true });
      expect(checkResultsIndex(index)).toEqual([]);
      expect(checkResultsAgainstRecord(index, out.record)).toEqual([]);
      expect(index.quantities.map((q: { name: string }) => q.name)).toEqual(["power", "fuelTemp", "coolantTemp", "energy", "reactivityTotal"]);
      for (const q of index.quantities) expect(sha256Hex(readFileSync(join(root, q.data.path)))).toBe(q.data.sha256);

      // Parity: the same case run directly through the runner gives the same numbers, bit for bit.
      const direct = spawnSync(process.execPath, [realBundle, "run", join(root, CASE), "--out", join(root, "direct"), "--run-id", "d"], { encoding: "utf8" });
      expect(direct.status).toBe(0);
      const directResults = JSON.parse(readFileSync(join(root, "direct", "d", "results.json"), "utf8"));
      for (const q of ["power", "fuelTemp", "coolantTemp", "energy", "reactivityTotal"]) {
        expect(series(root, out.runId, q).values).toEqual(directResults.samples.map((s: Vec) => s[q]));
      }
      expect(series(root, out.runId, "power").t).toEqual(directResults.samples.map((s: Vec) => s.t));

      // Oracle agreement: the SEED run matches the committed golden vector within the vector's own tolerances.
      expect(directResults.samples.length).toBe(vec.samples.length);
      for (const q of ["power", "fuelTemp", "coolantTemp", "energy", "reactivityTotal"]) {
        const tol = vec.tolerances[TOL_KEY[q] ?? ""] ?? { rel: 1e-9, abs: 1e-12 };
        const got = series(root, out.runId, q).values;
        const want = vec.samples.map((s: Vec) => (q === "reactivityTotal" ? s.reactivityTotal : s[q]));
        got.forEach((v, i) => expect(close(v, want[i], tol), `${q}[${i}] ${v} vs ${want[i]}`).toBe(true));
      }
    });

    it("the quantities carry units and the index records the library and case the run used", async () => {
      const { root, inputs, artifact, caseText } = raftProject("pulse");
      const out = await manager(root).start({ requestId: "req-units", actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      const index = JSON.parse(readFileSync(join(root, "runs", out.runId, "results.json"), "utf8"));
      expect(index.quantities.map((q: { unit: string }) => q.unit)).toEqual(["W", "K", "K", "J", "dk/k"]);
      expect(index.extensions.raft.caseSha256).toBe(sha256Hex(caseText));
      expect(index.extensions.raft.libraryDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(index.quantities.every((q: { verification: string }) => q.verification === "unverified")).toBe(true);
    });

    it("a case that cannot start is refused at validation: no run folder, no process", async () => {
      const { root, inputs, artifact } = raftProject("scram", (c) => (c.config = { outerDt: 0 }));
      const out = await manager(root).start({ requestId: "req-bad", actor, artifact, inputs, budget, settings: { case: CASE } });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/config/outerDt", source: "app-content" });
      expect(readdirSync(join(root, "runs")).filter((n) => n.startsWith("r-"))).toEqual([]);
    });

    it("the request seed must match the case seed", async () => {
      const { root, inputs, artifact } = raftProject();
      const out = await manager(root).start({ requestId: "req-seed", actor, artifact, inputs, budget, seed: 99, settings: { case: CASE } });
      // the adapter refuses the run verb; the run is recorded failed with the typed error, and no job exists
      expect(out.ok && out.state).toBe("failed");
      expect(JSON.stringify(out.ok && out.record)).toContain("E_REQUEST_CONFLICT");
      expect(existsSync(join(root, "runs", (out as { runId: string }).runId, "native", "job.json"))).toBe(false);
    });

    it("the case must be named when it is not the only case.json among the inputs, and must be an input", async () => {
      const { root, inputs, artifact } = raftProject();
      const extra = { path: "models/raft/other-case.json", sha256: inputs[0]!.sha256 };
      writeFileSync(join(root, extra.path), "x");
      const a = await manager(root).start({ requestId: "req-n1", actor, artifact, inputs, budget, settings: { case: "models/raft/not-there.json" } });
      expect(a.ok && a.state).toBe("failed");
      expect(JSON.stringify(a.ok && a.record)).toContain("E_PROP_MISSING");
    });

    it("cancel: kills the job and the runner underneath it, leaves RAFT's own manifest saying running", async () => {
      const { root, inputs, artifact } = raftProject("scram", (c) => {
        c.steps = 2_000_000;
        c.sampleEvery = 100_000;
        c.script = [];
      });
      const mgr = manager(root);
      const started = mgr.start({ requestId: "req-cancel", actor, artifact, inputs, budget, settings: { case: CASE } });
      let runId: string | undefined;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const reqs = JSON.parse(readFileSync(join(root, "runs", "requests.json"), "utf8"));
          const id = reqs["req-cancel"]?.runId as string | undefined;
          if (id && existsSync(join(root, "runs", id, "native", "child.json"))) {
            runId = id;
            break;
          }
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(runId).toBeDefined();
      const job = JSON.parse(readFileSync(join(root, "runs", runId!, "native", "job.json"), "utf8"));
      const child = JSON.parse(readFileSync(join(root, "runs", runId!, "native", "child.json"), "utf8"));
      pids.push(job.pid, child.pid);
      expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
      const c = await mgr.cancel(runId!);
      expect(c.ok && c.state).toBe("cancelled");
      const s = await started;
      expect(s.ok && s.state).toBe("cancelled");
      expect(isAlive(job.pid)).toBe(false);
      expect(isAlive(child.pid)).toBe(false);
      const m = JSON.parse(readFileSync(join(root, "runs", runId!, "native", "out", "raft", "manifest.json"), "utf8"));
      expect(m.status).toBe("running");
      // nothing was collected from the half-finished run
      expect(existsSync(join(root, "runs", runId!, "results.json"))).toBe(false);
    }, 60000);

    it("collect refuses a run whose files were changed after it finished", async () => {
      const { root, inputs, artifact } = raftProject("rod-withdrawal");
      const out = await manager(root).start({ requestId: "req-tamper", actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      const resultsPath = join(root, "runs", out.runId, "native", "out", "raft", "results.json");
      writeFileSync(resultsPath, readFileSync(resultsPath, "utf8").replace('"power"', '"power": 1, "x"'));
      const jobId = JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId;
      const r = okReply(await ask(root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.code).toBe("E_OUTPUT_INCOMPLETE");
      expect(r.errors[0]?.message).toContain("manifest hash");
    });

    it("collect does not trust a re-hashed results file or a manifest with a changed file list", async () => {
      const edits: [string, (m: Vec, res: Vec) => void, string][] = [
        ["a results file naming another case", (_m, res) => (res.caseSha256 = "0".repeat(64)), "snapshot's case"],
        ["a file list without session.json", (m) => (m.files = m.files.filter((f: { path: string }) => f.path !== "session.json")), "exactly its three files"],
      ];
      for (const [what, edit, message] of edits) {
        const { root, inputs, artifact } = raftProject("rod-withdrawal");
        const out = await manager(root).start({ requestId: "req-rehash", actor, artifact, inputs, budget, settings: { case: CASE } });
        if (!out.ok) throw new Error("refused");
        const dir = join(root, "runs", out.runId, "native", "out", "raft");
        const res = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        edit(m, res);
        const text = JSON.stringify(res, null, 2) + "\n";
        writeFileSync(join(dir, "results.json"), text);
        const entry = m.files.find((f: { path: string }) => f.path === "results.json");
        entry.sha256 = sha256Hex(text);
        entry.bytes = Buffer.byteLength(text);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
        const jobId = JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId;
        const r = okReply(await ask(root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
        expect(r.ok, what).toBe(false);
        expect(r.errors[0]?.message, what).toContain(message);
      }
    });

    it("collect refuses a run whose snapshot case was replaced after it ran", async () => {
      const { root, inputs, artifact } = raftProject("rod-withdrawal");
      const out = await manager(root).start({ requestId: "req-swap", actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      const snap = join(root, "runs", out.runId, "inputs", CASE);
      writeFileSync(snap, readFileSync(snap, "utf8").replace('"seed": 1', '"seed": 2'));
      const jobId = JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId;
      const r = okReply(await ask(root, { verb: "collect", jobId, runDir: `runs/${out.runId}` }));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.message).toContain("snapshot's case");
    });

    it("cancel does not kill a process whose heartbeat does not carry the job's token (pid reuse guard)", async () => {
      const { root, inputs, artifact } = raftProject("scram", (c) => {
        c.steps = 2_000_000;
        c.sampleEvery = 100_000;
        c.script = [];
      });
      const mgr = manager(root);
      const started = mgr.start({ requestId: "req-owner", actor, artifact, inputs, budget, settings: { case: CASE } });
      let runId: string | undefined;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !runId) {
        try {
          const id = JSON.parse(readFileSync(join(root, "runs", "requests.json"), "utf8"))["req-owner"]?.runId as string | undefined;
          if (id && existsSync(join(root, "runs", id, "native", "child.json"))) runId = id;
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(runId).toBeDefined();
      const jobPath = join(root, "runs", runId!, "native", "job.json");
      const job = JSON.parse(readFileSync(jobPath, "utf8"));
      const child = JSON.parse(readFileSync(join(root, "runs", runId!, "native", "child.json"), "utf8"));
      pids.push(job.pid, child.pid);
      writeFileSync(jobPath, JSON.stringify({ ...job, token: "not-the-token" }));
      const early = okReply(await ask(root, { verb: "collect", jobId: job.jobId, runDir: `runs/${runId}` }));
      expect(early.ok).toBe(false);
      expect(early.errors[0]).toMatchObject({ code: "E_OUTPUT_INCOMPLETE", message: "job is not completed" });
      const r = okReply(await ask(root, { verb: "cancel", jobId: job.jobId }));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.code).toBe("E_NOT_OWNED");
      expect(isAlive(job.pid) && isAlive(child.pid)).toBe(true);
      writeFileSync(jobPath, JSON.stringify(job));
      await mgr.cancel(runId!);
      await started;
    }, 60000);

    it("status and cancel of an unknown job are typed failures, and a finished job is not cancelled again", async () => {
      const { root, inputs, artifact } = raftProject("rod-withdrawal");
      expect(okReply(await ask(root, { verb: "status", jobId: "job-none" })).errors[0]?.code).toBe("E_APP_FAILED");
      expect(okReply(await ask(root, { verb: "cancel", jobId: "job-none" })).errors[0]?.code).toBe("E_APP_FAILED");
      const out = await manager(root).start({ requestId: "req-done", actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      const jobId = JSON.parse(readFileSync(join(root, "runs", out.runId, "native", "job.json"), "utf8")).jobId;
      const c = okReply(await ask(root, { verb: "cancel", jobId }));
      expect(c.result).toMatchObject({ lifecycle: "completed", cancelled: false });
      const s = okReply(await ask(root, { verb: "status", jobId }));
      expect(s.result.lifecycle).toBe("completed");
    });

    it("the same request twice gives one job (idempotent), another request on that run folder conflicts", async () => {
      const { root, inputs, artifact } = raftProject("rod-withdrawal");
      const out = await manager(root).start({ requestId: "req-idem", actor, artifact, inputs, budget, settings: { case: CASE } });
      if (!out.ok) throw new Error("refused");
      const runDir = `runs/${out.runId}`;
      const snapshot = { inputs };
      const again = okReply(await ask(root, { verb: "run", requestId: "req-idem", snapshot, runDir, budget, settings: { case: CASE } }));
      expect(again.ok).toBe(true);
      const other = okReply(await ask(root, { verb: "run", requestId: "req-other", snapshot, runDir, budget, settings: { case: CASE } }));
      expect(other.ok).toBe(false);
      expect(other.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
    });
  });

  it("no raft-headless or job process is left behind", () => {
    const list =
      process.platform === "win32"
        ? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" }).stdout
        : spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
    const mine = list.split("\n").filter((l) => l.includes("adapters") && l.includes("raft") && l.includes("job.cjs"));
    expect(mine).toEqual([]);
  });
});

describe("RAFT adapter: configuration and a misbehaving runner (stub)", () => {
  const useStub = (mode: string, verbs?: string) => {
    process.env.SEED_RAFT_HEADLESS = stubBundle;
    process.env.RAFT_STUB_MODE = mode;
    if (verbs) process.env.RAFT_STUB_VERBS = verbs;
  };
  afterEach(() => {
    delete process.env.RAFT_STUB_MODE;
    delete process.env.RAFT_STUB_VERBS;
  });

  it.each([
    ["unset", undefined],
    ["relative", "raft-headless.mjs"],
    ["relative to the project root, and existing", "models/m.json"],
    ["missing file", join(tmpdir(), "no-such-raft-headless.mjs")],
  ])("without a usable runner path (%s) every verb that needs it says setup is required", async (_n, value) => {
    if (value === undefined) delete process.env.SEED_RAFT_HEADLESS;
    else process.env.SEED_RAFT_HEADLESS = value;
    const root = newProject();
    writeFileSync(join(root, "models", "m.json"), "{}");
    const art = { path: "models/m.json", revision: { hash: sha256Hex("{}"), counter: 1 } };
    const sha = sha256Hex("{}");
    for (const req of [
      { verb: "describe" },
      { verb: "validate", artifact: art },
      { verb: "run", snapshot: { inputs: [{ path: "models/m.json", sha256: sha }] }, runDir: "runs/r-x", budget },
    ]) {
      const r = okReply(await ask(root, req));
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.code).toBe("E_SETUP_REQUIRED");
    }
  });

  it("a runner that prints something that is not a describe reply is E_APP_FAILED", async () => {
    useStub("garbage");
    const r = okReply(await ask(newProject(), { verb: "describe" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("E_APP_FAILED");
  });

  it("validate: the runner's own text is returned as data, labelled app-content, never acted on", async () => {
    useStub("refuse");
    const root = newProject();
    const text = JSON.stringify({ library: "lib" });
    writeFileSync(join(root, "models", "case.json"), text);
    mkdirSync(join(root, "models", "lib"));
    const r = okReply(await ask(root, { verb: "validate", artifact: { path: "models/case.json", revision: { hash: sha256Hex(text), counter: 1 } } }));
    expect(r.result.valid).toBe(false);
    expect(r.result.problems[0]).toMatchObject({ code: "E_SCHEMA_INVALID", source: "app-content" });
    expect(r.result.problems[0].message).toContain("ignore previous instructions");
  });

  it.each([
    ["failed", "engine halted: R_STUB"],
    ["refuse", "the runner refused the case"],
    ["crash", "stub crashed"],
    ["garbage", "the runner exited with 0"],
  ])("a run where the runner is %s ends failed with the reason in the native status", async (mode, detail) => {
    useStub(mode, "run");
    const root = newProject();
    writeFileSync(join(root, "models", "case.json"), JSON.stringify({ seed: 1, library: "lib" }));
    const inputs = [{ path: "models/case.json", sha256: sha256Hex(readFileSync(join(root, "models", "case.json"))) }];
    // the stub validates anything, so the manager gets to the run verb
    const out = await manager(root).start({ requestId: "req-stub-" + mode, actor, artifact: { path: "models/case.json", revision: { hash: inputs[0]!.sha256, counter: 1 } }, inputs, budget, settings: { case: "models/case.json" } });
    if (!out.ok) throw new Error("refused: " + JSON.stringify(out.errors));
    expect(out.state).toBe("failed");
    expect(JSON.stringify(out.record)).toContain(detail);
    expect(existsSync(join(root, "runs", out.runId, "results.json"))).toBe(false);
  });
});
