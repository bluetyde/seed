import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { friendly, Git, sameRepo } from "../src/main/git";
import { git, makeRemote, tempDir } from "./helpers/repo";

const g = new Git();

describe("sameRepo", () => {
  it("ignores .git, case, trailing slash and ssh vs https", () => {
    expect(sameRepo("https://github.com/Bluetyde/Seed.git", "https://github.com/bluetyde/seed")).toBe(true);
    expect(sameRepo("git@github.com:bluetyde/seed.git", "https://github.com/bluetyde/seed/")).toBe(true);
    expect(sameRepo("https://github.com/bluetyde/seed", "https://github.com/bluetyde/other")).toBe(false);
  });
});

describe("friendly", () => {
  it("explains a private repository and a network failure in plain words", () => {
    expect(friendly("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatch(/private.*sign in/);
    expect(friendly("fatal: unable to access 'x': Could not resolve host: github.com")).toMatch(/Could not reach GitHub/);
  });
});

describe("Git", () => {
  it("clones, reports status, sees a new upstream commit after a fetch, and fast-forwards listing the changed files", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = join(tempDir(), "clone");
    await g.clone(remote.url, "main", dir);
    let s = await g.status(dir);
    expect(s).toMatchObject({ exists: true, isRepo: true, branch: "main", dirty: false, ahead: 0, behind: 0 });
    expect(s.origin).toBe(remote.url);
    remote.commit({ "b.txt": "2", "web/package-lock.json": "{}" });
    expect((await g.status(dir)).behind).toBe(0);               // not known until a fetch
    await g.fetch(dir);
    expect((await g.status(dir)).behind).toBe(1);
    const changed = await g.fastForward(dir, "main");
    expect(changed.sort()).toEqual(["b.txt", "web/package-lock.json"]);
    s = await g.status(dir);
    expect(s).toMatchObject({ behind: 0, ahead: 0 });
  });

  it("refuses to update a copy with uncommitted changes, and leaves the change alone", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = join(tempDir(), "clone");
    await g.clone(remote.url, "main", dir);
    writeFileSync(join(dir, "a.txt"), "my edit");
    remote.commit({ "b.txt": "2" });
    await g.fetch(dir);
    await expect(g.fastForward(dir, "main")).rejects.toMatchObject({ message: expect.stringContaining("uncommitted changes") });
    expect(git(dir, "status", "--porcelain")).toContain("a.txt");
  });

  it("refuses a copy with local commits, and a copy on another branch", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = join(tempDir(), "clone");
    await g.clone(remote.url, "main", dir);
    writeFileSync(join(dir, "local.txt"), "x");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "local work");
    remote.commit({ "b.txt": "2" });
    await g.fetch(dir);
    const before = git(dir, "rev-parse", "HEAD");
    await expect(g.fastForward(dir, "main")).rejects.toMatchObject({ message: expect.stringContaining("commits that GitHub does not have") });
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    git(dir, "checkout", "-q", "-b", "feature");
    await expect(g.fastForward(dir, "main")).rejects.toMatchObject({ message: expect.stringContaining('not "main"') });
  });

  it("does not count untracked files as local work", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = join(tempDir(), "clone");
    await g.clone(remote.url, "main", dir);
    writeFileSync(join(dir, "scratch.log"), "x");
    remote.commit({ "b.txt": "2" });
    await g.fetch(dir);
    expect((await g.status(dir)).dirty).toBe(false);
    await expect(g.fastForward(dir, "main")).resolves.toEqual(["b.txt"]);
  });

  it("will not clone into a folder that has files", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = tempDir();
    writeFileSync(join(dir, "mine.txt"), "x");
    await expect(g.clone(remote.url, "main", dir)).rejects.toMatchObject({ message: expect.stringContaining("already has files") });
  });

  it("tells a missing folder, a plain folder and a folder inside another repository apart from a clone", async () => {
    const remote = makeRemote({ "a.txt": "1" });
    const dir = join(tempDir(), "clone");
    await g.clone(remote.url, "main", dir);
    expect(await g.status(join(tempDir(), "nope"))).toEqual({ exists: false, isRepo: false });
    expect((await g.status(tempDir())).isRepo).toBe(false);
    mkdirSync(join(dir, "sub"));
    expect((await g.status(join(dir, "sub"))).isRepo).toBe(false);
  });

  it("reports a clone failure with git's reason", async () => {
    await expect(g.clone(join(tempDir(), "no-such-remote"), "main", join(tempDir(), "x"))).rejects.toMatchObject({ name: "GitError" });
  });
});
