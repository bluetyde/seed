// Local git repositories for the tests: a bare "GitHub" and a working copy that pushes to it. No network.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" }).trim();

export function tempDir(prefix = "seed-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FakeRemote {
  /** The address to clone from (a local path). */
  url: string;
  commit(files: Record<string, string>, message?: string): void;
}

export function makeRemote(files: Record<string, string>): FakeRemote {
  const base = tempDir("seed-remote-");
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  git(base, "init", "--bare", "-b", "main", bare);
  mkdirSync(work);
  git(work, "init", "-b", "main");
  git(work, "remote", "add", "origin", bare);
  const write = (f: Record<string, string>) => {
    for (const [name, text] of Object.entries(f)) {
      const p = join(work, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  };
  write(files);
  git(work, "add", "-A");
  git(work, "commit", "-m", "first");
  git(work, "push", "-u", "origin", "main");
  return {
    url: bare,
    commit(f, message = "next") {
      write(f);
      git(work, "add", "-A");
      git(work, "commit", "-m", message);
      git(work, "push", "origin", "main");
    },
  };
}
