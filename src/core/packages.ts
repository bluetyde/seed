/**
 * Cross-app packages (docs/packages-cross-app.md). A package of one app can need a RECORD that a package of another app makes (RAFT's
 * burnup-dependent parameters need the depletion record that Studio's depletion package writes). The link is a file contract named in
 * the record-kinds registry, never a code import and never one app calling another. `resolveChain` turns "the user chose these add-ons"
 * into one plan across apps: every chosen add-on, the producers it needs (found in any app), their own dependencies, one total cost and
 * the one set of components a single grant must name. Pure: no file, no process, no network.
 */
import {
  compareVersions,
  eligible,
  resolveSelection,
  type ComponentError,
  type Installed,
  type Manifest,
  type Platform,
  type RecordRegistry,
  type Step
} from "./components";

export type SuiteStep = Step & { app: string };
export type ChainEdge = { consumer: string; record: string; minVersion: number; producer: string; how: "installed" | "chosen" | "added" };
export type ChainPlan = {
  ok: true;
  steps: SuiteStep[];
  chain: ChainEdge[];
  cost: { downloadBytes: number; expandedBytes: number };
  /** What one human grant must name for this plan: every component that would be installed or updated, with its app. */
  grant: { app: string; component: string }[];
};

const fail = (errors: ComponentError[]) => ({ ok: false as const, errors });
const key = (app: string, component: string) => `${app}/${component}`;

/** Every manifest of the suite is valid together: one manifest per app, every record named is registered, versions fall inside the registry. */
export function validateSuite(manifests: readonly Manifest[], registry: RecordRegistry): ComponentError[] {
  const errors: ComponentError[] = [];
  const apps = new Set<string>();
  const known = new Map<string, number[]>();
  for (const k of registry.kinds) known.set(k.record, [...(known.get(k.record) ?? []), k.version]);
  for (const m of manifests) {
    if (apps.has(m.app)) errors.push({ code: "E_SCHEMA_INVALID", message: `two manifests for the app ${m.app}` });
    apps.add(m.app);
    for (const c of m.components) {
      for (const p of c.produces ?? []) {
        if (!(known.get(p.record) ?? []).includes(p.version)) {
          errors.push({ code: known.has(p.record) ? "E_RECORD_VERSION" : "E_RECORD_UNKNOWN", component: key(m.app, c.id), message: `${key(m.app, c.id)} produces ${p.record} version ${p.version}, which is not in the record-kinds registry` });
        }
      }
      for (const r of c.consumes ?? []) {
        const versions = known.get(r.record);
        if (!versions) errors.push({ code: "E_RECORD_UNKNOWN", component: key(m.app, c.id), message: `${key(m.app, c.id)} needs ${r.record}, which is not in the record-kinds registry` });
        else if (!versions.some((v) => v >= r.minVersion && (r.maxVersion === undefined || v <= r.maxVersion))) {
          errors.push({ code: "E_RECORD_VERSION", component: key(m.app, c.id), message: `${key(m.app, c.id)} needs ${r.record} version ${r.minVersion}${r.maxVersion !== undefined ? ` to ${r.maxVersion}` : " or later"}; the registry has ${versions.join(", ")}` });
        }
      }
    }
  }
  // A cycle that cannot be avoided: each record has exactly one possible producer, and those producers need each other.
  const all = manifests.flatMap((m) => m.components.map((c) => ({ app: m.app, c })));
  const producersOf = (rec: { record: string; minVersion: number; maxVersion?: number }) =>
    all.filter(({ c }) => (c.produces ?? []).some((p) => p.record === rec.record && p.version >= rec.minVersion && (rec.maxVersion === undefined || p.version <= rec.maxVersion)));
  const edges = new Map<string, string[]>();
  for (const { app, c } of all) {
    const out: string[] = [];
    for (const d of c.dependsOn ?? []) out.push(key(app, d.component));
    for (const r of c.consumes ?? []) {
      const ps = producersOf(r);
      if (ps.length === 1) out.push(key(ps[0]!.app, ps[0]!.c.id));
    }
    edges.set(key(app, c.id), out);
  }
  const loop = findLoop(edges);
  if (loop) errors.push({ code: "E_COMPONENT_CYCLE", component: loop[0], message: `dependency cycle across apps: ${loop.join(" -> ")}` });
  return errors;
}

function findLoop(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (!edges.has(m)) continue;
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of [...edges.keys()].sort()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

export type ChainRequest = {
  manifests: readonly Manifest[];
  registry: RecordRegistry;
  installed: readonly Installed[];
  /** The add-ons the user chose, in any app. Cores are always included. */
  select: readonly { app: string; component: string }[];
  platform: Platform;
  /** The version of each app that is (or will be) installed. */
  appVersions: Readonly<Record<string, string>>;
  /** When more than one component could make a record: record id -> "app/component". Never guessed. */
  producerChoice?: Readonly<Record<string, string>>;
  cache?: ReadonlySet<string>;
  offline?: boolean;
  freeBytes?: number;
};

/**
 * The plan for a selection across apps. The user's add-ons come first; every record one of them needs is looked for among the producers
 * of all apps. A producer already installed, or already in the plan, costs nothing; otherwise the one candidate is added (with its own
 * app's core and dependencies), or the user must choose between several. A record no one makes is a refusal that names it.
 */
export function resolveChain(req: ChainRequest): ChainPlan | { ok: false; errors: ComponentError[] } {
  const invalid = validateSuite(req.manifests, req.registry);
  if (invalid.length) return fail(invalid);
  const byApp = new Map(req.manifests.map((m) => [m.app, m]));
  const userChose = new Set<string>();
  const wanted = new Map<string, Set<string>>(); // app -> add-on ids
  const errors: ComponentError[] = [];
  for (const s of req.select) {
    const m = byApp.get(s.app);
    const c = m?.components.find((x) => x.id === s.component);
    if (!m || !c) errors.push({ code: "E_COMPONENT_UNKNOWN", component: key(s.app, s.component), message: `${key(s.app, s.component)} is not a component of the suite` });
    else if (c.kind !== "addon") errors.push({ code: "E_COMPONENT_NOT_SELECTABLE", component: key(s.app, s.component), message: `${key(s.app, s.component)} is a ${c.kind}; only add-ons are chosen` });
    else {
      userChose.add(key(s.app, s.component));
      wanted.set(s.app, (wanted.get(s.app) ?? new Set()).add(s.component));
    }
  }
  if (errors.length) return fail(errors);

  const allComponents = req.manifests.flatMap((m) => m.components.map((c) => ({ app: m.app, c })));
  // An installed component stands for the manifest's only if it is at least that version: an older one may not make the record being asked for.
  const installedHere = (app: string, id: string, atLeast?: string) =>
    req.installed.some((i) => i.app === app && i.component === id && (atLeast === undefined || compareVersions(i.version, atLeast) >= 0));
  const chain: ChainEdge[] = [];
  const edges = new Map<string, string[]>();
  let plans = new Map<string, ReturnType<typeof resolveSelection>>();
  const addedByChain = new Set<string>(); // producers the chain brought in, as opposed to ones the user chose

  for (let round = 0; round < 64; round++) {
    plans = new Map();
    for (const [app, ids] of wanted) {
      const m = byApp.get(app)!;
      const version = req.appVersions[app];
      if (version === undefined) return fail([{ code: "E_COMPONENT_APP_VERSION", component: app, message: `no app version was given for ${app}` }]);
      plans.set(app, resolveSelection({ manifest: m, installed: req.installed, select: [...ids].sort(), platform: req.platform, appVersion: version, ...(req.cache ? { cache: req.cache } : {}), ...(req.offline ? { offline: req.offline } : {}) }));
    }
    for (const [app, p] of plans) if (!p.ok) return fail(p.errors.map((e) => ({ ...e, message: `${app}: ${e.message}` })));

    const inPlan = new Set<string>();
    for (const [app, p] of plans) if (p.ok) for (const s of p.steps) inPlan.add(key(app, s.component));

    let added = false;
    chain.length = 0;
    edges.clear();
    for (const [app, p] of plans) {
      if (!p.ok) continue;
      const m = byApp.get(app)!;
      for (const step of p.steps) {
        const comp = m.components.find((c) => c.id === step.component)!;
        const me = key(app, comp.id);
        edges.set(me, (comp.dependsOn ?? []).map((d) => key(app, d.component)));
        for (const need of comp.consumes ?? []) {
          const candidates = allComponents.filter(({ c }) => (c.produces ?? []).some((q) => q.record === need.record && q.version >= need.minVersion && (need.maxVersion === undefined || q.version <= need.maxVersion)));
          const usable = candidates.filter(({ app: a, c }) => eligible(c, req.platform, req.appVersions[a] ?? "0.0.0") === null || installedHere(a, c.id, c.version));
          const info = req.registry.kinds.find((k) => k.record === need.record);
          const done = (how: ChainEdge["how"], who: string) => {
            chain.push({ consumer: me, record: need.record, minVersion: need.minVersion, producer: who, how });
            edges.get(me)!.push(who);
          };
          const inst = usable.find(({ app: a, c }) => installedHere(a, c.id, c.version));
          if (inst) {
            done("installed", key(inst.app, inst.c.id));
            continue;
          }
          const there = usable.find(({ app: a, c }) => inPlan.has(key(a, c.id)));
          if (there) {
            done(addedByChain.has(key(there.app, there.c.id)) ? "added" : "chosen", key(there.app, there.c.id));
            continue;
          }
          if (usable.length === 0) {
            return fail([{ code: "E_RECORD_NO_PRODUCER", component: me, message: `${me} needs a ${need.record} record (version ${need.minVersion}${need.maxVersion !== undefined ? ` to ${need.maxVersion}` : " or later"}), and no package that makes one is available for this platform.${info ? ` By hand: ${info.manual}` : ""}` }]);
          }
          const chosenKey = req.producerChoice?.[need.record];
          const pick = chosenKey !== undefined ? usable.find(({ app: a, c }) => key(a, c.id) === chosenKey) : usable.length === 1 ? usable[0] : undefined;
          if (!pick) {
            const names = usable.map(({ app: a, c }) => key(a, c.id)).sort();
            return fail([{ code: "E_RECORD_AMBIGUOUS", component: me, message: chosenKey !== undefined ? `${chosenKey} does not make ${need.record} here; choose one of ${names.join(", ")}` : `${me} needs ${need.record}, which ${names.join(" or ")} can make; choose one (producerChoice)` }]);
          }
          if (pick.c.kind === "addon") wanted.set(pick.app, (wanted.get(pick.app) ?? new Set()).add(pick.c.id));
          else if (!wanted.has(pick.app)) wanted.set(pick.app, new Set()); // a core producer: the app's core comes with it
          addedByChain.add(key(pick.app, pick.c.id));
          done("added", key(pick.app, pick.c.id));
          added = true;
        }
      }
    }
    if (!added) break;
    if (round === 63) return fail([{ code: "E_COMPONENT_CYCLE", message: "the chain did not settle" }]);
  }

  const loop = findLoop(new Map([...edges].map(([k, v]) => [k, v])));
  if (loop) return fail([{ code: "E_COMPONENT_CYCLE", component: loop[0], message: `dependency cycle across apps: ${loop.join(" -> ")}` }]);

  // order: a component after everything it depends on and after the producers it consumes
  const steps: SuiteStep[] = [];
  const staged = new Map<string, SuiteStep>();
  let download = 0, expanded = 0;
  for (const [app, p] of plans) {
    if (!p.ok) continue;
    download += p.cost.downloadBytes;
    expanded += p.cost.expandedBytes;
    for (const s of p.steps) {
      const k = key(app, s.component);
      const chosen = userChose.has(k);
      staged.set(k, { ...s, app, selectedByUser: s.action === "keep" ? s.selectedByUser : chosen });
    }
  }
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const k of staged.keys()) { indeg.set(k, 0); out.set(k, []); }
  for (const [from, tos] of edges) for (const to of tos) {
    if (staged.has(from) && staged.has(to) && from !== to) { out.get(to)!.push(from); indeg.set(from, (indeg.get(from) ?? 0) + 1); }
  }
  const ready = [...indeg].filter(([, n]) => n === 0).map(([k]) => k).sort();
  while (ready.length) {
    const k = ready.shift()!;
    steps.push(staged.get(k)!);
    for (const next of (out.get(k) ?? []).sort()) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) { ready.push(next); ready.sort(); }
    }
  }
  if (req.freeBytes !== undefined && expanded > req.freeBytes) {
    return fail([{ code: "E_DISK_SPACE", message: `needs ${expanded} bytes on disk, ${req.freeBytes} free` }]);
  }
  const grant = steps.filter((s) => s.action !== "keep").map((s) => ({ app: s.app, component: s.component }));
  return { ok: true, steps, chain: chain.slice().sort((a, b) => (a.consumer + a.record).localeCompare(b.consumer + b.record)), cost: { downloadBytes: download, expandedBytes: expanded }, grant };
}

/** The library components that would fulfil a catalog prerequisite (for example conda-env), in any app, so SEED can offer to install it. */
export function componentsSatisfying(manifests: readonly Manifest[], prerequisiteId: string): { app: string; component: string }[] {
  return manifests.flatMap((m) => m.components.filter((c) => (c.satisfies ?? []).includes(prerequisiteId)).map((c) => ({ app: m.app, component: c.id }))).sort((a, b) => key(a.app, a.component).localeCompare(key(b.app, b.component)));
}

