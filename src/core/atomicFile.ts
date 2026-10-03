import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(absPath: string, data: string): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${absPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmpPath, data, "utf8");
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
