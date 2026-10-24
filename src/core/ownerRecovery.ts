// At startup the host looks at the process-owner records a previous host left behind (runtime contract, "Process ownership"; acceptance R4 and R5):
//  - a worker the dead host started is stopped, but only when the process now running under that pid is provably the SAME process (pid and start identity);
//  - a record whose pid now belongs to some other process (a reused pid) is stale: it authorizes nothing, and that process is left alone;
//  - a host that is still alive is not a dead host: its records are left alone;
//  - a server that was only attached (the host never started it) has no record and is never touched.
// Everything that touches a process or a distro is injected, so the rules are tested against fake processes.

import { execFile, spawn } from "node:child_process";
import { mayActOn, type ProcessIdentity } from "./components";
import { identityOfStrict, linuxIdentity } from "./processIdentity";
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
  // the boot id is read first: when the distro itself can not be asked, that is "unknown" (an error), never "the process is gone"
  const boot = await exec("wsl.exe", ["-d", distro, "--exec", "cat", "/proc/sys/kernel/random/boot_id"]);
  if (!boot.ok) throw new Error(`the distro ${distro} could not be asked about pid ${pid}`);
  const stat = await exec("wsl.exe", ["-d", distro, "--exec", "cat", `/proc/${pid}/stat`]);
  if (!stat.ok) return null;
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
  workerIdentity: (w) => {
    if (w.via === "wsl") return w.distro ? wslIdentityOf(w.distro, w.identity.pid) : Promise.reject(new Error("a WSL worker record names no distro"));
    return identityOfStrict(w.identity.pid);
  },
  hostIdentity: (pid) => identityOfStrict(pid),
  killWorker: async (w) => {
    if (w.via === "wsl" && !w.distro) throw new Error("a WSL worker record names no distro");
    // the worker's process group first (a worker started by the host leads one, so its children go with it), then the process itself
    if (w.via === "wsl" && w.distro) { await exec("wsl.exe", ["-d", w.distro, "--exec", "sh", "-c", `kill -9 -- -${w.identity.pid} 2>/dev/null; kill -9 ${w.identity.pid} 2>/dev/null; true`]); return; }
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
    let marked = false;
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
      // once more, as late as possible: the window in which a pid can be reused is only this short (a handle would close it; neither Node nor wsl.exe gives one)
      const again = await deps.workerIdentity(worker);
      if (again === null || !mayActOn(worker.identity, again)) { store.remove(rec.launchId); add("already-gone", "the worker ended while the record was being settled", worker.identity.pid); continue; }
      marked = true;
      store.mark(rec.launchId, "stopping");
      await deps.killWorker(worker);
      await sleep(opts.settleMs ?? 200);
      const after = await deps.workerIdentity(worker);
      if (after === null || !mayActOn(worker.identity, after)) { store.remove(rec.launchId); add("terminated", undefined, worker.identity.pid); }
      else { store.mark(rec.launchId, "orphaned"); add("kill-failed", `pid ${worker.identity.pid} is still running after the stop`, worker.identity.pid); }
    } catch (e) {
      let note = "";
      // a stop that was started and did not finish is not "in progress" on disk: the next start and a person must see that it failed
      if (marked) { try { store.mark(rec.launchId, "orphaned"); } catch (m) { note = `; the record could not be marked orphaned either: ${(m as Error).message}`; } }
      add("kill-failed", `could not settle this record: ${(e as Error).message}${note}`);
    }
  }
  return report;
}
