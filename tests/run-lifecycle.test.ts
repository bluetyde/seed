import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { appendLine, writeFileAtomic } from "../src/core/atomicFile";
import { sha256Hex } from "../src/core/canonical";
import { isAlive, killTree } from "../src/core/procTree";
import {
  isLegalTransition,
  RunManager,
  TERMINAL_STATES,
  type Budget,
  type StartRequest,
} from "../src/core/runManager";
import { validate } from "../src/core/validate";
import { createTempProject, type TempProject, isProcessAlive } from "./helpers/project";

const cliPath = join(__dirname, "fixtures", "fake-adapter", "cli.cjs");
const adapterSpec = {
  command: process.execPath,
  args: [cliPath],
  id: "fake",
  version: "0.1.0",
};

const actor = { kind: "human" as const, name: "tester" };
const budget: Budget = {
  maxWallSeconds: 30,
  maxCores: 1,
  maxMemoryMB: 512,
  maxDiskMB: 512,
};

const activeProjects: TempProject[] = [];

function makeProject(): TempProject {
  const p = createTempProject("seed-lifecycle-");
  activeProjects.push(p);
  return p;
}

afterEach(async () => {
  while (activeProjects.length > 0) {
    const p = activeProjects.pop();
    if (p) {
      await p.cleanup();
    }
  }
});

function setupPinModel(proj: TempProject, extraModelProps?: Record<string, unknown>): {
  pinPath: string;
  pinHash: string;
  inputs: { path: string; sha256: string }[];
  artifact: { path: string; revision: { hash: string; counter: number } };
} {
  const modelObj = {
    name: "pin",
    counter: 1,
    fake: { validate: "ok" },
    ...extraModelProps,
  };
  const pinContent = JSON.stringify(modelObj, null, 2) + "\n";
  const pinPath = "models/pin.json";
  proj.createFile(pinPath, pinContent);
  const pinHash = sha256Hex(pinContent);
  const inputs = [{ path: pinPath, sha256: pinHash }];
  const artifact = { path: pinPath, revision: { hash: pinHash, counter: 1 } };
  return { pinPath, pinHash, inputs, artifact };
}

describe("RunManager lifecycle", () => {
  it("an adapter cancel timeout returns an unconfirmed attempt and permits retry", async () => {
    const proj = makeProject(); const { inputs, artifact } = setupPinModel(proj);
    const flag = join(proj.root, "cancel-once"), wrapper = join(proj.root, "timeout-adapter.cjs");
    writeFileSync(wrapper, `const fs=require('node:fs'),{spawnSync}=require('node:child_process');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const verb=process.argv[2];if(verb==='cancel'&&!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'once');setInterval(()=>{},1000);}else{const p=spawnSync(process.execPath,[${JSON.stringify(cliPath)},verb],{input:text,encoding:'utf8',env:process.env});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exitCode=p.status;}});`);
    let launched = false;
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: { ...adapterSpec, args: [wrapper] }, pollMs: 50, callTimeoutMs: 1000,
      onLaunch: identity => { if (identity.jobId) launched = true; } });
    const pending = mgr.start({ requestId: "timeout-cancel", actor, inputs, artifact, budget, settings: { scenario: "success", delayMs: 10000 } });
    const deadline = Date.now() + 10000;
    while (!launched && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(launched).toBe(true);
    const first = await Promise.race([mgr.cancelRequest("timeout-cancel"), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(Error("cancel waited for entire run")), 5000); t.unref(); })]);
    expect(first?.ok).toBe(false);
    if (first && !first.ok) expect(first.errors[0]!.code).toBe("E_TIMEOUT");
    expect(mgr.hasActiveRequest("timeout-cancel")).toBe(true);
    expect(await mgr.cancelRequest("timeout-cancel")).toMatchObject({ ok: true, state: "cancelled" });
    expect(await pending).toMatchObject({ ok: true, state: "cancelled" });
  });
  it("1. Success: state completed, outputs, transitions, finishedAt", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);

    const mgr = new RunManager({
      projectRoot: proj.root,
      runsFolder: "runs",
      adapter: adapterSpec,
      pollMs: 50,
      callTimeoutMs: 5000,
    });

    const req: StartRequest = {
      requestId: "req-success-1",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "success", delayMs: 100 },
    };

    const outcome = await mgr.start(req);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.state).toBe("completed");
    expect(outcome.record.state).toBe("completed");
    expect(typeof outcome.record.finishedAt).toBe("string");

    // Outputs non-empty and each hash matches the file
    const outputs = outcome.record.outputs as Array<{ path: string; sha256: string }>;
    expect(Array.isArray(outputs)).toBe(true);
    expect(outputs.length).toBeGreaterThan(0);

    for (const out of outputs) {
      const outAbs = join(proj.root, out.path);
      expect(existsSync(outAbs)).toBe(true);
      const content = readFileSync(outAbs);
      expect(sha256Hex(content)).toBe(out.sha256);
    }

    // Record validates against schema
    const vRec = validate("run-record", outcome.record);
    expect(vRec.ok).toBe(true);

    // Transitions.jsonl is exactly queued->running, running->completed in order
    const transPath = join(proj.root, "runs", outcome.runId, "log", "transitions.jsonl");
    expect(existsSync(transPath)).toBe(true);
    const transLines = readFileSync(transPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(transLines).toHaveLength(2);
    expect(transLines[0]?.from).toBe("queued");
    expect(transLines[0]?.to).toBe("running");
    expect(transLines[1]?.from).toBe("running");
    expect(transLines[1]?.to).toBe("completed");
  });

  it("2. Refusals create no run directory and no job process", async () => {
    // 2.1 prop-missing
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj, { fake: { validate: "prop-missing" } });
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-1", actor, artifact, inputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_PROP_MISSING");
        expect(res.errors[0]?.field).toBe("/materials/0/sets/thermal.conductivity");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.2 units
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj, { fake: { validate: "units" } });
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-2", actor, artifact, inputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_UNITS");
        expect(res.errors[0]?.unit).toBe("W/m");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.3 out-of-domain
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj, { fake: { validate: "out-of-domain" } });
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-3", actor, artifact, inputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_OUT_OF_DOMAIN");
        expect(res.errors[0]?.range).toEqual({ min: 0, max: 100 });
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.4 injection
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj, { fake: { validate: "injection", text: "INJECTION ATTACK" } });
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-4", actor, artifact, inputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.message).toBe("INJECTION ATTACK");
        expect(res.errors[0]?.source).toBe("app-content");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.5 stale input hash
    {
      const proj = makeProject();
      const { artifact } = setupPinModel(proj);
      const staleInputs = [{ path: "models/pin.json", sha256: "0".repeat(64) }];
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-5", actor, artifact, inputs: staleInputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_STALE_REVISION");
        expect(res.errors[0]?.field).toBe("/inputs/0/sha256");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.6 missing input
    {
      const proj = makeProject();
      const { artifact } = setupPinModel(proj);
      const missingInputs = [{ path: "models/nonexistent.json", sha256: "0".repeat(64) }];
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-6", actor, artifact, inputs: missingInputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_PROP_MISSING");
        expect(res.errors[0]?.field).toBe("/inputs/0/path");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.7 path traversal in input
    {
      const proj = makeProject();
      const { artifact } = setupPinModel(proj);
      const traversalInputs = [{ path: "../escape.json", sha256: "0".repeat(64) }];
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({ requestId: "req-refusal-7", actor, artifact, inputs: traversalInputs, budget });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_PATH_TRAVERSAL");
        expect(res.errors[0]?.field).toBe("/inputs/0/path");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }

    // 2.8 over-budget
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const studyBudget: Budget = { maxWallSeconds: 10, maxCores: 1, maxMemoryMB: 256, maxDiskMB: 256 };
      const largeBudget: Budget = { maxWallSeconds: 20, maxCores: 2, maxMemoryMB: 256, maxDiskMB: 256 };
      const res = await mgr.start({
        requestId: "req-refusal-8",
        actor,
        artifact,
        inputs,
        budget: largeBudget,
        studyBudget,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors).toHaveLength(2);
        expect(res.errors.some((e) => e.code === "E_BUDGET_EXCEEDED" && e.field === "/budget/maxWallSeconds")).toBe(true);
        expect(res.errors.some((e) => e.code === "E_BUDGET_EXCEEDED" && e.field === "/budget/maxCores")).toBe(true);
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);

      const gateStopsPath = join(proj.root, "runs", "gate-stops.jsonl");
      expect(existsSync(gateStopsPath)).toBe(true);
      const gateStopContent = JSON.parse(readFileSync(gateStopsPath, "utf8").trim());
      expect(gateStopContent.rule).toBe("budget");
      expect(gateStopContent.requestId).toBe("req-refusal-8");
      expect(gateStopContent.fields).toContain("maxWallSeconds");
      expect(gateStopContent.fields).toContain("maxCores");
    }

    // 2.9 adapter crash during validate
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });
      const res = await mgr.start({
        requestId: "req-refusal-9",
        actor,
        artifact,
        inputs,
        budget,
        extensions: { fake: { mode: "crash" } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_APP_FAILED");
      }
      expect(readdirSync(join(proj.root, "runs")).filter((f) => f.startsWith("r-"))).toHaveLength(0);
    }
  });

  it("3. Failures end failed with the right evidence", async () => {
    // 3.1 job crash (native status died)
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-crash",
        actor,
        artifact,
        inputs,
        budget,
        settings: { scenario: "crash" },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect((res.record.native as any)?.status).toBe("died");
      }
    }

    // 3.2 silent-exit (native status died)
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-silent",
        actor,
        artifact,
        inputs,
        budget,
        settings: { scenario: "silent-exit" },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect((res.record.native as any)?.status).toBe("died");
      }
    }

    // 3.3 partial-output (E_OUTPUT_INCOMPLETE, no outputs, partial files kept in native/)
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-partial",
        actor,
        artifact,
        inputs,
        budget,
        settings: { scenario: "partial-output", delayMs: 100 },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect(res.record.outputs).toBeUndefined();
        const errsPath = join(proj.root, "runs", res.runId, "log", "errors.json");
        expect(existsSync(errsPath)).toBe(true);
        const errs = JSON.parse(readFileSync(errsPath, "utf8"));
        expect(errs[0]?.code).toBe("E_OUTPUT_INCOMPLETE");
        const outPartial = join(proj.root, "runs", res.runId, "native", "out.json");
        expect(existsSync(outPartial)).toBe(true);
      }
    }

    // 3.4 nan-output (E_OUTPUT_INCOMPLETE)
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-nan",
        actor,
        artifact,
        inputs,
        budget,
        settings: { scenario: "nan-output", delayMs: 100 },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect(res.record.outputs).toBeUndefined();
        const errsPath = join(proj.root, "runs", res.runId, "log", "errors.json");
        expect(existsSync(errsPath)).toBe(true);
        const errs = JSON.parse(readFileSync(errsPath, "utf8"));
        expect(errs[0]?.code).toBe("E_OUTPUT_INCOMPLETE");
      }
    }

    // 3.5 run verb failure at adapter level
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-run-crash",
        actor,
        artifact,
        inputs,
        budget,
        extensions: { fake: { mode: "crash", verb: "run" } },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect((res.record.native as any)?.status).toBe("adapter-error");
        const errsPath = join(proj.root, "runs", res.runId, "log", "errors.json");
        expect(existsSync(errsPath)).toBe(true);
      }
    }

    // 3.6 hang with wallLimitMs: 800 -> failed, E_TIMEOUT, job process dead
    {
      const proj = makeProject();
      const { inputs, artifact } = setupPinModel(proj);
      const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
      const res = await mgr.start({
        requestId: "req-fail-timeout",
        actor,
        artifact,
        inputs,
        budget,
        wallLimitMs: 800,
        settings: { scenario: "hang" },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.state).toBe("failed");
        expect((res.record.native as any)?.status).toBe("timeout");
        const errsPath = join(proj.root, "runs", res.runId, "log", "errors.json");
        expect(existsSync(errsPath)).toBe(true);
        const errs = JSON.parse(readFileSync(errsPath, "utf8"));
        expect(errs[0]?.code).toBe("E_TIMEOUT");

        const jobJsonPath = join(proj.root, "runs", res.runId, "native", "job.json");
        expect(existsSync(jobJsonPath)).toBe(true);
        const jobData = JSON.parse(readFileSync(jobJsonPath, "utf8"));
        expect(isProcessAlive(jobData.pid)).toBe(false);
      }
    }
  });

  it("4. Trip: terminated-by-trip, native detail high flux trip, no outputs", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });

    const res = await mgr.start({
      requestId: "req-trip",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "trip", delayMs: 100 },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state).toBe("terminated-by-trip");
      expect((res.record.native as any)?.detail).toBe("high flux trip");
      expect(res.record.outputs).toBeUndefined();
      expect(res.state).not.toBe("completed");
    }
  });

  it("5. Cancel: in flight, sibling survives, unknown id, completed run, E_NOT_OWNED", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });

    // Start hang run 1 and sibling hang run 2
    const p1 = mgr.start({
      requestId: "req-cancel-1",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "hang" },
    });

    const p2 = mgr.start({
      requestId: "req-cancel-2",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "hang" },
    });

    // Wait until both jobs really exist (process start-up time varies by machine); a fixed sleep was flaky.
    const reqsPath = join(proj.root, "runs", "requests.json");
    const jobFile = (runId: string): string => join(proj.root, "runs", runId, "native", "job.json");
    const readIds = (): string[] | null => {
      try {
        const r = JSON.parse(readFileSync(reqsPath, "utf8"));
        return r["req-cancel-1"] && r["req-cancel-2"] ? [r["req-cancel-1"].runId, r["req-cancel-2"].runId] : null;
      } catch {
        return null;
      }
    };
    const deadline = Date.now() + 10000;
    let ids = readIds();
    while (Date.now() < deadline && !(ids && existsSync(jobFile(ids[0]!)) && existsSync(jobFile(ids[1]!)))) {
      await new Promise((r) => setTimeout(r, 50));
      ids = readIds();
    }
    expect(ids).not.toBeNull();
    const [runId1, runId2] = ids as [string, string];

    const job1 = JSON.parse(readFileSync(join(proj.root, "runs", runId1, "native", "job.json"), "utf8"));
    const job2 = JSON.parse(readFileSync(join(proj.root, "runs", runId2, "native", "job.json"), "utf8"));
    proj.registerPid(job2.pid);

    expect(isAlive(job1.pid)).toBe(true);
    expect(isAlive(job2.pid)).toBe(true);

    // Cancel run 1
    const cancelOutcome1 = await mgr.cancel(runId1);
    const startOutcome1 = await p1;

    expect(cancelOutcome1.ok).toBe(true);
    expect(cancelOutcome1.state).toBe("cancelled");
    expect(startOutcome1.ok).toBe(true);
    expect(startOutcome1.state).toBe("cancelled");

    // job 1 is dead, sibling job 2 is still alive
    expect(isProcessAlive(job1.pid)).toBe(false);
    expect(isProcessAlive(job2.pid)).toBe(true);

    // Cancel job 2 so test finishes cleanly
    await mgr.cancel(runId2);
    await p2;
    expect(isProcessAlive(job2.pid)).toBe(false);

    // Cancel unknown runId -> E_PROP_MISSING
    const unknownCancel = await mgr.cancel("r-nonexistent");
    expect(unknownCancel.ok).toBe(false);
    if (!unknownCancel.ok) {
      expect(unknownCancel.errors[0]?.code).toBe("E_PROP_MISSING");
      expect(unknownCancel.errors[0]?.field).toBe("/runId");
    }

    // Cancel completed run returns unchanged, cancelled is not set
    const compOutcome = await mgr.start({
      requestId: "req-comp-test",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "success", delayMs: 50 },
    });
    expect(compOutcome.ok).toBe(true);
    expect(compOutcome.state).toBe("completed");

    const compCancel = await mgr.cancel(compOutcome.runId);
    expect(compCancel.ok).toBe(true);
    expect(compCancel.state).toBe("completed");
    expect((compCancel.record as any).cancelled).toBeUndefined();

    // Cancel run whose job.json points to unrelated live process -> E_NOT_OWNED
    const unrelatedChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const unrelatedPid = unrelatedChild.pid!;
    unrelatedChild.unref();
    proj.registerPid(unrelatedPid);
    expect(isAlive(unrelatedPid)).toBe(true);

    const forgedRunDir = join(proj.root, "runs", "r-forged");
    mkdirSync(join(forgedRunDir, "native"), { recursive: true });
    mkdirSync(join(forgedRunDir, "log"), { recursive: true });

    const forgedJob = {
      jobId: "job-forged-unowned",
      requestId: "req-forged",
      pid: unrelatedPid,
      token: "wrong-token-abc",
      inputs,
      scenario: "hang",
    };
    writeFileSync(join(forgedRunDir, "native", "job.json"), JSON.stringify(forgedJob, null, 2) + "\n");
    writeFileSync(
      join(forgedRunDir, "native", "status.json"),
      JSON.stringify({ status: "running", startedAt: new Date().toISOString() }, null, 2) + "\n"
    );
    writeFileSync(
      join(forgedRunDir, "native", "heartbeat.json"),
      JSON.stringify({ token: "different-token-xyz", time: new Date().toISOString() }, null, 2) + "\n"
    );

    const forgedRecord = {
      schema: "seed.run-record/0.1",
      runId: "r-forged",
      attempt: 1,
      adapter: { id: "fake", version: "0.1.0" },
      state: "running",
      inputs,
      settings: {},
      budget,
      createdAt: new Date().toISOString(),
      jobId: "job-forged-unowned",
    };
    writeFileSync(join(forgedRunDir, "run-record.json"), JSON.stringify(forgedRecord, null, 2) + "\n");

    const forgedCancelOutcome = await mgr.cancel("r-forged");
    expect(forgedCancelOutcome.ok).toBe(false);
    if (!forgedCancelOutcome.ok) {
      expect(forgedCancelOutcome.errors[0]?.code).toBe("E_NOT_OWNED");
    }
    expect(isAlive(unrelatedPid)).toBe(true);
    const unmodRecord = JSON.parse(readFileSync(join(forgedRunDir, "run-record.json"), "utf8"));
    expect(unmodRecord.state).toBe("running");

    await killTree(unrelatedPid);
  });

  it("6. Idempotency: replay while in flight, after finish, changed settings conflict, different requestId", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });

    const req: StartRequest = {
      requestId: "req-idem-1",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "success", delayMs: 150 },
    };

    // First call and immediate second call while first is in flight
    const p1 = mgr.start(req);
    const p2 = mgr.start(req);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.runId).toBe(res2.runId);
    expect(res2.replayed).toBe(true);

    // Third call after finished
    const res3 = await mgr.start(req);
    expect(res3.ok).toBe(true);
    expect(res3.runId).toBe(res1.runId);
    expect(res3.replayed).toBe(true);

    // Same requestId with changed settings -> E_REQUEST_CONFLICT
    const resConflict = await mgr.start({
      ...req,
      settings: { scenario: "success", delayMs: 200, changed: true },
    });
    expect(resConflict.ok).toBe(false);
    if (!resConflict.ok) {
      expect(resConflict.errors[0]?.code).toBe("E_REQUEST_CONFLICT");
      expect(resConflict.errors[0]?.field).toBe("/requestId");
    }

    // Different requestId creates second run with different runId and first record is untouched
    const rec1Before = readFileSync(join(proj.root, "runs", res1.runId, "run-record.json"), "utf8");
    const resDiff = await mgr.start({
      ...req,
      requestId: "req-idem-diff",
    });
    expect(resDiff.ok).toBe(true);
    expect(resDiff.runId).not.toBe(res1.runId);
    const rec1After = readFileSync(join(proj.root, "runs", res1.runId, "run-record.json"), "utf8");
    expect(rec1After).toBe(rec1Before);
  });

  it("7. Recovery: live hang -> interrupted (job alive), queued -> interrupted, finished -> completed, corrupt skipped", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);

    // 7.1 Forge running record with live hang job started directly through adapter
    const liveRunDir = "runs/r-live-hang";
    const liveAbsDir = join(proj.root, liveRunDir);
    mkdirSync(join(liveAbsDir, "inputs"), { recursive: true });
    mkdirSync(join(liveAbsDir, "native"), { recursive: true });
    mkdirSync(join(liveAbsDir, "log"), { recursive: true });
    const liveInputSrc = join(proj.root, inputs[0]!.path);
    const liveInputDest = join(liveAbsDir, "inputs", inputs[0]!.path);
    mkdirSync(dirname(liveInputDest), { recursive: true });
    writeFileSync(liveInputDest, readFileSync(liveInputSrc));

    const runDirectOutcome = await callAdapter(
      adapterSpec,
      {
        schema: "seed.adapter-request/0.1",
        verb: "run",
        requestId: "req-direct-hang",
        actor,
        snapshot: { inputs },
        runDir: liveRunDir,
        budget,
        settings: { scenario: "hang" },
      },
      { projectRoot: proj.root, timeoutMs: 5000 }
    );
    expect(runDirectOutcome.ok).toBe(true);
    const directReply = runDirectOutcome.reply as Record<string, unknown>;
    const directResult = directReply.result as { jobId: string };

    const liveJobData = JSON.parse(readFileSync(join(liveAbsDir, "native", "job.json"), "utf8"));
    const livePid = liveJobData.pid;
    proj.registerPid(livePid);
    expect(isAlive(livePid)).toBe(true);

    const liveRecord = {
      schema: "seed.run-record/0.1",
      runId: "r-live-hang",
      attempt: 1,
      adapter: { id: "fake", version: "0.1.0" },
      state: "running",
      inputs,
      settings: { scenario: "hang" },
      budget,
      createdAt: new Date().toISOString(),
      jobId: directResult.jobId,
    };
    writeFileSync(join(liveAbsDir, "run-record.json"), JSON.stringify(liveRecord, null, 2) + "\n");

    // 7.2 Forged queued record without a job
    const queuedDir = join(proj.root, "runs", "r-queued-nojob");
    mkdirSync(join(queuedDir, "log"), { recursive: true });
    const queuedRecord = {
      schema: "seed.run-record/0.1",
      runId: "r-queued-nojob",
      attempt: 1,
      adapter: { id: "fake", version: "0.1.0" },
      state: "queued",
      inputs,
      settings: {},
      budget,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(queuedDir, "run-record.json"), JSON.stringify(queuedRecord, null, 2) + "\n");

    // 7.3 Record whose job already finished successfully before recovery -> finalized completed
    const finishedRunDir = "runs/r-already-finished";
    const finishedAbsDir = join(proj.root, finishedRunDir);
    mkdirSync(join(finishedAbsDir, "inputs"), { recursive: true });
    mkdirSync(join(finishedAbsDir, "native"), { recursive: true });
    mkdirSync(join(finishedAbsDir, "log"), { recursive: true });
    const finInputSrc = join(proj.root, inputs[0]!.path);
    const finInputDest = join(finishedAbsDir, "inputs", inputs[0]!.path);
    mkdirSync(dirname(finInputDest), { recursive: true });
    writeFileSync(finInputDest, readFileSync(finInputSrc));

    const finRunOutcome = await callAdapter(
      adapterSpec,
      {
        schema: "seed.adapter-request/0.1",
        verb: "run",
        requestId: "req-direct-fin",
        actor,
        snapshot: { inputs },
        runDir: finishedRunDir,
        budget,
        settings: { scenario: "success", delayMs: 50 },
      },
      { projectRoot: proj.root, timeoutMs: 5000 }
    );
    expect(finRunOutcome.ok).toBe(true);
    const finReply = finRunOutcome.reply as Record<string, unknown>;
    const finResult = finReply.result as { jobId: string };

    // Wait until adapter job finishes
    await new Promise((r) => setTimeout(r, 200));

    const finishedRecord = {
      schema: "seed.run-record/0.1",
      runId: "r-already-finished",
      attempt: 1,
      adapter: { id: "fake", version: "0.1.0" },
      state: "running",
      inputs,
      settings: { scenario: "success" },
      budget,
      createdAt: new Date().toISOString(),
      jobId: finResult.jobId,
    };
    writeFileSync(join(finishedAbsDir, "run-record.json"), JSON.stringify(finishedRecord, null, 2) + "\n");

    // 7.4 Corrupt record
    const corruptDir = join(proj.root, "runs", "r-corrupt");
    mkdirSync(corruptDir, { recursive: true });
    const corruptContent = '{"schema":"seed.run-record/0.1","broken":true}\n';
    const corruptPath = join(corruptDir, "run-record.json");
    writeFileSync(corruptPath, corruptContent, "utf8");

    // Run recover()
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });
    const changes = await mgr.recover();

    // Verify live hang was interrupted, and job process is STILL ALIVE
    const liveChange = changes.find((c) => c.runId === "r-live-hang");
    expect(liveChange).toEqual({ runId: "r-live-hang", from: "running", to: "interrupted" });
    expect(isAlive(livePid)).toBe(true);
    await killTree(livePid); // Clean up live pid in test

    const liveRecOnDisk = JSON.parse(readFileSync(join(liveAbsDir, "run-record.json"), "utf8"));
    expect(liveRecOnDisk.state).toBe("interrupted");
    expect(liveRecOnDisk.native.status).toBe("host-lost");

    // Verify queued record without job was interrupted
    const queuedChange = changes.find((c) => c.runId === "r-queued-nojob");
    expect(queuedChange).toEqual({ runId: "r-queued-nojob", from: "queued", to: "interrupted" });

    // Verify already finished was finalized completed
    const finChange = changes.find((c) => c.runId === "r-already-finished");
    expect(finChange).toEqual({ runId: "r-already-finished", from: "running", to: "completed" });
    const finRecOnDisk = JSON.parse(readFileSync(join(finishedAbsDir, "run-record.json"), "utf8"));
    expect(finRecOnDisk.state).toBe("completed");
    expect(finRecOnDisk.outputs.length).toBeGreaterThan(0);

    // Verify corrupt record was skipped and reported as invalid->invalid, and bytes are unchanged
    const corruptChange = changes.find((c) => c.runId === "r-corrupt");
    expect(corruptChange).toEqual({ runId: "r-corrupt", from: "invalid", to: "invalid" });
    expect(readFileSync(corruptPath, "utf8")).toBe(corruptContent);
  });

  it("8. Transitions: table test over 7x7 states, terminal states never transition, illegal throws", async () => {
    const allStates = [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "terminated-by-trip",
    ];

    const legalPairs = new Set([
      "queued->running",
      "queued->failed",
      "queued->cancelled",
      "queued->interrupted",
      "running->completed",
      "running->failed",
      "running->cancelled",
      "running->terminated-by-trip",
      "running->interrupted",
    ]);

    for (const from of allStates) {
      for (const to of allStates) {
        const pair = `${from}->${to}`;
        const expected = legalPairs.has(pair);
        expect(isLegalTransition(from, to), `Expected ${pair} to be ${expected}`).toBe(expected);
      }
    }

    // Terminal states never transition
    for (const term of TERMINAL_STATES) {
      for (const to of allStates) {
        expect(isLegalTransition(term, to)).toBe(false);
      }
    }

    // Illegal transition request throws
    const proj = makeProject();
    setupPinModel(proj);
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec });

    const runDir = join(proj.root, "runs", "r-test-illegal");
    mkdirSync(join(runDir, "log"), { recursive: true });
    writeFileSync(
      join(runDir, "run-record.json"),
      JSON.stringify(
        {
          schema: "seed.run-record/0.1",
          runId: "r-test-illegal",
          attempt: 1,
          adapter: { id: "fake", version: "0.1.0" },
          state: "completed",
          inputs: [{ path: "models/pin.json", sha256: "0".repeat(64) }],
          settings: {},
          budget,
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          outputs: [{ path: "runs/r-test-illegal/results.json", sha256: "0".repeat(64) }],
        },
        null,
        2
      ) + "\n"
    );

    expect(() => mgr.transition("r-test-illegal", "running", "illegal transition")).toThrow(
      /Illegal state transition from "completed" to "running"/
    );
  });

  it("9. Atomic writes: leaves no .tmp- file on success, removes .tmp- and throws when rename fails", () => {
    const proj = makeProject();
    const targetFile = join(proj.root, "atomic-test", "file.txt");

    // Success
    writeFileAtomic(targetFile, "atomic content");
    expect(readFileSync(targetFile, "utf8")).toBe("atomic content");
    const parentFiles = readdirSync(dirname(targetFile));
    expect(parentFiles.some((f) => f.includes(".tmp-"))).toBe(false);

    // Fail renameSync when target path is an existing directory
    const targetDir = join(proj.root, "atomic-test", "dir-target");
    mkdirSync(targetDir, { recursive: true });
    expect(() => writeFileAtomic(targetDir, "should fail")).toThrow();
    const dirParentFiles = readdirSync(dirname(targetDir));
    expect(dirParentFiles.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("10. Never overwrites a failed attempt: two starts on same inputs leave two independent records", async () => {
    const proj = makeProject();
    const { inputs, artifact } = setupPinModel(proj);
    const mgr = new RunManager({ projectRoot: proj.root, runsFolder: "runs", adapter: adapterSpec, pollMs: 50 });

    const outcome1 = await mgr.start({
      requestId: "req-attempt-1",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "crash" },
    });
    expect(outcome1.ok).toBe(true);
    expect(outcome1.state).toBe("failed");

    const outcome2 = await mgr.start({
      requestId: "req-attempt-2",
      actor,
      artifact,
      inputs,
      budget,
      settings: { scenario: "success", delayMs: 50 },
    });
    expect(outcome2.ok).toBe(true);
    expect(outcome2.state).toBe("completed");

    expect(outcome1.runId).not.toBe(outcome2.runId);

    const rec1 = JSON.parse(readFileSync(join(proj.root, "runs", outcome1.runId, "run-record.json"), "utf8"));
    const rec2 = JSON.parse(readFileSync(join(proj.root, "runs", outcome2.runId, "run-record.json"), "utf8"));

    expect(rec1.state).toBe("failed");
    expect(rec2.state).toBe("completed");
    expect(rec1.runId).toBe(outcome1.runId);
    expect(rec2.runId).toBe(outcome2.runId);
  });
});
