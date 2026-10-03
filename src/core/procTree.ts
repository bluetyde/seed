import { spawn } from "node:child_process";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr && nodeErr.code === "ESRCH") {
      return false;
    }
    if (nodeErr && nodeErr.code === "EPERM") {
      return true;
    }
    throw err;
  }
}

/**
 * Stops a process and everything it started. Returns true when the pid is observed dead within 5 s, false when it is
 * still alive (the caller must say so; the process is not reported as stopped). Only an invalid pid throws.
 * Errors from the kill attempt itself (taskkill missing, EPERM) are not thrown: the liveness check after the attempt is the
 * single source of truth for the result.
 */
export async function killTree(pid: number): Promise<boolean> {
  if (pid === 0 || pid === 1 || pid === process.pid || pid < 0 || !Number.isInteger(pid)) {
    throw new RangeError(`Refusing to kill pid ${pid}`);
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const cp = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      cp.once("error", () => resolve());
      cp.once("close", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ESRCH or EPERM: the check below decides.
        }
      }
    }
  }

  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}
