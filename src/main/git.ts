// The git operations the installer needs, run through the git on this computer (so the user's own GitHub sign-in is used and SEED never
// holds a credential). Nothing here rewrites history or discards work: no reset, no force, no checkout of other branches.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export class GitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

export interface RepoStatus {
  exists: boolean;
  isRepo: boolean;
  origin?: string;
  branch?: string;
  head?: string;
  /** Tracked files changed since the last commit. Untracked files do not count: a fast-forward does not touch them. */
  dirty?: boolean;
  /** Commits here that origin does not have, and the other way round, as of the last fetch. */
  ahead?: number;
  behind?: number;
}

export type Run = (args: string[], cwd: string | undefined, signal?: AbortSignal) => Promise<string>;

const runGit: Run = (args, cwd, signal) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }, (err, stdout, stderr) => {
    if (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new GitError("Git is not installed (or not on PATH).", ""));
      if (signal?.aborted) return reject(new GitError("Cancelled.", ""));
      return reject(new GitError(friendly(String(stderr || err.message)), String(stderr)));
    }
    resolve(String(stdout));
  });
});

/** Turns git's own wording into what the user should do. The raw text stays in GitError.stderr. */
export function friendly(stderr: string): string {
  const s = stderr.trim();
  if (/Authentication failed|could not read Username|terminal prompts disabled|Repository not found|403|401/i.test(s)) {
    return "GitHub refused access. If this repository is private, sign in once on this computer (install Git Credential Manager and run `git ls-remote <repository>` in a terminal, or run `gh auth login`), then try again.";
  }
  if (/Could not resolve host|unable to access|Failed to connect|timed out/i.test(s)) return "Could not reach GitHub. Check the network connection and try again.";
  if (/not possible to fast-forward|diverging|Not possible to fast-forward/i.test(s)) return "This copy has commits that GitHub does not have, so it cannot be updated automatically.";
  return s.split("\n").slice(-3).join(" ") || "git failed.";
}

/** Two GitHub addresses for the same repository, whatever the form (https or ssh, with or without .git, any case). */
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/").replace(/\.git$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export class Git {
  constructor(private readonly run: Run = runGit) {}

  async status(dir: string): Promise<RepoStatus> {
    if (!fs.existsSync(dir)) return { exists: false, isRepo: false };
    let top: string;
    try { top = (await this.run(["rev-parse", "--show-toplevel"], dir)).trim(); } catch { return { exists: true, isRepo: false }; }
    if (!samePath(top, dir)) return { exists: true, isRepo: false };       // a folder inside some other repository is not itself a clone
    const out = async (...a: string[]) => { try { return (await this.run(a, dir)).trim(); } catch { return undefined; } };
    const origin = await out("remote", "get-url", "origin");
    const branch = await out("rev-parse", "--abbrev-ref", "HEAD");
    const head = await out("rev-parse", "--short", "HEAD");
    const dirty = ((await out("status", "--porcelain", "--untracked-files=no")) ?? "").length > 0;
    let ahead: number | undefined;
    let behind: number | undefined;
    const counts = branch ? await out("rev-list", "--left-right", "--count", `HEAD...origin/${branch}`) : undefined;
    if (counts) { const [a, b] = counts.split(/\s+/).map(Number); ahead = a; behind = b; }
    return { exists: true, isRepo: true, ...(origin ? { origin } : {}), ...(branch ? { branch } : {}), ...(head ? { head } : {}), dirty, ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}) };
  }

  async fetch(dir: string, signal?: AbortSignal): Promise<void> {
    await this.run(["fetch", "--prune", "origin"], dir, signal);
  }

  /** Clones into dir, which must not exist or must be empty. */
  async clone(url: string, branch: string, dir: string, signal?: AbortSignal): Promise<void> {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new GitError(`${dir} already has files in it, so SEED will not clone there.`, "");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.run(["clone", "--branch", branch, url, dir], undefined, signal);
  }

  /** Moves the checked-out branch forward to origin's. Refuses anything that could lose work. Returns the files the update changed. */
  async fastForward(dir: string, branch: string): Promise<string[]> {
    const s = await this.status(dir);
    if (!s.isRepo) throw new GitError("This folder is not a git clone.", "");
    if (s.branch !== branch) throw new GitError(`This copy is on branch "${s.branch}", not "${branch}". SEED only updates ${branch}; switch it yourself first.`, "");
    if (s.dirty) throw new GitError("This copy has uncommitted changes. Commit or stash them, then update.", "");
    if ((s.ahead ?? 0) > 0) throw new GitError("This copy has commits that GitHub does not have, so it cannot be updated automatically.", "");
    const before = (await this.run(["rev-parse", "HEAD"], dir)).trim();
    await this.run(["merge", "--ff-only", `origin/${branch}`], dir);
    const after = (await this.run(["rev-parse", "HEAD"], dir)).trim();
    if (before === after) return [];
    return (await this.run(["diff", "--name-only", before, after], dir)).split("\n").map((l) => l.trim()).filter(Boolean);
  }
}
