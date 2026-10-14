// @covers R-STUDY-05
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReplayPolicy, REPLAY_POLICY_SCHEMA } from "../src/core/replayPolicy";
import { validReplayPolicy, type ReplayPolicy } from "../src/core/replay";

// The replay policy of an adapter lives in adapters/<id>/replay.json (docs/replay.md, decision of the user, 2026-10-14: option A).
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const adapters = (files: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "seed-replay-policy-"));
  dirs.push(root);
  for (const [id, body] of Object.entries(files)) { mkdirSync(join(root, id)); writeFileSync(join(root, id, "replay.json"), typeof body === "string" ? body : JSON.stringify(body)); }
  return root;
};
const doc = (over: Record<string, unknown> = {}) => ({ schema: REPLAY_POLICY_SCHEMA, adapter: "demo", policy: { mode: "exact" }, basis: "the engine is deterministic for the same inputs", ...over });

describe("the policy files that ship with the adapters", () => {
  it.each(["raft", "nodal", "pra", "feed", "openmc"])("adapter %s has a valid policy that says why", (id) => {
    const r = loadReplayPolicy(id);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.adapter).toBe(id); expect(r.basis.length).toBeGreaterThan(30); }
  });

  it("the deterministic apps are exact, FEED has a tight bound, and OpenMC is statistical", () => {
    const get = (id: string) => { const r = loadReplayPolicy(id); if (!r.ok) throw new Error("no policy"); return r.policy; };
    expect(get("raft")).toEqual({ mode: "exact" });
    expect(get("nodal")).toEqual({ mode: "exact" });
    expect(get("feed")).toEqual({ mode: "tolerance", abs: 0, rel: 1e-9 });
    expect(get("openmc")).toEqual({ mode: "statistical", sigmas: 3 });
  });
});

describe("reading a policy file", () => {
  it("reads a good file", () => {
    expect(loadReplayPolicy("demo", adapters({ demo: doc() }))).toMatchObject({ ok: true, adapter: "demo", policy: { mode: "exact" } });
  });

  it("an adapter with no policy is refused, with the place a policy would go: there is no default", () => {
    const r = loadReplayPolicy("demo", adapters({}));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors[0]!.code).toBe("E_SETUP_REQUIRED"); expect(r.errors[0]!.message).toMatch(/no replay policy for adapter demo/); }
  });

  it.each([
    ["not JSON", "{ nope", "E_SCHEMA_INVALID"],
    ["not an object", "[1]", "E_SCHEMA_INVALID"],
    ["an unknown field", doc({ extra: 1 }), "E_SCHEMA_INVALID"],
    ["another schema version", doc({ schema: "seed.replay-policy/9.9" }), "E_SCHEMA_VERSION"],
    ["another adapter's id", doc({ adapter: "other" }), "E_SCHEMA_INVALID"],
    ["no reason", doc({ basis: "short" }), "E_SCHEMA_INVALID"],
    ["a reason that is not text", doc({ basis: 5 }), "E_SCHEMA_INVALID"],
    ["a bad policy mode", doc({ policy: { mode: "loose" } }), "E_SCHEMA_INVALID"],
    ["a tolerance with a typo (it would loosen nothing, but it is refused)", doc({ policy: { mode: "tolerance", abs: 0, rel: 1e-9, relative: 5 } }), "E_SCHEMA_INVALID"],
    ["an exact policy with a bound", doc({ policy: { mode: "exact", rel: 1 } }), "E_SCHEMA_INVALID"],
    ["a statistical policy with a bound", doc({ policy: { mode: "statistical", sigmas: 3, abs: 1 } }), "E_SCHEMA_INVALID"],
  ])("refuses a file that is %s", (_n, body, code) => {
    const r = loadReplayPolicy("demo", adapters({ demo: body }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe(code);
  });

  it("refuses an adapter id that could reach another folder, and a file that is too large", () => {
    for (const id of ["../x", "a/b", "", "A", "x".repeat(40), ".."]) expect(loadReplayPolicy(id, adapters({})).ok).toBe(false);
    const r = loadReplayPolicy("demo", adapters({ demo: JSON.stringify(doc({ basis: "x".repeat(20000) })) }));
    expect(r.ok).toBe(false);
  });
});

describe("validReplayPolicy", () => {
  it.each([
    [{ mode: "exact" }, null],
    [{ mode: "tolerance", abs: 0, rel: 1e-9 }, null],
    [{ mode: "tolerance", abs: 1, rel: 0 }, null],
    [{ mode: "statistical", sigmas: 3 }, null],
    [{ mode: "statistical", sigmas: 10 }, null],
  ])("accepts %j", (p, bad) => expect(validReplayPolicy(p as ReplayPolicy)).toBe(bad));

  it.each([null, [], "exact", 3, { mode: "exact", x: 1 }, { mode: "tolerance", abs: 0, rel: 0 }, { mode: "tolerance", abs: -1, rel: 1 }, { mode: "tolerance", abs: 1 }, { mode: "statistical" }, { mode: "statistical", sigmas: 0 }, { mode: "statistical", sigmas: 11 }])("refuses %j", (p) => {
    expect(validReplayPolicy(p as unknown as ReplayPolicy)).not.toBeNull();
  });
});
