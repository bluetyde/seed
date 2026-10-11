// @covers R-DISP-02
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaimOwner, readRequestsMap, releaseClaim, removeClaimIfAbandoned, removeWhile, takeClaim } from "../src/core/runManager";

// Found on 2026-10-07 by tracing the request-log stress test on a loaded machine: two processes were inside the lock at once and entries were
// lost, because a release that failed with EPERM was retried by path after somebody else had made a new lock at that path. Every deletion of
// a claim now looks again (is it still mine? is it still abandoned?) before each attempt, and the guard folder is a claim like the others.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(code + ": simulated"), { code });
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "seed-claim-"));
  dirs.push(root);
  return root;
};
const writeOwner = (dir: string, o: Record<string, unknown>) => writeFileSync(join(dir, "owner.json"), JSON.stringify(o));
const alive = (token: string) => ({ pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token });
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid as number;
const rmReal = (p: string) => rmSync(p, { recursive: true, force: true });

describe("a retried release never deletes the successor's lock", () => {
  it("the first attempt fails with EPERM after the folder was taken away and another holder made a new one: the new one survives", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    mkdirSync(dir);
    writeOwner(dir, alive("mine"));
    let calls = 0;
    releaseClaim(dir, "mine", (p) => {
      calls++;
      if (calls === 1) {
        rmReal(p); // the first attempt did take the folder away ...
        mkdirSync(p); // ... somebody else made a lock at the same path ...
        writeOwner(p, alive("successor"));
        throw errno("EPERM"); // ... and Windows reported a refusal anyway
      }
      rmReal(p); // what the old code did on its retry
    });
    expect(calls).toBe(1);
    expect(readClaimOwner(dir)?.token).toBe("successor");
  });

  it("while the folder is still mine a transient refusal is retried until it works", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    mkdirSync(dir);
    writeOwner(dir, alive("mine"));
    let calls = 0;
    releaseClaim(dir, "mine", (p) => {
      calls++;
      if (calls <= 2) throw errno(calls === 1 ? "EPERM" : "EBUSY");
      rmReal(p);
    });
    expect(calls).toBe(3);
    expect(existsSync(dir)).toBe(false);
  });

  it("a folder that never lets go is not reported as an error: its owner file is taken away so it expires, and nothing is thrown", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    mkdirSync(dir);
    writeOwner(dir, alive("mine"));
    let calls = 0;
    expect(() =>
      releaseClaim(dir, "mine", () => {
        calls++;
        throw errno("EACCES");
      })
    ).not.toThrow();
    expect(calls).toBe(21);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "owner.json"))).toBe(false);
  });

  it("any other error is not hidden", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    mkdirSync(dir);
    writeOwner(dir, alive("mine"));
    expect(() =>
      releaseClaim(dir, "mine", () => {
        throw errno("EIO");
      })
    ).toThrow(/EIO/);
  });

  it("someone else's claim is not released, and a missing one is fine", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    mkdirSync(dir);
    writeOwner(dir, alive("theirs"));
    releaseClaim(dir, "mine");
    expect(existsSync(dir)).toBe(true);
    releaseClaim(join(root, "none.lock"), "mine");
  });
});

describe("removeWhile looks again before every attempt", () => {
  it("stops, without touching anything, as soon as the folder is no longer wanted", () => {
    let wanted = true;
    let removed = 0;
    const r = removeWhile(
      "/x",
      () => wanted,
      () => {
        removed++;
        wanted = false;
        throw errno("EPERM");
      }
    );
    expect(r).toBe(true);
    expect(removed).toBe(1);
  });

  it("gives up with false after a transient refusal that does not end", () => {
    let removed = 0;
    expect(
      removeWhile(
        "/x",
        () => true,
        () => {
          removed++;
          throw errno("EBUSY");
        }
      )
    ).toBe(false);
    expect(removed).toBe(21);
  });
});

describe("removing an abandoned claim does not delete a live holder's new claim", () => {
  it("the abandoned folder is gone after the first (failed) attempt and a live holder made a new one: the new one is left alone", () => {
    const root = fresh();
    const claim = join(root, "requests.json.lock");
    mkdirSync(claim);
    writeOwner(claim, { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
    let calls = 0;
    const r = removeClaimIfAbandoned(claim, 5000, undefined, undefined, (p) => {
      calls++;
      rmReal(p);
      mkdirSync(p);
      writeOwner(p, alive("live"));
      throw errno("EPERM");
    });
    expect(r).toBe(false);
    expect(calls).toBe(1);
    expect(readClaimOwner(claim)?.token).toBe("live");
    expect(readdirSync(root)).toEqual(["requests.json.lock"]); // the guard is gone
  });

  it("a stale guard of a dead contender is removed and the takeover goes on", () => {
    const root = fresh();
    const claim = join(root, "requests.json.lock");
    mkdirSync(claim);
    writeOwner(claim, { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
    const guard = join(root, ".takeover-requests.json.lock");
    mkdirSync(guard);
    writeOwner(guard, { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead-guard" });
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it("an old guard with no owner is removed as well", () => {
    const root = fresh();
    const claim = join(root, "requests.json.lock");
    mkdirSync(claim);
    writeOwner(claim, { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
    const guard = join(root, ".takeover-requests.json.lock");
    mkdirSync(guard);
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(true);
  });

  it("a guard held by a live contender is respected, even an old one", () => {
    const root = fresh();
    const claim = join(root, "requests.json.lock");
    mkdirSync(claim);
    writeOwner(claim, { pid: deadPid(), host: os.hostname(), time: new Date().toISOString(), token: "dead" });
    const guard = join(root, ".takeover-requests.json.lock");
    mkdirSync(guard);
    writeOwner(guard, alive("busy-contender"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    expect(removeClaimIfAbandoned(claim, 5000)).toBe(false);
    expect(existsSync(claim)).toBe(true);
    expect(readClaimOwner(guard)?.token).toBe("busy-contender");
  });
});

describe("the request log: only a missing file is empty", () => {
  const entry = { "req-1": { payloadHash: "a".repeat(64), runId: "r-1" } };

  it("a missing file is an empty log", () => {
    expect(readRequestsMap("/x", () => { throw errno("ENOENT"); })).toEqual({ ok: true, map: {} });
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("a file held for a moment (%s) is retried and then read, not taken for empty", (code) => {
    let calls = 0;
    const r = readRequestsMap("/x", () => {
      calls++;
      if (calls <= 2) throw errno(code);
      return JSON.stringify(entry);
    });
    expect(calls).toBe(3);
    expect(r).toEqual({ ok: true, map: entry });
  });

  it("a file that stays unreadable is an error, never an empty log", () => {
    let calls = 0;
    const r = readRequestsMap("/x", () => {
      calls++;
      throw errno("EPERM");
    });
    expect(r.ok).toBe(false);
    expect(calls).toBe(21);
  });

  it("another error, or content that is not a log, is an error", () => {
    expect(readRequestsMap("/x", () => { throw errno("EIO"); }).ok).toBe(false);
    expect(readRequestsMap("/x", () => "{not json").ok).toBe(false);
    expect(readRequestsMap("/x", () => "[]").ok).toBe(false);
  });
});

describe("reading a claim's owner", () => {
  const owner = { pid: 1, host: "h", time: "2026-10-07T00:00:00Z", token: "t" };

  it("a file held for a moment is retried: a live holder does not look ownerless", () => {
    let calls = 0;
    expect(
      readClaimOwner("/x", () => {
        calls++;
        if (calls <= 3) throw errno("EBUSY");
        return JSON.stringify(owner);
      })
    ).toEqual(owner);
    expect(calls).toBe(4);
  });

  it("a half-written file is retried and then read", () => {
    let calls = 0;
    expect(readClaimOwner("/x", () => (++calls === 1 ? '{"pid": 1, "ho' : JSON.stringify(owner)))).toEqual(owner);
  });

  it("a missing file is no owner at once, without retries", () => {
    let calls = 0;
    expect(readClaimOwner("/x", () => { calls++; throw errno("ENOENT"); })).toBeNull();
    expect(calls).toBe(1);
  });

  it("a file that never becomes readable, or is not an owner, is no owner", () => {
    expect(readClaimOwner("/x", () => { throw errno("EPERM"); })).toBeNull();
    expect(readClaimOwner("/x", () => JSON.stringify({ pid: "1" }))).toBeNull();
    expect(readClaimOwner("/x", () => "null")).toBeNull();
  });
});

describe("taking a claim", () => {
  it("an owner write refused because the folder is being deleted means the folder is not ours: false, and it is not removed by us", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    const r = takeClaim(
      dir,
      "mine",
      undefined,
      () => {
        throw errno("EPERM");
      }
    );
    expect(r).toBe(false);
    expect(existsSync(dir)).toBe(true); // whoever is deleting it finishes the job; we never delete by path what we do not own
  });

  it("a persistent refusal to make the folder is an error after a short wait", () => {
    const root = fresh();
    expect(() =>
      takeClaim(join(root, "x.lock"), "mine", undefined, undefined, () => {
        throw errno("EPERM");
      })
    ).toThrow(/EPERM/);
  });

  it("a claim it made is read back with its token", () => {
    const root = fresh();
    const dir = join(root, "x.lock");
    expect(takeClaim(dir, "mine")).toBe(true);
    expect(readClaimOwner(dir)).toMatchObject({ token: "mine", pid: process.pid, host: os.hostname() });
    expect(takeClaim(dir, "other")).toBe(false);
    expect(readFileSync(join(dir, "owner.json"), "utf8")).toContain("mine");
  });
});
