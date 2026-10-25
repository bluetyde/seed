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

/**
 * Like `identityOf`, but a lookup that FAILED (the tool timed out or errored, /proc or the boot id could not be read) throws instead of answering null:
 * "no such process" and "could not find out" are different answers, and only the first may authorize treating a process as gone.
 */
export async function identityOfStrict(pid: number, platform: NodeJS.Platform = process.platform, runner: typeof run = run): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  let text: string | null;
  if (platform === "win32") {
    // no such process is an empty answer with exit 0; a process that exists but whose start time cannot be read (access denied) is exit 3, never "gone"
    const r = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { try { $p.StartTime.ToUniversalTime().ToString('o') } catch { exit 3 } }; exit 0`]);
    if (r.code !== 0) throw new Error(`the process lookup for pid ${pid} failed (exit ${r.code})`);
    const t = r.stdout.trim();
    text = t ? `win:${t}` : null;
  } else if (platform === "linux") {
    let stat: string;
    try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ESRCH") return null;
      throw new Error(`/proc/${pid}/stat could not be read: ${(e as Error).message}`);
    }
    const id = linuxIdentity(stat, await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
    if (!id) throw new Error(`/proc/${pid}/stat could not be read as a process line`);
    text = id;
  } else {
    const r = await runner("ps", ["-o", "lstart=", "-p", String(pid)]);
    const t = r.stdout.trim().replace(/\s+/g, " ");
    if (r.code === 0 && t) text = `ps:${t}`;
    else if (r.code === 1 && !t) text = null;
    else throw new Error(`the process lookup for pid ${pid} failed (exit ${r.code})`);
  }
  return text ? { pid, startIdentity: text } : null;
}

/** The pid with its start identity, or null when the process is gone. */
export async function identityOf(pid: number): Promise<ProcessIdentity | null> {
  const startIdentity = await startIdentityOf(pid);
  return startIdentity ? { pid, startIdentity } : null;
}
