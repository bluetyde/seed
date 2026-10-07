import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, openProject, saveProjectHeld, withProjectLock, withProjectLockAsync } from "../src/core/projectStore";

// Findings of the Codex review of the E2 changes (2026-10-06) on the project writer lock, each shown by a test that fails without the fix.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-lockrev-"));
  dirs.push(dir);
  createProject(dir, { name: "Lock", seedVersion: "0.1.0" });
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const foreign = { host: "another-machine", staleMs: 400 };

describe("a writer that lost its lock stays refused while another callback of the same process holds it", () => {
  it("callback A (taken over, then the lock is free and callback B takes it) cannot save with B's token", async () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    let late: ReturnType<typeof saveProjectHeld> | undefined;
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    let bDone: Promise<unknown> | undefined;
    await withProjectLockAsync(
      dir,
      async () => {
        await sleep(700); // silent: no heartbeat
        expect(withProjectLock(dir, () => "took over and released", foreign)).toEqual({ ok: true, value: "took over and released" });
        bDone = withProjectLockAsync(dir, async () => gateB); // B takes the free lock inside the same process
        late = saveProjectHeld(dir, { ...opened.value.manifest, name: "expired writer" }, opened.value.revision);
        releaseB();
      },
      { staleMs: 400, heartbeatMs: 0 }
    );
    await bDone;
    expect(late?.ok).toBe(false);
    expect((late as { errors: { code: string }[] }).errors[0]!.code).toBe("E_PROJECT_LOCKED");
    const after = openProject(dir);
    expect(after.ok && after.value.manifest.name).toBe("Lock");
  });
});

describe("the heartbeat writes nothing into a path the project controls", () => {
  it("a (hard) link planted at .seed/lock/beat is replaced, not written through: its target is not overwritten", async (ctx) => {
    const dir = fresh();
    const outside = join(dirs[0]!, "..", "seed-lockrev-outside-" + Date.now() + ".txt");
    writeFileSync(outside, "untouched");
    dirs.push(outside);
    await withProjectLockAsync(
      dir,
      async () => {
        try {
          linkSync(outside, join(dir, ".seed", "lock", "beat")); // writing through it would change the outside file; no privilege needed
        } catch {
          return ctx.skip(); // this machine cannot create links
        }
        await sleep(400); // several heartbeats
      },
      { staleMs: 400, heartbeatMs: 50 }
    );
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });

  it("the heartbeat still keeps a lock of another host alive (the folder's own time carries it)", async () => {
    const dir = fresh();
    const results: boolean[] = [];
    await withProjectLockAsync(
      dir,
      async () => {
        for (let i = 0; i < 4; i++) {
          await sleep(300);
          results.push(withProjectLock(dir, () => "stolen", foreign).ok);
        }
      },
      { staleMs: 400 }
    );
    expect(results).toEqual([false, false, false, false]);
  });
});

describe("a save that finds its lock gone after the write says so", () => {
  it("is reported as lost, not as a clean save", async () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    let r: ReturnType<typeof saveProjectHeld> | undefined;
    await withProjectLockAsync(dir, async () => {
      const ownerPath = join(dir, ".seed", "lock", "owner.json");
      r = saveProjectHeld(dir, { ...opened.value.manifest, name: "written" }, opened.value.revision, {
        afterManifestWrite: () => {
          const o = JSON.parse(readFileSync(ownerPath, "utf8"));
          writeFileSync(ownerPath, JSON.stringify({ ...o, token: "a-successor" }));
        },
      });
    });
    expect(r?.ok).toBe(false);
    expect((r as { errors: { code: string; message: string }[] }).errors[0]).toMatchObject({ code: "E_PROJECT_LOCKED" });
    expect((r as { errors: { message: string }[] }).errors[0]!.message).toContain("had been written");
  });
});
