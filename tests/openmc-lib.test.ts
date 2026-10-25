// @covers R-XFER-07
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Studio's transfer command as the coupling loop and the transfer host call it (adapters/openmc/lib.cjs): a reply counts only from a command that
// exited 0 in time, and a request that could not be delivered is said. The program is replaced by a fake result here; the real one runs in
// tests/coupling-lumped-real.test.ts.
const lib = createRequire(__filename)("../adapters/openmc/lib.cjs") as { studioTransfer(cfg: unknown, request: unknown, timeoutMs?: number, run?: (spec: any, ms: number) => Promise<any>, launch?: (cfg: unknown, args: string[]) => any): Promise<any> };
const launch = () => ({ command: "x", args: [] });
const result = (over: Record<string, unknown>) => async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });
const call = (over: Record<string, unknown>) => lib.studioTransfer({}, { schema: "seed.transfer-request/0.2" }, 1000, result(over), launch);
const good = JSON.stringify({ ok: true, output: { content: "{}" }, checks: {} });

describe("studioTransfer", () => {
  it("passes on a reply from a command that exited 0, whether it says ok or refuses", async () => {
    expect(await call({ stdout: good + "\n" })).toMatchObject({ ok: true });
    expect(await call({ stdout: JSON.stringify({ ok: false, errors: [{ code: "E_UNITS", message: "degC" }] }) })).toMatchObject({ ok: false, errors: [{ code: "E_UNITS" }] });
  });
  it("reads the last line, so notices printed first do not matter", async () => {
    expect(await call({ stdout: "wsl: a notice\n" + good + "\n" })).toMatchObject({ ok: true });
  });
  it("does not use the reply of a command that exited with an error, and says so", async () => {
    const r = await call({ code: 3, stdout: good });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "E_APP_FAILED" });
    expect(r.errors[0].message).toMatch(/exited with 3; its reply is not used/);
  });
  it("does not use the reply of a command that timed out", async () => {
    const r = await call({ code: null, timedOut: true, stdout: good });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/timed out/);
  });
  it("says when the request could not be delivered, instead of 'exit 0'", async () => {
    const r = await call({ stdout: "", stdinError: "write EPIPE" });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/did not answer in JSON.*could not be delivered: write EPIPE/);
  });
  it("shows the end of stderr when the command died without an answer", async () => {
    const r = await call({ code: 1, stderr: "Traceback ... ModuleNotFoundError: openmc_studio" });
    expect(r.errors[0].message).toMatch(/exited with 1.*ModuleNotFoundError/);
  });
});
