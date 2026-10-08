import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callAdapter } from "../src/core/adapterClient";
import { isAlive } from "../src/core/procTree";

// Findings of the Codex review of batch 6 (process ownership and hasArg, 2026-10-08), each shown by a test that fails without its fix.
const util = createRequire(__filename)("../adapters/shared/util.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a Linux command line is the exact argument list (finding: a flattened ps line cannot tell arguments apart)", () => {
  it("an array is matched by whole arguments: a word inside a path with spaces is not an argument", () => {
    const cl = ["node", "bundle.mjs", "cancel", "/tmp/my run folder/native/out"];
    expect(util.hasArg(cl, "run")).toBe(false);
    expect(util.hasArg(cl, "/tmp/my run folder/native/out")).toBe(true);
    expect(util.hasArg(cl, "/tmp/my")).toBe(false);
    expect(util.argvOf(cl)).toBe(cl);
    // the same arguments as one flat line cannot be told apart (the documented limit of ps output, only where /proc does not exist)
    if (process.platform !== "win32") expect(util.hasArg(cl.join(" "), "run")).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("commandLine reads an argument with spaces as one argument from /proc", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", "has a run b"], { stdio: "ignore" });
    try {
      await sleep(300);
      const cl = util.commandLine(child.pid);
      expect(Array.isArray(cl)).toBe(true);
      expect(cl).toContain("has a run b");
      expect(util.hasArg(cl, "run")).toBe(false);
      expect(util.hasArg(cl, "has a run b")).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("cancel proves the wrapper again just before it signals it (finding: the proof could be stale after a long native stop)", () => {
  const spec = { command: process.execPath, args: [join(__dirname, "fixtures", "shared-adapter", "cli.cjs")], id: "fixture", version: "0.1.0" };
  const actor = { kind: "human" as const, name: "tester" };
  const budget = { maxWallSeconds: 300, maxCores: 1, maxMemoryMB: 1024, maxDiskMB: 1024 };
  const inputs = [{ path: "models/x.json", sha256: "0".repeat(64) }];
  const pids: number[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ask = (root: string, request: Record<string, unknown>) =>
    callAdapter(spec, { schema: "seed.adapter-request/0.1", requestId: "req-1", actor, ...request }, { projectRoot: root, timeoutMs: 60000 });

  it("a wrapper that is no longer shown to be this job's when the native stop returns is not signalled", async () => {
    const root = mkdtempSync(join(tmpdir(), "seed b6 "));
    dirs.push(root);
    mkdirSync(join(root, "runs", "unprove"), { recursive: true });
    const r = await ask(root, { verb: "run", requestId: "req-unprove", runDir: "runs/unprove", snapshot: { inputs }, budget, settings: { mode: "hang", native: true, unprove: true } });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const rep = r.reply as any;
    expect(rep.ok, JSON.stringify(rep.errors)).toBe(true);
    const job = JSON.parse(readFileSync(join(root, "runs", "unprove", "native", "job.json"), "utf8"));
    pids.push(job.pid);
    const child = JSON.parse(readFileSync(join(root, "runs", "unprove", "native", "child.json"), "utf8"));
    pids.push(child.pid);
    const c = await ask(root, { verb: "cancel", jobId: rep.result.jobId });
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    const cr = c.reply as any;
    expect(cr.ok).toBe(false);
    expect(cr.errors[0].code).toBe("E_NOT_OWNED");
    expect(cr.errors[0].message).toMatch(/not signalled/);
    expect(isAlive(job.pid)).toBe(true); // nothing was killed
  }, 90000);
});
