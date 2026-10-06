import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appTree, treeChanges } from "./helpers/appTree";

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
