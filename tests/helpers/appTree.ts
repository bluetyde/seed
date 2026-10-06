// A fingerprint of an app's own folder, to prove that driving the app through its SEED adapter leaves the app untouched (E2 exit:
// "standalone launch of the app unchanged by its adapter"). Every file counts by relative path, size and modification time, except
// the folders an app rebuilds by itself whenever it runs (version control, installed packages, interpreter caches).
//
// The app's own developers (often another session on this machine) edit its source while these tests run, and an edit is not the
// adapter's doing. So an edit to a file that git tracks is tolerated; what an adapter or runner writing into its own folder would
// produce still fails: a file added or removed, or a change to a file git does not track.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache"]);

export function appTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.set(relative(root, p).split("\\").join("/"), `${s.size}:${Math.trunc(s.mtimeMs)}`);
      }
    }
  };
  walk(root);
  return out;
}

/** The files git tracks in the folder (empty when it is not a git checkout, so nothing is tolerated). */
export function trackedFiles(root: string): Set<string> {
  const r = spawnSync("git", ["-c", "safe.directory=*", "-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? new Set(r.stdout.split("\0").filter(Boolean)) : new Set();
}

/** What changed between two fingerprints, as readable lines (empty when nothing did). A changed file in `tolerated` is not reported. */
export function treeChanges(before: Map<string, string>, after: Map<string, string>, tolerated: Set<string> = new Set()): string[] {
  const lines: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) lines.push(`added ${k}`);
    else if (before.get(k) !== v && !tolerated.has(k)) lines.push(`changed ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) lines.push(`removed ${k}`);
  return lines.sort();
}
