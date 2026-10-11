// @covers R-SHELL-05
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appDir } from "./helpers/appDir";

// Decision D10 and the apps folder: a real-app test finds an app in this repository's `apps` folder first, then beside the repository.
const repoRoot = join(__dirname, "..");
const probe = "zz-app-dir-probe";
const inApps = join(repoRoot, "apps", probe);
const hadApps = existsSync(join(repoRoot, "apps"));

afterEach(() => {
  rmSync(inApps, { recursive: true, force: true });
  if (!hadApps) rmSync(join(repoRoot, "apps"), { recursive: true, force: true });
});

describe("where the real-app tests look for an app", () => {
  it("falls back to a sibling folder of the repository when the app is not in the apps folder", () => {
    expect(appDir(probe)).toBe(join(repoRoot, "..", probe));
  });

  it("prefers the apps folder inside the repository once the app is there", () => {
    mkdirSync(inApps, { recursive: true });
    expect(appDir(probe)).toBe(inApps);
  });

  it("the apps folder is ignored by git, so an installed app never shows up as a change", () => {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("git", ["check-ignore", "apps/anything"], { cwd: repoRoot, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("apps/anything");
  });
});
