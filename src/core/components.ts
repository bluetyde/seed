import fs from "node:fs";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

/**
 * Runtime and component contract (W2, docs/runtime-contract.md). Pure: it reads no file the caller did not pass in,
 * starts nothing and writes nothing. The installer (W4) and the process manager (W3) will call it; until then it
 * is exercised by fake manifests only.
 */

export type Platform = { os: "windows" | "macos" | "linux"; arch: "x64" | "arm64"; via?: "native" | "wsl" };
export type Artifact = { id: string; url?: string; sha256: string; downloadBytes: number; expandedBytes: number; archive: string };
export type Component = {
  id: string;
  version: string;
  kind: "core" | "addon" | "library";
  title: string;
  description?: string;
  platforms: Platform[];
  appVersions?: { min: string; max?: string };
  dependsOn?: { component: string; min?: string }[];
  conflicts?: string[];
  capabilities: string[];
  artifacts: Artifact[];
  dataRefs?: { id: string; sha256: string }[];
  license: { spdx: string; noticesSha256?: string; sourceOffer?: boolean };
  /** v0.2: record kinds this component makes, and needs (see packages.ts); library components `satisfy` catalog prerequisites. */
  produces?: { record: string; version: number }[];
  consumes?: { record: string; minVersion: number; maxVersion?: number }[];
  satisfies?: string[];
};
export type Manifest = { schema: "seed.component-manifest/0.1" | "seed.component-manifest/0.2"; app: string; recipeRevision: string; components: Component[] };
export type Installed = {
  app: string;
  component: string;
  version: string;
  origin: "managed" | "adopted";
  location: string;
  manifestSha256: string;
  artifactSha256?: string[];
  selectedByUser: boolean;
  installedAt: string;
  previous?: { version: string; location: string };
};
export type TxState =
  | "queued" | "preflight" | "staging" | "verifying" | "activating" | "ready"
  | "removing" | "removed" | "cancelled" | "failed" | "interrupted";
export type Transaction = {
  id: string;
  operation: "install" | "update" | "remove";
  app: string;
  component: string;
  from?: string;
  to?: string;
  state: TxState;
  startedAt: string;
  reason?: string;
  owner?: { pid: number; startIdentity: string; host?: string };
};
export type InstallState = { schema: "seed.install-state/0.1"; installs: Installed[]; transaction?: Transaction };

export const COMPONENT_ERROR_CODES = [
  "E_SCHEMA_INVALID",
  "E_COMPONENT_UNKNOWN",
  "E_COMPONENT_CYCLE",
  "E_COMPONENT_DEPENDENCY",
  "E_COMPONENT_NOT_SELECTABLE",
  "E_COMPONENT_PLATFORM",
  "E_COMPONENT_APP_VERSION",
  "E_COMPONENT_CONFLICT",
  "E_COMPONENT_REQUIRED_BY",
  "E_COMPONENT_IN_USE",
  "E_COMPONENT_CORE",
  "E_ADOPTED_PROTECTED",
  "E_OFFLINE_MISSING",
  "E_DISK_SPACE",
  "E_RECORD_UNKNOWN",
  "E_RECORD_VERSION",
  "E_RECORD_NO_PRODUCER",
  "E_RECORD_AMBIGUOUS"
] as const;
export type ComponentErrorCode = (typeof COMPONENT_ERROR_CODES)[number];
export type ComponentError = { code: ComponentErrorCode; component?: string; field?: string; message: string };
const fail = (errors: ComponentError[]) => ({ ok: false as const, errors });

// ---- schema validation -------------------------------------------------------------------------------------------

const schemaDir = path.join(__dirname, "..", "..", "schema");
let validators: Record<"manifest" | "state" | "owner" | "registry", ValidateFunction> | null = null;
function load() {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(schemaDir, f), "utf8")) as object;
  ajv.addSchema(read("common.schema.json"));
  ajv.addSchema(read("component-manifest.schema.json"));
  ajv.addSchema(read("record-kinds.schema.json"));
  ajv.addSchema(read("process-owner.schema.json"));
  ajv.addSchema(read("install-state.schema.json"));
  const get = (name: string) => ajv.getSchema(`https://seed.invalid/schema/${name}.schema.json`) as ValidateFunction;
  validators = { manifest: get("component-manifest"), state: get("install-state"), owner: get("process-owner"), registry: get("record-kinds") };
  return validators;
}
function schemaErrors(v: ValidateFunction, value: unknown): ComponentError[] | null {
  if (v(value)) return null;
  return (v.errors ?? []).map((e) => ({
    code: "E_SCHEMA_INVALID" as const,
    field: e.instancePath || "/",
    message: `${e.instancePath || "/"} ${e.message ?? "is invalid"}`
  }));
}

/** Compare dotted versions `a.b.c`; negative if a < b. Assumes the schema pattern has been checked. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A manifest the host may act on: valid against the schema and consistent (ids, dependencies, kinds). */
export function validateManifest(value: unknown): { ok: true; manifest: Manifest } | { ok: false; errors: ComponentError[] } {
  const bad = schemaErrors(load().manifest, value);
  if (bad) return fail(bad);
  const m = value as Manifest;
  const errors: ComponentError[] = [];
  const byId = new Map<string, Component>();
  for (const c of m.components) {
    if (byId.has(c.id)) errors.push({ code: "E_SCHEMA_INVALID", component: c.id, field: "/components", message: `component ${c.id} is listed twice` });
    byId.set(c.id, c);
  }
  if (!m.components.some((c) => c.kind === "core")) {
    errors.push({ code: "E_COMPONENT_CORE", field: "/components", message: "a manifest needs at least one core component" });
  }
  for (const c of m.components) {
    const seen = new Set<string>();
    for (const a of c.artifacts) {
      if (seen.has(a.id)) errors.push({ code: "E_SCHEMA_INVALID", component: c.id, field: "/artifacts", message: `artifact ${a.id} is listed twice in ${c.id}` });
      seen.add(a.id);
      if (a.expandedBytes < a.downloadBytes && a.archive !== "none") {
        errors.push({ code: "E_SCHEMA_INVALID", component: c.id, field: "/artifacts", message: `artifact ${a.id} expands to less than it downloads` });
      }
    }
    if (c.appVersions?.max !== undefined && compareVersions(c.appVersions.min, c.appVersions.max) > 0) {
      errors.push({ code: "E_COMPONENT_APP_VERSION", component: c.id, field: "/appVersions", message: `${c.id}: appVersions.min is above max` });
    }
    for (const d of c.dependsOn ?? []) {
      const dep = byId.get(d.component);
      if (dep === undefined) {
        errors.push({ code: "E_COMPONENT_DEPENDENCY", component: c.id, field: "/dependsOn", message: `${c.id} depends on ${d.component}, which the manifest does not list` });
        continue;
      }
      if (d.component === c.id) errors.push({ code: "E_COMPONENT_CYCLE", component: c.id, message: `${c.id} depends on itself` });
      if (c.kind === "core" && dep.kind !== "core" && dep.kind !== "library") {
        errors.push({ code: "E_COMPONENT_DEPENDENCY", component: c.id, field: "/dependsOn", message: `core component ${c.id} may not depend on the add-on ${dep.id}` });
      }
      if (d.min !== undefined && compareVersions(dep.version, d.min) < 0) {
        errors.push({ code: "E_COMPONENT_DEPENDENCY", component: c.id, field: "/dependsOn", message: `${c.id} needs ${dep.id} ${d.min} or later; the manifest has ${dep.version}` });
      }
    }
    for (const x of c.conflicts ?? []) {
      if (!byId.has(x)) errors.push({ code: "E_COMPONENT_UNKNOWN", component: c.id, field: "/conflicts", message: `${c.id} conflicts with ${x}, which the manifest does not list` });
    }
  }
  for (const c of m.components) {
    const where = (f: string) => ({ component: c.id, field: f });
    if (c.consumes !== undefined) {
      if (c.kind !== "addon") errors.push({ code: "E_COMPONENT_DEPENDENCY", ...where("/consumes"), message: `${c.id}: only an add-on may need another app's record; a core component must run without any package, and a library is only a dependency` });
      const seenC = new Set<string>();
      for (const r of c.consumes) {
        if (seenC.has(r.record)) errors.push({ code: "E_SCHEMA_INVALID", ...where("/consumes"), message: `${c.id} consumes ${r.record} twice` });
        seenC.add(r.record);
        if (r.maxVersion !== undefined && r.maxVersion < r.minVersion) errors.push({ code: "E_RECORD_VERSION", ...where("/consumes"), message: `${c.id}: maxVersion of ${r.record} is below its minVersion` });
      }
    }
    if (c.produces !== undefined) {
      if (c.kind === "library") errors.push({ code: "E_COMPONENT_DEPENDENCY", ...where("/produces"), message: `${c.id}: a library only supports other components; it does not make records` });
      const seenP = new Set<string>();
      for (const r of c.produces) {
        const key = `${r.record}@${r.version}`;
        if (seenP.has(key)) errors.push({ code: "E_SCHEMA_INVALID", ...where("/produces"), message: `${c.id} produces ${key} twice` });
        seenP.add(key);
      }
    }
    if (c.satisfies !== undefined) {
      if (c.kind !== "library") errors.push({ code: "E_COMPONENT_DEPENDENCY", ...where("/satisfies"), message: `${c.id}: only a library component can satisfy a catalog prerequisite` });
      if (new Set(c.satisfies).size !== c.satisfies.length) errors.push({ code: "E_SCHEMA_INVALID", ...where("/satisfies"), message: `${c.id} lists a prerequisite twice` });
    }
  }
  const cycle = findCycle(byId);
  if (cycle) errors.push({ code: "E_COMPONENT_CYCLE", component: cycle[0], message: `dependency cycle: ${cycle.join(" -> ")}` });
  return errors.length ? fail(errors) : { ok: true, manifest: m };
}

function findCycle(byId: Map<string, Component>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d.component) || d.component === id) continue;
      const c = visit(d.component);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of [...byId.keys()].sort()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

/** An install-state file the host may act on: schema valid, one record per component, a transaction that matches its operation. */
export function validateInstallState(value: unknown): { ok: true; state: InstallState } | { ok: false; errors: ComponentError[] } {
  const bad = schemaErrors(load().state, value);
  if (bad) return fail(bad);
  const s = value as InstallState;
  const errors: ComponentError[] = [];
  const seen = new Set<string>();
  for (const i of s.installs) {
    const key = `${i.app}/${i.component}`;
    if (seen.has(key)) errors.push({ code: "E_SCHEMA_INVALID", component: i.component, field: "/installs", message: `${key} is recorded twice` });
    seen.add(key);
  }
  const t = s.transaction;
  if (t) {
    const removeStates: TxState[] = ["queued", "preflight", "removing", "removed", "cancelled", "failed", "interrupted"];
    const installStates: TxState[] = ["queued", "preflight", "staging", "verifying", "activating", "ready", "cancelled", "failed", "interrupted"];
    if (t.operation === "remove" ? !removeStates.includes(t.state) : !installStates.includes(t.state)) {
      errors.push({ code: "E_SCHEMA_INVALID", field: "/transaction/state", message: `state ${t.state} does not belong to the ${t.operation} operation` });
    }
    if (t.operation !== "remove" && t.to === undefined) errors.push({ code: "E_SCHEMA_INVALID", field: "/transaction/to", message: "an install or update names the version it installs" });
    if (t.operation !== "install" && t.from === undefined) errors.push({ code: "E_SCHEMA_INVALID", field: "/transaction/from", message: "an update or removal names the version it replaces" });
  }
  return errors.length ? fail(errors) : { ok: true, state: s };
}

export type RecordKind = { record: string; version: number; owner: string; status: "planned" | "defined"; wireSchema?: string; schemaSha256?: string; summary: string; manual: string };
export type RecordRegistry = { schema: "seed.record-kinds/0.1"; kinds: RecordKind[] };

/** The registry of record kinds (record-kinds.json): valid against the schema, one entry per record and version, and a `defined` kind pins its schema by hash. */
export function validateRecordKinds(value: unknown): { ok: true; registry: RecordRegistry } | { ok: false; errors: ComponentError[] } {
  const bad = schemaErrors(load().registry, value);
  if (bad) return fail(bad);
  const r = value as RecordRegistry;
  const errors: ComponentError[] = [];
  const seen = new Set<string>();
  for (const k of r.kinds) {
    const key = `${k.record}@${k.version}`;
    if (seen.has(key)) errors.push({ code: "E_SCHEMA_INVALID", field: "/kinds", message: `${key} is registered twice` });
    seen.add(key);
    if (k.status === "defined" && (k.wireSchema === undefined || k.schemaSha256 === undefined)) {
      errors.push({ code: "E_SCHEMA_INVALID", field: "/kinds", message: `${key} is defined, so it names its wire schema and pins the schema's hash` });
    }
  }
  return errors.length ? fail(errors) : { ok: true, registry: r };
}

/** A process-owner record the host may act on. */
export function validateProcessOwner(value: unknown): { ok: true } | { ok: false; errors: ComponentError[] } {
  const bad = schemaErrors(load().owner, value);
  return bad ? fail(bad) : { ok: true };
}

// ---- selection ----------------------------------------------------------------------------------------------------

export type Step = { component: string; action: "install" | "update" | "keep"; from?: string; to: string; selectedByUser: boolean };
export type SelectionPlan = {
  ok: true;
  steps: Step[];
  /** What this selection would add, for the user to see before anything is downloaded. */
  cost: { downloadBytes: number; expandedBytes: number };
};

export type SelectionRequest = {
  manifest: Manifest;
  installed: readonly Installed[];
  /** Add-on ids the user chose. Core components are always included. */
  select: readonly string[];
  platform: Platform;
  appVersion: string;
  /** sha256 of artifacts already in the offline cache. */
  cache?: ReadonlySet<string>;
  /** True when nothing may be fetched. */
  offline?: boolean;
  freeBytes?: number;
};

export function eligible(c: Component, platform: Platform, appVersion: string): ComponentError | null {
  const ok = c.platforms.some((p) => p.os === platform.os && p.arch === platform.arch && (p.via === undefined || platform.via === undefined || p.via === platform.via));
  if (!ok) return { code: "E_COMPONENT_PLATFORM", component: c.id, message: `${c.id} is not available for ${platform.os} ${platform.arch}${platform.via ? ` (${platform.via})` : ""}` };
  const v = c.appVersions;
  if (v && (compareVersions(appVersion, v.min) < 0 || (v.max !== undefined && compareVersions(appVersion, v.max) > 0))) {
    return { code: "E_COMPONENT_APP_VERSION", component: c.id, message: `${c.id} supports app versions ${v.min}${v.max ? ` to ${v.max}` : " and later"}; this app is ${appVersion}` };
  }
  return null;
}

/**
 * What installing a selection would do: the components in dependency order (dependencies first), which are new,
 * updated or already there, and the download and disk cost. A refusal names the component. Nothing is chosen for the
 * user: optional components appear only when listed in `select`; their library dependencies come with them.
 */
export function resolveSelection(req: SelectionRequest): SelectionPlan | { ok: false; errors: ComponentError[] } {
  const byId = new Map(req.manifest.components.map((c) => [c.id, c]));
  const errors: ComponentError[] = [];
  const asked = new Set<string>();
  for (const id of req.select) {
    const c = byId.get(id);
    if (!c) errors.push({ code: "E_COMPONENT_UNKNOWN", component: id, message: `${id} is not a component of ${req.manifest.app}` });
    else if (c.kind === "library") errors.push({ code: "E_COMPONENT_NOT_SELECTABLE", component: id, message: `${id} is a library; it is installed only as a dependency` });
    else asked.add(id);
  }
  if (errors.length) return fail(errors);
  for (const c of req.manifest.components) if (c.kind === "core") asked.add(c.id);

  // closure through dependencies, deterministic order: dependencies first, then by id
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    const c = byId.get(id);
    if (!c) {
      errors.push({ code: "E_COMPONENT_DEPENDENCY", component: id, message: `${id} is needed but the manifest does not list it` });
      return;
    }
    for (const d of [...(c.dependsOn ?? [])].sort((a, b) => a.component.localeCompare(b.component))) place(d.component);
    order.push(id);
  };
  for (const id of [...asked].sort()) place(id);
  if (errors.length) return fail(errors);

  for (const id of order) {
    const bad = eligible(byId.get(id)!, req.platform, req.appVersion);
    if (bad) errors.push(bad);
  }
  const staying = new Set<string>([...order, ...req.installed.filter((i) => i.app === req.manifest.app).map((i) => i.component)]);
  for (const id of order) {
    for (const x of byId.get(id)!.conflicts ?? []) {
      if (staying.has(x)) errors.push({ code: "E_COMPONENT_CONFLICT", component: id, message: `${id} conflicts with ${x}, which is selected or installed` });
    }
  }
  if (errors.length) return fail(errors);

  const here = (id: string) => req.installed.find((i) => i.app === req.manifest.app && i.component === id);
  const steps: Step[] = [];
  let download = 0, expanded = 0;
  const missing: string[] = [];
  for (const id of order) {
    const c = byId.get(id)!;
    const have = here(id);
    const wants = (req.manifest.components.flatMap((x) => (order.includes(x.id) ? x.dependsOn ?? [] : [])).filter((d) => d.component === id));
    const need = wants.reduce<string | undefined>((m, d) => (d.min !== undefined && (m === undefined || compareVersions(d.min, m) > 0) ? d.min : m), undefined);
    if (have && compareVersions(have.version, c.version) >= 0) {
      steps.push({ component: id, action: "keep", from: have.version, to: have.version, selectedByUser: have.selectedByUser || asked.has(id) });
      continue;
    }
    if (have && have.origin === "adopted") {
      if (need !== undefined && compareVersions(have.version, need) < 0) {
        errors.push({ code: "E_ADOPTED_PROTECTED", component: id, message: `${id} ${have.version} was adopted, not installed by SEED, and ${need} is needed; SEED will not replace it` });
      } else {
        steps.push({ component: id, action: "keep", from: have.version, to: have.version, selectedByUser: have.selectedByUser || asked.has(id) });
      }
      continue;
    }
    steps.push({ component: id, action: have ? "update" : "install", ...(have ? { from: have.version } : {}), to: c.version, selectedByUser: asked.has(id) });
    for (const a of c.artifacts) {
      expanded += a.expandedBytes;
      if (req.cache?.has(a.sha256)) continue;
      if (req.offline) missing.push(`${id}/${a.id}`);
      download += a.downloadBytes;
    }
  }
  if (missing.length) errors.push({ code: "E_OFFLINE_MISSING", message: `not in the offline cache: ${missing.join(", ")}` });
  if (req.freeBytes !== undefined && expanded > req.freeBytes) {
    errors.push({ code: "E_DISK_SPACE", message: `needs ${expanded} bytes on disk, ${req.freeBytes} free` });
  }
  if (errors.length) return fail(errors);
  return { ok: true, steps, cost: { downloadBytes: download, expandedBytes: expanded } };
}

// ---- removal ------------------------------------------------------------------------------------------------------

export type RemovalPlan = {
  ok: true;
  /** `unregister` for an adopted component: SEED forgets it and leaves its files. */
  steps: { component: string; action: "remove" | "unregister" }[];
  kept: { component: string; neededBy: string[] }[];
};

/**
 * What removing one add-on would do. Refused while another installed component needs it or a job uses it; a core
 * component is never removed on its own. Libraries SEED installed only for it go with it unless something else still
 * needs them; an adopted component is never deleted, only unregistered.
 */
export function planRemoval(req: {
  manifest: Manifest;
  installed: readonly Installed[];
  remove: string;
  /** Component ids that a running launch or job uses (from the process-owner records). */
  inUse?: ReadonlySet<string>;
}): RemovalPlan | { ok: false; errors: ComponentError[] } {
  const byId = new Map(req.manifest.components.map((c) => [c.id, c]));
  const mine = req.installed.filter((i) => i.app === req.manifest.app);
  const target = mine.find((i) => i.component === req.remove);
  const def = byId.get(req.remove);
  if (!target || !def) return fail([{ code: "E_COMPONENT_UNKNOWN", component: req.remove, message: `${req.remove} is not installed` }]);
  if (def.kind === "core") return fail([{ code: "E_COMPONENT_CORE", component: req.remove, message: `${req.remove} is part of the core app; remove the app instead` }]);
  if (def.kind === "library") return fail([{ code: "E_COMPONENT_NOT_SELECTABLE", component: req.remove, message: `${req.remove} is a library; it goes when nothing needs it` }]);

  const needers = mine
    .filter((i) => i.component !== req.remove)
    .filter((i) => (byId.get(i.component)?.dependsOn ?? []).some((d) => d.component === req.remove))
    .map((i) => i.component)
    .sort();
  if (needers.length) return fail([{ code: "E_COMPONENT_REQUIRED_BY", component: req.remove, message: `${req.remove} is needed by ${needers.join(", ")}` }]);

  const going = new Set([req.remove]);
  // libraries and add-ons SEED installed on the way (not chosen by the user), no longer needed once the target goes
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of mine) {
      if (going.has(i.component) || i.selectedByUser || i.origin === "adopted") continue;
      const kind = byId.get(i.component)?.kind;
      if (kind === "core") continue;
      const stillNeeded = mine.some((o) => !going.has(o.component) && o.component !== i.component && (byId.get(o.component)?.dependsOn ?? []).some((d) => d.component === i.component));
      if (!stillNeeded) {
        going.add(i.component);
        grew = true;
      }
    }
  }
  const busy = [...going].filter((id) => req.inUse?.has(id)).sort();
  if (busy.length) return fail([{ code: "E_COMPONENT_IN_USE", component: busy[0], message: `${busy.join(", ")} in use by a running launch or job; try again when it ends` }]);

  const steps = [...going].sort().map((id) => ({ component: id, action: (mine.find((i) => i.component === id)!.origin === "adopted" ? "unregister" : "remove") as "remove" | "unregister" }));
  const kept = mine
    .filter((i) => !going.has(i.component) && byId.get(i.component)?.kind === "library")
    .map((i) => ({
      component: i.component,
      neededBy: mine.filter((o) => !going.has(o.component) && (byId.get(o.component)?.dependsOn ?? []).some((d) => d.component === i.component)).map((o) => o.component).sort()
    }))
    .filter((k) => k.neededBy.length > 0);
  return { ok: true, steps, kept };
}

// ---- transactions -------------------------------------------------------------------------------------------------

const INSTALL_FLOW: Record<string, TxState[]> = {
  queued: ["preflight", "cancelled"],
  preflight: ["staging", "failed", "cancelled"],
  staging: ["verifying", "failed", "cancelled", "interrupted"],
  verifying: ["activating", "failed", "cancelled", "interrupted"],
  // the switch of the active version is one atomic step: no cancel once it starts
  activating: ["ready", "failed", "interrupted"]
};
const REMOVE_FLOW: Record<string, TxState[]> = {
  queued: ["preflight", "cancelled"],
  preflight: ["removing", "failed", "cancelled"],
  removing: ["removed", "failed", "interrupted"]
};
const TERMINAL: ReadonlySet<TxState> = new Set(["ready", "removed", "cancelled", "failed", "interrupted"]);

export function isTerminal(s: TxState): boolean {
  return TERMINAL.has(s);
}
export function canTransition(operation: Transaction["operation"], from: TxState, to: TxState): boolean {
  const flow = operation === "remove" ? REMOVE_FLOW : INSTALL_FLOW;
  return Object.hasOwn(flow, from) && flow[from]!.includes(to);
}

export type Recovery = {
  state: TxState;
  /** What the host does next. `discard-staging`: delete the half-staged version; the active one is untouched. */
  action: "none" | "wait" | "discard-staging" | "mark-ready" | "mark-removed" | "keep-installed";
  active?: string;
};

/**
 * What to make of a transaction found at startup. A transaction whose owner is still alive is left alone. A
 * transaction whose owner is gone is `interrupted`, with one exception that is decided by the file system, not by the
 * record: if the switch of the active version had already happened, the install is ready. The previous version stays
 * the active one in every other case.
 */
export function recoverTransaction(tx: Transaction, found: { ownerAlive: boolean; activeVersion?: string; present?: boolean }): Recovery {
  if (isTerminal(tx.state)) return { state: tx.state, action: "none", ...(found.activeVersion ? { active: found.activeVersion } : {}) };
  if (found.ownerAlive) return { state: tx.state, action: "wait", ...(found.activeVersion ? { active: found.activeVersion } : {}) };
  if (tx.operation === "remove") {
    if (found.present === false) return { state: "removed", action: "mark-removed" };
    return { state: "interrupted", action: "keep-installed", ...(found.activeVersion ? { active: found.activeVersion } : {}) };
  }
  if (tx.state === "activating" && tx.to !== undefined && found.activeVersion === tx.to) {
    return { state: "ready", action: "mark-ready", active: tx.to };
  }
  const keep = tx.from ?? found.activeVersion;
  return { state: "interrupted", action: tx.state === "queued" || tx.state === "preflight" ? "none" : "discard-staging", ...(keep ? { active: keep } : {}) };
}

// ---- process ownership --------------------------------------------------------------------------------------------

export type ProcessIdentity = { pid: number; startIdentity: string };

/**
 * May SEED act (stop, clean up) on the process now at `pid`? Only if it is the very process the record named: same
 * pid AND same start identity. A reused pid, or a record with no identity to compare, authorizes nothing.
 */
export function mayActOn(recorded: ProcessIdentity, current: ProcessIdentity | null): boolean {
  if (current === null || !recorded.startIdentity || !current.startIdentity) return false;
  return recorded.pid === current.pid && recorded.startIdentity === current.startIdentity;
}
