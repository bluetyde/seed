// @covers R-CORE-12, R-DISP-01, R-DISP-04
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { RunDispatcher, describeCause, type DispatchAuthority, type DispatchAudit, type DispatcherOptions } from "../src/core/runDispatcher";
import { createTempProject, type TempProject } from "./helpers/project";
const projects: TempProject[] = [];
afterEach(async () => { for (const p of projects.splice(0)) await p.cleanup(); });
function fixture() {
  const p = createTempProject(); projects.push(p);
  const data = JSON.stringify({ name: "case", fake: { validate: "ok" } }); p.createFile("models/case.json", data);
  const hash = sha256Hex(data);
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const pins = { appCommit: "a".repeat(40), oracleFiles: [{ oracleId: "o1", entryVersion: 1, sha256: "b".repeat(64) }] };
  const authority: DispatchAuthority = {
    context: { study: { studyId: "study1", tier: "A1", budget, parameters: [{ id: "power", min: 0, max: 10 }] } },
    currentPins: pins, acceptedPins: structuredClone(pins),
    oracleResult: { adapter: "fake", adapterVersion: "0.1.0", verdict: "pass", inputsVerified: true, blocked: false,
      blockedQuantities: [], results: [{ oracleId: "o1", entryVersion: 1, tag: "good", verdict: "pass" }], pins: structuredClone(pins) },
  };
  const events: DispatchAudit[] = [];
  const registered = { artifact: { path: "models/case.json", revision: { hash, counter: 1 } }, inputs: [{ path: "models/case.json", sha256: hash }], settings: { scenario: "success", delayMs: 10 }, params: [{ id: "power", value: 2 }] };
  const options: DispatcherOptions = {
    manager: { projectRoot: p.root, runsFolder: "runs", adapter: { command: process.execPath, args: [join(__dirname, "fixtures/fake-adapter/cli.cjs")], id: "fake", version: "0.1.0" }, pollMs: 30 },
    engine: "fake-" + p.root, actor: { kind: "agent", name: "client", model: "test" },
    loadCase: async id => { if (id !== "case1") throw Error("unknown case"); return registered; },
    loadAuthority: async () => authority, audit: async e => { events.push(e); },
  };
  const request = { requestId: "r1", caseId: "case1", budget: structuredClone(budget) };
  return { p, options, authority, registered, request, events };
}
it("allowed agent case runs through the actual fake adapter with host actor and pins", async () => {
  const f = fixture(); const out = await new RunDispatcher(f.options).start(f.request);
  expect(out.ok).toBe(true); if (!out.ok) throw Error(JSON.stringify(out.errors));
  expect(out.state).toBe("completed");
  expect((out.record.extensions as any)["seed.dispatch"].actor).toEqual(f.options.actor);
  expect((out.record.extensions as any)["seed.dispatch"].pins).toEqual(f.authority.currentPins);
  expect(f.events[0]!.decision.allow).toBe(true);
});
for (const [name, change] of [
  ["A0", (f: ReturnType<typeof fixture>) => { f.authority.context.study.tier = "A0"; }],
  ["missing oracle", (f: ReturnType<typeof fixture>) => { delete f.authority.oracleResult; }],
  ["failed oracle", (f: ReturnType<typeof fixture>) => { f.authority.oracleResult!.blocked = true; }],
  ["unverified inputs", (f: ReturnType<typeof fixture>) => { f.authority.oracleResult!.inputsVerified = false; }],
  ["unaccepted pins", (f: ReturnType<typeof fixture>) => { delete f.authority.acceptedPins; }],
  ["changed app", (f: ReturnType<typeof fixture>) => { f.authority.currentPins.appCommit = "c".repeat(40); }],
  ["stale verdict", (f: ReturnType<typeof fixture>) => { f.authority.oracleResult!.pins.appCommit = "c".repeat(40); }],
  ["wrong adapter", (f: ReturnType<typeof fixture>) => { f.authority.oracleResult!.adapterVersion = "2"; }],
  ["missing verdict entry", (f: ReturnType<typeof fixture>) => { f.authority.currentPins.oracleFiles.push({ oracleId: "extra", entryVersion: 1, sha256: "d".repeat(64) }); f.authority.acceptedPins = structuredClone(f.authority.currentPins); f.authority.oracleResult!.pins = structuredClone(f.authority.currentPins); }],
  ["unknown app revision", (f: ReturnType<typeof fixture>) => { f.authority.currentPins.appCommit = "unknown"; f.authority.acceptedPins = structuredClone(f.authority.currentPins); f.authority.oracleResult!.pins = structuredClone(f.authority.currentPins); }],
  ["budget", (f: ReturnType<typeof fixture>) => { f.request.budget.maxCores = 2; }],
  ["bounds", (f: ReturnType<typeof fixture>) => { f.registered.params[0]!.value = 11; }],
] as const) it(`refuses ${name} before creating a run`, async () => {
  const f = fixture(); change(f);
  const out = await new RunDispatcher(f.options).start(f.request);
  expect(out.ok).toBe(false); expect(readdirSync(join(f.p.root, "runs"))).toEqual([]);
  expect(f.events).toHaveLength(1); expect(f.events[0]!.decision.allow).toBe(false);
});
it("client cannot submit authority, actor, settings, or wall limit", async () => {
  const f = fixture(); const d = new RunDispatcher(f.options);
  for (const key of ["actor", "context", "oracleResult", "settings", "wallLimitMs", "studyBudget"]) {
    expect((await d.start({ ...f.request, [key]: { kind: "human" } } as any)).ok).toBe(false);
  }
  expect(readdirSync(join(f.p.root, "runs"))).toEqual([]);
});
it("audit failure prevents launch and releases engine/project locks for retry", async () => {
  const f = fixture(); f.options.audit = async () => { throw Error("disk full"); };
  expect((await new RunDispatcher(f.options).start(f.request)).ok).toBe(false);
  expect(readdirSync(join(f.p.root, "runs"))).toEqual([]);
  f.options.audit = async () => {};
  expect((await new RunDispatcher(f.options).start(f.request)).ok).toBe(true);
});
it("engine reservation covers asynchronous admission across dispatcher instances", async () => {
  const f = fixture(); let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  f.options.loadAuthority = async () => { entered(); await new Promise<void>(r => { release = r; }); return f.authority; };
  const first = new RunDispatcher(f.options).start(f.request); await ready;
  const other = await new RunDispatcher(f.options).start({ ...f.request, requestId: "r2" });
  expect(other.ok).toBe(false); release(); expect((await first).ok).toBe(true);
});
it("caller mutation during admission cannot change the dispatched budget", async () => {
  const f = fixture(); const d = new RunDispatcher(f.options); const promise = d.start(f.request);
  f.request.budget.maxCores = 99;
  const out = await promise; expect(out.ok).toBe(true);
  if (out.ok) expect((out.record.budget as any).maxCores).toBe(1);
});

it("reloads policy on each call, including after a successful run", async () => {
  const f = fixture(); const d = new RunDispatcher(f.options);
  expect((await d.start(f.request)).ok).toBe(true);
  f.authority.context.study.tier = "A0";
  expect((await d.start({ ...f.request, requestId: "r2" })).ok).toBe(false);
  expect(f.events.map(e => e.decision.allow)).toEqual([true, false]);
});

// Review hardening 2026-10-05: a refusal for an internal failure names the stage and the kind of failure, never a host path.
for (const [stage, make] of [
  ["loading the registered case", (f: ReturnType<typeof fixture>) => { f.options.loadCase = async () => { throw Object.assign(Error("cannot read C:/Users/me/secret/case.json"), { code: "EACCES" }); }; }],
  ["loading the host authority", (f: ReturnType<typeof fixture>) => { f.options.loadAuthority = async () => { throw new TypeError("bad config at /home/me/host.json"); }; }],
  ["recording the gate decision", (f: ReturnType<typeof fixture>) => { f.options.audit = async () => { throw Object.assign(Error("no space left on 'D:/state/audit.jsonl'"), { code: "ENOSPC" }); }; }],
] as const) it(`an internal failure while ${stage} is reported with its stage and kind, without host paths`, async () => {
  const f = fixture(); make(f);
  const out = await new RunDispatcher(f.options).start(f.request);
  expect(out.ok).toBe(false);
  if (out.ok) throw Error("expected a refusal");
  expect(out.errors[0]!.code).toBe("E_INTERNAL");
  expect(out.errors[0]!.message).toContain(`failed while ${stage}`);
  expect(out.errors[0]!.message).not.toMatch(/Users|home\/me|state\/audit|\.json/);
  expect(readdirSync(join(f.p.root, "runs"))).toEqual([]);
});
it("describeCause returns only an allowlisted classification, never message text (UNC, spaces, secrets)", () => {
  const unc = Error("cannot read " + String.fromCharCode(92, 92) + "fileserver" + String.fromCharCode(92) + "private" + String.fromCharCode(92) + "host.json");
  expect(describeCause(unc)).toBe("Error");
  expect(describeCause(Object.assign(Error("open 'C:/Users/Jane Doe/private/host.json'"), { code: "ENOENT" }))).toBe("ENOENT");
  expect(describeCause(new Error("invalid token=SYNTHETIC_SENTINEL"))).toBe("Error");
  expect(describeCause(new RangeError("anything"))).toBe("RangeError");
  expect(describeCause(Object.assign(Error("x"), { code: "not an errno; token=secret" }))).toBe("Error");
  expect(describeCause(Object.assign(Error("x"), { name: "SecretNamedError" }))).toBe("Error");
  expect(describeCause("not an error")).toBe("Error");
  expect(describeCause(null)).toBe("Error");
});
it("the host diagnostics hook receives the stage and the full cause, and a throwing hook changes nothing", async () => {
  const seen: { stage: string; message: string }[] = [];
  const f = fixture();
  f.options.audit = async () => { throw Object.assign(Error("no space left on D:/state/audit.jsonl token=SYNTHETIC_SENTINEL"), { code: "ENOSPC" }); };
  f.options.onInternalError = (stage, cause) => { seen.push({ stage, message: (cause as Error).message }); };
  const out = await new RunDispatcher(f.options).start(f.request);
  if (out.ok) throw Error("expected a refusal");
  expect(out.errors[0]!.message).toBe("run not started: failed while recording the gate decision (ENOSPC)");
  expect(out.errors[0]!.message).not.toMatch(/SYNTHETIC_SENTINEL|audit.jsonl/);
  expect(seen).toEqual([{ stage: "recording the gate decision", message: "no space left on D:/state/audit.jsonl token=SYNTHETIC_SENTINEL" }]);
  const g = fixture();
  g.options.audit = async () => { throw Error("disk full"); };
  g.options.onInternalError = () => { throw Error("logger broke"); };
  const refused = await new RunDispatcher(g.options).start(g.request);
  expect(!refused.ok && refused.errors[0]!.code).toBe("E_INTERNAL");
});
