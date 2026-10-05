import { fork } from "node:child_process";
import { join } from "node:path";
import type { DispatchRequest } from "../core/runDispatcher";
import { runFromHostFile } from "../core/fileRunHost";
import type { RunOutcome } from "../core/runManager";

/** A detached, per-call owner survives a client's termination of the MCP process. */
export function supervisedRun(hostConfig: string, request: DispatchRequest): Promise<RunOutcome> {
  return new Promise(resolve => {
    let replied = false;
    const failure = () => { if (!replied) { replied = true; resolve({ ok: false, errors: [{ code: "E_INTERNAL", field: "", message: "run supervisor disconnected without a reply; inspect host records before retrying", source: "seed" }] }); } };
    const child = fork(join(__dirname, "supervisor.js"), [], { detached: true, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SEED_HOST_CONFIG: hostConfig } });
    child.once("error", failure); child.once("exit", failure);
    child.once("message", value => { if (!replied) { replied = true; resolve(value as RunOutcome); } });
    child.send(request, error => { if (error) failure(); });
  });
}
if (require.main === module) {
  // IPC disconnect does not cancel an admitted host operation. Its timers/children own its lifetime.
  process.once("message", async request => {
    const outcome = await runFromHostFile(process.env.SEED_HOST_CONFIG ?? "", request);
    if (process.connected && process.send) {
      process.send(outcome, () => { if (process.connected) process.disconnect?.(); });
    }
  });
}
