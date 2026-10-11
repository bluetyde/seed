// @covers R-SHELL-01, R-SHELL-04, R-SHELL-09
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogRepo } from "../src/main/catalog";
import { Git } from "../src/main/git";
import { defaultCheckCmd, defaultRunCmd, Installer } from "../src/main/installer";
import { InstallStore } from "../src/main/store";
import { git, makeRemote, tempDir, type FakeRemote } from "./helpers/repo";

const node = process.execPath;
const writeStep = (label: string, file: string, text: string) => ({ label, cwd: ".", command: node, args: ["-e", `require("fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)})`], watch: ["package-lock.json"] });

function setup(over: Partial<CatalogRepo> = {}, files: Record<string, string> = { "package-lock.json": "1", "app.txt": "a" }) {
  const remote = makeRemote(files);
  const root = tempDir();
  const settings = join(tempDir(), "installs.json");
  const store = new InstallStore(settings, join(root, "apps"));
  const repo: CatalogRepo = { id: "demo", name: "Demo", url: remote.url, branch: "main", folder: "demo", isPrivate: false, candidates: [], prerequisites: [], steps: [], ...over };
  let running = false;
  const changes: number[] = [];
  const inst = new Installer({ repos: [repo], store, git: new Git(), runCmd: defaultRunCmd, checkCmd: defaultCheckCmd, isRunning: () => running, onChange: () => changes.push(1) });
  return { remote, store, repo, inst, root, setRunning: (v: boolean) => { running = v; }, info: () => inst.list()[0]! };
}

describe("Installer", () => {
  it("installs: clones into the install folder, runs the steps, remembers the folder", async () => {
    const t = setup({ steps: [writeStep("Install deps", "deps.log", "ran\n")] });
    await t.inst.refresh("demo");
    expect(t.info().state).toBe("not-installed");
    await t.inst.install("demo");
    const dir = join(t.root, "apps", "demo");
    expect(t.info()).toMatchObject({ state: "up-to-date", path: dir, branch: "main" });          // just cloned: current by definition
    expect(t.info().job).toMatchObject({ running: false, step: "Done" });
    expect(readFileSync(join(dir, "deps.log"), "utf-8")).toBe("ran\n");
    expect(t.store.load().paths["demo"]).toBe(dir);
  });

  it("a failing step shows its output and the exit code, keeps the clone, and a retry repeats the steps", async () => {
    const fail = { label: "Install deps", cwd: ".", command: node, args: ["-e", "console.log('npm ERR! something'); process.exit(4)"], watch: [] };
    const t = setup({ steps: [fail] });
    await t.inst.install("demo");
    expect(t.info().job).toMatchObject({ running: false, error: expect.stringContaining("exit code 4") });
    expect(t.info().job!.lines.join("\n")).toContain("npm ERR! something");
    expect(existsSync(join(t.root, "apps", "demo", "app.txt"))).toBe(true);
    t.repo.steps = [writeStep("Install deps", "deps.log", "ok")];
    await t.inst.install("demo");
    expect(t.info().job!.error).toBeUndefined();
    expect(existsSync(join(t.root, "apps", "demo", "deps.log"))).toBe(true);
  });

  it("blocks an install when a required program is missing, says how to fix it, and clones nothing", async () => {
    const t = setup({ prerequisites: [{ id: "tool", label: "The Tool", command: node, args: ["-e", "process.exit(1)"], fix: "Install the tool.", when: "install" }] });
    await t.inst.install("demo");
    expect(t.info().job!.error).toContain("The Tool. Install the tool.");
    expect(existsSync(join(t.root, "apps", "demo"))).toBe(false);
    expect(t.store.load().paths["demo"]).toBeUndefined();
  });

  it("a missing run-time program is only a warning", async () => {
    const t = setup({ prerequisites: [{ id: "tool", label: "The Tool", command: node, args: ["-e", "process.exit(1)"], fix: "Install the tool.", when: "run" }] });
    await t.inst.install("demo");
    expect(t.info().job!.error).toBeUndefined();
    expect(t.info().prerequisites).toEqual([expect.objectContaining({ id: "tool", ok: false, when: "run" })]);
    expect(t.info().state).toBe("up-to-date");
  });

  it("checks for updates, updates by fast-forward, and repeats a step only when its watched file changed", async () => {
    const t = setup({ steps: [writeStep("Install deps", "deps.log", "x")] });
    await t.inst.install("demo");
    const dir = join(t.root, "apps", "demo");
    t.remote.commit({ "readme.md": "hi" });
    await t.inst.check("demo");
    expect(t.info()).toMatchObject({ state: "update-available", behind: 1 });
    await t.inst.update("demo");
    expect(t.info().state).toBe("up-to-date");
    expect(readFileSync(join(dir, "deps.log"), "utf-8")).toBe("x");                 // package-lock.json did not change: no second run
    t.remote.commit({ "package-lock.json": "2" });
    await t.inst.check("demo");
    await t.inst.update("demo");
    expect(readFileSync(join(dir, "deps.log"), "utf-8")).toBe("xx");                // it did: the step ran again
    expect(readFileSync(join(dir, "package-lock.json"), "utf-8")).toBe("2");
  });

  it("will not update an app that is open", async () => {
    const t = setup();
    await t.inst.install("demo");
    t.remote.commit({ "b.txt": "2" });
    await t.inst.check("demo");
    t.setRunning(true);
    await t.inst.update("demo");
    expect(t.info().job!.error).toContain("Close the Demo tab first");
    expect(existsSync(join(t.root, "apps", "demo", "b.txt"))).toBe(false);
  });

  it("will not update over local work, and says so on the card", async () => {
    const t = setup();
    await t.inst.install("demo");
    const dir = join(t.root, "apps", "demo");
    writeFileSync(join(dir, "app.txt"), "my edit");
    t.remote.commit({ "b.txt": "2" });
    await t.inst.check("demo");
    expect(t.info().message).toContain("uncommitted changes");
    await t.inst.update("demo");
    expect(t.info().job!.error).toContain("uncommitted changes");
    expect(readFileSync(join(dir, "app.txt"), "utf-8")).toBe("my edit");
  });

  it("a failed check (no network) is reported and changes nothing", async () => {
    const t = setup();
    await t.inst.install("demo");
    const dir = join(t.root, "apps", "demo");
    git(dir, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
    await t.inst.check("demo");
    expect(t.info().job!.error).toBeTruthy();
    expect(t.info().state).toBe("blocked");                                          // the origin no longer matches the catalog
  });

  it("offers an existing clone it finds, and adopts only a clone of the right repository", async () => {
    const t = setup();
    const existing = join(tempDir(), "mine");
    await new Git().clone(t.remote.url, "main", existing);
    t.repo.candidates = [existing];
    await t.inst.refresh("demo");
    expect(t.info()).toMatchObject({ state: "not-installed", candidate: existing });
    await t.inst.adopt("demo", existing);
    expect(t.info()).toMatchObject({ state: "installed", path: existing });
    const other = makeRemote({ "z.txt": "1" });
    const wrong = join(tempDir(), "wrong");
    await new Git().clone(other.url, "main", wrong);
    await t.inst.forget("demo");
    await t.inst.adopt("demo", wrong);
    expect(t.info().job!.error).toContain("not");
    expect(t.info().state).toBe("not-installed");
    await t.inst.adopt("demo", tempDir());
    expect(t.info().job!.error).toContain("not the top folder of a git clone");
  });

  it("forgetting a copy leaves its files alone", async () => {
    const t = setup();
    await t.inst.install("demo");
    await t.inst.forget("demo");
    expect(t.info().state).toBe("not-installed");
    expect(existsSync(join(t.root, "apps", "demo", "app.txt"))).toBe(true);
  });

  it("reports a saved folder that has disappeared", async () => {
    const t = setup();
    await t.inst.install("demo");
    const { rmSync } = await import("node:fs");
    rmSync(join(t.root, "apps", "demo"), { recursive: true, force: true });
    await t.inst.refresh("demo");
    expect(t.info()).toMatchObject({ state: "blocked", message: expect.stringContaining("is gone") });
  });

  it("cancel stops a running step and reports Cancelled", async () => {
    const slow = { label: "Slow step", cwd: ".", command: node, args: ["-e", "console.log('started'); setTimeout(()=>{}, 60000)"], watch: [] };
    const t = setup({ steps: [slow] });
    const job = t.inst.install("demo");
    for (let i = 0; i < 100 && !t.info().job?.lines.includes("started"); i++) await new Promise((r) => setTimeout(r, 100));
    t.inst.cancel("demo");
    await job;
    expect(t.info().job).toMatchObject({ running: false, error: "Cancelled." });
  }, 20_000);

  it("ignores a second job on an app while one is running", async () => {
    const slow = { label: "Slow step", cwd: ".", command: node, args: ["-e", "console.log('started'); setTimeout(()=>{}, 800)"], watch: [] };
    const t = setup({ steps: [slow] });
    const first = t.inst.install("demo");
    await new Promise((r) => setTimeout(r, 300));
    await t.inst.install("demo");                                                    // returns at once
    expect(t.info().job!.running).toBe(true);
    await first;
    expect(t.info().job!.error).toBeUndefined();
  });
});

export type { FakeRemote };
