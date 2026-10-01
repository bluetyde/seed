// The app registry: which apps the host can open and how to start them. Read from apps.json in the user's data folder, falling
// back to apps.default.json. Every field is checked; a bad entry is reported by name and skipped, never half-used.

import * as fs from "node:fs";

export interface StartSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AppEntry {
  id: string;
  name: string;
  icon: string;
  /** How to start the server. Absent: the host can only attach to a server that is already running (see attachUrl). */
  start?: StartSpec;
  /** Path on the server that answers once it is ready. */
  healthPath: string;
  /** What the tab loads, relative to the server. {token} is replaced by a per-launch random value. */
  urlPath: string;
  /** A server the user already runs. If it answers, the host uses it and never stops it. */
  attachUrl?: string;
  startTimeoutMs: number;
  /** The catalog entry that installs this app. {install} in start.cwd, start.args and start.env stands for its folder. */
  catalog?: string;
}

export interface RegistryResult {
  apps: AppEntry[];
  problems: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseRegistry(text: string): RegistryResult {
  const problems: string[] = [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { apps: [], problems: [`apps.json is not valid JSON: ${(e as Error).message}`] }; }
  const list = (raw as { apps?: unknown })?.apps;
  if (!Array.isArray(list)) return { apps: [], problems: ['apps.json needs an "apps" array'] };
  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const label = `apps[${i}]${typeof (item as any)?.id === "string" ? ` (${(item as any).id})` : ""}`;
    const bad = (msg: string) => { problems.push(`${label}: ${msg}`); };
    if (typeof item !== "object" || item === null) return bad("must be an object");
    const o = item as Record<string, any>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return bad("id must be lowercase letters, digits and dashes");
    if (seen.has(o.id)) return bad("duplicate id");
    if (typeof o.name !== "string" || !o.name.trim()) return bad("name is required");
    if (typeof o.healthPath !== "string" || !o.healthPath.startsWith("/")) return bad('healthPath must start with "/"');
    if (typeof o.urlPath !== "string" || !o.urlPath.startsWith("/")) return bad('urlPath must start with "/"');
    let start: StartSpec | undefined;
    if (o.start !== undefined) {
      const s = o.start;
      if (typeof s !== "object" || s === null || typeof s.command !== "string" || !s.command) return bad("start.command is required");
      if (!Array.isArray(s.args) || !s.args.every((a: unknown) => typeof a === "string")) return bad("start.args must be a list of strings");
      if (s.cwd !== undefined && (typeof s.cwd !== "string" || /['"\n\r]/.test(s.cwd))) return bad("start.cwd must be a path without quotes or line breaks");
      if (s.env !== undefined && (typeof s.env !== "object" || !Object.values(s.env).every((v) => typeof v === "string"))) return bad("start.env must map names to strings");
      start = { command: s.command, args: s.args, ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.env ? { env: s.env } : {}) };
    }
    if (o.attachUrl !== undefined) {
      try {
        const u = new URL(o.attachUrl);
        if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return bad("attachUrl must be http on this computer (127.0.0.1 or localhost)");
      } catch { return bad("attachUrl is not a URL"); }
    }
    if (!start && o.attachUrl === undefined) return bad("needs start or attachUrl, otherwise it cannot be opened");
    const timeout = o.startTimeoutMs === undefined ? 60_000 : o.startTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000) return bad("startTimeoutMs must be 1000 to 600000");
    if (o.catalog !== undefined && (typeof o.catalog !== "string" || !ID_RE.test(o.catalog))) return bad("catalog must be a catalog id");
    seen.add(o.id);
    apps.push({ ...(o.catalog ? { catalog: o.catalog } : {}), id: o.id, name: o.name, icon: typeof o.icon === "string" ? o.icon : "app", healthPath: o.healthPath, urlPath: o.urlPath, startTimeoutMs: timeout, ...(start ? { start } : {}), ...(o.attachUrl ? { attachUrl: o.attachUrl } : {}) });
  });
  return { apps, problems };
}

/** The user's file if present, otherwise the shipped defaults. A user file that fails to parse is reported, and the defaults are NOT silently used in its place. */
export function loadRegistry(userPath: string, defaultPath: string): RegistryResult & { source: string } {
  if (fs.existsSync(userPath)) return { ...parseRegistry(fs.readFileSync(userPath, "utf-8")), source: userPath };
  return { ...parseRegistry(fs.readFileSync(defaultPath, "utf-8")), source: defaultPath };
}

/**
 * Fills in {install} from where the app is installed. An entry that names a catalog app and has no install yet comes back with
 * missingInstall set (and no start command), so the host shows "install it" instead of trying to run a path that is not there.
 */
export function applyInstall(entry: AppEntry, dir: string | undefined): AppEntry & { missingInstall?: boolean } {
  if (!entry.catalog) return entry;
  if (!dir) { const { start: _drop, ...rest } = entry; return { ...rest, missingInstall: true }; }
  const sub = (s: string) => s.split("{install}").join(dir);
  if (!entry.start) return entry;
  const start: StartSpec = {
    command: entry.start.command, args: entry.start.args.map(sub),
    ...(entry.start.cwd ? { cwd: sub(entry.start.cwd) } : {}),
    ...(entry.start.env ? { env: Object.fromEntries(Object.entries(entry.start.env).map(([k, v]) => [k, sub(v)])) } : {}),
  };
  return { ...entry, start };
}
