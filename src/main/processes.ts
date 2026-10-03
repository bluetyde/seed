// Starts, watches and stops the app servers. The host stops only what it started: a server that was already running (attachUrl)
// is used as is and left alone. No Electron here, so the lifecycle is tested against a real child process.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import type { AppEntry } from "./apps";

export interface Running {
  url: string;
  port: number | undefined;
  /** True when the host started the server and will stop it. */
  owned: boolean;
}

export interface Deps {
  spawn: typeof nodeSpawn;
  freePort: () => Promise<number>;
  fetchStatus: (url: string) => Promise<number>;
  kill: (child: ChildProcess) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export class AppStartError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.name = "AppStartError";
    this.output = output;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function fetchStatus(url: string): Promise<number> {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return r.status;
}

/** Stops a child and everything it started. On Windows that needs taskkill; the plain kill would leave grandchildren (vite, wsl) running. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once("exit", () => resolve());
    if (process.platform === "win32") nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 5000).unref();
  });
}

const defaultDeps: Deps = { spawn: nodeSpawn, freePort, fetchStatus, kill: killTree, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

interface Entry { child?: ChildProcess; running: Running; output: string[]; exited: boolean; ready?: boolean; code?: number | null }

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(port|token)\}/g, (_, k: string) => vars[k] ?? "");

export class ProcessManager {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, { promise: Promise<Running>; controller: AbortController }>();
  /** Called when a server the host started stops on its own (crash, closed from outside). */
  onExit: (appId: string, code: number | null) => void = () => {};

  constructor(private readonly deps: Deps = defaultDeps) {}

  running(appId: string): Running | undefined {
    const e = this.entries.get(appId);
    return e && !e.exited ? e.running : undefined;
  }

  output(appId: string): string {
    return (this.entries.get(appId)?.output ?? []).join("");
  }

  /** The server for an app: the one already running, an attachable one, or a new one. Concurrent calls for one app share one start. */
  ensure(app: AppEntry): Promise<Running> {
    const pending = this.pending.get(app.id);
    if (pending) {
      // A reopen waits for cancellation cleanup, never shares the cancelled launch.
      if (pending.controller.signal.aborted) return pending.promise.then(
        () => this.ensure(app), () => this.ensure(app),
      );
      return pending.promise;
    }
    const have = this.running(app.id);
    if (have) return Promise.resolve(have);
    const controller = new AbortController();
    const promise = this.startOrAttach(app, controller.signal).finally(() => this.pending.delete(app.id));
    this.pending.set(app.id, { promise, controller });
    return promise;
  }

  async stop(appId: string): Promise<void> {
    const pending = this.pending.get(appId);
    if (pending) {
      pending.controller.abort();
      // The opening caller receives its startup error; stop waits for its cleanup.
      await pending.promise.then(() => undefined, () => undefined);
      return;
    }
    await this.stopEntry(appId);
  }

  private async stopEntry(appId: string): Promise<void> {
    const e = this.entries.get(appId);
    this.entries.delete(appId);
    if (e?.child && e.running.owned && !e.exited) {
      e.exited = true;
      await this.deps.kill(e.child);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.entries.keys(), ...this.pending.keys()])].map((id) => this.stop(id)));
  }

  private async healthy(base: string, app: AppEntry): Promise<boolean> {
    try { const status = await this.deps.fetchStatus(base + app.healthPath); return status >= 200 && status < 300; } catch { return false; }
  }

  private async startOrAttach(app: AppEntry, signal: AbortSignal): Promise<Running> {
    const checkCancelled = () => {
      if (signal.aborted) throw new AppStartError(`${app.name} startup was cancelled.`, this.output(app.id));
    };
    try {
      checkCancelled();
      const token = randomBytes(16).toString("hex");
      if (app.attachUrl) {
        const base = app.attachUrl.replace(/\/$/, "");
        if (await this.healthy(base, app)) {
          checkCancelled();
          const running: Running = { url: base + fill(app.urlPath, { token }), port: undefined, owned: false };
          this.entries.set(app.id, { running, output: [], exited: false });
          return running;
        }
      }
      checkCancelled();
      if (!app.start) throw new AppStartError(`${app.name} is not running at ${app.attachUrl ?? "any address"} and has no start command in the registry.`, "");
      const port = await this.deps.freePort();
      checkCancelled();
      const vars = { port: String(port), token };
      const child = this.deps.spawn(fill(app.start.command, vars), app.start.args.map((a) => fill(a, vars)), {
        cwd: app.start.cwd,
        env: { ...process.env, ...Object.fromEntries(Object.entries(app.start.env ?? {}).map(([k, v]) => [k, fill(v, vars)])) },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const entry: Entry = { child, running: { url: `http://127.0.0.1:${port}${fill(app.urlPath, vars)}`, port, owned: true }, output: [], exited: false };
      this.entries.set(app.id, entry);
      const keep = (b: Buffer) => { entry.output.push(b.toString()); if (entry.output.length > 400) entry.output.shift(); };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      let spawnError: string | undefined;
      child.once("error", (e) => { spawnError = e.message; });
      child.once("exit", (code) => {
        const wasRunning = !entry.exited && entry.ready;
        entry.exited = true;
        entry.code = code;
        if (wasRunning) this.onExit(app.id, code);
      });

      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + app.startTimeoutMs;
      while (Date.now() < deadline) {
        checkCancelled();
        if (spawnError) { throw new AppStartError(`Could not start ${app.name}: ${spawnError}`, spawnError); }
        if (entry.exited) {
          const out = entry.output.join("");
          this.entries.delete(app.id);
          throw new AppStartError(`${app.name} stopped before it was ready (exit code ${entry.code ?? "unknown"}).`, out);
        }
        const healthy = await this.healthy(base, app);
        checkCancelled();
        if (healthy && !entry.exited) { entry.ready = true; return entry.running; }
        await this.deps.sleep(250);
      }
      const out = entry.output.join("");
      throw new AppStartError(`${app.name} did not answer on port ${port} within ${Math.round(app.startTimeoutMs / 1000)} s.`, out);
    } catch (error) {
      await this.stopEntry(app.id);
      throw error;
    }
  }
}
