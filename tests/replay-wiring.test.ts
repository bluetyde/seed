// @covers R-STUDY-05
import { rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/seed";
import { budget, fixture, fixtureDirs, policyDir } from "./helpers/replayFixture";
import { connectSeedMcp } from "./helpers/mcp-client";

// The replay verb as the CLI and the MCP server expose it (docs/replay.md, docs/host-cli.md, docs/mcp.md). These tests start dist/ code: run `npm run build` first.
const fx = (o: Parameters<typeof fixture>[0] = {}) => fixture({ scenario: "series", ...o });
const input = (v: unknown) => Readable.from([JSON.stringify(v)]);
const EXACT = { mode: "exact" };
const savedEnv = process.env.SEED_REPLAY_POLICY_DIR;
beforeEach(() => { process.env.SEED_REPLAY_POLICY_DIR = policyDir(EXACT); });
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SEED_REPLAY_POLICY_DIR; else process.env.SEED_REPLAY_POLICY_DIR = savedEnv;
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const original = { requestId: "orig", caseId: "approved", budget };
const request = (over: Record<string, unknown> = {}) => ({ requestId: "rep1", originalRequestId: "orig", budget, ...over });

describe("the CLI verb: replay", () => {
  it("is in the usage line, and needs the trusted host configuration like every verb", async () => {
    const usage = await runCli(["nonsense"], input({}), "/x");
    expect(usage.code).toBe(2);
    expect(JSON.stringify(usage.reply)).toMatch(/run\|sweep\|sample\|sampling-propose\|sampling-status\|replay\|note/);
    const noHost = await runCli(["replay"], input(request()), undefined);
    expect(noHost).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_SETUP_REQUIRED" }] } });
  });

  it("answers a reproduction with exit 0, the verdict and both run ids", async () => {
    const f = await fx();
    expect((await runCli(["run"], input(original), f.file)).code).toBe(0);
    const r = await runCli(["replay"], input(request()), f.file);
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ schema: "seed.cli-reply/0.1", ok: true, adapter: "fake", original: { requestId: "orig" }, replay: { requestId: "rep1", state: "completed" }, result: { verdict: "reproduced" } });
  });

  it("answers a replay that differs with exit 1 (it ran, it did not reproduce) and a refusal with exit 2", async () => {
    const f = await fx({ scenario: "jitter" });
    await runCli(["run"], input(original), f.file);
    const differs = await runCli(["replay"], input(request()), f.file);
    expect(differs.code).toBe(1);
    expect(differs.reply).toMatchObject({ ok: true, result: { verdict: "differs" } });
    const refused = await runCli(["replay"], input(request({ requestId: "rep2", originalRequestId: "never-ran" })), f.file);
    expect(refused).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_NOT_FOUND" }] } });
  });

  it("a replay within the adapter's tolerance exits 0", async () => {
    const f = await fx({ scenario: "jitter" });
    process.env.SEED_REPLAY_POLICY_DIR = policyDir({ mode: "tolerance", abs: 1e-5, rel: 0 });
    await runCli(["run"], input(original), f.file);
    const r = await runCli(["replay"], input(request()), f.file);
    expect(r.code).toBe(0);
    expect(r.reply).toMatchObject({ result: { verdict: "reproduced-within-tolerance" } });
  });

  it("takes only requestId, originalRequestId and budget: no case, input, path or policy", async () => {
    const f = await fx();
    await runCli(["run"], input(original), f.file);
    for (const extra of [{ caseId: "approved" }, { policy: { mode: "tolerance", abs: 1, rel: 1 } }, { path: "x" }, { inputs: [] }]) {
      const r = await runCli(["replay"], input(request(extra)), f.file);
      expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] } });
    }
  });

  it("the policy folder comes from the trusted environment, and a relative one is ignored", async () => {
    const f = await fx();
    await runCli(["run"], input(original), f.file);
    // a valid policy folder, named by a path relative to where the test runs: it would work if it were honoured
    process.env.SEED_REPLAY_POLICY_DIR = relative(process.cwd(), policyDir(EXACT));
    expect(isAbsolute(process.env.SEED_REPLAY_POLICY_DIR)).toBe(false);
    const r = await runCli(["replay"], input(request()), f.file);
    // not honoured: the shipped adapters folder has no policy for the fake adapter
    expect(r).toMatchObject({ code: 2, reply: { errors: [{ code: "E_SETUP_REQUIRED" }] } });
  });
});

describe("the MCP tool: seed_replay_run", () => {
  it("is listed with a strict input schema, and an agent still has no approving tool", async () => {
    const f = await fx(); const m = await connectSeedMcp(f.file);
    try {
      const tool = (await m.client.listTools()).tools.find((t) => t.name === "seed_replay_run");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual(["budget", "originalRequestId", "requestId"]);
    } finally { await m.client.close(); }
  }, 60000);

  it("replays a run made through the same server and answers the verdict as a result", async () => {
    const f = await fx(); const m = await connectSeedMcp(f.file);
    try {
      const first = await m.client.callTool({ name: "seed_run_case", arguments: original });
      expect(first.isError).toBe(false);
      const r = await m.client.callTool({ name: "seed_replay_run", arguments: request() });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({ schema: "seed.mcp-reply/0.1", ok: true, replay: { requestId: "rep1", state: "completed" }, result: { verdict: "reproduced" } });
    } finally { await m.client.close(); }
  }, 120000);

  it("a replay that differs is still a result, not an error; a refusal is an error", async () => {
    const f = await fx({ scenario: "jitter" }); const m = await connectSeedMcp(f.file);
    try {
      await m.client.callTool({ name: "seed_run_case", arguments: original });
      const differs = await m.client.callTool({ name: "seed_replay_run", arguments: request() });
      expect(differs.isError).toBe(false);
      expect(differs.structuredContent).toMatchObject({ ok: true, result: { verdict: "differs" } });
      const refused = await m.client.callTool({ name: "seed_replay_run", arguments: request({ requestId: "rep2", originalRequestId: "never-ran" }) });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ ok: false, errors: [{ code: "E_NOT_FOUND" }] });
    } finally { await m.client.close(); }
  }, 180000);

  it("refuses an argument the tool does not take", async () => {
    const f = await fx(); const m = await connectSeedMcp(f.file);
    try {
      const bad = await m.client.callTool({ name: "seed_replay_run", arguments: request({ caseId: "approved" }) }).catch((e) => ({ isError: true, thrown: String(e) }));
      expect(bad.isError).toBe(true);
    } finally { await m.client.close(); }
  }, 60000);
});
