import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The real gate unless a test sets `denyQuery`: the gate has no configuration that refuses an A0 operation, so its refusal is tested by making it refuse.
const gateSwitch = vi.hoisted(() => ({ deny: false }));
vi.mock("../src/core/policy", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/policy")>();
  return { ...real, evaluateGate: (req: any, ctx: any) => (gateSwitch.deny ? { allow: false, errors: [{ code: "E_NOT_PERMITTED", field: "/operation", message: "refused by the gate", source: "seed" }] } : real.evaluateGate(req, ctx)) };
});

const dirs: string[] = [];
const saved = { mode: process.env.QUERY_STUB_MODE, py: process.env.SEED_NODAL_PYTHON, repo: process.env.SEED_NODAL_REPO };
afterEach(() => {
  gateSwitch.deny = false;
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
  return { root, project, state, hostFile, hash, inputs, config, logRows, model: join(project, opts.modelPath), modelText: opts.modelText, ask: (q: unknown, extra: Record<string, unknown> = {}) => queryFromHostFile(hostFile, { requestId: "q1", caseId: "approved", query: q, ...extra }) };
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

  it("an adapter whose describe refuses is not asked to query, and its refusal is passed on", async () => {
    process.env.QUERY_STUB_MODE = "describe-refuse";
    const f = stubHost();
    expect(errs(await f.ask({}))).toEqual(["E_SETUP_REQUIRED"]);
    expect(f.logRows()).toEqual([]);
  });

  it("an adapter that answers describe with something that is not a reply is refused with the transport's reason, not as an internal failure", async () => {
    process.env.QUERY_STUB_MODE = "describe-garbage";
    const f = stubHost();
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors.map((e: any) => e.code)).not.toContain("E_INTERNAL");
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

  it("a model that cannot be read after the query ran is refused like a changed one, and the query is still recorded", async () => {
    process.env.QUERY_STUB_MODE = "remove";
    const f = stubHost();
    const o: any = await f.ask({ op: "summary" });
    expect(o.ok).toBe(false);
    expect(o.errors[0]).toMatchObject({ code: "E_STALE_REVISION", message: "the model file could not be read after the query ran" });
    expect(f.logRows()).toHaveLength(1);
    expect((f.logRows()[0]!.event as any).event).toMatchObject({ ok: false, codes: ["E_STALE_REVISION"] });
  });

  it("a model file that is gone before the query is E_NOT_FOUND without a path of this machine in the message", async () => {
    const f = stubHost();
    rmSync(f.model);
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0].code).toBe("E_NOT_FOUND");
    expect(JSON.stringify(o)).not.toContain(f.project);
    expect(f.logRows()).toEqual([]);
  });

  it("a host state folder that cannot be used is refused without naming a path of this machine", async () => {
    const f = stubHost();
    writeFileSync(join(f.state, "queries"), "a file where the query log folder must be");
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0].code).toBe("E_INTERNAL");
    expect(JSON.stringify(o)).not.toContain(f.state);
  });

  it("an operating-system error (here ENOENT, the state folder is gone) is a fixed sentence, not a message that names a path", async () => {
    const f = stubHost();
    rmSync(f.state, { recursive: true, force: true });
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.errors[0]).toMatchObject({ code: "E_INTERNAL", message: "the query could not be completed" });
    expect(JSON.stringify(o)).not.toContain(f.state);
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

  it("the gate's refusal is returned as it is: the adapter is not asked, nothing is logged, nothing is answered", async () => {
    process.env.QUERY_STUB_MODE = "mutate"; // would change the model if it were asked at all
    const f = stubHost();
    gateSwitch.deny = true;
    const o: any = await f.ask({ op: "summary" });
    expect(o).toMatchObject({ ok: false, errors: [{ code: "E_NOT_PERMITTED", field: "/operation", message: "refused by the gate" }] });
    expect(f.logRows()).toEqual([]);
    expect(readFileSync(f.model, "utf8")).toBe(f.modelText);
  });

  it("no answer without a record: a query log that is damaged is refused, and nothing is answered", async () => {
    const f = stubHost();
    mkdirSync(join(f.state, "queries"), { recursive: true });
    const sub = join(f.state, "queries", sha256Hex(realpathSync(f.project)).slice(0, 32));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "admissions.jsonl"), "not json, no newline");
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.answer).toBeUndefined();
    expect(o.errors[0].code).toBe("E_INTERNAL");
  });

  it("no answer without a record: a query log that cannot be locked is refused with its own reason, and nothing is answered", async () => {
    const f = stubHost();
    const sub = join(f.state, "queries", sha256Hex(realpathSync(f.project)).slice(0, 32));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".seed"), "a file where the lock folder's parent must be");
    const o: any = await f.ask({});
    expect(o.ok).toBe(false);
    expect(o.answer).toBeUndefined();
    expect(o.errors[0].code).toBe("E_INTERNAL");
    expect(o.errors[0].message).toMatch(/could not be recorded/);
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
const nodalRepo = process.env.SEED_NODAL_REPO ?? [resolve(__dirname, "../../nodal-studio")].find((p) => existsSync(join(p, "nodal_studio", "query.py")));
const py = [process.env.SEED_NODAL_PYTHON, nodalRepo && join(nodalRepo, ".venv", "Scripts", "python.exe"), nodalRepo && join(nodalRepo, ".venv", "bin", "python"), resolve(__dirname, "../../nodal-studio/.venv/Scripts/python.exe"), resolve(__dirname, "../../nodal-studio/.venv/bin/python")].find((p) => p && existsSync(p));
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

// The adapter's own handling of the model file, with a stand-in runner module (a Python package named nodal_studio in a temporary folder, so it needs
// only a Python): what path the runner is given, and what happens when the project's file is replaced while the runner works.
describe.skipIf(!py)("the NODAL adapter's query reads a private copy of the bytes it hashed", () => {
  const fakeRepo = () => {
    const repo = tmp();
    mkdirSync(join(repo, "nodal_studio"), { recursive: true });
    writeFileSync(join(repo, "nodal_studio", "__init__.py"), "");
    writeFileSync(join(repo, "nodal_studio", "run.py"), [
      "import json, os, sys, time",
      "model = sys.argv[1]",
      "time.sleep(float(os.environ.get('STUB_DELAY', '0')))",
      "if os.environ.get('STUB_MODE') == 'refuse':",
      "    print(json.dumps({'ok': False, 'errors': [{'code': 'E_QUERY_MODEL', 'field': '', 'message': 'not a NODAL model: ' + model}]}))",
      "    sys.exit(2)",
      "if os.environ.get('STUB_MODE') == 'crash':",
      "    raise RuntimeError('boom at ' + model + ' in ' + os.getcwd())",
      "print(json.dumps({'ok': True, 'modelPath': model, 'content': open(model, encoding='utf-8').read()}))",
      "",
    ].join(String.fromCharCode(10)));
    return repo;
  };
  const ask = (project: string, repo: string, hash: string, env: Record<string, string>) =>
    new Promise<any>((done) => {
      const child = require("node:child_process").spawn(process.execPath, [resolve(__dirname, "../adapters/nodal/cli.cjs"), "query"], {
        env: { ...process.env, SEED_PROJECT_ROOT: project, SEED_NODAL_PYTHON: py!, SEED_NODAL_REPO: repo, ...env },
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.on("close", () => done(JSON.parse(out.trim().split(String.fromCharCode(10)).pop()!)));
      child.stdin.end(JSON.stringify({ schema: "seed.adapter-request/0.1", verb: "query", requestId: "snap", actor: agent, artifact: { path: "models/m/model.json", revision: { hash, counter: 1 } }, query: { op: "summary" } }));
    });
  const project = (text: string) => {
    const root = tmp();
    mkdirSync(join(root, "models", "m"), { recursive: true });
    writeFileSync(join(root, "models", "m", "model.json"), text);
    return root;
  };

  it("hands the runner a copy outside the project, with the bytes that were hashed", async () => {
    const text = '{"format":"x"}';
    const root = project(text);
    const r = await ask(root, fakeRepo(), sha256Hex(text), {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.answer.content).toBe(text);
    expect(r.result.modelSha256).toBe(sha256Hex(text));
    expect(resolve(r.result.answer.modelPath).startsWith(resolve(root))).toBe(false);
  }, 60000);

  it("a file replaced while the runner works is not what the answer is about", async () => {
    const original = '{"format":"original"}', replacement = '{"format":"replacement"}';
    const root = project(original);
    const pending = ask(root, fakeRepo(), sha256Hex(original), { STUB_DELAY: "1.5" });
    await new Promise((r) => setTimeout(r, 600));
    writeFileSync(join(root, "models", "m", "model.json"), replacement);
    const r = await pending;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result.answer.content).toBe(original);
    expect(r.result.modelSha256).toBe(sha256Hex(original));
  }, 60000);

  it("a runner that crashes gives a fixed sentence: no traceback, no path of this machine", async () => {
    const text = '{"format":"x"}';
    const root = project(text), repo = fakeRepo();
    const r = await ask(root, repo, sha256Hex(text), { STUB_MODE: "crash" });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("E_APP_FAILED");
    expect(r.errors[0].message).toMatch(/^the NODAL runner could not answer the query \(exit \d+\)$/);
    expect(JSON.stringify(r)).not.toContain(repo);
    expect(JSON.stringify(r)).not.toContain(root);
  }, 60000);

  it("a runner's own refusal that quotes the path it was given is passed on with the path replaced by 'the model'", async () => {
    const text = '{"format":"x"}';
    const root = project(text), repo = fakeRepo();
    const r = await ask(root, repo, sha256Hex(text), { STUB_MODE: "refuse" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", message: "E_QUERY_MODEL: not a NODAL model: the model" });
    expect(JSON.stringify(r)).not.toContain(require("node:os").tmpdir());
  }, 60000);
});

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

  // NODAL main 1640ffd fixed an uncaught TypeError for a `unit` that is a list or an object (found by the Codex review of query_model, 2026-10-08).
  // A unit that is not a word is a typed refusal from the runner itself, and SEED passes it on as the same typed refusal, never a crash.
  it.each([["a list", ["mm"]], ["an object", {}], ["a number", 5], ["null", null], ["a boolean", true]])("a diameter unit that is %s is E_QUERY_BAD_UNIT from NODAL and a typed refusal from SEED, with no crash text", async (_name, unit) => {
    const f = nodal();
    const query = { op: "list", diameter: { min: 1, unit } };
    const o: any = await f.ask(query);
    expect(o.ok).toBe(false);
    expect(o.errors[0].code).toBe("E_QUERY_INVALID");
    expect(o.errors[0].message).toContain("E_QUERY_BAD_UNIT");
    expect(JSON.stringify(o)).not.toMatch(/TypeError|Traceback|unhashable|nodal_studio[\/]/);
    // the runner itself answers with its typed code and exit 2
    const qf = join(f.root, "bad-unit.json");
    writeFileSync(qf, JSON.stringify(query));
    const direct = spawnSync(py!, ["-m", "nodal_studio.run", f.model, "--query", qf], { cwd: nodalRepo!, env: { ...process.env, PYTHONPATH: nodalRepo!, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    expect(direct.status).toBe(2);
    expect(JSON.parse(direct.stdout)).toMatchObject({ ok: false, errors: [{ code: "E_QUERY_BAD_UNIT" }] });
  }, 120000);

  it("the NODAL adapter checks the model itself, whoever calls it: a stale revision, a path that leaves the project and a missing file", async () => {
    const f = nodal();
    const ask = (artifact: Record<string, unknown>) => {
      const r = spawnSync(process.execPath, [resolve(__dirname, "../adapters/nodal/cli.cjs"), "query"], {
        input: JSON.stringify({ schema: "seed.adapter-request/0.1", verb: "query", requestId: "direct", actor: agent, artifact, query: { op: "summary" } }),
        encoding: "utf8", env: { ...process.env, SEED_PROJECT_ROOT: f.project },
      });
      expect(r.status).toBe(0);
      const reply = JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).pop()!);
      return reply.ok ? ["ok"] : reply.errors.map((e: any) => e.code);
    };
    const good = { path: "models/m/model.json", revision: { hash: f.hash, counter: 1 } };
    expect(ask(good)).toEqual(["ok"]);
    expect(ask({ ...good, revision: { hash: "f".repeat(64), counter: 1 } })).toEqual(["E_STALE_REVISION"]);
    expect(ask({ path: "../outside.json", revision: good.revision })).toEqual(["E_PATH_TRAVERSAL"]);
    expect(ask({ path: "models/m/none.json", revision: good.revision })).toEqual(["E_NOT_FOUND"]);
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

describe("review batch 1: the adapter is run only as approved", () => {
  it("a runtime file that changed since the host approved it is not run for a query, and nothing is recorded", async () => {
    const f = stubHost();
    expect(errs(await f.ask({ op: "summary" }))).toEqual([]);
    writeFileSync(join(f.root, "dummy.json"), "{ }");
    const o: any = await f.ask({ op: "summary" }, { requestId: "q2" });
    expect(errs(o)).toEqual(["E_NOT_PERMITTED"]);
    expect(o.errors[0].message).toMatch(/runtime bundle changed/);
    expect(f.logRows()).toHaveLength(1); // only the first query
  });
});
