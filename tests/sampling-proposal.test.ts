// @covers R-STUDY-06, R-MCP-01
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { runCli } from "../src/cli/seed";
import { allCases, saveHostConfiguration } from "../src/core/fileRunHost";
import { runSamplingFromHostFile } from "../src/core/samplingHost";
import { appendProposalEvent, approvedSampling, definitionHash, foldProposals, readProposalLog } from "../src/core/samplingProposal";
import { approveSamplingFromHost, proposeSamplingFromHost, rejectSamplingFromHost, samplingProposalStatus } from "../src/core/samplingProposalHost";
import type { SamplingDefinition } from "../src/core/sampling";
import { connectSeedMcp } from "./helpers/mcp-client";
import { budget, fixture, fixtureDirs } from "./helpers/replayFixture";

// An agent may propose a sampling; nothing runs until a person approves exactly that proposal (docs/sampling.md, D12).
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const def = (over: Partial<SamplingDefinition> = {}): SamplingDefinition => ({
  base: "approved", design: { method: "lhs", n: 4, seed: 7 },
  parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 60 } }], outputs: [{ quantity: "out", reduce: "last" }], ...over
});
async function world() {
  const f = await fixture({ scenario: "response", maxCases: 40 });
  // a second configuration for the same host with a human identity: the person's copy
  const humanFile = join(f.root, "human-host.json");
  saveHostConfiguration(humanFile, { ...f.config, actor: { kind: "human", name: "the user" } });
  return { ...f, humanFile };
}
const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { if (!r.ok) throw new Error(JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
const msg = (r: { ok: boolean; errors?: { message: string }[] }) => (r.ok ? "" : r.errors!.map((e) => e.message).join("; "));
const code = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? "" : r.errors![0]!.code);

describe("proposing", () => {
  it("a valid proposal waits as pending, with the hash a person approves and the number of runs", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def(), note: "check the delay" }));
    expect(p).toMatchObject({ proposalId: "p1", state: "pending", runs: 4, definitionSha256: definitionHash(def()) });
    const s = must(samplingProposalStatus(w.file, { proposalId: "p1" }));
    expect(s.proposals[0]).toMatchObject({ state: "pending", note: "check the delay", proposedBy: { kind: "agent", name: "test-agent" } });
  });
  it("is checked as a registered sampling is: outside the study bounds, over the case limit, unknown parameter, bad design", async () => {
    const w = await world();
    expect(msg(proposeSamplingFromHost(w.file, { proposalId: "a", definition: def({ parameters: [{ id: "delayMs", distribution: { kind: "uniform", min: 10, max: 5000 } }] }) }))).toMatch(/leaves the study bounds/);
    expect(code(proposeSamplingFromHost(w.file, { proposalId: "b", definition: def({ design: { method: "sobol", n: 20, seed: 1 } }) }))).toBe("E_BUDGET_EXCEEDED");
    expect(msg(proposeSamplingFromHost(w.file, { proposalId: "c", definition: def({ parameters: [{ id: "nope", distribution: { kind: "uniform", min: 1, max: 2 } }] }) }))).toMatch(/not a parameter of the study/);
    expect(code(proposeSamplingFromHost(w.file, { proposalId: "d", definition: def({ base: "missing" }) }))).toBe("E_SCHEMA_INVALID");
    expect(samplingProposalStatus(w.file, {}).ok && must(samplingProposalStatus(w.file, {})).proposals).toEqual([]);
  });
  it("refuses an id that is already a case, a proposal or a registered sampling, an extra field, and a bad id", async () => {
    const w = await world();
    expect(code(proposeSamplingFromHost(w.file, { proposalId: "approved", definition: def() }))).toBe("E_REQUEST_CONFLICT");
    must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    expect(msg(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }))).toMatch(/used before/);
    expect(code(proposeSamplingFromHost(w.file, { proposalId: "p2", definition: def(), approve: true }))).toBe("E_SCHEMA_INVALID");
    expect(code(proposeSamplingFromHost(w.file, { proposalId: "../x", definition: def() }))).toBe("E_SCHEMA_INVALID");
  });
  it("refuses an id whose points would take the id of a case that is registered (p-001 of a case named p-001)", async () => {
    const w = await world();
    saveHostConfiguration(w.file, { ...w.config, cases: { ...w.config.cases, "clash-001": w.config.cases.approved! } });
    expect(msg(proposeSamplingFromHost(w.file, { proposalId: "clash", definition: def() }))).toMatch(/clash-001 of this proposal has the id of a case/);
  });
  it("an agent has at most ten proposals waiting", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) must(proposeSamplingFromHost(w.file, { proposalId: `p${i}`, definition: def() }));
    expect(msg(proposeSamplingFromHost(w.file, { proposalId: "p10", definition: def() }))).toMatch(/10 proposals waiting/);
  });
});

describe("approving", () => {
  it("only a human host identity can: the agent's configuration is refused, and the agent CLI has no such verb", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    expect(msg(approveSamplingFromHost(w.file, { proposalId: "p1", definitionSha256: p.definitionSha256 }))).toMatch(/only by a human/);
    expect(msg(rejectSamplingFromHost(w.file, { proposalId: "p1" }))).toMatch(/only by a human/);
    const cli = await runCli(["approve-sampling"], Readable.from(["{}"]), w.file);
    expect(cli.code).toBe(2);
    expect(JSON.stringify(cli.reply)).toContain("E_VERB_UNKNOWN");
    expect(must(samplingProposalStatus(w.file, { proposalId: "p1" })).proposals[0]!.state).toBe("pending");
  });
  it("must name the hash of the proposal read; a different hash, an unknown id and a decided proposal are refused", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    expect(msg(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: "0".repeat(64) }))).toMatch(/not the one of this proposal/);
    expect(msg(approveSamplingFromHost(w.humanFile, { proposalId: "nope", definitionSha256: p.definitionSha256 }))).toMatch(/no proposal/);
    must(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }));
    expect(msg(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }))).toMatch(/already approved/);
    expect(msg(rejectSamplingFromHost(w.humanFile, { proposalId: "p1" }))).toMatch(/already approved/);
  });
  it("is refused when the proposal no longer fits the host (the study bounds were narrowed after it was proposed)", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    saveHostConfiguration(w.humanFile, { ...w.config, actor: { kind: "human", name: "the user" }, study: { ...w.config.study, parameters: [{ id: "delayMs", min: 0, max: 30 }] } });
    expect(msg(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }))).toMatch(/no longer fits this host/);
  });
  it("is refused when a case registered since the proposal has the id of one of its points", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    const mine = { ...w.config.cases.approved!, settings: { ...(w.config.cases.approved!.settings as object), delayMs: 999 } };
    saveHostConfiguration(w.humanFile, { ...w.config, actor: { kind: "human", name: "the user" }, cases: { ...w.config.cases, "p1-001": mine } });
    expect(msg(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }))).toMatch(/p1-001 of this proposal now has the id of a case/);
    expect(w.config.cases["p1-001"]).toBeUndefined();
  });
  it("works through the admin CLI: list, approve, reject", async () => {
    const w = await world();
    const a = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    must(proposeSamplingFromHost(w.file, { proposalId: "p2", definition: def() }));
    const list = await runAdminCli(["list-sampling-proposals"], Readable.from(["{}"]), w.humanFile);
    expect(list.code).toBe(0);
    expect((list.reply as { proposals: unknown[] }).proposals).toHaveLength(2);
    expect((await runAdminCli(["approve-sampling"], Readable.from([JSON.stringify({ proposalId: "p1", definitionSha256: a.definitionSha256 })]), w.humanFile)).code).toBe(0);
    expect((await runAdminCli(["reject-sampling"], Readable.from([JSON.stringify({ proposalId: "p2", reason: "too few points" })]), w.humanFile)).code).toBe(0);
    const s = must(samplingProposalStatus(w.file, {})).proposals;
    expect(s.map((x) => x.state)).toEqual(["approved", "rejected"]);
    expect(s[0]!.decidedBy).toMatchObject({ kind: "human", name: "the user" });
    expect(s[1]!.reason).toBe("too few points");
  });
});

describe("running", () => {
  it("an approved proposal runs under its id; the summary and the log are those of any sampling", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    must(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }));
    const r = await runSamplingFromHostFile(w.file, { requestId: "r1", samplingId: "p1", budget });
    expect(r.ok ? [r.complete, r.stoppedAt, r.results.map((x) => x.state)] : JSON.stringify(r)).toEqual([true, undefined, ["completed", "completed", "completed", "completed"]]);
    if (!r.ok) return;
    expect(r.samplingId).toBe("p1");
    expect(r.results).toHaveLength(4);
    expect(r.summary.outputs[0]).toMatchObject({ n: 4 });
  }, 120000);
  it("a pending, a rejected, a withdrawn-by-nobody and an unknown id do not run: nothing is launched", async () => {
    const w = await world();
    must(proposeSamplingFromHost(w.file, { proposalId: "pending", definition: def() }));
    const rej = must(proposeSamplingFromHost(w.file, { proposalId: "rejected", definition: def() }));
    expect(rej.state).toBe("pending");
    must(rejectSamplingFromHost(w.humanFile, { proposalId: "rejected" }));
    for (const id of ["pending", "rejected", "unknown"]) {
      const r = await runSamplingFromHostFile(w.file, { requestId: `r-${id}`, samplingId: id, budget });
      expect(r.ok).toBe(false);
    }
    expect(readFileSync(join(w.state, "samplings.jsonl"), "utf8").includes("\"phase\":\"summary\"")).toBe(false);
  }, 60000);
  it("a sampling whose point id was taken by a case after approval is refused whole: the other case is not run under the point's values", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    must(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }));
    const mine = { ...w.config.cases.approved!, settings: { ...(w.config.cases.approved!.settings as object), delayMs: 999 } };
    saveHostConfiguration(w.file, { ...w.config, cases: { ...w.config.cases, "p1-001": mine } });
    const r = await runSamplingFromHostFile(w.file, { requestId: "r-clash", samplingId: "p1", budget });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors[0]!.code).toBe("E_REQUEST_CONFLICT");
    expect(r.ok ? "" : r.errors[0]!.message).toMatch(/p1-001 of the sampling p1 is not the case registered under that id/);
  }, 60000);
  it("a case the host registers later under the id of an approved point keeps its own definition", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    must(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }));
    const mine = { ...w.config.cases.approved!, settings: { ...(w.config.cases.approved!.settings as object), delayMs: 999 } };
    const c = { ...w.config, cases: { ...w.config.cases, "p1-001": mine } };
    expect(allCases(c as never)["p1-001"]).toEqual(mine);
    expect(allCases(c as never)["p1-002"]).toBeDefined();
  });
  it("a proposal log that was edited is refused as a whole: nothing runs under it", async () => {
    const w = await world();
    const p = must(proposeSamplingFromHost(w.file, { proposalId: "p1", definition: def() }));
    must(approveSamplingFromHost(w.humanFile, { proposalId: "p1", definitionSha256: p.definitionSha256 }));
    const file = join(w.state, "sampling-proposals.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"n":4', '"n":3'));
    const r = await runSamplingFromHostFile(w.file, { requestId: "r1", samplingId: "p1", budget });
    expect(r.ok).toBe(false);
    expect(() => readProposalLog(w.state)).toThrow(/hash chain|does not match/);
  }, 60000);
});

describe("the log itself", () => {
  const actor = { kind: "agent", name: "bot" };
  it("refuses a decision for a proposal nobody made, a second decision, an approval for another definition, and a proposal twice", async () => {
    const w = await world();
    const d = def();
    const add = (event: Parameters<typeof appendProposalEvent>[1] extends (r: never) => infer R ? R extends { event: infer E } ? E : never : never) => appendProposalEvent(w.state, () => ({ event, value: 1 }));
    expect(add({ type: "approved", proposalId: "ghost", by: actor, definitionSha256: "0".repeat(64) }).ok).toBe(true); // the append itself does not judge: the reader does
    expect(() => readProposalLog(w.state)).toThrow(/not made before/);
    rmSync(join(w.state, "sampling-proposals.jsonl"));
    add({ type: "proposed", proposalId: "p", actor, definition: d, definitionSha256: definitionHash(d) });
    add({ type: "proposed", proposalId: "p", actor, definition: d, definitionSha256: definitionHash(d) });
    expect(() => readProposalLog(w.state)).toThrow(/twice/);
    rmSync(join(w.state, "sampling-proposals.jsonl"));
    add({ type: "proposed", proposalId: "p", actor, definition: d, definitionSha256: definitionHash(d) });
    add({ type: "approved", proposalId: "p", by: actor, definitionSha256: "1".repeat(64) });
    expect(() => readProposalLog(w.state)).toThrow(/not for the definition that was proposed/);
    rmSync(join(w.state, "sampling-proposals.jsonl"));
    add({ type: "proposed", proposalId: "p", actor, definition: { ...d, design: { ...d.design, n: 9 } }, definitionSha256: definitionHash(d) });
    expect(() => readProposalLog(w.state)).toThrow(/does not match its own hash/);
    rmSync(join(w.state, "sampling-proposals.jsonl"));
    add({ type: "proposed", proposalId: "p", actor, definition: d, definitionSha256: definitionHash(d) });
    add({ type: "rejected", proposalId: "p", by: actor });
    add({ type: "approved", proposalId: "p", by: actor, definitionSha256: definitionHash(d) });
    expect(() => readProposalLog(w.state)).toThrow(/decides p twice/);
    expect(() => approvedSampling(w.state, "p")).toThrow(/decides p twice/); // nothing is registered under a damaged log
  });
  it("folds the state of each proposal in the order they were made", async () => {
    const w = await world();
    const d = def();
    appendProposalEvent(w.state, () => ({ event: { type: "proposed" as const, proposalId: "a", actor, definition: d, definitionSha256: definitionHash(d) }, value: 1 }));
    appendProposalEvent(w.state, () => ({ event: { type: "proposed" as const, proposalId: "b", actor, definition: d, definitionSha256: definitionHash(d) }, value: 1 }));
    appendProposalEvent(w.state, () => ({ event: { type: "approved" as const, proposalId: "b", by: { kind: "human", name: "x" }, definitionSha256: definitionHash(d) }, value: 1 }));
    expect(foldProposals(readProposalLog(w.state)).map((p) => [p.proposalId, p.state])).toEqual([["a", "pending"], ["b", "approved"]]);
    expect(approvedSampling(w.state, "b")).toEqual(d);
    expect(approvedSampling(w.state, "a")).toBeUndefined();
  });
});

describe("the MCP tools (these start dist/ code: run npm run build first)", () => {
  it("seed_propose_sampling and seed_sampling_status exist, take strict input, and a proposal made through them is pending; no tool approves", async () => {
    const w = await world();
    const m = await connectSeedMcp(w.file);
    try {
      const tools = (await m.client.listTools()).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain("seed_propose_sampling");
      expect(names).toContain("seed_sampling_status");
      expect(names.some((n) => /approve|reject/.test(n) && /sampling/.test(n))).toBe(false);
      expect(tools.find((t) => t.name === "seed_propose_sampling")!.inputSchema.additionalProperties).toBe(false);
      const r = await m.client.callTool({ name: "seed_propose_sampling", arguments: { proposalId: "mcp1", definition: def() } });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({ ok: true, state: "pending", runs: 4 });
      const s = await m.client.callTool({ name: "seed_sampling_status", arguments: {} });
      expect((s.structuredContent as { proposals: { proposalId: string }[] }).proposals.map((p) => p.proposalId)).toEqual(["mcp1"]);
      const bad = await m.client.callTool({ name: "seed_propose_sampling", arguments: { proposalId: "mcp2", definition: def(), approved: true } }).then((x) => x, (e) => e);
      expect((bad as { isError?: boolean }).isError === true || bad instanceof Error).toBe(true);
    } finally { await m.client.close(); }
  }, 120000);
});
