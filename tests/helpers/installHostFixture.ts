import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CAD, CORE, LIBS, fixtureManifest, makeWorld, type Spec } from "./installFixture";

/** A trusted install host on disk: a manifest with its pin, a folder of artifacts, an install root, a state folder and two configurations (a human's and an agent's). */
export function makeHost(specs: Spec[] = [CORE(), LIBS(), CAD()], over: { appVersion?: string; actorName?: string } = {}) {
  const w = makeWorld();
  const { manifest } = fixtureManifest(specs, w.served);
  const manifestFile = path.join(w.base, "manifests", "fakeapp.json");
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const bytes = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(manifestFile, bytes);
  const pin = createHash("sha256").update(bytes).digest("hex");
  const artifactsDir = path.join(w.base, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const [id, b] of w.served) fs.writeFileSync(path.join(artifactsDir, id), b);
  const stateRoot = path.join(w.base, "host-state");
  fs.mkdirSync(stateRoot, { recursive: true });
  const ownersFolder = path.join(w.base, "owners");
  const config = (actor: { kind: string; name: string }, extra: Record<string, unknown> = {}, app: Record<string, unknown> = {}) => ({
    schema: "seed.install-host/0.1", actor, installRoot: w.root, stateRoot, ownersFolder,
    platform: { os: "linux", arch: "x64" },
    apps: { fakeapp: { manifestFile, manifestSha256: pin, appVersion: over.appVersion ?? "1.5.0", artifactsDir, ...app } },
    ...extra
  });
  const write = (name: string, value: unknown) => {
    const f = path.join(w.base, "config", name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value, null, 2));
    return f;
  };
  const bot = { kind: "agent", name: over.actorName ?? "setup-bot", model: "test-model" };
  return {
    ...w, manifest: manifest, manifestFile, pin, artifactsDir, stateRoot, ownersFolder, config, write,
    humanFile: write("human.json", config({ kind: "human", name: "the user" })),
    agentFile: write("agent.json", config(bot)),
    bot,
    installsLog: () => {
      const f = path.join(stateRoot, "installs.jsonl");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).event as Record<string, unknown>) : [];
    },
    grantLog: () => {
      const f = path.join(stateRoot, "install-grants.jsonl");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    }
  };
}
export type Host = ReturnType<typeof makeHost>;
