import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAdmission } from "../src/core/hostFiles";
import type { PinSet, SetResult } from "../src/core/oracle";
import { clearFailure, journalBlock, journalRoot, readResultFile, recordEvaluation } from "../src/core/oracleJournal";
import { createProject, openProject, saveProject, withProjectLock, withProjectLockAsync } from "../src/core/projectStore";

// Findings of the Codex review of batch 4 (project lock and oracle journal, 2026-10-08), each shown by a test that fails without its fix.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "seed-b4-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const project = () => {
  const dir = tmp();
  createProject(dir, { name: "B4", seedVersion: "0.1.0" });
  return dir;
};
const code = (r: unknown) => (r as { errors?: { code: string }[] }).errors?.[0]?.code;

const sha = (c: string) => c.repeat(64);
const pins = (): PinSet => ({ appCommit: "a".repeat(40), oracleFiles: [{ oracleId: "o1", entryVersion: 1, sha256: sha("b") }] });
const failed = (): SetResult => ({
  adapter: "fake",
  adapterVersion: "0.1.0",
  verdict: "fail",
  inputsVerified: true,
  blocked: true,
  blockedQuantities: [],
  results: [{ oracleId: "o1", entryVersion: 1, tag: "good", verdict: "fail", reason: "value off" }],
  pins: pins()
});
const adapter = { id: "fake", version: "0.1.0" };
const human = { kind: "human", name: "owner" } as const;
const rec = (state: string) => recordEvaluation(state, adapter, failed(), sha("c"), human);
const block = (state: string) => journalBlock(state, "fake", "0.1.0", pins());

describe("the journal keeps every failure that stands (finding: clearing the newest hid the older)", () => {
  it("fail A, fail B, clear B: A still blocks, naming A; clearing A then lifts it", () => {
    const s = tmp();
    const a = rec(s);
    const b = rec(s);
    expect(block(s)).toMatchObject({ blocked: true, rowHash: b.hash, openFailures: 2 });
    clearFailure(s, adapter, pins(), b.hash, "looked at the second", human);
    expect(block(s)).toMatchObject({ blocked: true, rowHash: a.hash, openFailures: 1 });
    expect(() => clearFailure(s, adapter, pins(), b.hash, "the second again", human)).toThrow(/not the failure that is blocking/);
    clearFailure(s, adapter, pins(), a.hash, "looked at the first", human);
    expect(block(s)).toEqual({ blocked: false });
  });

  it("one clearance clears one failure: two failures need two", () => {
    const s = tmp();
    const a = rec(s);
    const b = rec(s);
    clearFailure(s, adapter, pins(), b.hash, "second", human);
    clearFailure(s, adapter, pins(), a.hash, "first", human);
    expect(block(s).blocked).toBe(false);
  });

  it("a clearance without a string target clears nothing", () => {
    const s = tmp();
    const a = rec(s);
    appendAdmission(journalRoot(s, "fake", true)!, { type: "clearance", clears: 5, reason: "numbers", actor: human });
    expect(block(s)).toMatchObject({ blocked: true, rowHash: a.hash });
  });
});

describe("a result file with a second name is refused (finding: hard link past the outside-the-project check)", () => {
  it("a linked file is refused; the same bytes in an unlinked file are read", () => {
    const base = tmp();
    const proj = join(base, "project");
    mkdirSync(proj);
    const outside = join(base, "out");
    mkdirSync(outside);
    const plain = join(outside, "result.json");
    writeFileSync(plain, JSON.stringify(failed()));
    expect(readResultFile(plain, proj).sha256).toMatch(/^[0-9a-f]{64}$/);
    linkSync(plain, join(outside, "second-name.json"));
    expect(() => readResultFile(plain, proj)).toThrow(/linked file/);
  });
});

describe("a planted heartbeat cannot keep a dead lock for ever (finding: project-controlled beat)", () => {
  const plant = (dir: string, beat: number) => {
    const lock = join(dir, ".seed", "lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 1, host: "another-machine", acquiredAt: "2020-01-01T00:00:00.000Z", token: "planted" }));
    writeFileSync(join(lock, "beat"), String(beat));
  };
  const me = { host: "this-machine", staleMs: 400, graceMs: 50 };

  it("a beat far in the future is no sign of life: the lock is taken over", () => {
    const dir = project();
    plant(dir, Date.now() + 10 ** 13);
    expect(withProjectLock(dir, () => "mine", me)).toEqual({ ok: true, value: "mine" });
  });

  it("a beat from now still keeps a lock that is alive", () => {
    const dir = project();
    plant(dir, Date.now());
    expect(code(withProjectLock(dir, () => "mine", me))).toBe("E_PROJECT_LOCKED");
  });

  it("an old beat does not", () => {
    const dir = project();
    plant(dir, Date.now() - 60000);
    expect(withProjectLock(dir, () => "mine", me)).toEqual({ ok: true, value: "mine" });
  });
});

describe("a holder whose lock was taken over is told (finding: release reported success)", () => {
  const ownerFile = (dir: string) => join(dir, ".seed", "lock", "owner.json");
  const swapOwner = (dir: string) => {
    const o = JSON.parse(readFileSync(ownerFile(dir), "utf8"));
    writeFileSync(ownerFile(dir), JSON.stringify({ ...o, token: "somebody-else" }));
  };

  it("a callback whose owner file now names another token gets E_PROJECT_LOCKED, and the other owner's lock is left alone", () => {
    const dir = project();
    const r = withProjectLock(dir, () => swapOwner(dir));
    expect(code(r)).toBe("E_PROJECT_LOCKED");
    expect(JSON.parse(readFileSync(ownerFile(dir), "utf8")).token).toBe("somebody-else");
  });

  it("the same for the asynchronous wrapper", async () => {
    const dir = project();
    const r = await withProjectLockAsync(dir, async () => swapOwner(dir), { heartbeatMs: 0 });
    expect(code(r)).toBe("E_PROJECT_LOCKED");
  });

  it("a callback whose lock folder is gone gets the same error", () => {
    const dir = project();
    const r = withProjectLock(dir, () => rmSync(join(dir, ".seed", "lock"), { recursive: true, force: true }));
    expect(code(r)).toBe("E_PROJECT_LOCKED");
  });

  it("an ordinary callback releases cleanly and the lock is free again", () => {
    const dir = project();
    expect(withProjectLock(dir, () => 7)).toEqual({ ok: true, value: 7 });
    expect(withProjectLock(dir, () => 8)).toEqual({ ok: true, value: 8 });
  });
});

describe("saveProject has the lock fence too (finding: only saveProjectHeld had it)", () => {
  it("a save whose lock is taken over while the manifest is written is reported, not called a success", () => {
    const dir = project();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    const r = saveProject(dir, { ...opened.value.manifest, name: "late" }, opened.value.revision, {
      afterManifestWrite: () => {
        const f = join(dir, ".seed", "lock", "owner.json");
        const o = JSON.parse(readFileSync(f, "utf8"));
        writeFileSync(f, JSON.stringify({ ...o, token: "newer-writer" }));
      }
    });
    expect(r.ok).toBe(false);
    expect(code(r)).toBe("E_PROJECT_LOCKED");
    expect((r as { errors: { message: string }[] }).errors[0]!.message).toMatch(/may have replaced a newer writer/);
  });

  it("an ordinary save still works", () => {
    const dir = project();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    const r = saveProject(dir, { ...opened.value.manifest, name: "renamed" }, opened.value.revision);
    expect(r.ok).toBe(true);
  });
});
