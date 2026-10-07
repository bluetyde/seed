import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Residual 1 of the E2 exit review (accepted by the user on 2026-10-06 and carried into E3): `RunManager` is a low-level primitive. The
// only production code that builds one is the guarded dispatcher and the host control in src/core. A CLI, an MCP server or the desktop
// shell that built a manager itself would bypass the policy gate, the oracle check and the admission journal. This test fails if one does.
// A type-only import (`import type { RunOutcome } from ".../runManager"`) builds nothing and is allowed.

const SOURCE = /\.(?:ts|tsx|js|cjs|mjs)$/;
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const FROM_RUN_MANAGER = String.raw`["'][^"'\n]*runManager(?:\.[a-z]+)?["']`;

/** Why a source text builds or loads the run manager, or null when it does not. */
export function runManagerUse(text: string): string | null {
  const code = stripComments(text);
  if (/\bRunManager\b/.test(code)) return "names RunManager";
  const loads = [
    new RegExp(String.raw`\bimport\s+(?!type\b)[^;]*?\bfrom\s+${FROM_RUN_MANAGER}`),
    new RegExp(String.raw`\bimport\s+${FROM_RUN_MANAGER}`),
    new RegExp(String.raw`\bexport\s+(?!type\b)[^;]*?\bfrom\s+${FROM_RUN_MANAGER}`),
    new RegExp(String.raw`\brequire\s*\(\s*${FROM_RUN_MANAGER}\s*\)`),
    new RegExp(String.raw`\bimport\s*\(\s*${FROM_RUN_MANAGER}\s*\)`),
  ];
  return loads.some((re) => re.test(code)) ? "loads the runManager module" : null;
}

/** Every source file under `dirs` (relative to `root`) that uses the run manager, with the reason. */
export function findRunManagerUse(root: string, dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE.test(e.name)) {
        const why = runManagerUse(readFileSync(p, "utf8"));
        if (why) found.push(`${relative(root, p).split("\\").join("/")}: ${why}`);
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return found.sort();
}

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("production entry points do not build a RunManager (E2 residual 1)", () => {
  it("nothing under src/cli, src/mcp or src/main names or loads it", () => {
    expect(findRunManagerUse(join(__dirname, ".."), ["src/cli", "src/mcp", "src/main", "src/preload", "src/renderer"])).toEqual([]);
  });

  it("the guarded paths in src/core do build one (so the scan is looking at something real)", () => {
    const core = findRunManagerUse(join(__dirname, ".."), ["src/core"]);
    expect(core.filter((l) => l.startsWith("src/core/runDispatcher.ts") || l.startsWith("src/core/hostControl.ts"))).toHaveLength(2);
  });
});

describe("the scan itself", () => {
  const use = (text: string) => runManagerUse(text);

  it.each([
    ["a new manager", 'const m = new RunManager({ projectRoot: r });'],
    ["a value import", 'import { RunManager } from "../core/runManager";'],
    ["an import of anything else from the module", 'import { sha } from "../core/runManager";'],
    ["a default or namespace import", 'import * as rm from "../core/runManager";'],
    ["a side-effect import", 'import "../core/runManager";'],
    ["a re-export", 'export { RunManager } from "../core/runManager";'],
    ["a require", 'const { RunManager: R } = require("../core/runManager");'],
    ["a dynamic import", 'const m = await import("../core/runManager.js");'],
    ["a multi-line import", 'import {\n  RunOutcome,\n  helper,\n} from "../core/runManager";'],
    ["the class name in a type position", "let m: RunManager | undefined;"],
  ])("flags %s", (_name, text) => {
    expect(use(text)).not.toBeNull();
  });

  it.each([
    ["a type-only import", 'import type { RunOutcome } from "../core/runManager";'],
    ["a comment that mentions it", "// RunManager is a primitive, see run-dispatcher.md\nconst x = 1;"],
    ["a block comment that mentions it", "/* new RunManager() would bypass the gate */\nconst x = 1;"],
    ["an unrelated module", 'import { RunDispatcher } from "../core/runDispatcher";'],
    ["a similar identifier", "const myRunManagerLike = 1; const RunManagerFactory = 2;"],
  ])("does not flag %s", (_name, text) => {
    expect(use(text)).toBeNull();
  });

  it("walks nested folders and reports the file and the reason", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-structure-"));
    tmp.push(root);
    mkdirSync(join(root, "src", "cli", "deep"), { recursive: true });
    mkdirSync(join(root, "src", "mcp"), { recursive: true });
    writeFileSync(join(root, "src", "cli", "deep", "bad.ts"), 'import { RunManager } from "../../core/runManager";\n');
    writeFileSync(join(root, "src", "cli", "ok.ts"), 'import type { RunOutcome } from "../core/runManager";\n');
    writeFileSync(join(root, "src", "mcp", "bad.cjs"), 'const m = require("../core/runManager");\n');
    writeFileSync(join(root, "src", "mcp", "notes.md"), "RunManager\n");
    expect(findRunManagerUse(root, ["src/cli", "src/mcp"])).toEqual(["src/cli/deep/bad.ts: names RunManager", "src/mcp/bad.cjs: loads the runManager module"]);
  });

  it("a folder that does not exist is not an error", () => {
    expect(findRunManagerUse(join(tmpdir(), "seed-no-such-folder-xyz"), ["src/cli"])).toEqual([]);
  });
});
