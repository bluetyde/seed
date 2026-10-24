// @covers R-MCP-01, R-STUDY-06
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { budget, fixture, fixtureDirs } from "./helpers/replayFixture";
import { connectSeedMcp } from "./helpers/mcp-client";

// The MCP tool seed_run_sampling (docs/mcp.md, docs/sampling.md): a registered sampling and a budget, held by a detached owner like a run.
// These tests start dist/ code: run `npm run build` first.
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const samplings = { uq: { base: "approved", design: { method: "lhs" as const, n: 4, seed: 7 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform" as const, min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" as const }] } };
const request = (over: Record<string, unknown> = {}) => ({ requestId: "m1", samplingId: "uq", budget, ...over });

describe("the MCP tool: seed_run_sampling", () => {
  it("is listed with a strict input schema that has no value, distribution, seed or count", async () => {
    const f = await fixture({ scenario: "response", maxCases: 10, samplings });
    const m = await connectSeedMcp(f.file);
    try {
      const tool = (await m.client.listTools()).tools.find((t) => t.name === "seed_run_sampling");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual(["budget", "requestId", "samplingId"]);
    } finally { await m.client.close(); }
  }, 60000);

  it("runs a registered sampling and answers the summary, with the noise and the spread as separate figures; the owner is not this test and not the server", async () => {
    const f = await fixture({ scenario: "response-noise", maxCases: 10, samplings });
    const m = await connectSeedMcp(f.file);
    try {
      const r = await m.client.callTool({ name: "seed_run_sampling", arguments: request() });
      expect(r.isError).toBe(false);
      const body = r.structuredContent as { schema: string; ok: boolean; complete: boolean; results: unknown[]; summary: { outputs: { n: number; noise: { kind: string; rms: number | null }; inputSpread: number | null }[] } };
      expect(body).toMatchObject({ schema: "seed.mcp-reply/0.1", ok: true, complete: true });
      expect(body.results).toHaveLength(4);
      expect(body.summary.outputs[0]).toMatchObject({ n: 4, noise: { kind: "statistical", rms: 0.25 } });
      expect(body.summary.outputs[0]!.inputSpread).toBeGreaterThan(0);
    } finally { await m.client.close(); }
  }, 180000);

  it("a sampling that is not registered is an error; an argument the tool does not take is refused before the host", async () => {
    const f = await fixture({ scenario: "response", maxCases: 10, samplings });
    const m = await connectSeedMcp(f.file);
    try {
      const none = await m.client.callTool({ name: "seed_run_sampling", arguments: request({ samplingId: "other" }) });
      expect(none.isError).toBe(true);
      expect(none.structuredContent).toMatchObject({ ok: false, errors: [{ code: "E_NOT_PERMITTED" }] });
      for (const extra of [{ seed: 1 }, { n: 100 }, { values: [1] }, { parameters: [] }]) {
        const bad = await m.client.callTool({ name: "seed_run_sampling", arguments: request(extra) }).catch((e) => ({ isError: true, thrown: String(e) }));
        expect(bad.isError).toBe(true);
      }
    } finally { await m.client.close(); }
  }, 120000);
});
