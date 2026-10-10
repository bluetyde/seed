import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killTree } from "../src/core/procTree";
import { applyInstall, parseRegistry, type AppEntry } from "../src/main/apps";

// E2 exit, "standalone launch of the app unchanged by its adapter", the launch half: each app starts with its own registered command in a
// clean environment (no SEED_* variable, nothing from an adapter run) and answers its health path. The fingerprint half (the adapter
// leaves the app's folder as it found it) is the last test of every *-oracles.test.ts. An app whose folder or dependencies are not on this
// machine is skipped by name, so a skipped count is a count of apps not checked.
const registry = parseRegistry(readFileSync(join(__dirname, "..", process.platform === "win32" ? "apps.windows.json" : "apps.default.json"), "utf-8"));
const homeRoot = join(__dirname, "..", "..");
const first = (...c: (string | undefined)[]) => c.find((p) => p && existsSync(p));
// where an install of each app may be (the SEED_*_REPO variable first, then a sibling folder named as the catalog names it)
const installs: Record<string, { dir: string | undefined; needs: string[] }> = {
  "openmc-studio": { dir: first(process.env.SEED_OPENMC_REPO, join(homeRoot, "openmc-studio")), needs: ["studio/start.sh"] },
  // the NODAL checkout needs its web dependencies installed
  "nodal-studio": {
    dir: [process.env.SEED_NODAL_REPO, join(homeRoot, "nodal-studio")].find((p) => p && existsSync(join(p, "web", "node_modules", "vite", "bin", "vite.js"))),
    needs: ["web/node_modules/vite/bin/vite.js"],
  },
  "virtual-reactor": { dir: first(process.env.SEED_RAFT_REPO, join(homeRoot, "raft")), needs: ["web/node_modules/vite/bin/vite.js"] },
  feed: { dir: first(process.env.SEED_FEED_REPO, join(homeRoot, "feed")), needs: ["dist/server/server.js"] },
  sneed: { dir: first(process.env.SEED_PRA_REPO, join(homeRoot, "sneed")), needs: ["node_modules/tsx/dist/cli.mjs", "dist/web/index.html"] },
};
// SNEED keeps its models and runs under the user's home by default: point both at a throw-away folder for the check
const scratch = mkdtempSync(join(tmpdir(), "seed-launch-"));
const extraEnv: Record<string, Record<string, string>> = { sneed: { SNEED_PROJECT_DIR: join(scratch, "models"), SNEED_RUNS_DIR: join(scratch, "runs") } };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function launchAndProbe(app: AppEntry): Promise<{ status: number; stderr: string }> {
  const port = await freePort();
  const token = "standalone-check";
  const sub = (s: string) => s.split("{port}").join(String(port)).split("{token}").join(token);
  const start = app.start!;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("SEED_")) delete env[k];
  for (const [k, v] of Object.entries(start.env ?? {})) env[k] = sub(v);
  Object.assign(env, extraEnv[app.id] ?? {});
  const child = spawn(start.command, start.args.map(sub), { cwd: start.cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    const url = `http://127.0.0.1:${port}${sub(app.healthPath)}`;
    const until = Date.now() + app.startTimeoutMs;
    while (Date.now() < until && !exited) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return { status: r.status, stderr };
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { status: 0, stderr };
  } finally {
    if (child.pid && !exited) await killTree(child.pid);
  }
}

describe("every registered app starts standalone with no SEED variable in its environment", () => {
  it("the registry is the one the host uses", () => {
    expect(registry.problems).toEqual([]);
    expect(registry.apps.map((a) => a.id).sort()).toEqual(Object.keys(installs).sort());
  });

  for (const app of registry.apps) {
    const inst = installs[app.id];
    const present = !!inst?.dir && inst.needs.every((n) => existsSync(join(inst.dir!, ...n.split("/"))));
    // the OpenMC registry entry starts the app through WSL
    const runnable = present && (app.id !== "openmc-studio" || process.platform === "win32" || process.platform === "linux");
    it.skipIf(!runnable)(`${app.id} answers ${app.healthPath} on a free port`, async () => {
      const entry = applyInstall(app, inst!.dir);
      expect(entry.start, "the install must fill the start command").toBeDefined();
      const r = await launchAndProbe(entry);
      expect(r.status, r.stderr).toBe(200);
    }, app.startTimeoutMs + 30_000);
  }
});
