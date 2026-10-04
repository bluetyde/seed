import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

export async function connectSeedMcp(file: string) {
  const client = new Client({ name: "seed-acceptance", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(__dirname, "../../dist/mcp/seed.js")],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)), SEED_HOST_CONFIG: file }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", b => { stderr += b; });
  try { await client.connect(transport); } catch (e) { await transport.close(); throw e; }
  return { client, transport, stderr: () => stderr };
}
