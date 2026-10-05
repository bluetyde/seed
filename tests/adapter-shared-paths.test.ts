import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

// Path containment and the snapshot check from adapters/shared/util.cjs, each rule on its own (see adapter-shared-util.test.ts).
const util = createRequire(__filename)("../adapters/shared/util.cjs") as Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "seed shared paths ") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
/** A folder link pointing at `target`, or null where links are not permitted. */
function link(at: string, target: string): boolean {
  try {
    symlinkSync(target, at, "junction");
    return true;
  } catch {
    return false;
  }
}

describe("insideRoot", () => {
  it("finds a file inside the root, reports a missing one, and refuses every way out", () => {
    const root = tmp();
    mkdirSync(join(root, "runs"));
    writeFileSync(join(root, "runs", "a.json"), "{}");
    const ok = util.insideRoot(root, "runs/a.json");
    expect(ok.abs).toBeTruthy();
    expect(ok.escaped).toBeUndefined();
    expect(util.insideRoot(root, "runs/none.json")).toMatchObject({ missing: true });
    for (const bad of ["../x", "runs/../../x", "/etc/passwd", "C:/Windows", "runs\\a.json"]) expect(util.insideRoot(root, bad), bad).toEqual({ escaped: true });

    const outside = tmp("seed shared outside ");
    writeFileSync(join(outside, "secret.json"), "{}");
    if (link(join(root, "linked"), outside)) {
      expect(util.insideRoot(root, "linked/secret.json")).toEqual({ escaped: true }); // a link that leads out of the project
      expect(util.containedBelow(root, join(root, "linked"))).toBe(false);
    }
  });
});

describe("snapshotProblem", () => {
  const setup = (files: Record<string, string>) => {
    const run = tmp();
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(run, "inputs", p.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(run, "inputs", p), text);
    }
    return run;
  };

  it("passes when every input still hashes to what was recorded", () => {
    const run = setup({ "models/m.json": "abc" });
    expect(util.snapshotProblem(run, [{ path: "models/m.json", sha256: sha("abc") }])).toBeNull();
  });
  it("names a changed file, a missing one and a path that is not portable", () => {
    const run = setup({ "models/m.json": "abc" });
    expect(util.snapshotProblem(run, [{ path: "models/m.json", sha256: sha("abd") }])).toContain("no longer matches");
    expect(util.snapshotProblem(run, [{ path: "models/gone.json", sha256: sha("x") }])).toContain("missing");
    expect(util.snapshotProblem(run, [{ path: "../escape.json", sha256: sha("x") }])).toContain("not a portable");
  });
  it("refuses an input that is a link leading out of the run folder", () => {
    const run = setup({ "models/m.json": "abc" });
    const outside = tmp("seed shared outside ");
    writeFileSync(join(outside, "m.json"), "abc");
    mkdirSync(join(run, "inputs", "more"));
    if (link(join(run, "inputs", "more", "linked"), outside)) {
      expect(util.snapshotProblem(run, [{ path: "more/linked/m.json", sha256: sha("abc") }])).toContain("outside the run folder");
    }
  });
});
