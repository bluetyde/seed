import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withHiddenWindow } from "./helpers/hideWindows";

// A test must not open console windows that take the focus (tests/helpers/hideWindows.ts, installed by vitest.config.ts).
describe("withHiddenWindow", () => {
  it("adds the option where a call has none, in the place its form needs", () => {
    expect(withHiddenWindow(["git"])).toEqual(["git", { windowsHide: true }]);
    expect(withHiddenWindow(["git", ["status"]])).toEqual(["git", ["status"], { windowsHide: true }]);
    const cb = () => undefined;
    expect(withHiddenWindow(["git", ["status"], cb])).toEqual(["git", ["status"], { windowsHide: true }, cb]);
    expect(withHiddenWindow(["git status", cb])).toEqual(["git status", { windowsHide: true }, cb]);
  });
  it("adds it to the options a call has, and leaves a value the caller set", () => {
    expect(withHiddenWindow(["git", ["status"], { cwd: "x" }])).toEqual(["git", ["status"], { windowsHide: true, cwd: "x" }]);
    expect(withHiddenWindow(["git", { stdio: "ignore" }])).toEqual(["git", { windowsHide: true, stdio: "ignore" }]);
    expect(withHiddenWindow(["git", ["status"], { windowsHide: false }])).toEqual(["git", ["status"], { windowsHide: false }]);
  });
  it("does not change the arguments it was given", () => {
    const a: unknown[] = ["git", ["status"]];
    withHiddenWindow(a);
    expect(a).toEqual(["git", ["status"]]);
  });
});

describe("the child_process calls a test makes, after the setup", () => {
  it("still run and return what they used to (the promisified execFile too)", async () => {
    expect(spawnSync(process.execPath, ["-e", "process.stdout.write('a')"], { encoding: "utf8" }).stdout).toBe("a");
    expect(execFileSync(process.execPath, ["-e", "process.stdout.write('b')"], { encoding: "utf8" })).toBe("b");
    expect((await promisify(execFile)(process.execPath, ["-e", "process.stdout.write('c')"], { encoding: "utf8" })).stdout).toBe("c");
  });
});
