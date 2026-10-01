// The catalog: the repositories SEED can install and update, with what each one needs. Shipped as catalog.json. The catalog is trusted
// data (it names commands that run on this computer), so it is only ever read from the shipped file, never from the network or an app.

import * as fs from "node:fs";

export interface Prerequisite {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Plain-language fix shown when the check fails. */
  fix: string;
  /** "install": must pass before SEED installs. "run": only needed to run the app, so a failure is a warning. */
  when: "install" | "run";
}

export interface InstallStep {
  label: string;
  /** Folder inside the repository. */
  cwd: string;
  command: string;
  args: string[];
  /** Files that, when an update changes them, make this step run again. Empty: only on first install. */
  watch: string[];
}

export interface CatalogRepo {
  id: string;
  name: string;
  url: string;
  branch: string;
  folder: string;
  isPrivate: boolean;
  notes?: string;
  /** Places this computer may already hold a clone, offered as "use this one". Never used without the user's click. */
  candidates: string[];
  prerequisites: Prerequisite[];
  steps: InstallStep[];
}

export interface Catalog {
  repos: CatalogRepo[];
  problems: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** allowLocal lets a test catalog point at local folders instead of GitHub addresses. */
export function parseCatalog(text: string, allowLocal = false): Catalog {
  const problems: string[] = [];
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { return { repos: [], problems: [`catalog.json is not valid JSON: ${(e as Error).message}`] }; }
  if (!Array.isArray(raw?.repos)) return { repos: [], problems: ['catalog.json needs a "repos" array'] };
  const repos: CatalogRepo[] = [];
  const seen = new Set<string>();
  raw.repos.forEach((o: any, i: number) => {
    const label = `repos[${i}]${typeof o?.id === "string" ? ` (${o.id})` : ""}`;
    const bad = (m: string) => { problems.push(`${label}: ${m}`); };
    if (typeof o !== "object" || o === null) return bad("must be an object");
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return bad("id must be lowercase letters, digits and dashes");
    if (seen.has(o.id)) return bad("duplicate id");
    if (typeof o.name !== "string" || !o.name) return bad("name is required");
    if (typeof o.url !== "string" || (!allowLocal && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(o.url))) return bad("url must be an https://github.com/<owner>/<repo> address");
    if (typeof o.branch !== "string" || !/^[\w./-]+$/.test(o.branch)) return bad("branch is required");
    if (typeof o.folder !== "string" || !/^[\w.-]+$/.test(o.folder)) return bad("folder must be a plain folder name");
    const cand = o.candidates ?? [];
    if (!strings(cand)) return bad("candidates must be a list of paths");
    const pre: Prerequisite[] = [];
    for (const p of o.prerequisites ?? []) {
      if (typeof p?.id !== "string" || typeof p.label !== "string" || typeof p.command !== "string" || !strings(p.args) || typeof p.fix !== "string") return bad("a prerequisite needs id, label, command, args and fix");
      pre.push({ id: p.id, label: p.label, command: p.command, args: p.args, fix: p.fix, when: p.when === "run" ? "run" : "install" });
    }
    const steps: InstallStep[] = [];
    for (const s of o.steps ?? []) {
      if (typeof s?.label !== "string" || typeof s.command !== "string" || !strings(s.args) || (s.cwd !== undefined && typeof s.cwd !== "string")) return bad("a step needs label, command and args");
      if (typeof s.cwd === "string" && (/^([a-zA-Z]:|[\\/])/.test(s.cwd) || s.cwd.split(/[\\/]/).includes(".."))) return bad("step cwd must stay inside the repository");
      steps.push({ label: s.label, cwd: s.cwd ?? ".", command: s.command, args: s.args, watch: strings(s.watch) ? s.watch : [] });
    }
    seen.add(o.id);
    repos.push({ id: o.id, name: o.name, url: o.url, branch: o.branch, folder: o.folder, isPrivate: o.private === true, ...(typeof o.notes === "string" ? { notes: o.notes } : {}), candidates: cand, prerequisites: pre, steps });
  });
  return { repos, problems };
}

export function loadCatalog(file: string, allowLocal = false): Catalog {
  return parseCatalog(fs.readFileSync(file, "utf-8"), allowLocal);
}
