import { describe, expect, it } from "vitest";
import {
  OPERATION_RULES,
  evaluateGate,
  gateStopStep,
  issueGrant,
  type Actor,
  type GateContext,
  type GateRequest,
  type Grant,
  type PolicyStudy
} from "../src/core/policy";
import { validate } from "../src/core/validate";

const NOW = new Date("2026-10-03T12:00:00Z");
const human: Actor = { kind: "human", name: "user" };
const agent: Actor = { kind: "agent", name: "bot", model: "m" };
const other: Actor = { kind: "agent", name: "bot2" };
const system: Actor = { kind: "system", name: "seed" };

function study(tier: PolicyStudy["tier"]): PolicyStudy {
  return {
    studyId: "study-1",
    tier,
    budget: { maxWallSeconds: 600, maxCores: 4, maxMemoryMB: 4096, maxDiskMB: 1000 },
    parameters: [{ id: "temp", min: 300, max: 900, unit: "K" }]
  };
}
const ctx = (tier: PolicyStudy["tier"], extra: Partial<GateContext> = {}): GateContext => ({
  study: study(tier),
  now: () => NOW,
  ...extra
});
const req = (operation: string, actor: Actor = agent, extra: Partial<GateRequest> = {}): GateRequest => ({
  operation,
  actor,
  studyId: "study-1",
  ...(operation === "run_sweep" ? { cases: 1 } : {}),
  ...extra
});
const REV = [{ artifact: "a1", revision: "a".repeat(64) }];

function grantFor(operation: keyof typeof OPERATION_RULES, over: Partial<Grant> = {}): Grant {
  const r = issueGrant(human, {
    grantId: "g1",
    studyId: "study-1",
    actor: { kind: "agent", name: "bot" },
    operation,
    inputRevisions: REV,
    issuedAt: "2026-10-03T11:00:00Z",
    expires: "2026-10-03T13:00:00Z"
  });
  if (!r.ok) throw new Error("grant refused");
  return { ...r.grant, ...over };
}

describe("tier table", () => {
  const rows: [string, "A0" | "A1" | "A2" | "A3", boolean][] = [];
  for (const [op, rule] of Object.entries(OPERATION_RULES)) {
    if (rule === "human" || rule === "grant") continue;
    for (const tier of ["A0", "A1", "A2", "A3"] as const) {
      rows.push([op, tier, ["A0", "A1", "A2", "A3"].indexOf(tier) >= ["A0", "A1", "A2", "A3"].indexOf(rule)]);
    }
  }
  it.each(rows)("%s at study tier %s is allowed: %s", (op, tier, allowed) => {
    const d = evaluateGate(req(op), ctx(tier));
    expect(d.allow).toBe(allowed);
    if (!d.allow) {
      expect(d.errors[0]?.code).toBe("E_NOT_PERMITTED");
      expect(d.gateStop.rule).toBe("tier");
      expect(d.gateStop.request).toContain("agent:bot");
    }
  });

  it("A0 can read and validate but not run (acceptance 1, 5)", () => {
    expect(evaluateGate(req("validate"), ctx("A0")).allow).toBe(true);
    expect(evaluateGate(req("run_case"), ctx("A0")).allow).toBe(false);
  });
});

describe("human-only operations (A4: never grantable)", () => {
  const ops = Object.entries(OPERATION_RULES)
    .filter(([, r]) => r === "human")
    .map(([o]) => o);
  it("covers the A4 list", () => {
    expect(ops).toEqual(
      expect.arrayContaining([
        "change_tier",
        "change_budget",
        "change_bounds",
        "change_tolerance",
        "override_refusal",
        "write_outside_roots",
        "run_command_from_content"
      ])
    );
  });
  it.each(ops)("%s is refused for an agent and the system at every tier, even with a grant", (op) => {
    for (const tier of ["A0", "A1", "A2", "A3"] as const) {
      for (const actor of [agent, system]) {
        const forged: Grant = { ...grantFor("run_case"), operation: op as Grant["operation"], actor: { kind: actor.kind, name: actor.name } };
        const d = evaluateGate(req(op, actor, { inputRevisions: REV }), ctx(tier, { grants: [forged] }));
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.gateStop.rule).toBe("human-only");
      }
    }
  });
  it.each(ops)("%s is allowed for a human (a GUI action)", (op) => {
    expect(evaluateGate(req(op, human), ctx("A0")).allow).toBe(true);
  });
  it("issueGrant refuses to grant a human-only operation", () => {
    const r = issueGrant(human, {
      grantId: "g",
      studyId: "study-1",
      actor: { kind: "agent", name: "bot" },
      operation: "change_tolerance",
      inputRevisions: [],
      issuedAt: "2026-10-03T11:00:00Z",
      expires: "2026-10-03T13:00:00Z"
    });
    expect(r.ok).toBe(false);
  });
});

describe("grants (A3 and approval stops)", () => {
  it("enable_transfer needs a grant even at tier A3", () => {
    const d = evaluateGate(req("enable_transfer", agent, { inputRevisions: REV }), ctx("A3"));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.gateStop.rule).toBe("grant-required");
  });
  it("accept_material_set stops for a human at A2 (acceptance 5)", () => {
    const d = evaluateGate(req("accept_material_set"), ctx("A2"));
    expect(d.allow).toBe(false);
  });
  it("a matching grant allows it and names the grant", () => {
    const d = evaluateGate(req("enable_transfer", agent, { inputRevisions: REV }), ctx("A3", { grants: [grantFor("enable_transfer")] }));
    expect(d).toEqual({ allow: true, via: "grant", grantId: "g1" });
  });
  it("a grant lets an agent exceed the study tier for that one operation only", () => {
    const g = grantFor("new_revision");
    expect(evaluateGate(req("new_revision", agent, { inputRevisions: REV }), ctx("A1", { grants: [g] })).allow).toBe(true);
    expect(evaluateGate(req("propose_transfer", agent, { inputRevisions: REV }), ctx("A1", { grants: [g] })).allow).toBe(false);
  });
  it.each([
    ["another actor", { actor: { kind: "agent" as const, name: "bot2" } }, "grant belongs to another actor"],
    ["another study", { studyId: "study-2" }, "no grant for this operation"],
    ["expired", { expires: "2026-10-03T12:00:00Z" }, "grant expired"],
    ["revoked", { revoked: true }, "grant revoked"],
    ["bad expiry", { expires: "never" }, "grant expired"],
    ["not by a human", { approvedBy: agent }, "grant was not approved by a human"],
    ["other revisions", { inputRevisions: [{ artifact: "a1", revision: "b".repeat(64) }] }, "grant does not cover these input revisions"],
    ["more revisions", { inputRevisions: [...REV, { artifact: "a2", revision: "c".repeat(64) }] }, "grant does not cover these input revisions"],
    ["wrong operation", { operation: "new_revision" as const }, "no grant for this operation"]
  ])("a grant is unusable when %s", (_name, over, reason) => {
    const d = evaluateGate(req("enable_transfer", agent, { inputRevisions: REV }), ctx("A3", { grants: [grantFor("enable_transfer", over as Partial<Grant>)] }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.errors[0]?.message).toContain(reason);
  });
  it("a changed input revision invalidates an otherwise valid grant", () => {
    const g = grantFor("enable_transfer");
    const changed = [{ artifact: "a1", revision: "d".repeat(64) }];
    expect(evaluateGate(req("enable_transfer", agent, { inputRevisions: changed }), ctx("A3", { grants: [g] })).allow).toBe(false);
  });
  it("the same request by a human is not blocked by the grant rule", () => {
    expect(evaluateGate(req("enable_transfer", human), ctx("A3")).allow).toBe(true);
  });
  it("issueGrant refuses an agent or system approver and bad times", () => {
    const base = {
      grantId: "g",
      studyId: "study-1",
      actor: { kind: "agent" as const, name: "bot" },
      operation: "enable_transfer" as const,
      inputRevisions: REV,
      issuedAt: "2026-10-03T11:00:00Z",
      expires: "2026-10-03T13:00:00Z"
    };
    for (const who of [agent, system]) {
      const r = issueGrant(who, base);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]?.code).toBe("E_NOT_PERMITTED");
    }
    expect(issueGrant(human, { ...base, expires: "2026-10-03T10:00:00Z" }).ok).toBe(false);
    expect(issueGrant(human, { ...base, expires: "soon" }).ok).toBe(false);
    expect(issueGrant(human, { ...base, operation: "nonsense" as never }).ok).toBe(false);
  });
});

describe("budgets, bounds and engine limit (acceptance 5)", () => {
  it("an over-budget A1 request stops, one error per field, with the limit as range", () => {
    const d = evaluateGate(
      req("run_case", agent, { budget: { maxWallSeconds: 601, maxCores: 4, maxMemoryMB: 9999, maxDiskMB: 1 } }),
      ctx("A1")
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.errors.map((e) => [e.code, e.field])).toEqual([
        ["E_BUDGET_EXCEEDED", "/budget/maxWallSeconds"],
        ["E_BUDGET_EXCEEDED", "/budget/maxMemoryMB"]
      ]);
      expect(d.errors[0]?.range).toEqual({ max: 600 });
      expect(d.gateStop.rule).toBe("budget");
    }
  });
  it("a budget at exactly the limit passes", () => {
    expect(evaluateGate(req("run_case", agent, { budget: { maxWallSeconds: 600, maxCores: 4, maxMemoryMB: 4096, maxDiskMB: 1000 } }), ctx("A1")).allow).toBe(true);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("budget value %s is refused", (v) => {
    const d = evaluateGate(req("run_case", agent, { budget: { maxWallSeconds: v, maxCores: 1, maxMemoryMB: 1, maxDiskMB: 1 } }), ctx("A1"));
    expect(d.allow).toBe(false);
  });
  it("budget limits also bind a human GUI request", () => {
    const d = evaluateGate(req("run_case", human, { budget: { maxWallSeconds: 601, maxCores: 1, maxMemoryMB: 1, maxDiskMB: 1 } }), ctx("A1"));
    expect(d.allow).toBe(false);
  });
  it("parameters outside the bounds, undeclared or non-finite are refused with the range and unit", () => {
    const d = evaluateGate(
      req("run_sweep", agent, { cases: 5, params: [{ id: "temp", value: 901 }, { id: "temp", value: 299 }, { id: "nope", value: 1 }, { id: "temp", value: Number.NaN }, { id: "temp", value: 300 }] }),
      ctx("A1")
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.errors.map((e) => e.field)).toEqual(["/params/0/value", "/params/1/value", "/params/2/id", "/params/3/value"]);
      expect(d.errors[0]).toMatchObject({ code: "E_BOUNDS_EXCEEDED", range: { min: 300, max: 900 }, unit: "K" });
      expect(d.gateStop.rule).toBe("bounds");
    }
    expect(evaluateGate(req("run_sweep", agent, { cases: 2, params: [{ id: "temp", value: 900 }, { id: "temp", value: 300 }] }), ctx("A1")).allow).toBe(true);
  });
  it("a parameter named like an Object.prototype member is just undeclared", () => {
    const d = evaluateGate(req("run_case", agent, { params: [{ id: "constructor", value: 1 }] }), ctx("A1"));
    expect(d.allow).toBe(false);
  });
  it("one active case per engine", () => {
    expect(evaluateGate(req("run_case", agent, { engine: "nodal", activeOnEngine: 1 }), ctx("A1")).allow).toBe(false);
    expect(evaluateGate(req("run_case", agent, { engine: "nodal", activeOnEngine: 0 }), ctx("A1")).allow).toBe(true);
    expect(evaluateGate(req("status", agent, { engine: "nodal", activeOnEngine: 3 }), ctx("A1")).allow).toBe(true);
  });
});

describe("oracle and pin blocks", () => {
  it("a failed oracle blocks run operations but not run_oracles, reads or notes", () => {
    const c = ctx("A3", { oracleBlocked: true });
    for (const op of ["run_case", "run_sweep", "new_revision", "propose_transfer"]) {
      const d = evaluateGate(req(op), c);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.gateStop.rule).toBe("oracle-failed");
    }
    for (const op of ["run_oracles", "validate", "describe", "append_step", "status", "cancel"]) {
      expect(evaluateGate(req(op), c).allow).toBe(true);
    }
  });
  it("a human cannot run cases past a failed oracle either (the study is blocked)", () => {
    expect(evaluateGate(req("run_case", human), ctx("A3", { oracleBlocked: true })).allow).toBe(false);
  });
  it("changed pins block run operations until accepted", () => {
    const d = evaluateGate(req("run_case"), ctx("A1", { pinsChanged: true }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.gateStop.rule).toBe("pins-changed");
  });
});

describe("request shape", () => {
  it.each(["", "constructor", "__proto__", "toString", "run_case ", "RUN_CASE", "hasOwnProperty"])("unknown operation %j is refused", (op) => {
    const d = evaluateGate(req(op), ctx("A3"));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.errors[0]?.code).toBe("E_VERB_UNKNOWN");
      expect(d.gateStop.rule).toBe("unknown-operation");
    }
  });
  it("another study's request is refused", () => {
    const d = evaluateGate({ ...req("run_case"), studyId: "other" }, ctx("A3"));
    expect(d.allow).toBe(false);
  });
  it("a long operation name is truncated in the gate-stop", () => {
    const d = evaluateGate(req("x".repeat(500)), ctx("A3"));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.gateStop.request.length).toBeLessThanOrEqual(200);
  });
});

describe("gate-stop step", () => {
  it("is a valid study step line, with the request and the rule", () => {
    const d = evaluateGate(req("run_case", agent, { budget: { maxWallSeconds: 601, maxCores: 1, maxMemoryMB: 1, maxDiskMB: 1 } }), ctx("A1"));
    if (d.allow) throw new Error("expected a stop");
    const step = gateStopStep(d, agent, 3, "2026-10-03T12:00:00Z");
    expect(step.action).toBe("gate-stop");
    expect(validate("study", step)).toEqual({ ok: true });
  });
  it("stays valid for every kind of stop", () => {
    const reqs = [req("nonsense"), req("change_tier"), req("run_case"), req("enable_transfer")];
    for (const r of reqs) {
      const d = evaluateGate(r, ctx("A0"));
      if (d.allow) throw new Error("expected a stop");
      expect(validate("study", gateStopStep(d, r.actor, 1, "2026-10-03T12:00:00Z"))).toEqual({ ok: true });
    }
  });
});

describe("two actors", () => {
  it("one agent's grant does not help another (acceptance 13: impersonation boundary)", () => {
    const g = grantFor("enable_transfer");
    expect(evaluateGate(req("enable_transfer", other, { inputRevisions: REV }), ctx("A3", { grants: [g] })).allow).toBe(false);
  });
});

describe("review fixes (Codex, 2026-10-03)", () => {
  it("a grant dated in the future does not authorize anything yet", () => {
    const g = grantFor("enable_transfer", { issuedAt: "2026-10-04T00:00:00Z", expires: "2026-10-05T00:00:00Z" });
    const d = evaluateGate(req("enable_transfer", agent, { inputRevisions: REV }), ctx("A3", { grants: [g] }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.errors[0]?.message).toContain("not valid yet");
    const bad = grantFor("enable_transfer", { issuedAt: "tomorrow" });
    expect(evaluateGate(req("enable_transfer", agent, { inputRevisions: REV }), ctx("A3", { grants: [bad] })).allow).toBe(false);
  });

  it("running oracles on a busy engine is refused like running a case", () => {
    expect(evaluateGate(req("run_oracles", agent, { engine: "nodal", activeOnEngine: 1 }), ctx("A1")).allow).toBe(false);
    expect(evaluateGate(req("run_oracles", agent, { engine: "nodal", activeOnEngine: 0 }), ctx("A1")).allow).toBe(true);
    // a failed oracle set must still be re-runnable on an idle engine
    expect(evaluateGate(req("run_oracles", agent, { engine: "nodal", activeOnEngine: 0 }), ctx("A1", { oracleBlocked: true })).allow).toBe(true);
  });
});
