// Installs and updates the suite's repositories: clone, adopt an existing clone, fast-forward update, dependency install, prerequisite
// checks. One job per app at a time, cancellable. It never changes a working tree that has local work in it, never updates an app that
// is running, and keeps every outcome visible (a failed step leaves its output on the app's card).

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogRepo, InstallStep } from "./catalog";
import { Git, GitError, sameRepo } from "./git";
import { killTree } from "./processes";
import type { InstallStore } from "./store";

export interface Deps {
  repos: CatalogRepo[];
  store: InstallStore;
  git: Git;
  /** Runs a command, calling onLine for each output line. Resolves with the exit code. */
  runCmd: (cmd: string, args: string[], cwd: string, onLine: (l: string) => void, signal: AbortSignal) => Promise<number>;
  /** True when the command exits with 0. */
  checkCmd: (cmd: string, args: string[]) => Promise<boolean>;
  isRunning: (id: string) => boolean;
  /** Something visible changed. */
  onChange: () => void;
}

const MAX_LINES = 300;

export const defaultRunCmd: Deps["runCmd"] = (cmd, args, cwd, onLine, signal) => new Promise((resolve, reject) => {
  // npm is a .cmd file on Windows, which cannot be started directly; the arguments here come from the shipped catalog, not from a user.
  const win = process.platform === "win32" && /^(npm|npx)$/.test(cmd);
  const child = spawn(win ? "cmd.exe" : cmd, win ? ["/d", "/s", "/c", cmd, ...args] : args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const feed = (b: Buffer) => { buf += b.toString(); const parts = buf.split(/\r?\n/); buf = parts.pop() ?? ""; parts.forEach(onLine); };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.once("error", reject);
  child.once("exit", (code) => { if (buf) onLine(buf); resolve(code ?? -1); });
  signal.addEventListener("abort", () => { void killTree(child); }, { once: true });
});

export const defaultCheckCmd: Deps["checkCmd"] = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err) => resolve(!err));
});

export class Installer {
  private infos = new Map<string, HostInstall>();
  private jobs = new Map<string, AbortController>();
  private checked = new Set<string>();
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: Deps) {
    for (const r of d.repos) this.infos.set(r.id, { id: r.id, name: r.name, ...(r.notes ? { notes: r.notes } : {}), isPrivate: r.isPrivate, state: "not-installed", prerequisites: [] });
  }

  list(): HostInstall[] {
    return this.d.repos.map((r) => this.infos.get(r.id)!);
  }

  /** The folder an app runs from, if it is installed. */
  installPath(id: string): string | undefined {
    return this.d.store.load().paths[id];
  }

  private repo(id: string): CatalogRepo {
    const r = this.d.repos.find((x) => x.id === id);
    if (!r) throw new Error(`Unknown app "${id}".`);
    return r;
  }

  private notify(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = undefined; this.d.onChange(); }, 60);
  }

  // ---- reading the current situation (no network) ----

  async refreshAll(): Promise<void> {
    await Promise.all(this.d.repos.map((r) => this.refresh(r.id)));
  }

  async refresh(id: string): Promise<void> {
    const r = this.repo(id);
    const prev = this.infos.get(id)!;
    const next: HostInstall = { id, name: r.name, ...(r.notes ? { notes: r.notes } : {}), isPrivate: r.isPrivate, state: "not-installed", prerequisites: [], ...(prev.job ? { job: prev.job } : {}) };
    next.prerequisites = await Promise.all(r.prerequisites.map(async (p) => ({ id: p.id, label: p.label, ok: await this.d.checkCmd(p.command, p.args), fix: p.fix, when: p.when })));
    const dir = this.installPath(id);
    if (dir) {
      const s = await this.d.git.status(dir);
      next.path = dir;
      if (!s.exists) { next.state = "blocked"; next.message = `The saved folder ${dir} is gone. Install again, or use another copy.`; }
      else if (!s.isRepo) { next.state = "blocked"; next.message = `${dir} is no longer a git clone. Install again, or use another copy.`; }
      else if (!s.origin || !sameRepo(s.origin, r.url)) { next.state = "blocked"; next.message = `${dir} is a clone of a different repository (${s.origin ?? "no origin"}).`; }
      else {
        if (s.branch) next.branch = s.branch;
        if (s.head) next.head = s.head;
        next.dirty = s.dirty === true;
        next.ahead = s.ahead ?? 0;
        next.behind = s.behind ?? 0;
        next.state = (s.behind ?? 0) > 0 ? "update-available" : this.checked.has(id) ? "up-to-date" : "installed";
        const notes: string[] = [];
        if (s.branch !== r.branch) notes.push(`on branch ${s.branch}, SEED updates ${r.branch}`);
        if (s.dirty) notes.push("has uncommitted changes");
        if ((s.ahead ?? 0) > 0) notes.push(`${s.ahead} local commit${s.ahead === 1 ? "" : "s"} not on GitHub`);
        if (notes.length) next.message = notes.join("; ");
      }
    } else {
      const found = await this.findExisting(r);
      if (found) next.candidate = found;
    }
    this.infos.set(id, next);
    this.notify();
  }

  private async findExisting(r: CatalogRepo): Promise<string | undefined> {
    const places = [...r.candidates, path.join(this.d.store.load().installRoot, r.folder)];
    for (const p of places) {
      const s = await this.d.git.status(p);
      if (s.isRepo && s.origin && sameRepo(s.origin, r.url)) return p;
    }
    return undefined;
  }

  // ---- jobs ----

  private begin(id: string, kind: "install" | "update" | "check"): AbortController {
    if (this.jobs.has(id)) throw new Error("Something is already running for this app. Wait for it or cancel it.");
    const ac = new AbortController();
    this.jobs.set(id, ac);
    this.infos.get(id)!.job = { kind, step: "Starting", lines: [], running: true };
    this.notify();
    return ac;
  }

  private log(id: string, line: string): void {
    const j = this.infos.get(id)!.job;
    if (!j || !line.trim()) return;
    j.lines.push(line);
    if (j.lines.length > MAX_LINES) j.lines.shift();
    this.notify();
  }

  private async finish(id: string, error?: string): Promise<void> {
    this.jobs.delete(id);
    const j = this.infos.get(id)!.job;
    if (j) { j.running = false; j.step = error ? "Failed" : "Done"; if (error) j.error = error; else delete j.error; }
    const keep = this.infos.get(id)!.job;
    await this.refresh(id);
    if (keep) this.infos.get(id)!.job = keep;
    this.notify();
  }

  cancel(id: string): void {
    this.jobs.get(id)?.abort();
  }

  /** Fetches from GitHub to see whether an update exists. Changes nothing on disk except git's remote-tracking refs. */
  async check(id: string): Promise<void> {
    const dir = this.installPath(id);
    if (!dir) { await this.refresh(id); return; }
    if (this.jobs.has(id)) return;
    const ac = this.begin(id, "check");
    try {
      this.infos.get(id)!.job!.step = "Asking GitHub";
      await this.d.git.fetch(dir, ac.signal);
      this.checked.add(id);
      await this.finish(id);
    } catch (e) {
      await this.finish(id, (e as Error).message);
    }
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.d.repos.filter((r) => this.installPath(r.id)).map((r) => this.check(r.id)));
  }

  /** A problem found before a job could start, shown on the app's card like any failed job. */
  private fail(id: string, kind: "install" | "update" | "check" | "adopt", message: string): void {
    this.infos.get(id)!.job = { kind, step: "Failed", lines: [], running: false, error: message };
    this.notify();
  }

  private async requirePrerequisites(id: string): Promise<void> {
    await this.refresh(id);
    const failed = this.infos.get(id)!.prerequisites.filter((p) => !p.ok && p.when === "install");
    if (failed.length) throw new Error(`Missing before it can be installed: ${failed.map((p) => `${p.label}. ${p.fix}`).join(" ")}`);
  }

  private async runSteps(id: string, dir: string, steps: InstallStep[], signal: AbortSignal): Promise<void> {
    for (const s of steps) {
      this.infos.get(id)!.job!.step = s.label;
      this.log(id, `> ${s.label}`);
      this.notify();
      const cwd = path.join(dir, s.cwd);
      if (!fs.existsSync(cwd)) throw new Error(`${s.label}: the folder ${s.cwd} is not in this copy.`);
      const code = await this.d.runCmd(s.command, s.args, cwd, (l) => this.log(id, l), signal);
      if (signal.aborted) throw new Error("Cancelled.");
      if (code !== 0) throw new Error(`${s.label} failed (exit code ${code}). The output is below.`);
    }
  }

  /** Clones the repository into the install folder and runs its install steps. On an app that is already installed, repeats the steps. */
  async install(id: string): Promise<void> {
    const r = this.repo(id);
    if (this.jobs.has(id)) return;
    const ac = this.begin(id, "install");
    try {
      await this.requirePrerequisites(id);
      let dir = this.installPath(id);
      if (!dir) {
        dir = path.join(this.d.store.load().installRoot, r.folder);
        this.infos.get(id)!.job!.step = "Cloning from GitHub";
        this.log(id, `Cloning ${r.url} into ${dir}`);
        await this.d.git.clone(r.url, r.branch, dir, ac.signal);
        this.d.store.setPath(id, dir);
      }
      await this.runSteps(id, dir, r.steps, ac.signal);
      this.checked.add(id);
      await this.finish(id);
    } catch (e) {
      await this.finish(id, (e as Error).message);
    }
  }

  /** Brings an installed copy up to GitHub's branch by fast-forward. Refuses if the app is open, or the copy has local work. */
  async update(id: string): Promise<void> {
    const r = this.repo(id);
    const dir = this.installPath(id);
    if (!dir) return this.fail(id, "update", "Not installed yet.");
    if (this.d.isRunning(id)) return this.fail(id, "update", `Close the ${r.name} tab first, so its files are not changed while it runs.`);
    if (this.jobs.has(id)) return;
    const ac = this.begin(id, "update");
    try {
      await this.requirePrerequisites(id);
      this.infos.get(id)!.job!.step = "Asking GitHub";
      await this.d.git.fetch(dir, ac.signal);
      this.checked.add(id);
      this.infos.get(id)!.job!.step = "Updating";
      const changed = await this.d.git.fastForward(dir, r.branch);
      this.log(id, changed.length ? `Updated: ${changed.length} file${changed.length === 1 ? "" : "s"} changed.` : "Already up to date.");
      const again = r.steps.filter((s) => s.watch.some((w) => changed.includes(w)));
      await this.runSteps(id, dir, again, ac.signal);
      await this.finish(id);
    } catch (e) {
      await this.finish(id, e instanceof GitError || e instanceof Error ? e.message : String(e));
    }
  }

  /** Uses a clone that is already on this computer. It must be a clone of this app's repository. Nothing in it is changed. */
  async adopt(id: string, dir: string): Promise<void> {
    const r = this.repo(id);
    const s = await this.d.git.status(dir);
    if (!s.isRepo) return this.fail(id, "adopt", `${dir} is not the top folder of a git clone.`);
    if (!s.origin || !sameRepo(s.origin, r.url)) return this.fail(id, "adopt", `${dir} is a clone of ${s.origin ?? "an unknown repository"}, not ${r.url}.`);
    this.d.store.setPath(id, dir);
    await this.refresh(id);
    delete this.infos.get(id)!.job;
    this.notify();
  }

  /** Forgets the saved folder. The files stay where they are. */
  async forget(id: string): Promise<void> {
    this.repo(id);
    this.d.store.setPath(id, undefined);
    await this.refresh(id);
  }

  async setInstallRoot(root: string): Promise<void> {
    this.d.store.setRoot(root);
    await this.refreshAll();
  }
}
