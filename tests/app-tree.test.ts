// @covers R-SHELL-01, R-SHELL-03
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appTree, trackedFiles, treeChanges } from "./helpers/appTree";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const app = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-apptree-"));
  dirs.push(d);
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.txt"), "one");
  return d;
};

describe("the app folder fingerprint that backs the standalone check", () => {
  it("is equal for an untouched folder", () => {
    const d = app();
    expect(treeChanges(appTree(d), appTree(d))).toEqual([]);
  });
  it("reports an added, a changed (size), a touched (time) and a removed file", () => {
    const d = app();
    writeFileSync(join(d, "src", "b.txt"), "x");
    writeFileSync(join(d, "src", "c.txt"), "x");
    const before = appTree(d);
    writeFileSync(join(d, "src", "new.txt"), "n");
    writeFileSync(join(d, "src", "a.txt"), "longer");
    utimesSync(join(d, "src", "b.txt"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    rmSync(join(d, "src", "c.txt"));
    expect(treeChanges(before, appTree(d))).toEqual(["added src/new.txt", "changed src/a.txt", "changed src/b.txt", "removed src/c.txt"]);
  });
  it("ignores what an app rebuilds itself (git data, packages, interpreter caches)", () => {
    const d = app();
    const before = appTree(d);
    for (const f of [".git", "node_modules", ".venv", "__pycache__"]) {
      mkdirSync(join(d, f), { recursive: true });
      writeFileSync(join(d, f, "x"), "x");
    }
    expect(treeChanges(before, appTree(d))).toEqual([]);
  });
});

describe("tolerating the app's own developers", () => {
  it("does not report an edited tracked file, but still reports an added, a removed and an edited untracked one", () => {
    const d = app();
    writeFileSync(join(d, "src", "gone.txt"), "x");
    writeFileSync(join(d, "src", "scratch.txt"), "x");
    const before = appTree(d);
    writeFileSync(join(d, "src", "a.txt"), "edited");
    writeFileSync(join(d, "src", "scratch.txt"), "edited too");
    writeFileSync(join(d, "src", "new.txt"), "n");
    rmSync(join(d, "src", "gone.txt"));
    const tracked = new Set(["src/a.txt", "src/gone.txt"]);
    expect(treeChanges(before, appTree(d), tracked)).toEqual(["added src/new.txt", "changed src/scratch.txt", "removed src/gone.txt"]);
  });
  it("lists what git tracks in a checkout and nothing outside one", () => {
    const d = app();
    expect(trackedFiles(d).size).toBe(0);
  });
});

describe("trackedFiles in a real checkout", () => {
  it("lists the committed files and not the untracked ones", async () => {
    const { git } = await import("./helpers/repo");
    const d = app();
    git(d, "init", "-b", "main");
    git(d, "add", "-A");
    git(d, "commit", "-m", "first");
    writeFileSync(join(d, "src", "untracked.txt"), "x");
    expect([...trackedFiles(d)]).toEqual(["src/a.txt"]);
  });
});

describe("hasUncommittedEdits", () => {
  it("is false for a clean checkout and true once a tracked file is edited; untracked files do not count", async () => {
    const { git } = await import("./helpers/repo");
    const { hasUncommittedEdits } = await import("./helpers/appTree");
    const d = app();
    git(d, "init", "-b", "main");
    git(d, "add", "-A");
    git(d, "commit", "-m", "first");
    expect(hasUncommittedEdits(d)).toBe(false);
    writeFileSync(join(d, "src", "untracked.txt"), "x");
    expect(hasUncommittedEdits(d)).toBe(false);
    writeFileSync(join(d, "src", "a.txt"), "edited");
    expect(hasUncommittedEdits(d)).toBe(true);
  });
});

describe("gitStatus", () => {
  it("changes when a file is added, so a developer's new file can be told from an unchanged folder", async () => {
    const { git } = await import("./helpers/repo");
    const { gitStatus } = await import("./helpers/appTree");
    const d = app();
    git(d, "init", "-b", "main");
    git(d, "add", "-A");
    git(d, "commit", "-m", "first");
    const before = gitStatus(d);
    expect(gitStatus(d)).toBe(before);
    writeFileSync(join(d, "src", "new.txt"), "x");
    expect(gitStatus(d)).not.toBe(before);
    expect(gitStatus(d)).toContain("src/new.txt");
  });
  it("is empty outside a checkout", async () => {
    const { gitStatus } = await import("./helpers/appTree");
    expect(gitStatus(app())).toBe("");
  });
});
