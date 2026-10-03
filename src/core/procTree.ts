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
 * Stops a process and everything it started. Returns true when the root process (and, on POSIX, its whole process group)
 * is observed dead within 5 s and, on Windows, taskkill reported the tree as killed; false otherwise (the caller must say so). Only an invalid pid throws.
 * Errors from the kill attempt itself (taskkill missing, EPERM) are not thrown: the liveness check after the attempt is the
 * single source of truth for the result.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killTree(pid: number): Promise<boolean> {
  if (pid === 0 || pid === 1 || pid === process.pid || pid < 0 || !Number.isInteger(pid)) {
    throw new RangeError(`Refusing to kill pid ${pid}`);
  }

  let taskkillOk = true;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const cp = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // Exit 0 = tree killed, 128 = no such process. Anything else (or a spawn error) means descendants may survive
      // even if the root process is gone, so the result must not claim success.
      cp.once("error", () => {
        taskkillOk = false;
        resolve();
      });
      cp.once("close", (code) => {
        taskkillOk = code === 0 || code === 128;
        resolve();
      });
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
  const stillAlive = (): boolean => isAlive(pid) || (process.platform !== "win32" && groupAlive(pid));
  while (stillAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !stillAlive() && taskkillOk;
}
