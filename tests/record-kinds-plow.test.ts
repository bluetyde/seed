// @covers R-PKG-01
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { validateManifest, validateRecordKinds, type Manifest, type Platform, type RecordKind, type RecordRegistry } from "../src/core/components";
import { resolveChain } from "../src/core/packages";

// PLOW's three record kinds in SEED's registry (record-kinds.json): the entries follow the registry's rules, name nothing private, say what the results are
// worth, and a consumer that needs one is told how to make it. The wire schemas live in PLOW's repository; a test below checks the pinned hashes against it
// when SEED_PLOW_REPO names a checkout of it (it is skipped otherwise: PLOW is a separate repository).
const registry = (() => {
  const v = validateRecordKinds(JSON.parse(readFileSync(join(__dirname, "..", "record-kinds.json"), "utf8")));
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.registry;
})();
const KINDS = ["fusion-source", "first-wall-geometry", "blanket-heat-load"];
const plowKinds = (): RecordKind[] => registry.kinds.filter((k) => k.owner === "plow");

describe("the PLOW record kinds in record-kinds.json", () => {
  it("are the three kinds, each at version 1, owned by plow and defined with a wire schema of the same name and a pinned hash", () => {
    expect(plowKinds().map((k) => k.record)).toEqual(KINDS);
    for (const k of plowKinds()) {
      expect(k.version, k.record).toBe(1);
      expect(k.status, k.record).toBe("defined");
      expect(k.wireSchema, k.record).toBe(`plow.${k.record}/0.1`);
      expect(k.schemaSha256, k.record).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(plowKinds().map((k) => k.schemaSha256)).size).toBe(3);
  });

  it("leave the depletion record's entry as it was (planned, owned by Studio)", () => {
    const dep = registry.kinds.find((k) => k.record === "depletion-record");
    expect(dep).toMatchObject({ version: 1, owner: "openmc-studio", status: "planned", wireSchema: "studio.depletion/0.1" });
    expect(dep?.schemaSha256).toBeUndefined();
  });

  it("say in every manual that the result is educational and not validated for design, safety or licensing use", () => {
    for (const k of plowKinds()) expect(k.manual, k.record).toContain("educational result, not validated for design, safety or licensing use");
  });

  it("carry no personal path, machine name or address, and stay inside the registry's length limits with room to spare", () => {
    for (const k of plowKinds()) {
      for (const text of [k.summary, k.manual]) {
        expect(text, k.record).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\/|@|\\\\/);
      }
      expect(k.summary.length, k.record).toBeLessThanOrEqual(300);
      expect(k.manual.length, k.record).toBeLessThanOrEqual(600);
    }
  });

  it("say, for the heat load, that it needs the other two records first", () => {
    const heat = plowKinds().find((k) => k.record === "blanket-heat-load")!;
    expect(heat.manual).toContain("fusion-source");
    expect(heat.manual).toContain("first-wall-geometry");
  });
});

describe("what a consumer sees", () => {
  const linux: Platform = { os: "linux", arch: "x64" };
  let n = 0;
  const sha = () => (++n).toString(16).padStart(64, "0");
  const comp = (id: string, kind: "core" | "addon", extra: Record<string, unknown> = {}) => ({
    id, version: "1.0.0", kind, title: id, platforms: [{ os: "linux", arch: "x64" }], capabilities: [id],
    artifacts: [{ id: id + "-pack", sha256: sha(), downloadBytes: 1000, expandedBytes: 3000, archive: "tar.gz" }], license: { spdx: "MIT" }, ...extra
  });
  const valid = (app: string, components: unknown[]): Manifest => {
    const v = validateManifest({ schema: "seed.component-manifest/0.2", app, recipeRevision: "r1", components });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return v.manifest;
  };
  const consumer = valid("demo", [comp("demo-core", "core"), comp("demo-wall", "addon", { consumes: [{ record: "blanket-heat-load", minVersion: 1, maxVersion: 1 }], dependsOn: [{ component: "demo-core" }] })]);
  const producer = valid("plow", [comp("plow-core", "core", { produces: KINDS.map((record) => ({ record, version: 1 })) })]);
  const ask = (manifests: Manifest[], reg: RecordRegistry = registry) =>
    resolveChain({ manifests, registry: reg, installed: [], select: [{ app: "demo", component: "demo-wall" }], platform: linux, appVersions: { demo: "1.0.0", plow: "1.0.0" } });

  it("a manifest may consume a PLOW kind, and an unregistered kind is still refused", () => {
    expect(ask([consumer, producer]).ok).toBe(true);
    const without: RecordRegistry = { ...registry, kinds: registry.kinds.filter((k) => k.record !== "blanket-heat-load") };
    const r = ask([consumer, producer], without);
    expect(r.ok).toBe(false);
  });

  it("with the PLOW package available the producer is planned", () => {
    const r = ask([consumer, producer]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.steps.map((s) => `${s.action}:${s.app}/${s.component}`)).toContain("install:plow/plow-core");
  });

  it("with no PLOW package the refusal names the record and says how to make it by hand", () => {
    const r = ask([consumer]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("E_RECORD_NO_PRODUCER");
      expect(r.errors[0]!.message).toContain("blanket-heat-load");
      expect(r.errors[0]!.message).toContain("By hand: In PLOW, run `python -m plow records point.json --out-dir out`");
      expect(r.errors[0]!.message).toContain("not validated for design, safety or licensing use");
    }
  });
});

describe.skipIf(!process.env.SEED_PLOW_REPO || !existsSync(join(process.env.SEED_PLOW_REPO, "schema")))("against a checkout of PLOW (SEED_PLOW_REPO)", () => {
  const repo = process.env.SEED_PLOW_REPO ?? "";
  // the hash is of the file as git stores it, with LF line endings: a checkout that converts them to CRLF is read back as LF before it is hashed
  const bytesOf = (file: string) => Buffer.from(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "utf8");
  it.each(KINDS)("%s: the pinned hash is the hash of PLOW's wire schema, and SEED's own JSON Schema engine compiles it", (record) => {
    const k = registry.kinds.find((x) => x.record === record)!;
    const file = join(repo, "schema", `${k.wireSchema!.split("/")[0]}.schema.json`);
    expect(createHash("sha256").update(bytesOf(file)).digest("hex")).toBe(k.schemaSha256);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(() => ajv.compile(JSON.parse(readFileSync(file, "utf8")))).not.toThrow();
  });
});
