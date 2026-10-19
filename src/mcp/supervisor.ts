import { fork } from "node:child_process";
import { join } from "node:path";
import type { DispatchRequest } from "../core/runDispatcher";
import { runFromHostFile } from "../core/fileRunHost";
import { replayFromHostFile, type ReplayOutcome, type ReplayRequest } from "../core/replayHost";
import { installFromHost, type InstallRequestOutcome } from "../core/installHost";
import type { RunOutcome } from "../core/runManager";

type Verb = "run" | "replay" | "install";

/** A detached, per-call owner survives a client's termination of the MCP process. Used for every call that starts a calculation. */
function supervised<T>(hostEnv: Record<string, string>, verb: Verb, request: unknown): Promise<T> {
  return new Promise(resolve => {
    let replied = false;
    const failure = () => {
      if (!replied) {
        replied = true;
        resolve({
          ok: false,
          errors: [
            {
              code: "E_INTERNAL",
              field: "",
              message: "run supervisor disconnected without a reply; inspect host records before retrying",
              source: "seed",
            },
          ],
        } as T);
      }
    };
    const child = fork(join(__dirname, "supervisor.js"), [], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...hostEnv },
    });
    child.once("error", failure);
    child.once("exit", failure);
    child.once("message", value => {
      if (!replied) {
        replied = true;
        resolve(value as T);
      }
    });
    child.send({ verb, request }, error => {
      if (error) failure();
    });
  });
}
export function supervisedRun(hostConfig: string, request: DispatchRequest): Promise<RunOutcome> {
  return supervised<RunOutcome>({ SEED_HOST_CONFIG: hostConfig }, "run", request);
}
export function supervisedReplay(hostConfig: string, request: ReplayRequest): Promise<ReplayOutcome> {
  return supervised<ReplayOutcome>({ SEED_HOST_CONFIG: hostConfig }, "replay", request);
}
/** An install is long and must finish even if the client closes the MCP process: it runs in the same kind of detached owner. */
export function supervisedInstall(installHostConfig: string, request: unknown): Promise<InstallRequestOutcome> {
  return supervised<InstallRequestOutcome>({ SEED_INSTALL_HOST_CONFIG: installHostConfig }, "install", request);
}
if (require.main === module) {
  // IPC disconnect does not cancel an admitted host operation. Its timers/children own its lifetime.
  process.once("message", async (message: { verb?: Verb; request?: unknown }) => {
    const file = process.env.SEED_HOST_CONFIG ?? "";
    const outcome =
      message?.verb === "install"
        ? await installFromHost(process.env.SEED_INSTALL_HOST_CONFIG ?? "", message.request)
        : message?.verb === "replay"
          ? await replayFromHostFile(file, message.request)
          : await runFromHostFile(file, message?.request);
    if (process.connected && process.send) {
      process.send(outcome, () => {
        if (process.connected) process.disconnect?.();
      });
    }
  });
}
