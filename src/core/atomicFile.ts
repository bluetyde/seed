import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(absPath: string, data: string): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${absPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    // the contents reach the disk before the rename makes them the file: a power failure leaves the old file or the new one, not a hole
    const fd = openSync(tmpPath, "wx");
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore unlink error and rethrow the original error
    }
    throw err;
  }
}

export function appendLine(absPath: string, line: string): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  appendFileSync(absPath, line + "\n", "utf8");
}
