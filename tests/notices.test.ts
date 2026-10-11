// @covers R-HYG-02
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// THIRD_PARTY_NOTICES.md is generated from package-lock.json (scripts/gen-notices.cjs). A dependency change that leaves it stale fails here.
const root = resolve(__dirname, "..");

it("THIRD_PARTY_NOTICES.md was made from the current package-lock.json", () => {
  const r = spawnSync(process.execPath, [resolve(root, "scripts/gen-notices.cjs"), "--check"], { encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});

it("it names the packages SEED runs with and the licence of each, and has no unknown licence", () => {
  const text = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as { packages: Record<string, { license?: string; dev?: boolean }> };
  const direct = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(direct.dependencies)) {
    expect(text, `${name} is in the notices`).toMatch(new RegExp(`\| ${name.replace(/[/@]/g, (c) => "\\" + c)} \| [0-9][^|]* \| [^|]+ \|`));
  }
  expect(text).not.toContain("| UNKNOWN |");
  expect(Object.keys(lock.packages).length).toBeGreaterThan(10);
});

it("the check fails when the file was made from another lockfile, and when there is no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-notices-"));
  try {
    const text = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    const stale = join(dir, "stale.md");
    writeFileSync(stale, text.replace(/Lockfile SHA-256: [0-9a-f]{64}/, "Lockfile SHA-256: " + "0".repeat(64)));
    const old = spawnSync(process.execPath, [resolve(root, "scripts/gen-notices.cjs"), "--check", "--notices", stale], { encoding: "utf8" });
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/not made from the current package-lock/);
    const none = spawnSync(process.execPath, [resolve(root, "scripts/gen-notices.cjs"), "--check", "--notices", join(dir, "absent.md")], { encoding: "utf8" });
    expect(none.status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
