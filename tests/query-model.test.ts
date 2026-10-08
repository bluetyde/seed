import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/seed";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import { saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { readAdmissions } from "../src/core/hostFiles";
import { createProject } from "../src/core/projectStore";
import { connectSeedMcp } from "./helpers/mcp-client";
import { queryFromHostFile, MAX_QUERY_BYTES } from "../src/core/queryHost";

// `query_model` (docs/query-model.md): a registered model is asked read-only questions. The host side is tested with a stub adapter (every refusal
// and every way an adapter can misbehave); the four plan questions are tested against the real NODAL runner when it is there, through the host
// function, the CLI and the MCP tool, with answers known by inspection of a hand-built model.

const dirs: string[] = [];
const saved = { mode: process.env.QUERY_STUB_MODE, py: process.env.SEED_NODAL_PYTHON, repo: process.env.SEED_NODAL_REPO };
afterEach(() => {
  for (const [k, v] of [["QUERY_STUB_MODE", saved.mode], ["SEED_NODAL_PYTHON", saved.py], ["SEED_NODAL_REPO", saved.repo]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-query-"));
  dirs.push(d);
  return d;
};
const agent = { kind: "agent", name: "bot", model: "fixture" } as const;
const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };

function host(opts: { adapter: { id: string; command: string; args: string[] }; modelPath: string; modelText: string; tier?: "A0" | "A1"; actor?: HostConfiguration["actor"] }) {
  const root = tmp();
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state);
  expect(createProject(project, { name: "Query fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  mkdirSync(join(project, "models", "m"), { recursive: true });
  writeFileSync(join(project, opts.modelPath), opts.modelText);
  const hash = sha256Hex(opts.modelText);
  const inputs = [{ path: opts.modelPath, sha256: hash }];
  const dummy = join(root, "dummy.json");
  writeFileSync(dummy, "{}");
  const config = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: opts.adapter.id, version: "0.1.0", command: opts.adapter.command, args: opts.adapter.args }, actor: opts.actor ?? agent,
    study: { studyId: "s1", tier: opts.tier ?? "A0", budget, parameters: [] },
    cases: { approved: { artifact: { path: opts.modelPath, revision: { hash, counter: 1 } }, inputs, params: [], settings: {} } },
    runtime: { path: dummy, sha256: sha256Hex("{}") },
    oracles: { repository: root, entriesDir: root, inputsRoot: root, evidenceFile: dummy, evidenceSha256: sha256Hex("{}") },
    acceptedPins: { appCommit: "0".repeat(40), oracleFiles: [{ oracleId: "dummy", entryVersion: 1, sha256: "0".repeat(64) }] },
  } as unknown as HostConfiguration;
  const hostFile = join(root, "host.json");
  saveHostConfiguration(hostFile, config);
  const logDir = () => join(state, "queries");
  const logRows = () => {
    if (!existsSync(logDir())) return [];
    const sub = readdirSync(logDir())[0];
    return sub ? readAdmissions(join(logDir(), sub)) : [];
  };
  return { root, project, state, hostFile, hash, inputs, config, logRows, model: join(project, opts.modelPath), ask: (q: unknown, extra: Record<string, unknown> = {}) => queryFromHostFile(hostFile, { requestId: "q1", caseId: "approved", query: q, ...extra }) };
}

const stubAdapter = { id: "stub", command: process.execPath, args: [resolve(__dirname, "fixtures/query-adapter/cli.cjs")] };
const stubHost = (over: Partial<Parameters<typeof host>[0]> = {}) => host({ adapter: stubAdapter, modelPath: "models/m/model.json", modelText: '{"a":1}\n', ...over });
const errs = (o: any) => (o.ok ? [] : o.errors.map((e: any) => e.code));

describe("query_model with a stub adapter: what the host checks", () => {
  it("answers, with the model's hash and a receipt, and writes a chained record of the question before answering", async () => {
    const f = stubHost();
    const o: any = await f.ask({ op: "summary" });
    expect(o).toMatchObject({ ok: true, caseId: "approved", modelSha256: f.hash, answer: { echo: { op: "summary" }, bytes: 8 } });
    const rows = f.logRows();
    expect(rows).toHaveLength(1);
    expect(o.receipt).toEqual({ seq: 1, hash: rows[0]!.hash });
    expect((rows[0]!.event as any).event).toMatchObject({ requestId: "q1", caseId: "approved", model: { path: "models/m/model.json", sha256: f.hash }, ok: true, queryHash: sha256Hex(canonicalJson({ op: "summary" })) });
    expect((rows[0]!.event as any).event.answerHash).toBe(sha256Hex(canonicalJson(o.answer)));
    await f.ask({ op: "summary" }, { requestId: "q2" });
    expect(f.logRows().map((r) => r.seq)).toEqual([1, 2]);
  });

  it("is read-only: the model file and the project folder are byte for byte what they were", async () => {
    const f = stubHost();
    const listing = () => readdirSync(f.project, { recursive: true }).map(String).sort().join("|");
    const before = { model: readFileSync(f.model, "utf8"), listing: listing() };
    expect((await f.ask({ op: "summary" }) as any).ok).toBe(true);
    expect(readFileSync(f.model, "utf8")).toBe(before.model);
    expect(listing()).toBe(before.listing);
  });

  it.each([
    ["a path instead of a case id", { requestId: "q1", path: "models/m/model.json", query: {} }],
    ["an actor", { requestId: "q1", caseId: "approved", query: {}, actor: { kind: "human", name: "x" } }],
    ["a grant", { requestId: "q1", caseId: "approved", query: {}, grant: "g" }],
    ["no query", { requestId: "q1", caseId: "approved" }],
    ["a query that is a list", { requestId: "q1", caseId: "approved", query: [] }],
    ["a query that is text", { requestId: "q1", caseId: "approved", query: "summary" }],
    ["a bad request id", { requestId: "../x", caseId: "approved", query: {} }],
    ["a bad case id", { requestId: "q1", caseId: "../approved", query: {} }],
    ["no object at all", null],
  ])("refuses %s as E_SCHEMA_INVALID", async (_n, request) => {
    const f = stubHost();
    expect(errs(await queryFromHostFile(f.hostFile, request))).toEqual(["E_SCHEMA_INVALID"]);
    expect(f.logRows()).toEqual([]);
  });

  it("refuses a query larger than the limit", async () => {
    const f = stubHost();
    expect(errs(await f.ask({ op: "list", name: "x".repeat(MAX_QUERY_BYTES) }))).toEqual(["E_SCHEMA_INVALID"]);
    expect((await f.ask({ op: "list", name: "x".repeat(MAX_QUERY_BYTES - 40) }) as any).ok).toBe(true);
  });

  it("refuses a case that is not registered", async () => {
    const f = stubHost();
    expect(errs(await f.ask({}, { caseId: "nope" }))).toEqual(["E_NOT_FOUND"]);
  });

  it("refuses a model that is not the revision registered for the case, and does not ask the adapter", async () => {
    const f = stubHost();
    writeFileSync(f.model, '{"a":2}\n');
    expect(errs(await f.ask({}))).toEqual(["E_STALE_REVISION"]);
    expect(f.logRows()).toEqual([]);
  });

  it("an adapter that does not advertise the query-model capability is not asked", async () => {
    process.env.QUERY_STUB_MODE = "no-capability";
    const f = stubHost();
    expect(errs(await f.ask({}))).toEqual(["E_UNSUPPORTED"]);
    expect(f.logRows()).toEqual([]);
  });

  it("an answer about another model than the one asked is refused, and the refusal is recorded", async () => {
    process.env.QUERY_STUB_MODE = "wrong-hash";
    const f = stubHost();
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0]).toMatchObject({ code: "E_APP_FAILED", field: "/result/modelSha256" });
    expect((f.logRows()[0]!.event as any).event).toMatchObject({ ok: false, codes: ["E_APP_FAILED"] });
  });

  it("a model that changed while the query ran is not answered, however the adapter replied", async () => {
    process.env.QUERY_STUB_MODE = "mutate";
    const f = stubHost();
    expect(errs(await f.ask({}))).toEqual(["E_STALE_REVISION"]);
  });

  it("an answer over a megabyte is refused", async () => {
    process.env.QUERY_STUB_MODE = "big";
    const f = stubHost();
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0].field).toBe("/result/answer");
  });

  it("an adapter's typed refusal is passed on, and a refusal with no reason still says so", async () => {
    process.env.QUERY_STUB_MODE = "refuse";
    expect(errs(await stubHost().ask({ op: "nope" }))).toEqual(["E_QUERY_INVALID"]);
    process.env.QUERY_STUB_MODE = "silent";
    const o: any = await stubHost().ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0]).toMatchObject({ code: "E_APP_FAILED" });
  });

  it("no answer without a record: a query log that cannot be written is not answered", async () => {
    const f = stubHost();
    mkdirSync(join(f.state, "queries"), { recursive: true });
    const sub = join(f.state, "queries", sha256Hex(realpathSync(f.project)).slice(0, 32));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "admissions.jsonl"), "not json, no newline");
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
  });
});

describe("query_model through the CLI and the host verb list", () => {
  it("the agent CLI has a query verb, takes only the three fields, and answers with exit 0; a refusal exits 2", async () => {
    const f = stubHost();
    const run = (req: unknown) => runCli(["query"], Readable.from([JSON.stringify(req)]), f.hostFile);
    expect(await run({ requestId: "c1", caseId: "approved", query: { op: "summary" } })).toMatchObject({ code: 0, reply: { schema: "seed.cli-reply/0.1", ok: true, modelSha256: f.hash } });
    expect(await run({ requestId: "c2", caseId: "nope", query: {} })).toMatchObject({ code: 2, reply: { ok: false } });
    expect(await run({ requestId: "c3", caseId: "approved", query: {}, path: "x" })).toMatchObject({ code: 2 });
  });
});

describe("query_model through MCP", () => {
  it("the tool is listed as read-only with exactly three inputs, answers, and refuses a path or an actor", async () => {
    const f = stubHost();
    const m = await connectSeedMcp(f.hostFile);
    try {
      const tool = (await m.client.listTools()).tools.find((t) => t.name === "seed_query_model")!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys((tool.inputSchema.properties ?? {}) as object).sort()).toEqual(["caseId", "query", "requestId"]);
      const ok = await m.client.callTool({ name: "seed_query_model", arguments: { requestId: "m1", caseId: "approved", query: { op: "summary" } } });
      expect(ok.isError).toBe(false);
      expect(ok.structuredContent).toMatchObject({ schema: "seed.mcp-reply/0.1", ok: true, modelSha256: f.hash });
      const bad = await m.client.callTool({ name: "seed_query_model", arguments: { requestId: "m2", caseId: "nope", query: {} } }).catch((e) => ({ isError: true, e }));
      expect(bad.isError).toBe(true);
      const extra = await m.client.callTool({ name: "seed_query_model", arguments: { requestId: "m3", caseId: "approved", query: {}, path: "x" } }).catch((e) => ({ isError: true, e }));
      expect(extra.isError).toBe(true);
    } finally {
      await m.client.close();
    }
  }, 60000);
});

// ---- the real NODAL runner ----------------------------------------------------------------------------------------------------------
const nodalRepo = process.env.SEED_NODAL_REPO ?? [resolve(__dirname, "../../nodal-seed"), resolve(__dirname, "../../pipe-studio")].find((p) => existsSync(join(p, "nodal_studio", "query.py")));
const py = [process.env.SEED_NODAL_PYTHON, nodalRepo && join(nodalRepo, ".venv", "Scripts", "python.exe"), nodalRepo && join(nodalRepo, ".venv", "bin", "python"), resolve(__dirname, "../../pipe-studio/.venv/Scripts/python.exe"), resolve(__dirname, "../../pipe-studio/.venv/bin/python")].find((p) => p && existsSync(p));
const haveNodal = !!nodalRepo && !!py;

function drainModel(repo: string): string {
  const m = JSON.parse(readFileSync(join(repo, "schema/vectors/model/valid/basic-drain.json"), "utf8"));
  const pipe = (id: string, extra: Record<string, unknown>) => ({ id, kind: "pipe", path: [[5, 0, 2], [5, 0, 3]], nodes: 2, area: 0.01, roughness: 4.5e-5, lengthSource: "geometry", initial: { state: "pT", p: 1000000, T: 300 }, ...extra });
  const D3 = 0.0762;
  m.parts.push(
    pipe("p3stored", { hydraulicDiameter: D3, nominalSize: "3 in" }),
    pipe("p3derived", { area: (Math.PI * D3 * D3) / 4, hydraulicDiameter: 0, nominalSize: "DN80" }),
    pipe("pbig", { area: 0.2, path: [[6, 0, 10], [6, 0, 12]] }),
  );
  return JSON.stringify(m, null, 2) + "\n";
}

describe.skipIf(!haveNodal)("query_model against the real NODAL runner: the four plan questions", () => {
  const nodal = () => {
    process.env.SEED_NODAL_PYTHON = py!;
    process.env.SEED_NODAL_REPO = nodalRepo!;
    return host({ adapter: { id: "nodal", command: process.execPath, args: [resolve(__dirname, "../adapters/nodal/cli.cjs")] }, modelPath: "models/m/model.json", modelText: drainModel(nodalRepo!) });
  };
  const QUESTIONS: [string, Record<string, unknown>, (a: any) => void][] = [
    ["how many parts of each kind", { op: "summary" }, (a) => {
      expect(a).toMatchObject({ partCount: 8, linkCount: 4, kinds: { boundaryVolume: 2, junction: 2, pipe: 4 }, tagged: 0, withNominalSize: 2 });
    }],
    ["which pipes have a 3-inch bore", { op: "list", kind: "pipe", diameter: { near: 3, tolerance: 0.01, unit: "in" } }, (a) => {
      expect(a.parts.map((p: any) => [p.id, p.diameter.source])).toEqual([["p3derived", "derived"], ["p3stored", "stored"]]);
    }],
    ["is the source connected to the sink, and through what", { op: "connected", a: "source", b: "sink" }, (a) => {
      expect(a).toMatchObject({ connected: true, path: ["source", "jin", "pipe1", "jout", "sink"], hops: 4 });
    }],
    ["what touches pipe1", { op: "neighbors", part: "pipe1" }, (a) => {
      expect(a.neighbors.map((n: any) => n.id)).toEqual(["jin", "jout"]);
    }],
  ];

  it.each(QUESTIONS)("%s: the exact answer, the model hash, and the same through the CLI and the MCP tool", async (_name, query, check) => {
    const f = nodal();
    const o: any = await f.ask(query);
    expect(o, JSON.stringify(o.errors)).toMatchObject({ ok: true, modelSha256: f.hash });
    check(o.answer);
    const cli = await runCli(["query"], Readable.from([JSON.stringify({ requestId: "cli-" + _name.length, caseId: "approved", query })]), f.hostFile);
    expect(cli.code).toBe(0);
    expect((cli.reply as any).answer).toEqual(o.answer);
    // the same question straight to NODAL gives the same answer (SEED adds nothing and drops nothing but the ok flag)
    const qf = join(f.root, "direct-query.json");
    writeFileSync(qf, JSON.stringify(query));
    const direct = spawnSync(py!, ["-m", "nodal_studio.run", f.model, "--query", qf], { cwd: nodalRepo!, env: { ...process.env, PYTHONPATH: nodalRepo!, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    expect(direct.status).toBe(0);
    const { ok: _ok, ...want } = JSON.parse(direct.stdout);
    expect(o.answer).toEqual(want);
    expect(readFileSync(f.model, "utf8")).toBe(drainModel(nodalRepo!)); // never changes the model
  }, 120000);

  it("a bad question is refused with SEED's typed code and recorded", async () => {
    const f = nodal();
    expect(errs(await f.ask({ op: "teleport" }))).toEqual(["E_QUERY_INVALID"]);
    expect(errs(await f.ask({ op: "neighbors", part: "no-such-part" }, { requestId: "q2" }))).toEqual(["E_QUERY_UNKNOWN_PART"]);
    expect(errs(await f.ask({ op: "list", diameter: { min: 1, unit: "furlong" } }, { requestId: "q3" }))).toEqual(["E_QUERY_INVALID"]);
    expect(f.logRows().map((r) => (r.event as any).event.ok)).toEqual([false, false, false]);
  }, 120000);

  it("a model that is not a NODAL model is refused as invalid, not answered", async () => {
    process.env.SEED_NODAL_PYTHON = py!;
    process.env.SEED_NODAL_REPO = nodalRepo!;
    const f = host({ adapter: { id: "nodal", command: process.execPath, args: [resolve(__dirname, "../adapters/nodal/cli.cjs")] }, modelPath: "models/m/model.json", modelText: '{"format":"something-else"}\n' });
    const o: any = await f.ask({ op: "summary" });
    expect(o.ok).toBe(false);
    expect(o.errors[0].code).toBe("E_SCHEMA_INVALID");
  }, 120000);
});
