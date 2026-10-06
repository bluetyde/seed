// A fingerprint of an app's own folder, to prove that driving the app through its SEED adapter leaves the app untouched (E2 exit:
// "standalone launch of the app unchanged by its adapter"). Every file counts by relative path, size and modification time, except
// the folders an app rebuilds by itself whenever it runs (version control, installed packages, interpreter caches).
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

/** What changed between two fingerprints, as readable lines (empty when nothing did). */
export function treeChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) lines.push(`added ${k}`);
    else if (before.get(k) !== v) lines.push(`changed ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) lines.push(`removed ${k}`);
  return lines.sort();
}
