import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withProjectLock } from "../src/core/projectStore";

// Found on 2026-10-07 by running scripts/stress-project-lock.cjs under load (C-07 in docs/corrections.md): a lock folder or owner file
// that its holder is deleting right now refuses a read, a mkdir or a write for a moment on Windows (EPERM, EBUSY, EACCES), and the lock
// answered E_INTERNAL instead of waiting. Nothing was lost, but a save failed under contention. Each rule is pinned with injected refusals.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(code + ": simulated"), { code });
const project = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-plock-"));
  dirs.push(d);
  mkdirSync(join(d, ".seed"));
  return d;
};
const lockDir = (d: string) => join(d, ".seed", "lock");
const guardDir = (d: string) => join(d, ".seed", "takeover");
const owner = (pid: number, token = "t") => JSON.stringify({ ownerId: "o", pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token });
const plant = (d: string, pid: number) => {
  mkdirSync(lockDir(d));
  writeFileSync(join(lockDir(d), "owner.json"), owner(pid));
};
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid as number;
const codeOf = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? "ok" : r.errors![0]!.code);
const realRead = (p: string) => readFileSync(p, "utf8");

describe("reading the owner file of a lock that is being released", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("%s a few times then a good read: the lock is judged normally (held by a live process)", (code) => {
    const d = project();
    plant(d, process.pid);
    let calls = 0;
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        readFile: (p) => {
          if (++calls <= 3) throw errno(code);
          return realRead(p);
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(calls).toBe(4);
  });

  it("a read that keeps being refused means held, never an internal error", () => {
    const d = project();
    plant(d, process.pid);
    let calls = 0;
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        readFile: () => {
          calls++;
          throw errno("EPERM");
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(calls).toBe(6);
    expect(existsSync(lockDir(d))).toBe(true);
  });

  it("after a transient refusal a dead holder's lock is still taken over", () => {
    const d = project();
    plant(d, deadPid());
    let calls = 0;
    const r = withProjectLock(d, () => "ran", {
      waitMs: 0,
      io: {
        readFile: (p) => {
          if (++calls === 1) throw errno("EBUSY");
          return realRead(p);
        }
      }
    });
    expect(r).toEqual({ ok: true, value: "ran" });
  });

  it("any other read error is still an internal error", () => {
    const d = project();
    plant(d, process.pid);
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        readFile: () => {
          throw errno("EIO");
        }
      }
    });
    expect(codeOf(r)).toBe("E_INTERNAL");
  });
});

describe("making the lock folder while its previous holder deletes it", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("%s a few times then success: the lock is taken, not refused", (code) => {
    const d = project();
    let calls = 0;
    const r = withProjectLock(d, () => "ran", {
      waitMs: 5000,
      io: {
        mkdir: (p) => {
          if (p === lockDir(d) && ++calls <= 3) throw errno(code);
          mkdirSync(p);
        }
      }
    });
    expect(r).toEqual({ ok: true, value: "ran" });
    expect(calls).toBeGreaterThan(3);
  });

  it("a refusal that does not end is E_PROJECT_LOCKED at the deadline, not an internal error", () => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 60,
      io: {
        mkdir: () => {
          throw errno("EPERM");
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
  });

  it("with no waiting allowed the first refusal is E_PROJECT_LOCKED at once", () => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        mkdir: () => {
          throw errno("EBUSY");
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
  });

  it.each(["EIO", "ENOSPC"])("%s is still an internal error", (code) => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        mkdir: () => {
          throw errno(code);
        }
      }
    });
    expect(codeOf(r)).toBe("E_INTERNAL");
  });
});

describe("writing the owner file", () => {
  it("a folder that somebody else made and owned in the meantime is not overwritten: their owner file survives", () => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        // this process "pauses" after its own mkdir: another process removed the folder and made it again with its own owner
        mkdir: (p) => {
          mkdirSync(p);
          if (p === lockDir(d)) writeFileSync(join(p, "owner.json"), owner(process.pid, "theirs"));
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(JSON.parse(readFileSync(join(lockDir(d), "owner.json"), "utf8")).token).toBe("theirs");
  });

  it.each(["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"])("%s on the owner write means not ours: the folder is left alone and the call waits", (code) => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        writeOwner: () => {
          throw errno(code);
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(existsSync(lockDir(d))).toBe(true); // not removed by path: it is not ours
  });

  it("a folder that is deleted right under the writer is simply made again", () => {
    const d = project();
    let calls = 0;
    const r = withProjectLock(d, () => "ran", {
      waitMs: 5000,
      io: {
        writeOwner: (p, data) => {
          if (++calls === 1) {
            rmSync(lockDir(d), { recursive: true, force: true }); // its previous holder's release finishes
            throw errno("EPERM");
          }
          writeFileSync(p, data, { flag: "wx" });
        }
      }
    });
    expect(r).toEqual({ ok: true, value: "ran" });
  });

  it("any other write error removes the folder it made and is an internal error", () => {
    const d = project();
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        writeOwner: () => {
          throw errno("ENOSPC");
        }
      }
    });
    expect(codeOf(r)).toBe("E_INTERNAL");
    expect(existsSync(lockDir(d))).toBe(false);
  });
});

describe("moving a stale lock aside", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("%s a few times, then success: the takeover goes through", (code) => {
    const d = project();
    plant(d, deadPid());
    let calls = 0;
    const r = withProjectLock(d, () => "ran", {
      waitMs: 5000,
      io: {
        rename: (a, b) => {
          if (++calls <= 2) throw errno(code);
          renameSync(a, b);
        }
      }
    });
    expect(r).toEqual({ ok: true, value: "ran" });
    expect(calls).toBe(3);
    expect(existsSync(guardDir(d))).toBe(false); // the guard was released each time
  });

  it("a refusal that does not end is E_PROJECT_LOCKED at the deadline, not an internal error and not a hot loop", () => {
    const d = project();
    plant(d, deadPid());
    const t0 = Date.now();
    const r = withProjectLock(d, () => 1, {
      waitMs: 100,
      io: {
        rename: () => {
          throw errno("EPERM");
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(guardDir(d))).toBe(false);
  });

  it("the folder already moved by somebody else is not an error", () => {
    const d = project();
    plant(d, deadPid());
    const r = withProjectLock(d, () => "ran", {
      waitMs: 5000,
      io: {
        rename: () => {
          rmSync(lockDir(d), { recursive: true, force: true });
          throw errno("ENOENT");
        }
      }
    });
    expect(r).toEqual({ ok: true, value: "ran" });
  });

  it("any other error is still an internal error", () => {
    const d = project();
    plant(d, deadPid());
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        rename: () => {
          throw errno("EIO");
        }
      }
    });
    expect(codeOf(r)).toBe("E_INTERNAL");
    expect(existsSync(guardDir(d))).toBe(false);
  });
});

describe("the takeover guard", () => {
  it("a guard folder refused for a moment means somebody else is judging: not an error", () => {
    const d = project();
    plant(d, deadPid());
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        mkdir: (p) => {
          if (p === guardDir(d)) throw errno("EPERM");
          mkdirSync(p);
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(existsSync(lockDir(d))).toBe(true); // the dead holder's lock was not touched
  });

  it("the guard of a contender whose process is gone is removed at once, even a fresh one, and the takeover goes on", () => {
    const d = project();
    plant(d, deadPid());
    mkdirSync(guardDir(d));
    writeFileSync(join(guardDir(d), "owner.json"), owner(deadPid(), "dead-guard"));
    const r = withProjectLock(d, () => "ran", { waitMs: 5000 });
    expect(r).toEqual({ ok: true, value: "ran" });
  });

  it("the guard of a live contender is respected, even an old one", () => {
    const d = project();
    plant(d, deadPid());
    mkdirSync(guardDir(d));
    writeFileSync(join(guardDir(d), "owner.json"), owner(process.pid, "busy-contender"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(guardDir(d), old, old);
    const r = withProjectLock(d, () => 1, { waitMs: 0 });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(JSON.parse(readFileSync(join(guardDir(d), "owner.json"), "utf8")).token).toBe("busy-contender");
  });

  it("an owner-less guard is removed once it is older than graceMs, and left alone before", () => {
    const d = project();
    plant(d, deadPid());
    mkdirSync(guardDir(d));
    expect(codeOf(withProjectLock(d, () => 1, { waitMs: 0 }))).toBe("E_PROJECT_LOCKED"); // fresh: somebody may be about to write its owner
    const old = new Date(Date.now() - 60_000);
    utimesSync(guardDir(d), old, old);
    expect(withProjectLock(d, () => "ran", { waitMs: 5000 })).toEqual({ ok: true, value: "ran" });
  });

  it("an abandoned guard that a live contender has replaced while this one was failing to remove it is left alone", () => {
    const d = project();
    plant(d, deadPid());
    mkdirSync(guardDir(d));
    writeFileSync(join(guardDir(d), "owner.json"), owner(deadPid(), "dead-guard"));
    let calls = 0;
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      removeTree: (p) => {
        if (p !== guardDir(d)) return rmSync(p, { recursive: true, force: true });
        calls++;
        // the first attempt did take the old guard away; a live contender made a new one; and Windows reported a refusal anyway
        rmSync(p, { recursive: true, force: true });
        mkdirSync(p);
        writeFileSync(join(p, "owner.json"), owner(process.pid, "live-guard"));
        throw errno("EPERM");
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
    expect(calls).toBe(1); // it looked again, saw a live guard, and did not try a second removal
    expect(JSON.parse(readFileSync(join(guardDir(d), "owner.json"), "utf8")).token).toBe("live-guard");
  });

  it("a guard holder that finds its guard replaced does not delete the new one on its way out", () => {
    const d = project();
    plant(d, deadPid());
    let replaced = false;
    const r = withProjectLock(d, () => "ran", {
      waitMs: 0,
      removeTree: (p) => {
        rmSync(p, { recursive: true, force: true });
        if (p.includes("lock.stale-") && !replaced) {
          replaced = true;
          // this contender was starved while it held the guard; another one judged the guard abandoned and took over
          rmSync(guardDir(d), { recursive: true, force: true });
          mkdirSync(guardDir(d));
          writeFileSync(join(guardDir(d), "owner.json"), owner(process.pid, "successor"));
        }
      }
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(guardDir(d), "owner.json"), "utf8")).token).toBe("successor");
  });

  it("a guard owner file that cannot be written for another reason than a refusal is an internal error", () => {
    const d = project();
    plant(d, deadPid());
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        writeOwner: (p, data) => {
          if (p === join(guardDir(d), "owner.json")) throw errno("ENOSPC");
          writeFileSync(p, data, { flag: "wx" });
        }
      }
    });
    expect(codeOf(r)).toBe("E_INTERNAL");
  });

  it.each(["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"])("%s on the guard's owner file means somebody else is judging: wait, not an error", (code) => {
    const d = project();
    plant(d, deadPid());
    const r = withProjectLock(d, () => 1, {
      waitMs: 0,
      io: {
        writeOwner: (p, data) => {
          if (p === join(guardDir(d), "owner.json")) throw errno(code);
          writeFileSync(p, data, { flag: "wx" });
        }
      }
    });
    expect(codeOf(r)).toBe("E_PROJECT_LOCKED");
  });

  it("a normal takeover leaves no guard and no stale folder behind", () => {
    const d = project();
    plant(d, deadPid());
    expect(withProjectLock(d, () => 1, { waitMs: 0 }).ok).toBe(true);
    expect(existsSync(guardDir(d))).toBe(false);
    expect(existsSync(lockDir(d))).toBe(false);
  });
});
