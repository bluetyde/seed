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

export async function killTree(pid: number): Promise<void> {
  if (pid === 0 || pid === 1 || pid === process.pid || pid < 0 || !Number.isInteger(pid)) {
    throw new RangeError(`Refusing to kill pid ${pid}`);
  }

  if (process.platform === "win32") {
    try {
      const cp = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      cp.on("error", () => {});
    } catch {
      // Ignore spawn errors
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr && nodeErr.code === "ESRCH") {
        try {
          process.kill(pid, "SIGKILL");
        } catch (err2: unknown) {
          const nodeErr2 = err2 as NodeJS.ErrnoException;
          if (!nodeErr2 || nodeErr2.code !== "ESRCH") {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
  }

  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
