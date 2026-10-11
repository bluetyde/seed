// @covers R-SHELL-07
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ProcessManager, type Deps } from "../src/main/processes";
import type { AppEntry } from "../src/main/apps";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const app: AppEntry = { id: "fake", name: "Fake", icon: "app", healthPath: "/health", urlPath: "/", startTimeoutMs: 1000,
  start: { command: process.execPath, args: [] } };

describe("startup ownership races", () => {
  it("stopAll cancels a launch waiting for its port before spawning", async () => {
    const port = deferred<number>();
    let spawned = 0;
    const deps: Deps = { spawn: (() => { spawned++; throw Error("must not spawn"); }) as typeof spawn,
      freePort: () => port.promise, fetchStatus: async () => 200, kill: async () => {}, sleep: async () => {} };
    const m = new ProcessManager(deps);
    const result = m.ensure(app).catch((e: Error) => e.message);
    const stopped = m.stopAll();
    port.resolve(12345);
    await stopped;
    expect(await result).toContain("cancelled");
    expect(spawned).toBe(0);
    expect(m.running(app.id)).toBeUndefined();
  });

  it("cancelled attach cannot reappear; a concurrent reopen gets its own launch", async () => {
    const health = deferred<number>();
    let checks = 0;
    let kills = 0;
    const deps: Deps = { spawn, freePort: async () => 12345,
      fetchStatus: async () => ++checks === 1 ? health.promise : 200,
      kill: async () => { kills++; }, sleep: async () => {} };
    const m = new ProcessManager(deps);
    const attached = { ...app, attachUrl: "http://127.0.0.1:12345" };
    const first = m.ensure(attached).catch((e: Error) => e.message);
    const stopping = m.stop(app.id);
    const reopened = m.ensure(attached);
    health.resolve(200);
    await stopping;
    expect(await first).toContain("cancelled");
    expect((await reopened).owned).toBe(false);
    expect(m.running(app.id)).toBeDefined();
    await m.stopAll();
    expect(kills).toBe(0);
  });

  it.each([401, 404, 500])("does not accept HTTP %s as readiness", async (status) => {
    const deps: Deps = { spawn, freePort: async () => 12345, fetchStatus: async () => status,
      kill: async () => {}, sleep: async () => {} };
    const m = new ProcessManager(deps);
    const attached = { ...app, start: undefined, attachUrl: "http://127.0.0.1:12345" };
    await expect(m.ensure(attached)).rejects.toThrow("no start command");
    expect(m.running(app.id)).toBeUndefined();
  });
});
