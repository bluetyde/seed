// @covers R-INSTALL-06
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_VERBS, runAdminCli } from "../src/cli/admin";
import { runCli } from "../src/cli/seed";
import { CAD, CORE, LIBS, cleanWorlds } from "./helpers/installFixture";
import { makeHost } from "./helpers/installHostFixture";

// The verbs: the agent's CLI can ask for an install (`install-component`) but has no verb to grant, revoke, list or remove; the admin CLI has those,
// reads its own configuration variable, and still needs the configured actor to be a human.
afterEach(cleanWorlds);

const input = (v: unknown) => Readable.from([JSON.stringify(v)]);
const NODAL = { id: "fake-nodal", version: "0.1.0", kind: "addon" as const, dependsOn: [{ component: "fakeapp-core", min: "1.2.0" }] };
const host = () => makeHost([CORE(), LIBS(), CAD(), NODAL]);
const CEIL = { downloadBytes: 10_000_000, expandedBytes: 10_000_000 };
const asAgent = (h: ReturnType<typeof host>, argv: string[], request: unknown) => runCli(argv, input(request), undefined, undefined, h.agentFile);
const admin = (file: string | undefined, verb: string, request: unknown = {}) => runAdminCli([verb], input(request), undefined, undefined, file);
const code = (r: { reply: unknown }) => ((r.reply as { errors?: { code: string }[] }).errors ?? []).map((e) => e.code);

describe("the agent's CLI", () => {
  it("has install-component and no verb to grant, revoke, list or remove", async () => {
    const h = host();
    for (const verb of ["grant-install", "revoke-install-grant", "list-install-grants", "remove-component"]) {
      const r = await asAgent(h, [verb], {});
      expect(r.code).toBe(2);
      expect(code(r)).toEqual(["E_VERB_UNKNOWN"]);
    }
    const usage = JSON.stringify((await asAgent(h, ["nonsense"], {})).reply);
    expect(usage).toContain("install-component");
    expect(usage).not.toContain("grant-install");
  });
  it("needs SEED_INSTALL_HOST_CONFIG, and not the study host configuration", async () => {
    const r = await runCli(["install-component"], input({ app: "fakeapp", select: [] }), "/some/study-host.json", undefined, undefined);
    expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] } });
    expect(JSON.stringify(r.reply)).toContain("SEED_INSTALL_HOST_CONFIG");
  });
  it("without a grant it is refused with exit 2 and a reply that says what to grant", async () => {
    const h = host();
    const r = await asAgent(h, ["install-component"], { app: "fakeapp", select: ["fake-cad"] });
    expect(r.code).toBe(2);
    expect(r.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: false, errors: [{ code: "E_NOT_PERMITTED" }] });
    expect(JSON.stringify(r.reply)).toContain("grant-install");
  });
});

describe("the admin CLI", () => {
  it("lists the four install verbs", () => {
    for (const v of ["grant-install", "revoke-install-grant", "list-install-grants", "remove-component"]) expect(ADMIN_VERBS).toContain(v);
  });
  it("needs SEED_ADMIN_INSTALL_HOST_CONFIG for them", async () => {
    for (const verb of ["grant-install", "revoke-install-grant", "list-install-grants", "remove-component"]) {
      const r = await admin(undefined, verb);
      expect(code(r)).toEqual(["E_SETUP_REQUIRED"]);
      expect(JSON.stringify(r.reply)).toContain("SEED_ADMIN_INSTALL_HOST_CONFIG");
    }
  });
  it("is refused when the configured actor is not a human, for every install verb", async () => {
    const h = host();
    for (const [verb, req] of [["grant-install", { actor: { kind: "agent", name: "x" }, app: "fakeapp", components: [], ceiling: CEIL }], ["revoke-install-grant", { grantId: "a".repeat(32) }], ["list-install-grants", {}], ["remove-component", { app: "fakeapp", component: "fake-cad" }]] as const) {
      const r = await admin(h.agentFile, verb, req);
      expect(r.code).toBe(2);
      expect(code(r)).toEqual(["E_NOT_PERMITTED"]);
    }
  });
  it("the whole path: a person grants, the agent installs through its CLI, the person lists, revokes and removes", async () => {
    const h = host();
    const g = await admin(h.humanFile, "grant-install", { actor: { kind: "agent", name: "setup-bot" }, app: "fakeapp", components: ["fake-cad"], ceiling: CEIL, hours: 3 });
    expect(g).toMatchObject({ code: 0, reply: { schema: "seed.cli-reply/0.1", ok: true } });
    const grantId = (g.reply as { grant: { grantId: string } }).grant.grantId;

    const inst = await asAgent(h, ["install-component"], { app: "fakeapp", select: ["fake-cad"], requestId: "cli-1" });
    expect(inst.code).toBe(0);
    expect(inst.reply).toMatchObject({ ok: true, via: "grant", grantId });
    expect(fs.readFileSync(path.join(h.root, ".seed", "active", "fakeapp", "fake-cad"), "utf8").trim()).toBe("0.3.0");

    const list = await admin(h.humanFile, "list-install-grants");
    expect(list.code).toBe(0);
    expect((list.reply as { grants: { grantId: string; state: string; spent: { downloadBytes: number } }[] }).grants).toMatchObject([{ grantId, state: "active" }]);

    const gone = await admin(h.humanFile, "remove-component", { app: "fakeapp", component: "fake-cad" });
    expect(gone).toMatchObject({ code: 0, reply: { ok: true } });
    expect((gone.reply as { removed: string[] }).removed.sort()).toEqual(["fake-cad", "shared-libs"]);

    const rev = await admin(h.humanFile, "revoke-install-grant", { grantId, reason: "done" });
    expect(rev).toMatchObject({ code: 0, reply: { ok: true, grantId } });
    const again = await asAgent(h, ["install-component"], { app: "fakeapp", select: ["fake-cad"] });
    expect(again.code).toBe(2);
    expect(JSON.stringify(again.reply)).toContain("revoked");
  });
  it("the agent's variable does not reach the admin verbs: a human configuration passed as the agent's is still only the agent's CLI", async () => {
    const h = host();
    const r = await runCli(["install-component"], input({ app: "fakeapp", select: [] }), undefined, undefined, h.humanFile);
    expect(r.code).toBe(0); // a human at the agent CLI may install: that is a human using the verb the agent has
    const noGrantVerb = await runCli(["grant-install"], input({}), undefined, undefined, h.humanFile);
    expect(code(noGrantVerb)).toEqual(["E_VERB_UNKNOWN"]);
  });
});
