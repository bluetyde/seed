import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isAlive, killTree } from "../../src/core/procTree";

export interface TempProject {
  root: string;
  createFile: (relPath: string, content: string) => string;
  cleanup: () => Promise<void>;
  registerPid: (pid: number) => void;
}

export function createTempProject(prefix = "seed-test-proj-"): TempProject {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "models"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "studies"), { recursive: true });
  mkdirSync(join(root, "oracles"), { recursive: true });

  const pids = new Set<number>();

  const registerPid = (pid: number) => {
    if (pid > 1) {
      pids.add(pid);
    }
  };

  const createFile = (relPath: string, content: string): string => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  };

  const cleanup = async (): Promise<void> => {
    for (const pid of pids) {
      try {
        if (isAlive(pid)) {
          await killTree(pid);
        }
      } catch {
        // Ignore kill errors during cleanup
      }
    }
    pids.clear();

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore remove errors
    }
  };

  return { root, createFile, cleanup, registerPid };
}
