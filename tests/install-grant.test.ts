// @covers R-INSTALL-05
import { describe, expect, it } from "vitest";
import { MAX_GRANT_MS, evaluateInstallGate, foldGrants, issueInstallGrant, type GrantEvent, type InstallGrant, type InstallRequest } from "../src/core/installGrant";
import { OPERATION_RULES, type Actor } from "../src/core/policy";

// The install gate (runtime contract, user decision no. 2): an agent may ask for an install inside a human grant; removal is a person's.
const NOW = new Date("2026-10-18T12:00:00.000Z");
const human: Actor = { kind: "human", name: "user" };
const agent: Actor = { kind: "agent", name: "setup-bot", model: "m" };
const GID = "a".repeat(32);

const body = (over: Partial<Omit<InstallGrant, "approvedBy">> = {}): Omit<InstallGrant, "approvedBy"> => ({
  grantId: GID, actor: { kind: "agent", name: "setup-bot" }, app: "fakeapp", components: ["fake-cad"],
  ceiling: { downloadBytes: 1000, expandedBytes: 5000 }, issuedAt: NOW.toISOString(), expires: new Date(NOW.getTime() + 24 * 3600_000).toISOString(), ...over
});
const grant = (over: Partial<Omit<InstallGrant, "approvedBy">> = {}): InstallGrant => {
  const r = issueInstallGrant(human, body(over));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.grant;
};
const req = (over: Partial<InstallRequest> = {}): InstallRequest => ({
  operation: "install_component", actor: agent, app: "fakeapp", components: ["fake-cad"], cost: { downloadBytes: 400, expandedBytes: 2000 }, ...over
});
const state = (g: InstallGrant, extra: GrantEvent[] = []) => foldGrants([{ type: "issued", grant: g }, ...extra]);
const decide = (r: InstallRequest, events: GrantEvent[] = [], at = NOW) => evaluateInstallGate(r, foldGrants(events), at);
const issued = (g = grant()): GrantEvent => ({ type: "issued", grant: g });
const used = (cost: { downloadBytes: number; expandedBytes: number }, grantId = GID): GrantEvent => ({ type: "used", grantId, requestId: "r", actor: agent, app: "fakeapp", components: ["fake-cad"], cost });
const reasons = (d: ReturnType<typeof decide>) => (d.allow ? [] : d.errors.map((e) => e.message));

describe("the operations in the rules table", () => {
  it("installing is grantable, removing is a person's", () => {
    expect(OPERATION_RULES.install_component).toBe("grant");
    expect(OPERATION_RULES.remove_component).toBe("human");
  });
});

describe("who can issue a grant, and for what", () => {
  it("a human can; an agent or the system can not", () => {
    expect(issueInstallGrant(human, body()).ok).toBe(true);
    for (const who of [agent, { kind: "system", name: "seed" } as Actor]) {
      const r = issueInstallGrant(who, body());
      expect(!r.ok && r.errors[0]!.code).toBe("E_NOT_PERMITTED");
    }
  });
  it("is for an agent or system actor by name, never a human", () => {
    expect(issueInstallGrant(human, body({ actor: { kind: "human", name: "me" } as never })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ actor: { kind: "agent", name: "" } })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ actor: { kind: "agent", name: "x".repeat(81) } })).ok).toBe(false);
  });
  it("names an app and at most 16 different valid add-on ids", () => {
    expect(issueInstallGrant(human, body({ components: [] })).ok).toBe(true);
    expect(issueInstallGrant(human, body({ app: "Bad App" })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ components: ["a", "a"] })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ components: ["../x"] })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ components: Array.from({ length: 17 }, (_, i) => `c${i}`) })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ components: Array.from({ length: 16 }, (_, i) => `c${i}`) })).ok).toBe(true);
  });
  it("has a ceiling of whole numbers of bytes", () => {
    for (const bad of [{ downloadBytes: -1, expandedBytes: 1 }, { downloadBytes: 1.5, expandedBytes: 1 }, { downloadBytes: 1, expandedBytes: Number.NaN }, { downloadBytes: 1e14, expandedBytes: 1 }, {} as never]) {
      expect(issueInstallGrant(human, body({ ceiling: bad })).ok).toBe(false);
    }
    expect(issueInstallGrant(human, body({ ceiling: { downloadBytes: 0, expandedBytes: 0 } })).ok).toBe(true);
  });
  it("expires after it is issued, and within 31 days", () => {
    expect(issueInstallGrant(human, body({ expires: NOW.toISOString() })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ expires: "not a time" })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ expires: new Date(NOW.getTime() + MAX_GRANT_MS).toISOString() })).ok).toBe(true);
    const long = issueInstallGrant(human, body({ expires: new Date(NOW.getTime() + MAX_GRANT_MS + 1).toISOString() }));
    expect(!long.ok && long.errors[0]!.message).toContain("31 days");
  });
  it("has a 32-hex grant id and a short note", () => {
    expect(issueInstallGrant(human, body({ grantId: "short" })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ note: "x".repeat(301) })).ok).toBe(false);
    expect(issueInstallGrant(human, body({ note: "for the cloud setup" })).ok).toBe(true);
  });
  it("records the approver", () => {
    expect(grant().approvedBy).toEqual(human);
  });
});

describe("a request under a grant", () => {
  it("is allowed when the actor, app, add-ons, time and cost all fit", () => {
    expect(decide(req(), [issued()])).toEqual({ allow: true, via: "grant", grantId: GID });
  });
  it("needs a grant at all: none is a refusal that says what to grant", () => {
    const d = decide(req(), []);
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.gateStop.rule).toBe("grant-required");
    expect(d.errors[0]!.code).toBe("E_NOT_PERMITTED");
    expect(d.errors[0]!.message).toContain("grant-install");
    expect(d.errors[0]!.message).toContain("fakeapp");
    expect(d.errors[0]!.message).toContain("400 bytes to download and 2000 bytes on disk");
  });
  it("refuses another actor's grant, another app's, and a name that only looks alike", () => {
    expect(decide(req({ actor: { kind: "agent", name: "other-bot" } }), [issued()]).allow).toBe(false);
    expect(decide(req({ actor: { kind: "system", name: "setup-bot" } }), [issued()]).allow).toBe(false);
    expect(decide(req({ app: "otherapp" }), [issued()]).allow).toBe(false);
    expect(reasons(decide(req({ actor: { kind: "agent", name: "other-bot" } }), [issued()]))[0]).toContain("belongs to another actor");
  });
  it("refuses an add-on the grant does not name, and says which", () => {
    const d = decide(req({ components: ["fake-cad", "fake-nodal"] }), [issued()]);
    expect(d.allow).toBe(false);
    expect(reasons(d)[0]).toContain("does not cover fake-nodal");
  });
  it("a grant for the core only (no add-ons) allows a request with no add-ons and refuses one with an add-on", () => {
    const g = grant({ components: [] });
    expect(decide(req({ components: [] }), [issued(g)]).allow).toBe(true);
    expect(decide(req({ components: ["fake-cad"] }), [issued(g)]).allow).toBe(false);
  });
  it("is refused after the grant expired, before it is valid, and once revoked", () => {
    expect(reasons(decide(req(), [issued()], new Date(NOW.getTime() + 24 * 3600_000)))[0]).toContain("expired");
    expect(reasons(decide(req(), [issued()], new Date(NOW.getTime() - 1)))[0]).toContain("not valid yet");
    expect(reasons(decide(req(), [issued(), { type: "revoked", grantId: GID, by: human }]))[0]).toContain("revoked");
  });
  it("is refused when the grant was not approved by a human", () => {
    const forged = { ...grant(), approvedBy: agent };
    expect(reasons(decide(req(), [{ type: "issued", grant: forged }]))[0]).toContain("not approved by a human");
  });
  it("is refused when the cost is over the ceiling, in either number", () => {
    expect(decide(req({ cost: { downloadBytes: 1001, expandedBytes: 1 } }), [issued()]).allow).toBe(false);
    expect(decide(req({ cost: { downloadBytes: 1, expandedBytes: 5001 } }), [issued()]).allow).toBe(false);
    expect(decide(req({ cost: { downloadBytes: 1000, expandedBytes: 5000 } }), [issued()]).allow).toBe(true);
  });
  it("the ceiling is spent across requests: what earlier requests used is no longer left", () => {
    const events = [issued(), used({ downloadBytes: 700, expandedBytes: 1000 })];
    const d = decide(req({ cost: { downloadBytes: 400, expandedBytes: 100 } }), events);
    expect(d.allow).toBe(false);
    expect(reasons(d)[0]).toContain("300 bytes of download");
    expect(decide(req({ cost: { downloadBytes: 300, expandedBytes: 4000 } }), events).allow).toBe(true);
    expect(decide(req({ cost: { downloadBytes: 300, expandedBytes: 4001 } }), events).allow).toBe(false);
  });
  it("uses of another grant do not spend this one", () => {
    const other = "b".repeat(32);
    const events = [issued(), used({ downloadBytes: 999, expandedBytes: 4999 }, other)];
    expect(decide(req(), events).allow).toBe(true);
  });
  it("takes the first grant that fits when there are several", () => {
    const g2 = grant({ grantId: "c".repeat(32), ceiling: { downloadBytes: 100000, expandedBytes: 100000 } });
    const events = [issued(), used({ downloadBytes: 1000, expandedBytes: 5000 }), { type: "issued" as const, grant: g2 }];
    expect(decide(req(), events)).toEqual({ allow: true, via: "grant", grantId: "c".repeat(32) });
  });
  it("a human needs no grant; the system does", () => {
    expect(decide(req({ actor: human }), [])).toEqual({ allow: true, via: "human" });
    expect(decide(req({ actor: { kind: "system", name: "seed" } }), []).allow).toBe(false);
  });
});

describe("removal", () => {
  const rm = (actor: Actor): InstallRequest => req({ operation: "remove_component", actor, cost: { downloadBytes: 0, expandedBytes: 0 } });
  it("is for a human only", () => {
    expect(decide(rm(human), [])).toEqual({ allow: true, via: "human" });
  });
  it("is refused for an agent and for the system, grant or not", () => {
    for (const who of [agent, { kind: "system", name: "seed" } as Actor]) {
      const d = decide(rm(who), [issued()]);
      expect(d.allow).toBe(false);
      if (!d.allow) { expect(d.gateStop.rule).toBe("human-only"); expect(d.errors[0]!.message).toContain("human action"); }
    }
  });
  it("an operation that is not an install operation is refused", () => {
    const d = decide(req({ operation: "run_case" }), [issued()]);
    expect(!d.allow && d.errors[0]!.code).toBe("E_VERB_UNKNOWN");
  });
});

describe("foldGrants", () => {
  it("counts every use, ignores events of unknown grants, and keeps issue order", () => {
    const g2 = grant({ grantId: "d".repeat(32) });
    const s = foldGrants([issued(), { type: "issued", grant: g2 }, used({ downloadBytes: 1, expandedBytes: 2 }), used({ downloadBytes: 10, expandedBytes: 20 }), used({ downloadBytes: 5, expandedBytes: 5 }, "f".repeat(32)), { type: "revoked", grantId: "f".repeat(32), by: human }]);
    expect(s.map((x) => x.grant.grantId)).toEqual([GID, "d".repeat(32)]);
    expect(s[0]!.spent).toEqual({ downloadBytes: 11, expandedBytes: 22 });
    expect(s[1]!.spent).toEqual({ downloadBytes: 0, expandedBytes: 0 });
    expect(s.every((x) => !x.revoked)).toBe(true);
    expect(state(grant())[0]!.revoked).toBe(false);
  });
});
