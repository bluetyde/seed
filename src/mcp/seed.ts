import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { supervisedRun } from "./supervisor";

export const MAX_MCP_BYTES = 1_048_576;
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({
  requestId: z.string().min(1).max(256),
  caseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  budget: z.object({ maxWallSeconds: positiveInteger, maxCores: positiveInteger,
    maxMemoryMB: positiveInteger, maxDiskMB: positiveInteger }).strict(),
}).strict();

/** The path is selected once by the trusted process environment, never by MCP arguments. */
export function createSeedMcpServer(hostConfig: string): McpServer {
  const server = new McpServer({ name: "seed", version: "0.1.0" }, {
    instructions: "Run only host-registered cases. Authority, approved inputs and oracle evidence come from the trusted SEED host. No approval/configuration tools. Calls wait for terminal results; cancellation or disconnect does not stop a calculation. Keep the connection open and allow the configured wall budget plus cleanup time.",
  });
  server.registerTool("seed_run_case", {
    title: "Run an approved SEED case",
    description: "Run one registered case through SEED's guarded host. Host policy, scoped approvals, input revisions and oracle/runtime pins are checked; admission is recorded before launch. Only requestId, caseId and a positive-integer budget are accepted. Refusal and calculation failure return isError with typed SEED errors. One active case per engine using shared host state. Budget admission does not enforce OS CPU/memory/disk limits. Synthetic RAFT results have limited validation coverage. No cancellation, recovery or approval action is supplied by this tool.",
    inputSchema: requestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async request => {
    const outcome = await supervisedRun(hostConfig, request);
    const reply = { schema: "seed.mcp-reply/0.1", ...outcome };
    return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], structuredContent: reply,
      isError: !outcome.ok || outcome.state !== "completed" };
  });
  return server;
}

export async function startSeedMcp(hostConfig = process.env.SEED_HOST_CONFIG): Promise<McpServer> {
  if (!hostConfig) throw Error("set SEED_HOST_CONFIG in the trusted host environment");
  const server = createSeedMcpServer(hostConfig);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_MCP_BYTES });
  server.server.onerror = () => { process.stderr.write("SEED MCP protocol/transport error\n"); };
  // EOF stops new requests. In-flight host operations retain the lease and finish their journal.
  process.stdin.once("end", () => { void transport.close(); });
  process.stdout.on("error", () => { void transport.close(); });
  await server.connect(transport);
  return server;
}
if (require.main === module) {
  startSeedMcp().catch(() => { process.stderr.write("SEED MCP setup failed; check SEED_HOST_CONFIG\n"); process.exitCode = 2; process.stdin.destroy(); });
}
