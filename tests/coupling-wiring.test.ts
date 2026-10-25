// @covers R-STUDY-09
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/seed";
import { PASS_BUILDERS } from "../src/core/couplingHost";
import { agent, couplingFixture, coupledDirs, human } from "./helpers/couplingFixture";
import { connectSeedMcp } from "./helpers/mcp-client";
import { fixture, fixtureDirs } from "./helpers/replayFixture";

// How an agent reaches a coupling loop: the CLI verb `couple` and the MCP tool `seed_run_coupling`. Both take { requestId, loopId } and nothing else, both
// use the host file named by the trusted environment (SEED_COUPLING_HOST_CONFIG), and neither can give a grant. The MCP tests start dist/ code: run
// `npm run build` first.
afterEach(() => { for (const d of [...coupledDirs.splice(0), ...fixtureDirs.splice(0)]) rmSync(d, { recursive: true, force: true }); });
const asked = (o: Record<string, unknown> = {}) => ({ requestId: "r1", loopId: "lumped", ...o });
const cli = (coupling: string | undefined, request: unknown) => runCli(["couple"], Readable.from([JSON.stringify(request)]), undefined, undefined, undefined, coupling) as Promise<{ code: number; reply: any }>;
const first = (r: { reply: any }) => `${r.reply.errors?.[0]?.code} ${r.reply.errors?.[0]?.field}`;

describe("the CLI verb couple", () => {
  it("needs the trusted environment to name a coupling host", async () => {
    const r = await cli(undefined, asked());
    expect(r.code).toBe(2);
    expect(first(r)).toBe("E_SETUP_REQUIRED ");
    expect(r.reply.errors[0].message).toContain("SEED_COUPLING_HOST_CONFIG");
  });

  it("is in the usage line the CLI gives for an unknown verb", async () => {
    const r = (await runCli(["nonsense"], Readable.from(["{}"]))) as { reply: any };
    expect(r.reply.errors[0].message).toContain("|couple|");
  });

  it("refuses an agent that has no grant, with the gate's reason, before any app is touched", async () => {
    const f = await couplingFixture();
    f.write(agent, []);
    const r = await cli(f.file, asked());
    expect(r.code).toBe(2);
    expect(first(r)).toBe("E_NOT_PERMITTED /operation");
    expect(r.reply.errors[0].message).toMatch(/needs a human grant/);
  });

  it("with a grant, refuses a loop whose apps have no runner and transfer command before pass 1, saying which", async () => {
    const f = await couplingFixture();
    f.write(agent, [f.grant()]);
    const r = await cli(f.file, asked());
    expect(r.code).toBe(2);
    expect(first(r)).toBe("E_SETUP_REQUIRED /apps/openmc/transfer");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an unknown loop", { loopId: "nope" }, "E_NOT_FOUND /loopId"],
    ["a field the request does not take", { relaxation: 0.5 }, "E_SCHEMA_INVALID "],
    ["a request id that is not an id", { requestId: "../x" }, "E_SCHEMA_INVALID "],
  ])("refuses %s", async (_n, over, expected) => {
    const f = await couplingFixture();
    f.write(agent, [f.grant()]);
    const r = await cli(f.file, asked(over));
    expect(r.code).toBe(2);
    expect(first(r)).toBe(expected);
  });

  it("exits 0 for a loop that converged and 1 for one that ran and did not, and gives no result for the second", async () => {
    const f = await couplingFixture();
    const edit = (c: any) => { c.loops.lumped.kind = "scripted"; c.loops.lumped.definition.maxPasses = 8; };
    f.write(agent, [f.grant(edit)], edit);
    try {
      PASS_BUILDERS.scripted = () => async (it) => ({ ok: true, calc: { temperature_fuel_mean: 0.01 * (it.temperature_fuel_mean as number) + 500 } });
      const converged = await cli(f.file, asked({ requestId: "r-converge", loopId: "lumped" }));
      expect(converged.code).toBe(0);
      expect(converged.reply).toMatchObject({ ok: true, outcome: { state: "converged" }, verification: "unverified" });
      PASS_BUILDERS.scripted = () => async (it) => ({ ok: true, calc: { temperature_fuel_mean: (it.temperature_fuel_mean as number) + 100 } });
      const stuck = await cli(f.file, asked({ requestId: "r-stuck" }));
      expect(stuck.code).toBe(1);
      expect(stuck.reply).toMatchObject({ ok: true, outcome: { state: "not-converged" } });
      expect(stuck.reply.outcome.result).toBeUndefined();
    } finally { delete PASS_BUILDERS.scripted; }
  }, 60000);

  it("a host whose actor is a human is the person acting: the same refusal comes from the missing commands, not from a grant", async () => {
    const f = await couplingFixture();
    f.write(human, []);
    const r = await cli(f.file, asked());
    expect(first(r)).toBe("E_SETUP_REQUIRED /apps/openmc/transfer");
  });
});

describe("the MCP tool seed_run_coupling (dist/)", () => {
  it("is listed only when the trusted environment names a coupling host, with a strict input of requestId and loopId", async () => {
    const f = await fixture({ scenario: "response" });
    const c = await couplingFixture();
    c.write(agent, []);
    const without = await connectSeedMcp(f.file);
    try { expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain("seed_run_coupling"); } finally { await without.client.close(); }
    const withIt = await connectSeedMcp(f.file, { SEED_COUPLING_HOST_CONFIG: c.file });
    try {
      const tool = (await withIt.client.listTools()).tools.find((t) => t.name === "seed_run_coupling");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual(["loopId", "requestId"]);
    } finally { await withIt.client.close(); }
  }, 90000);

  it("answers a refusal as an error with the gate's code, and refuses an argument it does not take before the host", async () => {
    const f = await fixture({ scenario: "response" });
    const c = await couplingFixture();
    c.write(agent, []);
    const m = await connectSeedMcp(f.file, { SEED_COUPLING_HOST_CONFIG: c.file });
    try {
      const r = await m.client.callTool({ name: "seed_run_coupling", arguments: asked() });
      expect(r.isError).toBe(true);
      expect((r.structuredContent as any).errors[0].code).toBe("E_NOT_PERMITTED");
      const bad = await m.client.callTool({ name: "seed_run_coupling", arguments: asked({ relaxation: 0.5 }) }).then((x) => x, (e: Error) => e);
      expect(bad instanceof Error || (bad as { isError?: boolean }).isError === true).toBe(true);
    } finally { await m.client.close(); }
  }, 90000);
});
