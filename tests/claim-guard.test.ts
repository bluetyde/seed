import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeClaimIfAbandoned } from "../src/core/runManager";

// Found by the full suite on 2026-10-07 (two rounds in forty of the request-log stress test): on Windows a folder that another process is
// deleting refuses mkdir for a moment with EPERM, and the takeover guard's mkdir threw instead of waiting.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(code + ": simulated"), { code });
const abandonedClaim = () => {
  const root = mkdtempSync(join(tmpdir(), "seed-guard-"));
  dirs.push(root);
  const claim = join(root, "requests.json.lock");
  mkdirSync(claim);
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(join(claim, "owner.json"), JSON.stringify({ pid: dead, host: os.hostname(), time: new Date().toISOString(), token: "dead" }));
  return { root, claim };
};

describe("removing an abandoned claim under the takeover guard", () => {
  it("removes it when the guard can be made", () => {
    const { root, claim } = abandonedClaim();
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(true);
    expect(existsSync(claim)).toBe(false);
    expect(readdirSync(root)).toEqual([]); // the guard is gone too
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("%s on the guard (another contender is deleting it) means somebody else is judging: false, no throw, claim untouched", (code) => {
    const { root, claim } = abandonedClaim();
    const r = removeClaimIfAbandoned(claim, 5000, undefined, () => {
      throw errno(code);
    });
    expect(r).toBe(false);
    expect(existsSync(claim)).toBe(true);
    expect(readdirSync(root)).toEqual(["requests.json.lock"]);
  });

  it("any other failure to make the guard is still an error (a full disk is not 'somebody else')", () => {
    const { claim } = abandonedClaim();
    expect(() =>
      removeClaimIfAbandoned(claim, 5000, undefined, () => {
        throw errno("ENOSPC");
      })
    ).toThrow(/ENOSPC/);
  });

  it("a fresh guard that exists means somebody else is judging", () => {
    const { root, claim } = abandonedClaim();
    mkdirSync(join(root, ".takeover-requests.json.lock"));
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(false);
    expect(existsSync(claim)).toBe(true);
  });

  it("a claim whose holder is alive is left alone, and the guard is removed again", () => {
    const { root, claim } = abandonedClaim();
    writeFileSync(join(claim, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: "alive" }));
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(false);
    expect(existsSync(claim)).toBe(true);
    expect(readdirSync(root)).toEqual(["requests.json.lock"]);
  });
});
