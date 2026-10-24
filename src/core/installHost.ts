import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { installSelection, removeComponent, type ArtifactSource, type InstallEnv, type InstallOutcome } from "./componentInstaller";
import { eligible, resolveSelection, validateManifest, type ComponentError, type Manifest, type Platform } from "./components";
import { appendInstallRecord, inside, readHostJson, regularFile } from "./hostFiles";
import { httpsSource, type HttpsSourceOptions } from "./httpsSource";
import { evaluateInstallGate, foldGrants, issueInstallGrant, type Cost, type InstallDecision, type InstallGrant } from "./installGrant";
import { appendGrantEvent, readGrantLog } from "./installGrantStore";
import { readInstallState, verifiedCachedShas } from "./installStore";
import { OwnerStore } from "./ownerStore";
import type { Actor } from "./policy";
import type { TypedError } from "./validate";

/**
 * The host side of the install gate (docs/runtime-contract.md, "The install gate"). One trusted configuration file, `seed.install-host/0.1`,
 * written by a person outside every project and study, names who is acting, the install root, the state folder (grants and records), the
 * platform, and for each app its manifest file **with the hash that pins it** and the app version. A request names an app and the add-ons it wants and
 * nothing else: no manifest, no url, no command, no path. Everything a request does is one line in `installs.jsonl` of the state folder.
 */

type AppEntry = { manifestFile: string; manifestSha256: string; appVersion: string; artifactsDir?: string; downloads?: { hosts: string[] } };
export type InstallHostConfig = {
  schema: "seed.install-host/0.1";
  actor: Actor;
  installRoot: string;
  stateRoot: string;
  ownersFolder?: string;
  platform: Platform;
  apps: Record<string, AppEntry>;
};
export type InstallHostOpts = {
  now?: () => Date;
  env?: Partial<InstallEnv>;
  /** Test seam: extra options of the https source (a test certificate, a name lookup, shorter time limits). `allowedHosts` always comes from the configuration. */
  https?: Partial<Omit<HttpsSourceOptions, "allowedHosts">>;
  /** Test seam: runs between the first look at the grants and the moment the cost is counted under the lock (to let another request in between). */
  beforeAdmit?: () => void;
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, "../../schema/common.schema.json"), "utf8")));
const check = ajv.compile(JSON.parse(readFileSync(join(__dirname, "../../schema/install-host.schema.json"), "utf8")));

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });
const refuse = (errors: TypedError[]) => ({ ok: false as const, errors });
const fromComponent = (e: ComponentError): TypedError => err(e.code, e.component ? `/components/${e.component}` : e.field ?? "", e.message);

type Host = { config: InstallHostConfig; manifests: Map<string, { manifest: Manifest; sha: string }> };

/** Reads and checks the configuration, and the manifest of each app asked for against its pin. Throws a message on any problem. */
function loadHost(file: string, apps: readonly string[] | "all"): Host {
  if (!isAbsolute(file)) throw Error("the install host configuration must be given by an absolute path");
  const raw = readHostJson(file);
  if (!check(raw)) throw Error("invalid seed.install-host/0.1 configuration: " + ajv.errorsText(check.errors));
  const config = structuredClone(raw) as InstallHostConfig;
  const paths = [config.installRoot, config.stateRoot, ...(config.ownersFolder ? [config.ownersFolder] : []), ...Object.values(config.apps).flatMap((a) => [a.manifestFile, ...(a.artifactsDir ? [a.artifactsDir] : [])])];
  if (paths.some((p) => !isAbsolute(p))) throw Error("every path of the install host configuration must be absolute");
  if (inside(config.installRoot, config.stateRoot) || inside(config.stateRoot, config.installRoot)) throw Error("the state folder and the install root must be separate folders");
  if (inside(config.installRoot, file) || inside(config.stateRoot, file)) throw Error("the host configuration must be outside the install root and the state folder");
  for (const a of Object.values(config.apps)) if (inside(config.installRoot, a.manifestFile)) throw Error("a manifest must be outside the install root");
  const manifests = new Map<string, { manifest: Manifest; sha: string }>();
  for (const name of apps === "all" ? Object.keys(config.apps) : apps) {
    const entry = config.apps[name];
    if (!entry) throw Error(`the app ${JSON.stringify(name)} is not in the install host configuration`);
    regularFile(entry.manifestFile);
    const bytes = readFileSync(entry.manifestFile);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== entry.manifestSha256) throw Error(`the manifest of ${name} does not match its pin (the file has ${sha}, the configuration pins ${entry.manifestSha256})`);
    const v = validateManifest(JSON.parse(bytes.toString("utf8")));
    if (!v.ok) throw Error(`the manifest of ${name} is not valid: ${v.errors.map((e) => e.message).join("; ")}`);
    if (v.manifest.app !== name) throw Error(`the manifest of ${name} is for the app ${v.manifest.app}`);
    manifests.set(name, { manifest: v.manifest, sha });
  }
  return { config, manifests };
}

function envFor(h: Host, app: string, opts: InstallHostOpts): InstallEnv {
  const entry = h.config.apps[app]!;
  const dir = entry.artifactsDir;
  const local: ArtifactSource | undefined = dir
    ? async (a, dest) => {
        const from = join(dir, a.id);
        regularFile(from);
        if (statSync(from).size > a.downloadBytes) throw Error(`${a.id} in the artifacts folder is larger than the manifest says`);
        copyFileSync(from, dest);
      }
    : undefined;
  const remote: ArtifactSource | undefined = entry.downloads ? httpsSource({ ...opts.https, allowedHosts: entry.downloads.hosts }) : undefined;
  // a file in the artifacts folder is used before any download; the url of the manifest is used only when the host configuration allows downloads
  const source: ArtifactSource | undefined = local || remote
    ? async (a, dest, signal) => {
        if (local && dir && existsSync(join(dir, a.id))) return local(a, dest, signal);
        if (remote) return remote(a, dest, signal);
        return local!(a, dest, signal);
      }
    : undefined;
  const inUse = h.config.ownersFolder
    ? () => new Set(new OwnerStore(h.config.ownersFolder!).list().records.filter((r) => r.state !== "stopped").map((r) => r.runtime.component))
    : undefined;
  return { root: h.config.installRoot, platform: h.config.platform, appVersion: entry.appVersion, ...(source ? { source } : {}), ...(inUse ? { inUse } : {}), ...(opts.now ? { now: opts.now } : {}), ...opts.env };
}

function guard<T>(fn: () => T): T | { ok: false; errors: TypedError[] } {
  try {
    return fn();
  } catch (e) {
    return refuse([err("E_SETUP_REQUIRED", "", e instanceof Error ? e.message : "the install host failed")]);
  }
}
async function guardAsync<T>(fn: () => Promise<T>): Promise<T | { ok: false; errors: TypedError[] }> {
  try {
    return await fn();
  } catch (e) {
    return refuse([err("E_SETUP_REQUIRED", "", e instanceof Error ? e.message : "the install host failed")]);
  }
}

function strictObject(request: unknown, allowed: string[]): Record<string, unknown> | TypedError {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return err("E_SCHEMA_INVALID", "", "the request is an object");
  const extra = Object.keys(request).find((k) => !allowed.includes(k));
  if (extra !== undefined) return err("E_SCHEMA_INVALID", `/${extra}`, `the request has only ${allowed.join(", ")}; not ${extra}`);
  return request as Record<string, unknown>;
}
const isIdList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((c) => typeof c === "string" && ID.test(c)) && new Set(v).size === v.length;
const zero: Cost = { downloadBytes: 0, expandedBytes: 0 };

// ---- the agent's verb: ask for an install ---------------------------------------------------------------------------------------------------

export type InstallRequestOutcome =
  | { ok: true; via: "human" | "grant" | "nothing-to-do"; grantId?: string; steps: { component: string; action: string; version: string }[]; cost: Cost }
  | { ok: false; errors: TypedError[]; completed?: { component: string; action: string; version: string }[] };

/**
 * `{requestId?, app, select}`: install the core of `app` and the add-ons in `select`. The configured actor is the one asking. A human is let
 * through; an agent or the system needs a grant that covers the app, every add-on asked for and the cost, and what the request costs is counted
 * against the grant's ceiling before anything is fetched.
 */
export async function installFromHost(file: string, request: unknown, opts: InstallHostOpts = {}): Promise<InstallRequestOutcome> {
  return guardAsync(async () => {
    const r = strictObject(request, ["requestId", "app", "select"]);
    if ("code" in r) return refuse([r as TypedError]);
    if (typeof r.app !== "string" || !ID.test(r.app)) return refuse([err("E_SCHEMA_INVALID", "/app", "app is the id of an app in the host configuration")]);
    if (!isIdList(r.select ?? [], 16)) return refuse([err("E_SCHEMA_INVALID", "/select", "select is a list of at most 16 different add-on ids")]);
    if (r.requestId !== undefined && (typeof r.requestId !== "string" || !REQUEST_ID.test(r.requestId))) return refuse([err("E_SCHEMA_INVALID", "/requestId", "requestId is letters, digits, dots, underscores and dashes")]);
    const app = r.app, select = (r.select ?? []) as string[];
    const requestId = (r.requestId as string | undefined) ?? randomBytes(8).toString("hex");
    const now = opts.now ?? (() => new Date());
    const h = loadHost(file, [app]);
    const { manifest, sha } = h.manifests.get(app)!;
    const actor = h.config.actor;
    const env = envFor(h, app, opts);
    const log = (event: Record<string, unknown>) => appendInstallRecord(h.config.stateRoot, { requestId, operation: "install_component", actor, app, select, ...event });

    // what the request would do, without doing it
    const installed = readInstallState(env.root);
    if (!installed.ok) { log({ phase: "refused", errors: installed.errors.map((e) => e.code) }); return refuse(installed.errors.map(fromComponent)); }
    const plan = resolveSelection({ manifest, installed: installed.state.installs, select, platform: env.platform, appVersion: env.appVersion, cache: await verifiedCachedShas(env.root), offline: !env.source });
    if (!plan.ok) { log({ phase: "refused", errors: plan.errors.map((e) => e.code) }); return refuse(plan.errors.map(fromComponent)); }
    const steps = plan.steps.map((s) => ({ component: s.component, action: s.action as string, version: s.to }));
    if (plan.steps.every((s) => s.action === "keep")) {
      log({ phase: "nothing-to-do" });
      return { ok: true as const, via: "nothing-to-do" as const, steps, cost: zero };
    }

    const gateReq = { operation: "install_component", actor, app, components: select, cost: plan.cost };
    let decision: InstallDecision = evaluateInstallGate(gateReq, foldGrants(readGrantLog(h.config.stateRoot).map((x) => x.event)), now());
    if (decision.allow && decision.via === "grant") {
      // the ceiling is spent under the lock, against the log as it is at that moment
      opts.beforeAdmit?.();
      const spent = appendGrantEvent<InstallDecision>(h.config.stateRoot, (rows) => {
        const again = evaluateInstallGate(gateReq, foldGrants(rows.map((x) => x.event)), now());
        if (!again.allow || again.via !== "grant") return { refuse: again.allow ? "the grant changed" : again.errors.map((e) => e.message).join("; ") };
        return { event: { type: "used" as const, grantId: again.grantId!, requestId, actor, app, components: select, cost: plan.cost }, value: again };
      }, now);
      decision = spent.ok ? spent.value : { allow: false, errors: [err("E_NOT_PERMITTED", "/operation", spent.message)], gateStop: { request: `install_component by ${actor.kind}:${actor.name} for ${app}`, rule: "grant-required" } };
    }
    if (!decision.allow) {
      log({ phase: "refused", gateStop: decision.gateStop, errors: decision.errors.map((e) => e.message) });
      return refuse(decision.errors);
    }
    log({ phase: "admitted", via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {}), cost: plan.cost });

    const outcome: InstallOutcome = await installSelection(env, manifest, sha, select);
    if (!outcome.ok) {
      log({ phase: "finished", ok: false, errors: outcome.errors.map((e) => e.code), completed: outcome.completed.map((c) => c.component) });
      return { ok: false as const, errors: outcome.errors.map(fromComponent), completed: outcome.completed };
    }
    log({ phase: "finished", ok: true, steps: outcome.steps });
    return { ok: true as const, via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {}), steps: outcome.steps, cost: outcome.cost };
  });
}

// ---- reading: what could be installed, and what is ---------------------------------------------------------------------------------------

export type ComponentListing = {
  app: string;
  appVersion: string;
  /** Whether artifacts can be fetched at all: a local folder, a download host list, or only what is cached. */
  sources: ("local" | "https" | "cache")[];
  components: {
    id: string; kind: string; version: string; title: string; description?: string; capabilities: string[];
    dependsOn: string[]; downloadBytes: number; expandedBytes: number;
    /** Null when it can be installed here; otherwise the reason (platform, app version). */
    unavailable: string | null;
    installed: { version: string; origin: string; selectedByUser: boolean } | null;
  }[];
};

/** `{app?}`: the components of the pinned manifest of each configured app (or one), what is installed of them, and the transaction in flight. Any actor may read this. */
export function listComponentsFromHost(file: string, request: unknown = {}): { ok: true; apps: ComponentListing[]; transaction?: unknown } | { ok: false; errors: TypedError[] } {
  return guard(() => {
    const r = strictObject(request ?? {}, ["app"]);
    if ("code" in r) return refuse([r as TypedError]);
    if (r.app !== undefined && (typeof r.app !== "string" || !ID.test(r.app))) return refuse([err("E_SCHEMA_INVALID", "/app", "app is the id of an app in the host configuration")]);
    const h = loadHost(file, r.app === undefined ? "all" : [r.app as string]);
    const state = readInstallState(h.config.installRoot);
    if (!state.ok) return refuse(state.errors.map(fromComponent));
    const apps: ComponentListing[] = [];
    for (const [name, { manifest }] of h.manifests) {
      const entry = h.config.apps[name]!;
      apps.push({
        app: name, appVersion: entry.appVersion,
        sources: [...(entry.artifactsDir ? ["local" as const] : []), ...(entry.downloads ? ["https" as const] : []), "cache" as const],
        components: manifest.components.map((c) => {
          const have = state.state.installs.find((i) => i.app === name && i.component === c.id);
          const bad = eligible(c, h.config.platform, entry.appVersion);
          return {
            id: c.id, kind: c.kind, version: c.version, title: c.title, ...(c.description ? { description: c.description } : {}), capabilities: c.capabilities,
            dependsOn: (c.dependsOn ?? []).map((d) => d.component),
            downloadBytes: c.artifacts.reduce((n, a) => n + a.downloadBytes, 0), expandedBytes: c.artifacts.reduce((n, a) => n + a.expandedBytes, 0),
            unavailable: bad ? bad.message : null,
            installed: have ? { version: have.version, origin: have.origin, selectedByUser: have.selectedByUser } : null
          };
        })
      });
    }
    return { ok: true as const, apps, ...(state.state.transaction ? { transaction: state.state.transaction } : {}) };
  });
}

// ---- the person's verbs ------------------------------------------------------------------------------------------------------------------

function requireHuman(h: Host, what: string) {
  return h.config.actor.kind === "human" ? null : refuse([err("E_NOT_PERMITTED", "/actor", `${what} is done only by a human host identity`)]);
}

/** `{actor: {kind, name}, app, components, ceiling: {downloadBytes, expandedBytes}, hours?, note?}`: lets that actor install those add-ons of that app, within the ceiling, for `hours` (default 24, at most 744). */
export function grantInstallFromHost(file: string, request: unknown, opts: InstallHostOpts = {}): { ok: true; grant: InstallGrant } | { ok: false; errors: TypedError[] } {
  return guard(() => {
    const r = strictObject(request, ["actor", "app", "components", "ceiling", "hours", "note"]);
    if ("code" in r) return refuse([r as TypedError]);
    if (typeof r.app !== "string" || !ID.test(r.app)) return refuse([err("E_SCHEMA_INVALID", "/app", "app is the id of an app in the host configuration")]);
    const hours = r.hours === undefined ? 24 : r.hours;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 744) return refuse([err("E_SCHEMA_INVALID", "/hours", "hours is a number above 0 and at most 744 (31 days)")]);
    const who = r.actor as { kind?: unknown; name?: unknown } | null;
    if (!who || typeof who !== "object" || Object.keys(who).some((k) => k !== "kind" && k !== "name") || typeof who.kind !== "string" || typeof who.name !== "string")
      return refuse([err("E_SCHEMA_INVALID", "/actor", "actor is {kind, name} of the agent or system the grant is for")]);
    const h = loadHost(file, [r.app]);
    const denied = requireHuman(h, "issuing an install grant");
    if (denied) return denied;
    const comps = r.components;
    if (!isIdList(comps, 16)) return refuse([err("E_SCHEMA_INVALID", "/components", "components is a list of at most 16 different add-on ids (empty: the core only)")]);
    const manifest = h.manifests.get(r.app)!.manifest;
    for (const c of comps) {
      const def = manifest.components.find((x) => x.id === c);
      if (!def) return refuse([err("E_COMPONENT_UNKNOWN", `/components/${c}`, `${c} is not a component of ${r.app}`)]);
      if (def.kind !== "addon") return refuse([err("E_COMPONENT_NOT_SELECTABLE", `/components/${c}`, `${c} is not an add-on; only add-ons are named in a grant (the core belongs to the app, libraries come with the add-on that needs them)`)]);
    }
    const now = (opts.now ?? (() => new Date()))();
    const body = {
      grantId: randomBytes(16).toString("hex"),
      actor: { kind: who.kind, name: who.name } as InstallGrant["actor"], app: r.app, components: comps, ceiling: r.ceiling as InstallGrant["ceiling"],
      issuedAt: now.toISOString(), expires: new Date(now.getTime() + hours * 3600_000).toISOString(),
      ...(r.note !== undefined ? { note: r.note as string } : {})
    };
    const issued = issueInstallGrant(h.config.actor, body);
    if (!issued.ok) return refuse(issued.errors);
    const wrote = appendGrantEvent<InstallGrant>(h.config.stateRoot, () => ({ event: { type: "issued" as const, grant: issued.grant }, value: issued.grant }), opts.now);
    if (!wrote.ok) return refuse([err("E_SETUP_REQUIRED", "", wrote.message)]);
    appendInstallRecord(h.config.stateRoot, { operation: "grant-install", actor: h.config.actor, grantId: issued.grant.grantId, app: r.app, components: comps });
    return { ok: true as const, grant: wrote.value };
  });
}

/** `{grantId, reason?}`: ends a grant at once. What was spent stays spent. */
export function revokeInstallGrantFromHost(file: string, request: unknown, opts: InstallHostOpts = {}): { ok: true; grantId: string } | { ok: false; errors: TypedError[] } {
  return guard(() => {
    const r = strictObject(request, ["grantId", "reason"]);
    if ("code" in r) return refuse([r as TypedError]);
    if (typeof r.grantId !== "string" || !/^[0-9a-f]{32}$/.test(r.grantId)) return refuse([err("E_SCHEMA_INVALID", "/grantId", "a grant id is 32 hex characters")]);
    if (r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > 300)) return refuse([err("E_SCHEMA_INVALID", "/reason", "a reason is at most 300 characters")]);
    const h = loadHost(file, []);
    const denied = requireHuman(h, "revoking an install grant");
    if (denied) return denied;
    const wrote = appendGrantEvent<string>(h.config.stateRoot, (rows) => {
      const s = foldGrants(rows.map((x) => x.event)).find((x) => x.grant.grantId === r.grantId);
      if (!s) return { refuse: "there is no such grant" };
      if (s.revoked) return { refuse: "the grant is already revoked" };
      return { event: { type: "revoked" as const, grantId: r.grantId as string, by: h.config.actor, ...(r.reason ? { reason: r.reason as string } : {}) }, value: r.grantId as string };
    }, opts.now);
    if (!wrote.ok) return refuse([err("E_NOT_PERMITTED", "/grantId", wrote.message)]);
    appendInstallRecord(h.config.stateRoot, { operation: "revoke-install-grant", actor: h.config.actor, grantId: wrote.value });
    return { ok: true as const, grantId: wrote.value };
  });
}

/** Every grant with its state: active, expired or revoked, and how much of its ceiling is spent. */
export function listInstallGrantsFromHost(file: string, opts: InstallHostOpts = {}): { ok: true; grants: (InstallGrant & { state: "active" | "expired" | "revoked"; spent: Cost })[] } | { ok: false; errors: TypedError[] } {
  return guard(() => {
    const h = loadHost(file, []);
    const denied = requireHuman(h, "listing install grants");
    if (denied) return denied;
    const now = (opts.now ?? (() => new Date()))().getTime();
    const grants = foldGrants(readGrantLog(h.config.stateRoot).map((x) => x.event)).map((s) => ({
      ...s.grant, spent: s.spent, state: s.revoked ? ("revoked" as const) : Date.parse(s.grant.expires) <= now ? ("expired" as const) : ("active" as const)
    }));
    return { ok: true as const, grants };
  });
}

/** `{app, component}`: removes an add-on (and the libraries that came only with it). A human action: an agent or system actor is refused whatever grants exist. */
export async function removeFromHost(file: string, request: unknown, opts: InstallHostOpts = {}): Promise<{ ok: true; removed: string[]; unregistered: string[] } | { ok: false; errors: TypedError[] }> {
  return guardAsync(async () => {
    const r = strictObject(request, ["app", "component"]);
    if ("code" in r) return refuse([r as TypedError]);
    if (typeof r.app !== "string" || !ID.test(r.app) || typeof r.component !== "string" || !ID.test(r.component)) return refuse([err("E_SCHEMA_INVALID", "/app", "app and component are ids")]);
    const h = loadHost(file, "all");
    const actor = h.config.actor;
    const log = (event: Record<string, unknown>) => appendInstallRecord(h.config.stateRoot, { operation: "remove_component", actor, app: r.app, component: r.component, ...event });
    const decision = evaluateInstallGate({ operation: "remove_component", actor, app: r.app as string, components: [r.component as string], cost: zero }, [], (opts.now ?? (() => new Date()))());
    if (!decision.allow) { log({ phase: "refused", gateStop: decision.gateStop }); return refuse(decision.errors); }
    if (!h.manifests.has(r.app as string)) return refuse([err("E_COMPONENT_UNKNOWN", "/app", `the app ${r.app} is not in the install host configuration`)]);
    log({ phase: "admitted" });
    const out = await removeComponent(envFor(h, r.app as string, opts), [...h.manifests.values()].map((m) => m.manifest), r.app as string, r.component as string);
    if (!out.ok) { log({ phase: "finished", ok: false, errors: out.errors.map((e) => e.code) }); return refuse(out.errors.map(fromComponent)); }
    log({ phase: "finished", ok: true, removed: out.removed, unregistered: out.unregistered });
    return { ok: true as const, removed: out.removed, unregistered: out.unregistered };
  });
}
