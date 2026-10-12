// At startup the host looks at the process-owner records a previous host left behind (runtime contract, "Process ownership"; acceptance R4 and R5):
//  - a worker the dead host started is stopped, but only when the process now running under that pid is provably the SAME process (pid and start identity);
//  - a record whose pid now belongs to some other process (a reused pid) is stale: it authorizes nothing, and that process is left alone;
//  - a host that is still alive is not a dead host: its records are left alone;
//  - a server that was only attached (the host never started it) has no record and is never touched.
// Everything that touches a process or a distro is injected, so the rules are tested against fake processes.

import { execFile, spawn } from "node:child_process";
import { mayActOn, type ProcessIdentity } from "./components";
import { identityOf, linuxIdentity } from "./processIdentity";
import type { OwnerRecord, OwnerStore } from "./ownerStore";

export type Worker = NonNullable<OwnerRecord["worker"]>;

export type RecoveryOutcome =
  | "host-alive"        // the host that wrote it is still running: not ours to touch
  | "standalone"        // supervised by the app itself: never stopped by SEED
  | "no-worker"         // the host died before it started a worker
  | "already-gone"      // the worker is no longer running
  | "terminated"        // same pid and start identity: stopped, and confirmed gone
  | "stale-identity"    // the pid now belongs to a different process: nothing was stopped
  | "kill-failed";      // identity matched, the stop was tried, the process is still there

export type RecoveryReport = {
  results: { launchId: string; outcome: RecoveryOutcome; pid?: number; detail?: string }[];
  unreadable: { file: string; reason: string }[];
};

export type RecoveryDeps = {
  /** The identity of the process now running under this pid (null: nothing runs there). A worker in a WSL distro is looked up inside the distro. */
  workerIdentity: (worker: Worker) => Promise<ProcessIdentity | null>;
  /** The identity of the host process that wrote a record. */
  hostIdentity: (pid: number) => Promise<ProcessIdentity | null>;
  /** Stops the worker and everything it started. Only called after the identity matched. */
  killWorker: (worker: Worker) => Promise<void>;
};

function exec(command: string, args: string[], timeoutMs = 10000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (e, stdout) => resolve({ ok: !e, stdout: String(stdout ?? "") })));
}

/** The identity of a process inside a WSL distro, from its /proc entry and the distro's boot id. */
export async function wslIdentityOf(distro: string, pid: number): Promise<ProcessIdentity | null> {
  const stat = await exec("wsl.exe", ["-d", distro, "--exec", "cat", `/proc/${pid}/stat`]);
  const boot = await exec("wsl.exe", ["-d", distro, "--exec", "cat", "/proc/sys/kernel/random/boot_id"]);
  if (!stat.ok || !boot.ok) return null;
  const id = linuxIdentity(stat.stdout, boot.stdout);
  return id ? { pid, startIdentity: id } : null;
}

function killNativeTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.once("exit", () => resolve());
      k.once("error", () => resolve());
      return;
    }
    // A worker started by the host is a process-group leader (the host spawns it detached): stop the group, then the process if the group is gone.
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    resolve();
  });
}

export const defaultRecoveryDeps: RecoveryDeps = {
  workerIdentity: (w) => (w.via === "wsl" && w.distro ? wslIdentityOf(w.distro, w.identity.pid) : identityOf(w.identity.pid)),
  hostIdentity: (pid) => identityOf(pid),
  killWorker: async (w) => {
    if (w.via === "wsl" && w.distro) { await exec("wsl.exe", ["-d", w.distro, "--exec", "kill", "-9", String(w.identity.pid)]); return; }
    await killNativeTree(w.identity.pid);
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Looks at every record the store holds and settles it. A record that ends `stopped` is removed; a worker that could not be stopped keeps its record, marked
 * `orphaned`, so the next start tries again and a person can see it. Nothing here throws for one bad record: the others are still settled.
 */
export async function recoverOwners(store: OwnerStore, deps: RecoveryDeps = defaultRecoveryDeps, opts: { settleMs?: number } = {}): Promise<RecoveryReport> {
  const listing = store.list();
  const report: RecoveryReport = { results: [], unreadable: listing.unreadable };
  for (const rec of listing.records) {
    const add = (outcome: RecoveryOutcome, detail?: string, pid?: number) => report.results.push({ launchId: rec.launchId, outcome, ...(pid ? { pid } : {}), ...(detail ? { detail } : {}) });
    try {
      if (rec.state === "stopped") { store.remove(rec.launchId); continue; }
      if (rec.supervisor === "standalone") { add("standalone", "the app supervises itself; SEED does not stop it"); continue; }
      // A host that is still running (another SEED window, or this very host) wrote this record: it is not abandoned.
      const host = await deps.hostIdentity(rec.host.pid);
      if (mayActOn(rec.host, host)) { add("host-alive", undefined, rec.host.pid); continue; }
      const worker = rec.worker;
      if (!worker) { store.remove(rec.launchId); add("no-worker", "the host stopped before it started a worker"); continue; }
      const now = await deps.workerIdentity(worker);
      if (now === null) { store.remove(rec.launchId); add("already-gone", undefined, worker.identity.pid); continue; }
      if (!mayActOn(worker.identity, now)) {
        // The pid is alive but it is not the process that was recorded: the record is old and authorizes nothing.
        store.remove(rec.launchId);
        add("stale-identity", `pid ${worker.identity.pid} is now a different process (${now.startIdentity}, recorded ${worker.identity.startIdentity}); left running`, worker.identity.pid);
        continue;
      }
      store.mark(rec.launchId, "stopping");
      await deps.killWorker(worker);
      await sleep(opts.settleMs ?? 200);
      const after = await deps.workerIdentity(worker);
      if (after === null || !mayActOn(worker.identity, after)) { store.remove(rec.launchId); add("terminated", undefined, worker.identity.pid); }
      else { store.mark(rec.launchId, "orphaned"); add("kill-failed", `pid ${worker.identity.pid} is still running after the stop`, worker.identity.pid); }
    } catch (e) {
      add("kill-failed", `could not settle this record: ${(e as Error).message}`);
    }
  }
  return report;
}
