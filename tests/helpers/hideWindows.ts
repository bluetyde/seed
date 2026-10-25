// Test setup (vitest `setupFiles`). On Windows a console program started by a child_process call without `windowsHide: true` opens its own console window,
// and that window takes the focus: typing and games are interrupted while a suite runs. Many of the suite's calls (git, node, powershell, wsl) do not say
// `windowsHide`, so this makes it the default for every call a test file makes. A call that says `windowsHide: false` itself is left as it says.
import { createRequire, syncBuiltinESMExports } from "node:module";

// the CommonJS exports object of the module: the ES namespace of a built-in module cannot be assigned to
const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;

const FUNCTIONS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const;

/** The arguments of a child_process call with `windowsHide: true` added to its options (an options object is created where there is none). Pure. */
export function withHiddenWindow(args: unknown[]): unknown[] {
  const out = args.slice();
  const at = out.findIndex((x, i) => i > 0 && x !== null && typeof x === "object" && !Array.isArray(x));
  if (at > 0) {
    out[at] = { windowsHide: true, ...(out[at] as object) };
    return out;
  }
  // no options object: it goes after the command and its argument list, and before a callback
  out.splice(Array.isArray(out[1]) ? 2 : 1, 0, { windowsHide: true });
  return out;
}

let installed = false;
export function hideChildWindows(): void {
  // SEED_TEST_SHOW_WINDOWS=1 turns it off, to compare (the windows come back)
  if (installed || process.platform !== "win32" || process.env.SEED_TEST_SHOW_WINDOWS === "1") return;
  installed = true;
  const mutable = cp as Record<string, (...a: unknown[]) => unknown>;
  for (const name of FUNCTIONS) {
    const original = mutable[name];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) { return original.apply(this, withHiddenWindow(args)); };
    // keep what a caller may read off the function (promisify uses a custom symbol on exec and execFile)
    Object.setPrototypeOf(wrapped, original);
    for (const key of Object.getOwnPropertySymbols(original)) Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key)!);
    mutable[name] = wrapped;
  }
  syncBuiltinESMExports();
}

hideChildWindows();
