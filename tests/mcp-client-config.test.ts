import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sha256Hex } from "../src/core/canonical";
import { saveHostConfiguration, type HostConfiguration } from "../src/core/fileRunHost";
import { createProject } from "../src/core/projectStore";

// The MCP client configuration that docs/mcp.md tells a person to use (command, arguments, environment) must start the server and discover its
// tools. The test reads the block from the document, fills in the real paths, and connects the way a client would. It does not prove that Claude
// Code or Claude Desktop connects (TODO.md, "Connect a real MCP client"); it proves the documented shape is not out of date.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const doc = readFileSync(resolve(__dirname, "../docs/mcp.md"), "utf8");
const block = (): { mcpServers: { seed: { command: string; args: string[]; env: Record<string, string> } } } => {
  const m = /```json\n([\s\S]*?"mcpServers"[\s\S]*?)```/.exec(doc);
  if (!m) throw new Error("docs/mcp.md has no mcpServers block");
  return JSON.parse(m[1]!);
};

it("the documented block has exactly a command, one script argument and SEED_HOST_CONFIG", () => {
  const seed = block().mcpServers.seed;
  expect(Object.keys(seed).sort()).toEqual(["args", "command", "env"]);
  expect(seed.args).toHaveLength(1);
  expect(seed.args[0]).toMatch(/dist\/mcp\/seed\.js$/);
  expect(Object.keys(seed.env)).toEqual(["SEED_HOST_CONFIG"]);
});

it("the documented Claude Code command carries the same three values", () => {
  const line = doc.split("\n").find((l) => l.startsWith("claude mcp add seed"));
  expect(line, "docs/mcp.md has a `claude mcp add seed` line").toBeDefined();
  expect(line).toContain("-e SEED_HOST_CONFIG=");
  expect(line).toMatch(/-- node .*dist\/mcp\/seed\.js$/);
});

it("started as the block says (real paths in place of the placeholders), the server lists its tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "seed-mcpcfg-"));
  dirs.push(root);
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(state);
  expect(createProject(project, { name: "Client config fixture", seedVersion: "0.1.0" }).ok).toBe(true);
  mkdirSync(join(project, "models"), { recursive: true });
  const model = "{}";
  writeFileSync(join(project, "models/m.json"), model);
  const dummy = join(root, "dummy.json");
  writeFileSync(dummy, "{}");
  const hash = sha256Hex(model);
  const budget = { maxWallSeconds: 30, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 };
  const config = {
    schema: "seed.host/0.1", projectRoot: project, stateRoot: state,
    adapter: { id: "stub", version: "0.1.0", command: process.execPath, args: [dummy] }, actor: { kind: "agent", name: "bot", model: "fixture" },
    study: { studyId: "s1", tier: "A1", budget, parameters: [] },
    cases: { approved: { artifact: { path: "models/m.json", revision: { hash, counter: 1 } }, inputs: [{ path: "models/m.json", sha256: hash }], params: [], settings: {} } },
    runtime: { path: dummy, sha256: sha256Hex("{}") },
    oracles: { repository: root, entriesDir: root, inputsRoot: root, evidenceFile: dummy, evidenceSha256: sha256Hex("{}") },
    acceptedPins: { appCommit: "0".repeat(40), oracleFiles: [{ oracleId: "dummy", entryVersion: 1, sha256: "0".repeat(64) }] },
  } as unknown as HostConfiguration;
  const hostFile = join(root, "host.json");
  saveHostConfiguration(hostFile, config);

  const seed = block().mcpServers.seed;
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)) };
  for (const k of Object.keys(seed.env)) env[k] = hostFile; // the placeholder path becomes the real host file
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(__dirname, "../dist/mcp/seed.js")], env, stderr: "pipe" });
  const client = new Client({ name: "claude-like-client", version: "0.0.0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of ["seed_run_case", "seed_cancel_calculation", "seed_query_model", "seed_add_study_note", "seed_export_study_report"]) expect(names).toContain(expected);
    // an agent connected this way has no way to approve, clear or accept anything
    expect(names.filter((n) => /approve|clear|accept|grant|recover/.test(n))).toEqual([]);
  } finally {
    await client.close();
  }
});
