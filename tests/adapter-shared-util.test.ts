// @covers R-ADAPT-05
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// adapters/shared/util.cjs is used by every adapter. The adapters' own suites exercise it end to end; these tests pin each rule on its own, so a
// check that another check happens to cover (a token that is also missing, a folder that is also wrong) cannot hide a deleted rule.
const req = createRequire(__filename);
const util = req("../adapters/shared/util.cjs") as Record<string, any>;
const JOB = join(__dirname, "..", "adapters", "nodal", "job.cjs");

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      if (process.platform === "win32" && p.pid) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
      else p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "seed shared ") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
/** A live process whose command line carries exactly these extra arguments (it does nothing else). */
function sleeper(args: string[]) {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore", detached: true, windowsHide: true });
  p.unref();
  procs.push(p);
  return p.pid!;
}
async function commandLineReady(pid: number) {
  for (let i = 0; i < 100; i++) {
    if (util.commandLine(pid) !== null) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("cannot read the command line of " + pid);
}

describe("ownsJobProcess: a pid from a project file is trusted only when all three arguments match", () => {
  const token = "tok-0123456789abcdef";
  const owned = async (args: (run: string) => string[], jobToken = token) => {
    const run = tmp();
    const pid = sleeper(args(run));
    await commandLineReady(pid);
    return util.ownsJobProcess({ job: { pid, token: jobToken }, absRunDir: run }, { tokenOk: true }, JOB);
  };

  it("the wrapper script, this exact run folder and this job's token: owned", async () => {
    expect(await owned(run => [JOB, run, token])).toBe(true);
  });
  it("without the wrapper script: not owned", async () => {
    expect(await owned(run => ["other.cjs", run, token])).toBe(false);
  });
  it("another run folder (even one that starts with this one's text): not owned", async () => {
    const run = tmp();
    const pid = sleeper([JOB, run + "-longer", token]);
    await commandLineReady(pid);
    expect(util.ownsJobProcess({ job: { pid, token }, absRunDir: run }, { tokenOk: true }, JOB)).toBe(false);
  });
  it("without this job's token (another run's wrapper): not owned", async () => {
    expect(await owned(run => [JOB, run, "some-other-token"])).toBe(false);
  });
  it("a heartbeat that does not carry the token, a missing pid or an empty token: not owned", async () => {
    const run = tmp();
    const pid = sleeper([JOB, run, token]);
    await commandLineReady(pid);
    expect(util.ownsJobProcess({ job: { pid, token }, absRunDir: run }, { tokenOk: false }, JOB)).toBe(false);
    expect(util.ownsJobProcess({ job: { pid: null, token }, absRunDir: run }, { tokenOk: true }, JOB)).toBe(false);
    expect(util.ownsJobProcess({ job: { pid, token: "" }, absRunDir: run }, { tokenOk: true }, JOB)).toBe(false);
  });
  it("a process that is gone has no command line and is not owned", () => {
    expect(util.ownsJobProcess({ job: { pid: 2147483000, token }, absRunDir: tmp() }, { tokenOk: true }, JOB)).toBe(false);
  });
});

describe("the job registry folder", () => {
  it("must be a real folder inside the project: a linked .seed or .seed/jobs is refused", () => {
    const root = tmp();
    expect(util.jobsDir(root, true)).toBe(join(root, ".seed", "jobs"));

    const outside = tmp("seed shared outside ");
    mkdirSync(join(outside, "jobs"));
    const linked = tmp();
    try {
      symlinkSync(outside, join(linked, ".seed"), "junction");
    } catch {
      return; // links are not permitted in this environment
    }
    expect(util.jobsDir(linked, false)).toBeNull();

    const inner = tmp();
    mkdirSync(join(inner, ".seed"));
    symlinkSync(outside, join(inner, ".seed", "jobs"), "junction");
    expect(util.jobsDir(inner, false)).toBeNull();
  });
});

describe("paths, errors and job state", () => {
  it("portableRel refuses everything that is not a plain relative path", () => {
    for (const bad of ["", "/abs", "a/../b", "a//b", "./a", "a\\b", "C:/x", "a:b", "a\u0000b", "x".repeat(513), 5 as any]) expect(util.portableRel(bad), String(bad)).toBe(false);
    for (const good of ["a", "a/b.json", "models/pra-vote-exact.json"]) expect(util.portableRel(good), good).toBe(true);
  });

  it("typed bounds the field and the message, strips control characters and never returns an empty message", () => {
    const e = util.typed("E_X", "f".repeat(500), "bad\u0007\u0000text" + "m".repeat(2000), "app-content");
    expect(e.field).toHaveLength(200);
    expect(e.message).not.toMatch(/[\u0000-\u0008]/);
    expect(e.message.length).toBeLessThanOrEqual(900);
    expect(e.source).toBe("app-content");
    expect(util.typed("E_X", "", "").message).toBe("(no message)");
  });

  it("argvOf keeps quoted arguments whole", () => {
    expect(util.argvOf('node "C:\\a b\\job.cjs" run tok')).toEqual(["node", "C:\\a b\\job.cjs", "run", "tok"]);
  });

  it("jobState: finished, failed, cancelled, an app's own status word, a dead job and a live one", () => {
    const native = tmp();
    const job = { pid: process.pid, token: "t" };
    const set = (status: object | null, hb: object | null) => {
      for (const f of ["status.json", "heartbeat.json", "job.json"]) rmSync(join(native, f), { force: true });
      writeFileSync(join(native, "job.json"), JSON.stringify(job));
      if (status) writeFileSync(join(native, "status.json"), JSON.stringify(status));
      if (hb) writeFileSync(join(native, "heartbeat.json"), JSON.stringify(hb));
    };
    set({ status: "finished" }, null);
    expect(util.jobState(native, job).lifecycle).toBe("completed");
    set({ status: "failed", detail: "boom" }, null);
    expect(util.jobState(native, job)).toMatchObject({ lifecycle: "failed", native: { status: "failed", detail: "boom" } });
    set({ status: "cancelled" }, null);
    expect(util.jobState(native, job).lifecycle).toBe("cancelled");
    set({ status: "tripped" }, null);
    expect(util.jobState(native, job).lifecycle).toBe("failed"); // an unknown word is a failure ...
    expect(util.jobState(native, job, { tripped: "terminated-by-trip" })).toMatchObject({ lifecycle: "terminated-by-trip", native: { status: "tripped" } }); // ... unless the app declares it
    set({ status: "running" }, { token: "t", time: new Date().toISOString() });
    expect(util.jobState(native, job).lifecycle).toBe("running"); // this very process is alive and carries the token
    expect(util.jobState(native, { pid: 2147483000, token: "t" })).toMatchObject({ lifecycle: "failed", native: { status: "died" } });
    set({ status: "running" }, { token: "other", time: new Date().toISOString() });
    expect(util.jobState(native, job).lifecycle).toBe("failed"); // alive, but the heartbeat is another job's: a recycled pid must not look like this job
  });
});
