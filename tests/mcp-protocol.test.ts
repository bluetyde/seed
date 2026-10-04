import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { MAX_MCP_BYTES } from "../src/mcp/seed";
const executable = resolve(__dirname, "../dist/mcp/seed.js");
function raw(input: string, configured = true) {
  const env = { ...process.env }; delete env.SEED_HOST_CONFIG;
  if (configured) env.SEED_HOST_CONFIG = resolve(__dirname, "missing-host.json");
  return spawnSync(process.execPath, [executable], { env, input, encoding: "utf8", timeout: 10000 });
}
it("missing trusted configuration exits nonzero without contaminating protocol stdout", () => {
  const r = raw("", false); expect(r.error).toBeUndefined(); expect(r.status).toBe(2);
  expect(r.stdout).toBe(""); expect(r.stderr).toMatch(/setup failed/);
});
it("stdin EOF closes an idle MCP host promptly", () => {
  const r = raw(""); expect(r.error).toBeUndefined(); expect(r.status).toBe(0); expect(r.stdout + r.stderr).toBe("");
});
it("an oversized unterminated stdio frame closes without a run", () => {
  const r = raw("x".repeat(MAX_MCP_BYTES + 1)); expect(r.error).toBeUndefined();
  expect(r.stdout).toBe(""); expect(r.stderr).toMatch(/protocol\/transport error/);
});
it("malformed JSON is reported on stderr and never echoed as protocol data", () => {
  const r = raw("not-json\n"); expect(r.error).toBeUndefined(); expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/protocol\/transport error/);
});
