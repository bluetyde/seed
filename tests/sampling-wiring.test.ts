// @covers R-STUDY-06
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/seed";
import { budget, fixture, fixtureDirs } from "./helpers/replayFixture";

// The sample verb of the agent CLI (docs/sampling.md, docs/host-cli.md): a registered sampling and a budget; no value, distribution or seed.
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const input = (v: unknown) => Readable.from([JSON.stringify(v)]);
const samplings = { uq: { base: "approved", design: { method: "lhs" as const, n: 4, seed: 7 }, parameters: [{ id: "delayMs", distribution: { kind: "uniform" as const, min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" as const }] } };
const request = { requestId: "cli1", samplingId: "uq", budget };

describe("the sample verb", () => {
  it("is in the usage line and needs the trusted host configuration like every verb", async () => {
    const usage = await runCli(["nonsense"], input({}), "/x");
    expect(JSON.stringify(usage.reply)).toContain("run|sweep|sample|replay");
    expect(await runCli(["sample"], input(request), undefined)).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] } });
  });
  it("runs a registered sampling: exit 0, the cases, the summary, the caveats", async () => {
    const f = await fixture({ scenario: "response", maxCases: 10, samplings });
    const r = await runCli(["sample"], input(request), f.file);
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, samplingId: "uq", complete: true });
    const reply = r.reply as { results: unknown[]; summary: { outputs: { n: number; noise: { kind: string } }[]; caveats: string } };
    expect(reply.results).toHaveLength(4);
    expect(reply.summary.outputs[0]).toMatchObject({ n: 4, noise: { kind: "statistical" } });
    expect(reply.summary.caveats).toContain("never added");
  }, 120000);
  it("exits 1 when the run stopped early (a point failed), like a sweep", async () => {
    const f = await fixture({ scenario: "crash", maxCases: 10, samplings });
    const r = await runCli(["sample"], input(request), f.file);
    expect(r.code).toBe(1);
    expect(r.reply).toMatchObject({ ok: true, complete: false });
  }, 180000);
  it("refuses a sampling that is not registered, and a request that carries a value or a seed: exit 2", async () => {
    const f = await fixture({ scenario: "response", maxCases: 10, samplings });
    expect((await runCli(["sample"], input({ ...request, samplingId: "nope" }), f.file)).code).toBe(2);
    for (const extra of [{ seed: 1 }, { values: [1] }, { parameters: [] }, { n: 100 }]) {
      const r = await runCli(["sample"], input({ ...request, ...extra }), f.file);
      expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] } });
    }
  });
});
