import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { RunManager, type StartRequest } from "../src/core/runManager";
import { createTempProject, type TempProject } from "./helpers/project";

// Added by the dispatcher after review: a corrupt request log must refuse, not silently reset.
const cliPath = join(__dirname, "fixtures", "fake-adapter", "cli.cjs");
const projects: TempProject[] = [];
afterEach(async () => {
  while (projects.length > 0) await projects.pop()?.cleanup();
});

describe("RunManager: unreadable requests.json", () => {
  it("refuses with E_INTERNAL, creates no run directory and leaves the file untouched", async () => {
    const proj = createTempProject("seed-reqlog-");
    projects.push(proj);
    const model = JSON.stringify({ name: "pin", counter: 1, fake: { validate: "ok" } }) + "\n";
    proj.createFile("models/pin.json", model);
    const hash = sha256Hex(model);
    const runsDir = join(proj.root, "runs");
    mkdirSync(runsDir, { recursive: true });
    const garbage = "{ this is not json";
    writeFileSync(join(runsDir, "requests.json"), garbage);

    const mgr = new RunManager({
      projectRoot: proj.root,
      runsFolder: "runs",
      adapter: { command: process.execPath, args: [cliPath], id: "fake", version: "0.1.0" },
      pollMs: 50,
    });
    const req: StartRequest = {
      requestId: "req-corrupt-log",
      actor: { kind: "human", name: "tester" },
      artifact: { path: "models/pin.json", revision: { hash, counter: 1 } },
      inputs: [{ path: "models/pin.json", sha256: hash }],
      budget: { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 },
    };
    const out = await mgr.start(req);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]?.code).toBe("E_INTERNAL");
    expect(out.errors[0]?.field).toBe("/requests");
    expect(readFileSync(join(runsDir, "requests.json"), "utf8")).toBe(garbage);
    const runDirs = readdirSync(runsDir).filter((n) => n.startsWith("r-"));
    expect(runDirs).toEqual([]);
    expect(existsSync(join(runsDir, "gate-stops.jsonl"))).toBe(false);
  });
});
