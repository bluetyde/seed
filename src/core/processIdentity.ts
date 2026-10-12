// A process is named by its pid AND the moment it started, because a pid alone can be reused (runtime contract, "Process ownership"; acceptance R5).
// Windows: the creation time. Linux: the boot id and the start time from /proc/<pid>/stat. macOS and others: `ps -o lstart=`.
// Every function returns null when the process is not there; nothing here throws for a missing process.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ProcessIdentity } from "./components";

function run(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/** From the text of /proc/<pid>/stat and the boot id; null when the text is not a stat line. Also used for a process inside a WSL distro. */
export function linuxIdentity(statText: string, bootId: string): string | null {
  // The command name is in parentheses and may hold spaces and parentheses: the fields start after the LAST closing parenthesis.
  const close = statText.lastIndexOf(")");
  if (close < 0) return null;
  const startTicks = statText.slice(close + 2).split(" ")[19]; // field 22 of the file; field 3 is the first after the name
  const boot = bootId.trim();
  if (!startTicks || !/^\d+$/.test(startTicks) || !boot) return null;
  return `linux:${boot}:${startTicks}`;
}

/** The start identity string of a process, or null when there is no such process. */
export async function startIdentityOf(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (platform === "win32") {
    // Get-Process fails for a pid that does not exist; the creation time is in UTC at full resolution so a reused pid never matches.
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { }`]);
    const text = r.stdout.trim();
    return text ? `win:${text}` : null;
  }
  if (platform === "linux") {
    try {
      return linuxIdentity(await readFile(`/proc/${pid}/stat`, "utf8"), await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
    } catch { return null; }
  }
  const r = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
  const text = r.stdout.trim().replace(/\s+/g, " ");
  return r.code === 0 && text ? `ps:${text}` : null;
}

/** The pid with its start identity, or null when the process is gone. */
export async function identityOf(pid: number): Promise<ProcessIdentity | null> {
  const startIdentity = await startIdentityOf(pid);
  return startIdentity ? { pid, startIdentity } : null;
}
