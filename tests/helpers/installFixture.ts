import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest, type Manifest, type Platform } from "../../src/core/components";
import type { ArtifactSource, InstallEnv } from "../../src/core/componentInstaller";
import { makeTarGz, makeZip, type TarEntry, type ZipEntry } from "./archives";

/** A fake publisher and a fake machine for the installer tests: small real archives, real hashes, a source that serves them from memory. */

export type Spec = {
  id: string;
  version: string;
  kind: "core" | "addon" | "library";
  archive?: "tar.gz" | "zip" | "none";
  /** name -> content of the files in the archive. */
  files?: Record<string, string>;
  /** Raw tar entries (to build a hostile archive whose hash is still the pinned one). */
  tarEntries?: TarEntry[];
  zipEntries?: ZipEntry[];
  dependsOn?: { component: string; min?: string }[];
  /** Override what the manifest says about the artifact (to make it lie). */
  expandedBytes?: number;
  downloadBytes?: number;
  sha256?: string;
  platforms?: Platform[];
  appVersions?: { min: string; max?: string };
};

export const linux: Platform = { os: "linux", arch: "x64" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function fixtureManifest(specs: Spec[], served: Map<string, Buffer>, app = "fakeapp"): { manifest: Manifest; sha: string } {
  const components = specs.map((s) => {
    const files = s.files ?? { "bin/run": `${s.id} ${s.version}\n`, "README.txt": `${s.id} ${s.version}` };
    const archive = s.archive ?? "tar.gz";
    let bytes: Buffer;
    let expanded: number;
    if (archive === "tar.gz") {
      const entries = s.tarEntries ?? Object.entries(files).map(([name, data]) => ({ name, data }));
      bytes = makeTarGz(entries);
      expanded = entries.reduce((n, e) => n + (e.type === undefined || e.type === "0" ? Buffer.from(e.data ?? "").length : 0), 0);
    } else if (archive === "zip") {
      const entries = s.zipEntries ?? Object.entries(files).map(([name, data]) => ({ name, data }));
      bytes = makeZip(entries);
      expanded = entries.reduce((n, e) => n + Buffer.from(e.data ?? "").length, 0);
    } else {
      bytes = Buffer.from(Object.values(files)[0] ?? "single file");
      expanded = bytes.length;
    }
    const artifactId = `${s.id}-${s.version}`.replace(/[^a-z0-9._-]/g, "-");
    served.set(artifactId, bytes);
    return {
      id: s.id, version: s.version, kind: s.kind, title: s.id,
      platforms: s.platforms ?? [{ os: "linux", arch: "x64" }, { os: "windows", arch: "x64", via: "wsl" }],
      capabilities: [],
      ...(s.appVersions ? { appVersions: s.appVersions } : {}),
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      artifacts: [{ id: artifactId, sha256: s.sha256 ?? sha(bytes), downloadBytes: s.downloadBytes ?? bytes.length, expandedBytes: s.expandedBytes ?? Math.max(expanded, bytes.length), archive }],
      license: { spdx: "MIT" }
    };
  });
  const raw = { schema: "seed.component-manifest/0.1", app, recipeRevision: "r1", components };
  const v = validateManifest(raw);
  if (!v.ok) throw new Error("fixture manifest does not validate: " + JSON.stringify(v.errors));
  return { manifest: v.manifest, sha: sha(JSON.stringify(raw)) };
}

/** A source that serves from memory, and remembers what it served. */
export function memorySource(served: Map<string, Buffer>, log: string[]): ArtifactSource {
  return async (a, dest) => {
    log.push(a.id);
    const b = served.get(a.id);
    if (!b) throw new Error(`no such artifact on the server: ${a.id}`);
    fs.writeFileSync(dest, b);
  };
}

export const CORE = (version = "1.2.0"): Spec => ({ id: "fakeapp-core", version, kind: "core" });
export const LIBS = (version = "2.0.0"): Spec => ({ id: "shared-libs", version, kind: "library" });
export const CAD = (version = "0.3.0", over: Partial<Spec> = {}): Spec => ({
  id: "fake-cad", version, kind: "addon", archive: "zip", dependsOn: [{ component: "fakeapp-core", min: "1.2.0" }, { component: "shared-libs", min: "2.0.0" }], ...over
});

export type World = ReturnType<typeof makeWorld>;
export const dirs: string[] = [];

/** A temporary machine: an install root (its path has a space in it), a server and an environment for the installer. */
export function makeWorld(over: Partial<InstallEnv> = {}, rootName = "SEED apps") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "seed-install-"));
  dirs.push(base);
  const root = path.join(base, rootName);
  const served = new Map<string, Buffer>();
  const downloads: string[] = [];
  const env: InstallEnv = { root, platform: linux, appVersion: "1.5.0", source: memorySource(served, downloads), ...over };
  return {
    base, root, served, downloads, env,
    manifest: (specs: Spec[]) => fixtureManifest(specs, served),
    with: (more: Partial<InstallEnv>): InstallEnv => ({ ...env, ...more }),
    versionDir: (component: string, version: string) => path.join(root, "fakeapp", component, version),
    pointer: (component: string) => {
      try { return fs.readFileSync(path.join(root, ".seed", "active", "fakeapp", component), "utf8").trim(); } catch { return null; }
    },
    state: () => JSON.parse(fs.readFileSync(path.join(root, ".seed", "components.json"), "utf8")),
    leftovers: () => {
      const out: string[] = [];
      for (const d of ["staging", "trash"]) {
        const p = path.join(root, ".seed", d);
        if (fs.existsSync(p)) out.push(...fs.readdirSync(p).map((n) => `${d}/${n}`));
      }
      return out;
    }
  };
}

export function cleanWorlds() {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
