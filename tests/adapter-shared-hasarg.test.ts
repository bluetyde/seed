import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A process is proven to be a job's own by its command line (adapters/shared/util.cjs `hasArg`). Windows quotes an argument that has a space; a POSIX
// `ps` does not quote anything, so a project under "/Users/me/My Projects" must still match. The helper reads process.platform once when it loads,
// so each case runs in a child process with the platform set first: both branches are tested on every operating system.
const util = resolve(__dirname, "../adapters/shared/util.cjs");

function ask(platform: "linux" | "win32", cl: string, value: string): boolean {
  const code = `Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});const u=require(${JSON.stringify(util)});process.stdout.write(String(u.hasArg(${JSON.stringify(cl)},${JSON.stringify(value)})))`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  return r.stdout === "true";
}

const SCRIPT = "/Users/me/My Projects/seed/adapters/shared/job.cjs";
const RUN = "/Users/me/My Projects/project/runs/r-1";
const TOKEN = "0123456789abcdef";
const POSIX_LINE = `/usr/local/bin/node ${SCRIPT} ${RUN} ${TOKEN} {"command":"x"}`;

describe("hasArg on a POSIX command line (no quotes; paths may contain spaces)", () => {
  it.each([[SCRIPT], [RUN], [TOKEN], ["/usr/local/bin/node"], ['{"command":"x"}']])("finds the whole argument %s", (v) => {
    expect(ask("linux", POSIX_LINE, v)).toBe(true);
  });

  it.each([
    ["a part of a longer path", "/Users/me/My Projects/project/runs/r"],
    ["a longer path than the one in the line", RUN + "-2"],
    ["a sibling folder whose name starts the same", "/Users/me/My Projects2/project/runs/r-1"],
    ["a part of the token", TOKEN.slice(1)],
    ["the folder alone", "/Users/me/My Projects"],
    ["an empty value", ""],
  ])("does not find %s", (_n, v) => {
    expect(ask("linux", POSIX_LINE, v)).toBe(false);
  });

  it("finds the first and the last argument, and a word that stands alone", () => {
    expect(ask("linux", "run /a/out", "run")).toBe(true);
    expect(ask("linux", "run /a/out", "/a/out")).toBe(true);
    expect(ask("linux", "node bundle.mjs run /a/out", "run")).toBe(true);
    expect(ask("linux", "node bundle.mjs rerun /a/out", "run")).toBe(false);
  });

  it("is case sensitive and does not rewrite slashes", () => {
    expect(ask("linux", POSIX_LINE, SCRIPT.toUpperCase())).toBe(false);
    expect(ask("linux", "node a\\b", "a/b")).toBe(false);
  });
});

describe("hasArg on a Windows command line (quoted arguments, case and slash insensitive)", () => {
  const WIN_LINE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\seed code\\job.cjs" "C:\\My Project\\runs\\r-1" 0123456789abcdef {"a":1}';
  it.each([["C:\\Program Files\\nodejs\\node.exe"], ["C:/seed code/job.cjs"], ["c:\\my project\\RUNS\\r-1"], ["0123456789abcdef"]])("finds the whole argument %s", (v) => {
    expect(ask("win32", WIN_LINE, v)).toBe(true);
  });
  it.each([["C:\\My Project"], ["C:\\My Project\\runs\\r-1\\x"], ["0123456789abcde"], ["seed"]])("does not find %s", (v) => {
    expect(ask("win32", WIN_LINE, v)).toBe(false);
  });
});
