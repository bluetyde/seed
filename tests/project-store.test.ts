import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/canonical";
import { isAlive } from "../src/core/procTree";
import {
  createProject,
  listMissingArtifacts,
  MANIFEST_FILE,
  openProject,
  projectRevision,
  recoverProject,
  resolveArtifact,
  saveProject,
  saveProjectHeld,
  withProjectLock,
  withProjectLockAsync,
} from "../src/core/projectStore";
import { checkProject } from "../src/core/semantic";
import { validate } from "../src/core/validate";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

function makeTempDir(prefix = "seed-store-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of spawnedChildren) {
    try {
      if (child.pid && isAlive(child.pid)) {
        child.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
  }
  spawnedChildren.length = 0;

  for (const dir of tempDirs) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // ignore
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

describe("Project Store", () => {
  it("1. Create: valid manifest, folders, created===updated, revision, newId/now, non-empty dir, empty dir, invalid name", () => {
    const dir = makeTempDir();
    const fixedDate = new Date("2026-10-03T12:00:00.000Z");
    const fixedId = "p-0123456789ab";

    // Valid create with custom now and newId
    const res = createProject(dir, {
      name: "Test Project",
      seedVersion: "0.1.0",
      now: () => fixedDate,
      newId: () => fixedId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { manifest, revision } = res.value;
    expect(manifest.projectId).toBe(fixedId);
    expect(manifest.name).toBe("Test Project");
    expect(manifest.created).toBe(fixedDate.toISOString());
    expect(manifest.updated).toBe(fixedDate.toISOString());
    expect(manifest.seedVersion).toBe("0.1.0");
    expect(revision).toBe(projectRevision(manifest));

    // Passes validate and checkProject
    expect(validate("project", manifest).ok).toBe(true);
    expect(checkProject(manifest)).toEqual([]);

    // The four folders exist
    expect(existsSync(join(dir, "models"))).toBe(true);
    expect(existsSync(join(dir, "runs"))).toBe(true);
    expect(existsSync(join(dir, "studies"))).toBe(true);
    expect(existsSync(join(dir, "oracles"))).toBe(true);

    // Non-empty dir -> E_EXISTS
    const resExists = createProject(dir, {
      name: "Second Project",
      seedVersion: "0.1.0",
    });
    expect(resExists.ok).toBe(false);
    if (!resExists.ok) {
      expect(resExists.errors[0]?.code).toBe("E_EXISTS");
    }

    // Empty existing dir is accepted
    const emptyDir = makeTempDir();
    const resEmpty = createProject(emptyDir, {
      name: "Empty Dir Project",
      seedVersion: "0.1.0",
    });
    expect(resEmpty.ok).toBe(true);

    // Name of 0 characters -> E_SCHEMA_INVALID
    const dir0 = makeTempDir();
    const res0 = createProject(dir0, {
      name: "",
      seedVersion: "0.1.0",
    });
    expect(res0.ok).toBe(false);
    if (!res0.ok) {
      expect(res0.errors[0]?.code).toBe("E_SCHEMA_INVALID");
    }

    // Name of 121 characters -> E_SCHEMA_INVALID
    const dir121 = makeTempDir();
    const res121 = createProject(dir121, {
      name: "a".repeat(121),
      seedVersion: "0.1.0",
    });
    expect(res121.ok).toBe(false);
    if (!res121.ok) {
      expect(res121.errors[0]?.code).toBe("E_SCHEMA_INVALID");
    }
  });

  it("2. Open errors: missing folder/manifest, invalid JSON, schema failure, duplicate artifact ids, unsupported schema version, no folder mutation", () => {
    // Missing folder -> E_NOT_FOUND
    const nonExistentDir = join(tmpdir(), `seed-missing-${Date.now()}`);
    const resMissing = openProject(nonExistentDir);
    expect(resMissing.ok).toBe(false);
    if (!resMissing.ok) {
      expect(resMissing.errors[0]?.code).toBe("E_NOT_FOUND");
    }

    // Existing dir without manifest -> E_NOT_FOUND
    const dirNoManifest = makeTempDir();
    const resNoManifest = openProject(dirNoManifest);
    expect(resNoManifest.ok).toBe(false);
    if (!resNoManifest.ok) {
      expect(resNoManifest.errors[0]?.code).toBe("E_NOT_FOUND");
    }

    // Invalid JSON -> E_SCHEMA_INVALID with field ""
    const dirInvalidJson = makeTempDir();
    writeFileSync(join(dirInvalidJson, MANIFEST_FILE), "{ not valid json ", "utf8");
    const resInvalidJson = openProject(dirInvalidJson);
    expect(resInvalidJson.ok).toBe(false);
    if (!resInvalidJson.ok) {
      expect(resInvalidJson.errors[0]?.code).toBe("E_SCHEMA_INVALID");
      expect(resInvalidJson.errors[0]?.field).toBe("");
    }

    // Schema failure (missing required seedVersion) -> E_SCHEMA_INVALID
    const dirBadSchema = makeTempDir();
    const badManifest = {
      schema: "seed.project/0.1",
      projectId: "p-123456789012",
      name: "Bad Project",
      created: "2026-10-03T12:00:00.000Z",
      updated: "2026-10-03T12:00:00.000Z",
      folders: { models: "models", runs: "runs", studies: "studies", oracles: "oracles" },
      artifacts: [],
      materials: [],
      // missing seedVersion
    };
    writeFileSync(join(dirBadSchema, MANIFEST_FILE), JSON.stringify(badManifest, null, 2), "utf8");
    const resBadSchema = openProject(dirBadSchema);
    expect(resBadSchema.ok).toBe(false);
    if (!resBadSchema.ok) {
      expect(resBadSchema.errors[0]?.code).toBe("E_SCHEMA_INVALID");
    }

    // Manifest with duplicate artifact ids -> E_SCHEMA_INVALID
    const dirDupArtifacts = makeTempDir();
    const dupArtifactManifest = {
      ...badManifest,
      seedVersion: "0.1.0",
      artifacts: [
        {
          id: "art-1",
          app: "app1",
          path: "models/m1.json",
          format: "json",
          formatVersion: "1.0",
          revision: { hash: "0".repeat(64), counter: 0 },
        },
        {
          id: "art-1",
          app: "app1",
          path: "models/m2.json",
          format: "json",
          formatVersion: "1.0",
          revision: { hash: "0".repeat(64), counter: 0 },
        },
      ],
    };
    writeFileSync(join(dirDupArtifacts, MANIFEST_FILE), JSON.stringify(dupArtifactManifest, null, 2), "utf8");
    const resDupArtifacts = openProject(dirDupArtifacts);
    expect(resDupArtifacts.ok).toBe(false);
    if (!resDupArtifacts.ok) {
      expect(resDupArtifacts.errors[0]?.code).toBe("E_SCHEMA_INVALID");
      expect(resDupArtifacts.errors[0]?.field).toBe("/artifacts/1/id");
    }

    // Schema version seed.project/0.2 -> E_SCHEMA_VERSION
    const dirVer2 = makeTempDir();
    const ver2Manifest = {
      ...badManifest,
      seedVersion: "0.1.0",
      schema: "seed.project/0.2",
    };
    writeFileSync(join(dirVer2, MANIFEST_FILE), JSON.stringify(ver2Manifest, null, 2), "utf8");
    const resVer2 = openProject(dirVer2);
    expect(resVer2.ok).toBe(false);
    if (!resVer2.ok) {
      expect(resVer2.errors[0]?.code).toBe("E_SCHEMA_VERSION");
      expect(resVer2.errors[0]?.field).toBe("/schema");
    }

    // Open does not modify the folder (compare tree and mtime)
    const validDir = makeTempDir();
    createProject(validDir, { name: "Check No Mutation", seedVersion: "0.1.0" });
    const manifestPath = join(validDir, MANIFEST_FILE);
    const mtimeBefore = statSync(manifestPath).mtimeMs;
    const treeBefore = readdirSync(validDir).sort();

    const openOk = openProject(validDir);
    expect(openOk.ok).toBe(true);

    const mtimeAfter = statSync(manifestPath).mtimeMs;
    const treeAfter = readdirSync(validDir).sort();
    expect(treeAfter).toEqual(treeBefore);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("3. Save and reopen: change name, save with current revision, reopen, formatting", () => {
    const dir = makeTempDir();
    const t0 = new Date("2026-10-03T10:00:00.000Z");
    const t1 = new Date("2026-10-03T11:00:00.000Z");
    const created = createProject(dir, { name: "Original Name", seedVersion: "0.1.0", now: () => t0 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const initialRevision = created.value.revision;
    const toSave = { ...created.value.manifest, name: "New Name" };

    const saveRes = saveProject(dir, toSave, initialRevision, { now: () => t1 });
    expect(saveRes.ok).toBe(true);
    if (!saveRes.ok) return;

    expect(saveRes.value.manifest.name).toBe("New Name");
    expect(saveRes.value.manifest.updated).toBe(t1.toISOString());
    expect(saveRes.value.revision).not.toBe(initialRevision);

    // Reopen and assert
    const reopened = openProject(dir);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    expect(reopened.value.manifest.name).toBe("New Name");
    expect(reopened.value.manifest.updated).toBe(t1.toISOString());
    expect(reopened.value.revision).toBe(saveRes.value.revision);

    // File ends with a single line feed and is two-space indented
    const rawContent = readFileSync(join(dir, MANIFEST_FILE), "utf8");
    expect(rawContent.endsWith("\n")).toBe(true);
    expect(rawContent.endsWith("\n\n")).toBe(false);
    expect(rawContent).toContain('  "name": "New Name"');
  });

  it("4. Second writer conflict: two handles, stale revision, file holds first writer content, reopening succeeds", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Base", seedVersion: "0.1.0" });

    // Two handles open the same revision
    const handle1 = openProject(dir);
    const handle2 = openProject(dir);
    expect(handle1.ok).toBe(true);
    expect(handle2.ok).toBe(true);
    if (!handle1.ok || !handle2.ok) return;

    // Handle 1 saves first
    const save1 = saveProject(
      dir,
      { ...handle1.value.manifest, name: "From Handle 1" },
      handle1.value.revision
    );
    expect(save1.ok).toBe(true);
    if (!save1.ok) return;

    const contentAfterSave1 = readFileSync(join(dir, MANIFEST_FILE), "utf8");

    // Handle 2 tries to save with the old revision
    const save2 = saveProject(
      dir,
      { ...handle2.value.manifest, name: "From Handle 2" },
      handle2.value.revision
    );
    expect(save2.ok).toBe(false);
    if (!save2.ok) {
      expect(save2.errors[0]?.code).toBe("E_STALE_REVISION");
      expect(save2.errors[0]?.field).toBe("/revision");
    }

    // The file still holds the first writer's content byte for byte
    const contentAfterSave2 = readFileSync(join(dir, MANIFEST_FILE), "utf8");
    expect(contentAfterSave2).toBe(contentAfterSave1);

    // The rejection is recorded in the project (acceptance case 6): what the second writer expected and what the project held
    const conflicts = readFileSync(join(dir, ".seed", "conflicts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: "E_STALE_REVISION", expectedRevision: handle2.value.revision, observedRevision: save1.value.revision });
    expect(Number.isFinite(Date.parse(conflicts[0].time))).toBe(true);

    // After reopening, handle 2 can save with the new revision
    const handle2Fresh = openProject(dir);
    expect(handle2Fresh.ok).toBe(true);
    if (!handle2Fresh.ok) return;

    const save2Retry = saveProject(
      dir,
      { ...handle2Fresh.value.manifest, name: "From Handle 2 Fresh" },
      handle2Fresh.value.revision
    );
    expect(save2Retry.ok).toBe(true);
    if (!save2Retry.ok) return;
    expect(save2Retry.value.manifest.name).toBe("From Handle 2 Fresh");
  });

  it("5. Refused saves leave the file byte for byte unchanged, and material rules", () => {
    const dir = makeTempDir();
    const created = createProject(dir, { name: "Base", seedVersion: "0.1.0" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const baseManifest = created.value.manifest;
    const baseRevision = created.value.revision;
    const manifestPath = join(dir, MANIFEST_FILE);

    // Helper to test that refused save leaves file byte-for-byte unchanged
    const assertRefusedUnchanged = (
      badManifest: Record<string, unknown>,
      expectedCode: string,
      expectedField?: string
    ) => {
      const bytesBefore = readFileSync(manifestPath);
      const res = saveProject(dir, badManifest, baseRevision);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe(expectedCode);
        if (expectedField !== undefined) {
          expect(res.errors[0]?.field).toBe(expectedField);
        }
      }
      const bytesAfter = readFileSync(manifestPath);
      expect(bytesAfter).toEqual(bytesBefore);
    };

    // 1. Schema-invalid manifest
    assertRefusedUnchanged({ ...baseManifest, name: "" }, "E_SCHEMA_INVALID", "/name");

    // 2. Changed projectId
    assertRefusedUnchanged({ ...baseManifest, projectId: "p-other-id" }, "E_SCHEMA_INVALID", "/projectId");

    // 3. Changed created
    assertRefusedUnchanged(
      { ...baseManifest, created: "2020-01-01T00:00:00.000Z" },
      "E_SCHEMA_INVALID",
      "/created"
    );

    // 4. Duplicate artifact ids
    assertRefusedUnchanged(
      {
        ...baseManifest,
        artifacts: [
          { id: "a1", app: "app", path: "models/1.json", format: "f", formatVersion: "1", revision: { hash: "0".repeat(64), counter: 0 } },
          { id: "a1", app: "app", path: "models/2.json", format: "f", formatVersion: "1", revision: { hash: "0".repeat(64), counter: 0 } },
        ],
      },
      "E_SCHEMA_INVALID",
      "/artifacts/1/id"
    );

    // Now set up a material in base manifest to test material revision rules
    const mat1 = {
      id: "mat-1",
      revision: 1,
      name: "Uranium",
      sets: {
        "core.composition": { schema: "comp/1.0", density: 19.1 },
      },
    };
    const withMatRes = saveProject(
      dir,
      { ...baseManifest, materials: [mat1] },
      baseRevision
    );
    expect(withMatRes.ok).toBe(true);
    if (!withMatRes.ok) return;

    const currentManifest = withMatRes.value.manifest;
    let currentRev = withMatRes.value.revision;

    const assertMatRefusedUnchanged = (
      badManifest: Record<string, unknown>,
      expectedCode: string,
      expectedField?: string
    ) => {
      const bytesBefore = readFileSync(manifestPath);
      const res = saveProject(dir, badManifest, currentRev);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe(expectedCode);
        if (expectedField !== undefined) {
          expect(res.errors[0]?.field).toBe(expectedField);
        }
      }
      const bytesAfter = readFileSync(manifestPath);
      expect(bytesAfter).toEqual(bytesBefore);
    };

    // 5. Material content changed with the SAME revision -> refused
    const matChangedSameRev = {
      ...mat1,
      name: "Enriched Uranium", // changed
      revision: 1, // same
    };
    assertMatRefusedUnchanged(
      { ...currentManifest, materials: [matChangedSameRev] },
      "E_SCHEMA_INVALID",
      "/materials/0/revision"
    );

    // 6. Material content unchanged but revision bumped -> refused
    const matUnchangedBumpedRev = {
      ...mat1,
      revision: 2, // bumped
    };
    assertMatRefusedUnchanged(
      { ...currentManifest, materials: [matUnchangedBumpedRev] },
      "E_SCHEMA_INVALID",
      "/materials/0/revision"
    );

    // 7. Material changed with a lower revision -> refused
    // First bump to revision 2 with changed content (valid)
    const validBump = saveProject(
      dir,
      { ...currentManifest, materials: [{ ...mat1, name: "Enriched Uranium", revision: 2 }] },
      currentRev
    );
    expect(validBump.ok).toBe(true);
    if (!validBump.ok) return;
    currentRev = validBump.value.revision;
    const manifestWithRev2 = validBump.value.manifest;

    // Now try to change content with a lower revision (1 <= 2)
    const matLowerRev = {
      ...mat1,
      name: "Depleted Uranium",
      revision: 1, // lower than 2
    };
    assertMatRefusedUnchanged(
      { ...manifestWithRev2, materials: [matLowerRev] },
      "E_SCHEMA_INVALID",
      "/materials/0/revision"
    );

    // Accepted save when content changes with a higher revision
    const validHigherRev = saveProject(
      dir,
      { ...manifestWithRev2, materials: [{ ...mat1, name: "Depleted Uranium", revision: 3 }] },
      currentRev
    );
    expect(validHigherRev.ok).toBe(true);
    if (!validHigherRev.ok) return;
    currentRev = validHigherRev.value.revision;

    // Accepted save when a material is new
    const mat2 = {
      id: "mat-2",
      revision: 1,
      name: "Water",
      sets: { "core.thermal": { schema: "th/1.0" } },
    };
    const validNewMat = saveProject(
      dir,
      { ...validHigherRev.value.manifest, materials: [validHigherRev.value.manifest.materials![0], mat2] },
      currentRev
    );
    expect(validNewMat.ok).toBe(true);
    if (!validNewMat.ok) return;
    currentRev = validNewMat.value.revision;

    // Accepted save when a material is removed
    const validRemoveMat = saveProject(
      dir,
      { ...validNewMat.value.manifest, materials: [mat2] }, // mat-1 removed
      currentRev
    );
    expect(validRemoveMat.ok).toBe(true);
  });

  it("6. Preservation: custom material sets, unknown sets, __proto__, constructor, toString, prototype preservation", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Preserve", seedVersion: "0.1.0" });

    // Manifest written by hand with JSON.parse so __proto__ is an own key
    const rawJson = `
{
  "schema": "seed.project/0.1",
  "projectId": "p-123456789abc",
  "name": "Preserve Test",
  "created": "2026-10-03T12:00:00.000Z",
  "updated": "2026-10-03T12:00:00.000Z",
  "seedVersion": "0.1.0",
  "folders": {
    "models": "models",
    "runs": "runs",
    "studies": "studies",
    "oracles": "oracles"
  },
  "artifacts": [],
  "materials": [
    {
      "id": "mat-custom",
      "revision": 1,
      "name": "Graphite",
      "sets": {
        "openmc.neutronics": {
          "schema": "openmc.neutronics/0.1",
          "crossSection": "ENDF/B-VIII.0"
        },
        "zzz.unknown-set": {
          "schema": "unknown/1.0",
          "nested": [1, [2, null], { "k": "v" }],
          "expNumber": 1e-9,
          "unicode": "Neutrons \u2622 \u00a9 \ud83d\ude80"
        }
      }
    }
  ],
  "extensions": {
    "__proto__": { "polluted": false },
    "constructor": "custom-constructor-value",
    "toString": 42
  }
}
`;
    writeFileSync(join(dir, MANIFEST_FILE), rawJson.trim() + "\n", "utf8");

    // Open
    const opened = openProject(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Verify own property __proto__ in opened
    const openedExt = opened.value.manifest.extensions as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(openedExt, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(openedExt, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(openedExt, "toString")).toBe(true);
    expect(Object.getPrototypeOf(opened.value.manifest)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(openedExt)).toBe(Object.prototype);

    // Save with a trivial name change
    const toSave = { ...opened.value.manifest, name: "Preserve Test Changed" };
    const saved = saveProject(dir, toSave, opened.value.revision);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // Reopen
    const reopened = openProject(dir);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const reopenedManifest = reopened.value.manifest;
    const reopenedExt = reopenedManifest.extensions as Record<string, unknown>;

    // Assert prototype
    expect(Object.getPrototypeOf(reopenedManifest)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(reopenedExt)).toBe(Object.prototype);

    // Assert own keys
    expect(Object.prototype.hasOwnProperty.call(reopenedExt, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(reopenedExt, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(reopenedExt, "toString")).toBe(true);

    // Deep equal checks on sets and extensions
    const origParsed = JSON.parse(rawJson);
    const origMaterials = origParsed.materials;
    const reopenedMaterials = reopenedManifest.materials as any[];
    expect(reopenedMaterials[0].sets["openmc.neutronics"]).toEqual(
      origMaterials[0].sets["openmc.neutronics"]
    );
    expect(reopenedMaterials[0].sets["zzz.unknown-set"]).toEqual(
      origMaterials[0].sets["zzz.unknown-set"]
    );
    expect(reopenedExt["__proto__"]).toEqual({ polluted: false });
    expect(reopenedExt["constructor"]).toBe("custom-constructor-value");
    expect(reopenedExt["toString"]).toBe(42);
  });

  it("7. Lock basics: runs fn, release on throw, nested acquire, waitMs holder release, saveProject from inside lock hold", async () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Lock Basics", seedVersion: "0.1.0" });
    const lockDir = join(dir, ".seed", "lock");

    // withProjectLock runs fn and lock is gone afterwards
    let ran = false;
    const res = withProjectLock(dir, () => {
      ran = true;
      expect(existsSync(lockDir)).toBe(true);
      return "result-val";
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("result-val");
    expect(ran).toBe(true);
    expect(existsSync(lockDir)).toBe(false);

    // fn throws: error propagates, lock is still released
    expect(() => {
      withProjectLock(dir, () => {
        expect(existsSync(lockDir)).toBe(true);
        throw new Error("Boom");
      });
    }).toThrow("Boom");
    expect(existsSync(lockDir)).toBe(false);

    // Release leaves lock alone if owner.json token does not match
    withProjectLock(dir, () => {
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({ ownerId: "other", pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: "other-token" }) + "\n",
        "utf8"
      );
    });
    expect(existsSync(lockDir)).toBe(true);
    rmSync(lockDir, { recursive: true, force: true });

    // Nested acquire inside fn -> E_PROJECT_LOCKED
    withProjectLock(dir, () => {
      const nested = withProjectLock(dir, () => "nested");
      expect(nested.ok).toBe(false);
      if (!nested.ok) {
        expect(nested.errors[0]?.code).toBe("E_PROJECT_LOCKED");
      }
    });
    expect(existsSync(lockDir)).toBe(false);

    // waitMs 300 with a holder that releases after 100 ms succeeds
    const holderScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      const pDir = ${JSON.stringify(dir)};
      const lDir = path.join(pDir, '.seed', 'lock');
      fs.mkdirSync(lDir, { recursive: true });
      fs.writeFileSync(path.join(lDir, 'owner.json'), JSON.stringify({
        ownerId: 'short-holder',
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
        token: 'short-token'
      }) + '\\n', 'utf8');
      process.stdout.write('locked\\n');
      setTimeout(() => {
        fs.rmSync(lDir, { recursive: true, force: true });
        process.exit(0);
      }, 100);
    `;
    const child = spawn(process.execPath, ["-e", holderScript], { stdio: ["ignore", "pipe", "pipe"] });
    spawnedChildren.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => {
        if (d.toString().includes("locked")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        reject(new Error(`short-holder exited prematurely with code ${code}`));
      });
    });

    const waitAcquire = withProjectLock(dir, () => "acquired-after-wait", { waitMs: 400 });
    expect(waitAcquire.ok).toBe(true);
    if (waitAcquire.ok) {
      expect(waitAcquire.value).toBe("acquired-after-wait");
    }

    // Two saveProject calls issued from inside one lock hold -> inner returns E_PROJECT_LOCKED, outer content intact
    const openRes = openProject(dir);
    expect(openRes.ok).toBe(true);
    if (!openRes.ok) return;

    withProjectLock(dir, () => {
      const innerSave = saveProject(
        dir,
        { ...openRes.value.manifest, name: "Inner Save" },
        openRes.value.revision
      );
      expect(innerSave.ok).toBe(false);
      if (!innerSave.ok) {
        expect(innerSave.errors[0]?.code).toBe("E_PROJECT_LOCKED");
      }
    });

    // Content intact
    const reopened = openProject(dir);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.value.manifest.name).toBe("Lock Basics");
    }
  });

  it("8. Crash recovery with a real process: spawn lock-holder.cjs, SIGKILL, stale takeover, save succeeds", async () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Crash Recovery", seedVersion: "0.1.0" });

    const fixturePath = join(__dirname, "fixtures", "lock-holder.cjs");
    const child = spawn(process.execPath, [fixturePath, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawnedChildren.push(child);

    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (data) => {
        if (data.toString().includes("locked")) {
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        reject(new Error(`lock-holder exited prematurely with code ${code}`));
      });
    });

    // While child is alive, lock is held
    const heldRes = withProjectLock(dir, () => "should-fail");
    expect(heldRes.ok).toBe(false);
    if (!heldRes.ok) {
      expect(heldRes.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    }

    // Kill the process with SIGKILL and wait for exit
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
      } else {
        child.once("exit", () => resolve());
      }
    });

    // Ensure pid is dead
    const deadline = Date.now() + 3000;
    while (child.pid && isAlive(child.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Now withProjectLock succeeds (stale because pid is dead on same host) and stale dir was replaced
    const lockDir = join(dir, ".seed", "lock");
    const recoverRes = withProjectLock(dir, () => {
      expect(existsSync(lockDir)).toBe(true);
      const newOwner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
      expect(newOwner.ownerId).not.toBe("holder");
      return "recovered-ok";
    });
    expect(recoverRes.ok).toBe(true);
    if (recoverRes.ok) {
      expect(recoverRes.value).toBe("recovered-ok");
    }

    // A save succeeds
    const opened = openProject(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const saveRes = saveProject(
      dir,
      { ...opened.value.manifest, name: "Crash Recovered Name" },
      opened.value.revision
    );
    expect(saveRes.ok).toBe(true);
    if (saveRes.ok) {
      expect(saveRes.value.manifest.name).toBe("Crash Recovered Name");
    }
  });

  it("9. Stale rules with injected isAlive and now: same host live/dead, different host young/old, no owner.json fresh/old, garbage owner.json, no leftover stale dir", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Stale Injected", seedVersion: "0.1.0" });
    const seedDir = join(dir, ".seed");
    const lockDir = join(seedDir, "lock");
    const ownerPath = join(lockDir, "owner.json");

    const tCurrent = new Date("2026-10-03T12:00:00.000Z");
    const tOneYearAgo = new Date("2025-10-03T12:00:00.000Z");
    const nowFn = () => tCurrent;

    // Helper to write an owner.json
    const setupLock = (owner: Record<string, unknown>) => {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + "\n", "utf8");
    };

    // 1. Same host, pid alive -> held, NOT stale, even when acquiredAt is a year old
    setupLock({
      ownerId: "h1",
      pid: 99999,
      host: os.hostname(),
      acquiredAt: tOneYearAgo.toISOString(),
      token: "tok-1",
    });
    const resSameAlive = withProjectLock(dir, () => "ok", {
      isAlive: (pid) => pid === 99999,
      now: nowFn,
    });
    expect(resSameAlive.ok).toBe(false);
    if (!resSameAlive.ok) {
      expect(resSameAlive.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    }

    // 2. Different host, younger than staleMs (600s) -> held
    setupLock({
      ownerId: "h2",
      pid: 111,
      host: "other-host",
      acquiredAt: new Date(tCurrent.getTime() - 100000).toISOString(), // 100s ago < 600s
      token: "tok-2",
    });
    const resDiffYoung = withProjectLock(dir, () => "ok", { now: nowFn, staleMs: 600000 });
    expect(resDiffYoung.ok).toBe(false);
    if (!resDiffYoung.ok) {
      expect(resDiffYoung.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    }

    // 3. Different host, older than staleMs -> taken over
    setupLock({
      ownerId: "h3",
      pid: 111,
      host: "other-host",
      acquiredAt: new Date(tCurrent.getTime() - 700000).toISOString(), // 700s ago > 600s
      token: "tok-3",
    });
    const resDiffOld = withProjectLock(dir, () => "took-over", { now: nowFn, staleMs: 600000 });
    expect(resDiffOld.ok).toBe(true);
    if (resDiffOld.ok) expect(resDiffOld.value).toBe("took-over");

    // 4. No owner.json and fresh directory -> held
    mkdirSync(lockDir, { recursive: true });
    // fresh mtime is right now
    const resNoOwnerFresh = withProjectLock(dir, () => "ok", { now: nowFn, graceMs: 5000 });
    expect(resNoOwnerFresh.ok).toBe(false);
    if (!resNoOwnerFresh.ok) {
      expect(resNoOwnerFresh.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    }

    // 5. No owner.json and an old directory (set mtime back with utimesSync) -> taken over
    const oldTimeSec = (tCurrent.getTime() - 10000) / 1000;
    utimesSync(lockDir, oldTimeSec, oldTimeSec);
    const resNoOwnerOld = withProjectLock(dir, () => "took-over-no-owner", { now: nowFn, graceMs: 5000 });
    expect(resNoOwnerOld.ok).toBe(true);
    if (resNoOwnerOld.ok) expect(resNoOwnerOld.value).toBe("took-over-no-owner");

    // 6. Unreadable/garbage owner.json is treated like a missing one
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(ownerPath, "{ not valid json owner", "utf8");
    utimesSync(lockDir, oldTimeSec, oldTimeSec); // old dir
    const resGarbageOld = withProjectLock(dir, () => "took-over-garbage", { now: nowFn, graceMs: 5000 });
    expect(resGarbageOld.ok).toBe(true);
    if (resGarbageOld.ok) expect(resGarbageOld.value).toBe("took-over-garbage");

    // A takeover leaves no lock.stale-* directory behind
    const staleDirs = readdirSync(seedDir).filter((f) => f.startsWith("lock.stale-"));
    expect(staleDirs).toEqual([]);
  });

  it("10. Interrupted write: recoverProject cleans leftovers; live lock prevents recovery; read-only root", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Interrupted Write", seedVersion: "0.1.0" });
    const originalManifestContent = readFileSync(join(dir, MANIFEST_FILE), "utf8");

    // Place garbage seed.project.json.tmp-deadbeef and .seed/lock.stale-x
    writeFileSync(join(dir, "seed.project.json.tmp-deadbeef"), "garbage", "utf8");
    mkdirSync(join(dir, ".seed", "lock.stale-x"), { recursive: true });

    // openProject still returns original manifest
    const openRes = openProject(dir);
    expect(openRes.ok).toBe(true);
    if (openRes.ok) {
      expect(openRes.value.manifest.name).toBe("Interrupted Write");
    }

    // Live lock prevents recoverProject -> E_PROJECT_LOCKED and nothing deleted
    const lockDir = join(dir, ".seed", "lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ ownerId: "live", pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: "t" })
    );

    const recoverLocked = recoverProject(dir);
    expect(recoverLocked.ok).toBe(false);
    if (!recoverLocked.ok) {
      expect(recoverLocked.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    }
    expect(existsSync(join(dir, "seed.project.json.tmp-deadbeef"))).toBe(true);
    expect(existsSync(join(dir, ".seed", "lock.stale-x"))).toBe(true);

    // Release live lock
    rmSync(lockDir, { recursive: true, force: true });

    // Now recoverProject returns exactly those two names, they are gone, and manifest/folders untouched
    const recovered = recoverProject(dir);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.sort()).toEqual(["lock.stale-x", "seed.project.json.tmp-deadbeef"].sort());
    }
    expect(existsSync(join(dir, "seed.project.json.tmp-deadbeef"))).toBe(false);
    expect(existsSync(join(dir, ".seed", "lock.stale-x"))).toBe(false);
    expect(readFileSync(join(dir, MANIFEST_FILE), "utf8")).toBe(originalManifestContent);
    expect(existsSync(join(dir, "models"))).toBe(true);
    expect(existsSync(join(dir, "runs"))).toBe(true);
    expect(existsSync(join(dir, "studies"))).toBe(true);
    expect(existsSync(join(dir, "oracles"))).toBe(true);

    // Failed-write case (POSIX only; skip on Windows with a comment saying so)
    if (process.platform === "win32") {
      // Skipping chmod read-only test on Windows: directory chmod has different ACL semantics on Windows
    } else if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Skipping when running as root because root ignores chmod 0555
    } else {
      const bytesBefore = readFileSync(join(dir, MANIFEST_FILE));
      chmodSync(dir, 0o555);
      const failSave = saveProject(dir, { ...openRes.ok ? openRes.value.manifest : {}, name: "ReadOnlyFail" }, openRes.ok ? openRes.value.revision : "");
      expect(failSave.ok).toBe(false);
      if (!failSave.ok) {
        expect(["E_INTERNAL", "E_PROJECT_LOCKED"]).toContain(failSave.errors[0]?.code);
      }
      chmodSync(dir, 0o755);
      const bytesAfter = readFileSync(join(dir, MANIFEST_FILE));
      expect(bytesAfter).toEqual(bytesBefore);
    }
  });

  it("11. Relocation: renameSync and cpSync resolve artifacts; listMissingArtifacts returns deleted file id only", () => {
    const dir = makeTempDir();
    const created = createProject(dir, { name: "Relocation Test", seedVersion: "0.1.0" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Create two artifacts in models/
    writeFileSync(join(dir, "models", "model1.json"), '{"model": 1}\n', "utf8");
    writeFileSync(join(dir, "models", "model2.json"), '{"model": 2}\n', "utf8");

    const artifacts = [
      {
        id: "art-1",
        app: "app",
        path: "models/model1.json",
        format: "json",
        formatVersion: "1.0",
        revision: { hash: "0".repeat(64), counter: 0 },
      },
      {
        id: "art-2",
        app: "app",
        path: "models/model2.json",
        format: "json",
        formatVersion: "1.0",
        revision: { hash: "0".repeat(64), counter: 0 },
      },
    ];

    const saved = saveProject(
      dir,
      { ...created.value.manifest, artifacts },
      created.value.revision
    );
    expect(saved.ok).toBe(true);

    // Initial check: no missing artifacts
    expect(listMissingArtifacts(dir)).toEqual({ ok: true, value: [] });

    // renameSync to a new location
    const renamedDir = makeTempDir("seed-renamed-");
    rmSync(renamedDir, { recursive: true, force: true });
    renameSync(dir, renamedDir);

    const openRenamed = openProject(renamedDir);
    expect(openRenamed.ok).toBe(true);

    const art1Renamed = resolveArtifact(renamedDir, "art-1");
    expect(art1Renamed.ok).toBe(true);
    if (art1Renamed.ok) {
      expect(art1Renamed.value).toBe(join(renamedDir, "models", "model1.json"));
      expect(existsSync(art1Renamed.value)).toBe(true);
    }

    const art2Renamed = resolveArtifact(renamedDir, "art-2");
    expect(art2Renamed.ok).toBe(true);
    if (art2Renamed.ok) {
      expect(art2Renamed.value).toBe(join(renamedDir, "models", "model2.json"));
      expect(existsSync(art2Renamed.value)).toBe(true);
    }

    // cpSync to a third location
    const copiedDir = makeTempDir("seed-copied-");
    rmSync(copiedDir, { recursive: true, force: true });
    cpSync(renamedDir, copiedDir, { recursive: true });

    const openCopied = openProject(copiedDir);
    expect(openCopied.ok).toBe(true);

    const art1Copied = resolveArtifact(copiedDir, "art-1");
    expect(art1Copied.ok).toBe(true);
    if (art1Copied.ok) {
      expect(art1Copied.value).toBe(join(copiedDir, "models", "model1.json"));
    }

    // Delete one artifact file in copiedDir
    unlinkSync(join(copiedDir, "models", "model2.json"));
    const missing = listMissingArtifacts(copiedDir);
    expect(missing).toEqual({ ok: true, value: ["art-2"] });
  });

  it("12. resolveArtifact refusals: unknown id, forged schema traversal, symlink pointing outside", () => {
    const dir = makeTempDir();
    const created = createProject(dir, { name: "Artifact Refusals", seedVersion: "0.1.0" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Unknown artifact id -> E_NOT_FOUND
    const resUnknown = resolveArtifact(dir, "non-existent-id");
    expect(resUnknown.ok).toBe(false);
    if (!resUnknown.ok) {
      expect(resUnknown.errors[0]?.code).toBe("E_NOT_FOUND");
    }

    // Forge manifest with ../outside.json -> openProject fails schema and resolveArtifact returns it
    const forgedDir = makeTempDir();
    const forgedManifest = {
      schema: "seed.project/0.1",
      projectId: "p-123456789abc",
      name: "Forged Manifest",
      created: "2026-10-03T12:00:00.000Z",
      updated: "2026-10-03T12:00:00.000Z",
      seedVersion: "0.1.0",
      folders: { models: "models", runs: "runs", studies: "studies", oracles: "oracles" },
      artifacts: [
        {
          id: "outside-art",
          app: "app",
          path: "../outside.json",
          format: "json",
          formatVersion: "1.0",
          revision: { hash: "0".repeat(64), counter: 0 },
        },
      ],
      materials: [],
    };
    writeFileSync(join(forgedDir, MANIFEST_FILE), JSON.stringify(forgedManifest, null, 2), "utf8");

    const forgedOpen = openProject(forgedDir);
    expect(forgedOpen.ok).toBe(false);

    const forgedResolve = resolveArtifact(forgedDir, "outside-art");
    expect(forgedResolve.ok).toBe(false);
    if (!forgedResolve.ok && !forgedOpen.ok) {
      expect(forgedResolve.errors).toEqual(forgedOpen.errors);
    }

    // Symlink pointing outside the project -> E_PATH_TRAVERSAL
    let symlinkAllowed = true;
    try {
      const probeTarget = join(tmpdir(), "seed-probe-target");
      const probeLink = join(tmpdir(), "seed-probe-link");
      writeFileSync(probeTarget, "probe");
      symlinkSync(probeTarget, probeLink, "junction");
      rmSync(probeLink);
      rmSync(probeTarget);
    } catch {
      symlinkAllowed = false;
    }

    if (!symlinkAllowed) {
      // Symlink creation not permitted on this platform/environment, skipping symlink traversal test
    } else {
      // A directory link works as a symlink on POSIX and as a junction on Windows (a junction cannot point at a file).
      const outsideDir = mkdtempSync(join(tmpdir(), "seed-outside-"));
      writeFileSync(join(outsideDir, "f.json"), '{"outside": true}\n', "utf8");
      tempDirs.push(outsideDir);

      symlinkSync(outsideDir, join(dir, "models", "outlink"), "junction");

      const saveLinkRes = saveProject(
        dir,
        {
          ...created.value.manifest,
          artifacts: [
            {
              id: "art-symlink",
              app: "app",
              path: "models/outlink/f.json",
              format: "json",
              formatVersion: "1.0",
              revision: { hash: "0".repeat(64), counter: 0 },
            },
          ],
        },
        created.value.revision
      );
      expect(saveLinkRes.ok).toBe(true);

      const resTraversal = resolveArtifact(dir, "art-symlink");
      expect(resTraversal.ok).toBe(false);
      if (!resTraversal.ok) {
        expect(resTraversal.errors[0]?.code).toBe("E_PATH_TRAVERSAL");
        expect(resTraversal.errors[0]?.field).toBe("/artifacts/0/path");
      }
    }
  });

  it("13. Sequence and stale revisions: 20 sequential rounds and 5 stale revision strings", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Round 0", seedVersion: "0.1.0" });

    // 20 sequential read-modify-save rounds
    const revisionsSeen = new Set<string>();
    let currentOpen = openProject(dir);
    expect(currentOpen.ok).toBe(true);
    if (!currentOpen.ok) return;

    revisionsSeen.add(currentOpen.value.revision);

    for (let round = 1; round <= 20; round++) {
      const newName = `Round ${round}`;
      const saveRes = saveProject(
        dir,
        { ...currentOpen.value.manifest, name: newName },
        currentOpen.value.revision
      );
      expect(saveRes.ok).toBe(true);
      if (!saveRes.ok) return;

      expect(revisionsSeen.has(saveRes.value.revision)).toBe(false);
      revisionsSeen.add(saveRes.value.revision);

      currentOpen = openProject(dir);
      expect(currentOpen.ok).toBe(true);
      if (!currentOpen.ok) return;
      expect(currentOpen.value.manifest.name).toBe(newName);
    }

    expect(revisionsSeen.size).toBe(21); // initial + 20 rounds
    expect(currentOpen.value.manifest.name).toBe("Round 20");

    // Table test of 5 stale or garbage revision strings
    const manifestPath = join(dir, MANIFEST_FILE);
    const bytesBefore = readFileSync(manifestPath);
    const currentRev = currentOpen.value.revision;

    const fakeOtherDir = makeTempDir();
    const otherProj = createProject(fakeOtherDir, { name: "Other", seedVersion: "0.1.0" });
    const otherRev = otherProj.ok ? otherProj.value.revision : "0".repeat(64);

    const staleCases: [string, string][] = [
      ["an old revision", Array.from(revisionsSeen)[0]!],
      ["64 zeros", "0".repeat(64)],
      ["empty string", ""],
      ["a non-hex string", "not-a-valid-hex-revision!"],
      ["a valid revision of a different manifest", otherRev],
    ];

    for (const [description, badRev] of staleCases) {
      const res = saveProject(
        dir,
        { ...currentOpen.value.manifest, name: `Try-${description}` },
        badRev
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("E_STALE_REVISION");
        expect(res.errors[0]?.field).toBe("/revision");
      }
      // File remains unchanged
      const bytesAfter = readFileSync(manifestPath);
      expect(bytesAfter).toEqual(bytesBefore);
    }
  });
});

describe("Project Store: stale takeover race (added by the dispatcher)", () => {
  function writeOwner(dir: string, owner: Record<string, unknown>): void {
    mkdirSync(join(dir, ".seed", "lock"), { recursive: true });
    writeFileSync(join(dir, ".seed", "lock", "owner.json"), JSON.stringify(owner), "utf8");
  }
  const owner = (pid: number, token: string) => ({ ownerId: "o", pid, host: "h", acquiredAt: "2026-10-03T00:00:00Z", token });

  it("a live lock that replaced the stale one before the rename is put back, not destroyed", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Race", seedVersion: "0.1.0" });
    writeOwner(dir, owner(424242, "old-token"));
    const res = withProjectLock(dir, () => "never", {
      host: "h",
      isAlive: (pid) => pid === 777,
      beforeTakeover: () => {
        rmSync(join(dir, ".seed", "lock"), { recursive: true, force: true });
        writeOwner(dir, owner(777, "live-token"));
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    const kept = JSON.parse(readFileSync(join(dir, ".seed", "lock", "owner.json"), "utf8")) as { token: string };
    expect(kept.token).toBe("live-token");
    expect(readdirSync(join(dir, ".seed")).filter((n) => n.startsWith("lock.stale-"))).toEqual([]);
  });

  it("an unchanged stale lock is still taken over (the check does not refuse real takeovers)", () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Race", seedVersion: "0.1.0" });
    writeOwner(dir, owner(424242, "old-token"));
    let hook = 0;
    const res = withProjectLock(dir, () => "ran", { host: "h", isAlive: () => false, beforeTakeover: () => { hook++; } });
    expect(res).toEqual({ ok: true, value: "ran" });
    expect(hook).toBe(1);
    expect(readdirSync(join(dir, ".seed"))).toEqual([]);
  });
});

describe("Project Store: review fixes (Codex, 2026-10-03)", () => {
  function fresh(): string {
    const dir = makeTempDir();
    createProject(dir, { name: "Fix", seedVersion: "0.1.0" });
    return dir;
  }
  const lockDirOf = (dir: string) => join(dir, ".seed", "lock");

  it("a linked .seed folder is refused before anything is written or deleted outside the project", () => {
    const dir = fresh();
    const outside = makeTempDir("seed-outside-");
    mkdirSync(join(outside, "lock.stale-fixture"));
    writeFileSync(join(outside, "lock.stale-fixture", "sentinel.txt"), "keep", "utf8");
    try {
      symlinkSync(outside, join(dir, ".seed"), "junction");
    } catch {
      return; // links not permitted in this environment
    }
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open failed");
    for (const res of [
      withProjectLock(dir, () => 1),
      saveProject(dir, { ...opened.value.manifest, name: "X" }, opened.value.revision),
      recoverProject(dir),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors[0]?.code).toBe("E_PATH_TRAVERSAL");
    }
    expect(readdirSync(outside)).toEqual(["lock.stale-fixture"]);
    expect(readFileSync(join(outside, "lock.stale-fixture", "sentinel.txt"), "utf8")).toBe("keep");
  });

  it("the synchronous lock refuses a promise-returning callback; the async one holds the lock until it settles", async () => {
    const dir = fresh();
    const syncRes = withProjectLock(dir, (() => Promise.resolve(1)) as () => unknown);
    expect(syncRes.ok).toBe(false);
    if (!syncRes.ok) expect(syncRes.errors[0]?.message).toContain("withProjectLockAsync");
    expect(existsSync(lockDirOf(dir))).toBe(false);

    let resume!: () => void;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const first = withProjectLockAsync(dir, async () => {
      await gate;
      return "done";
    });
    await new Promise((r) => setTimeout(r, 30));
    const second = withProjectLock(dir, () => "entered");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    resume();
    expect(await first).toEqual({ ok: true, value: "done" });
    expect(existsSync(lockDirOf(dir))).toBe(false);
    await expect(withProjectLockAsync(dir, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lockDirOf(dir))).toBe(false);
  });

  it("a release that fails is reported, and a save that committed says so", () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open failed");
    const failing = { removeTree: () => { throw Object.assign(new Error("busy"), { code: "EIO" }); } };
    const res = withProjectLock(dir, () => 1, failing);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("E_INTERNAL");
      expect(res.errors[0]?.message).toContain("could not be released");
    }
    rmSync(lockDirOf(dir), { recursive: true, force: true });
    const saved = saveProject(dir, { ...opened.value.manifest, name: "Committed" }, opened.value.revision, failing);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.errors[0]?.message).toContain("the project was saved, but");
    const after = openProject(dir);
    expect(after.ok && after.value.manifest.name).toBe("Committed");
  });

  it("a transient release error (EBUSY) is retried", () => {
    const dir = fresh();
    let calls = 0;
    const flaky = {
      removeTree: (p: string) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        rmSync(p, { recursive: true, force: true });
      },
    };
    expect(withProjectLock(dir, () => 1, flaky)).toEqual({ ok: true, value: 1 });
    expect(existsSync(lockDirOf(dir))).toBe(false);
    expect(calls).toBe(2);
  });

  it("only one contender takes over a stale lock: a fresh takeover guard held by another means held", () => {
    const dir = fresh();
    mkdirSync(lockDirOf(dir), { recursive: true });
    writeFileSync(join(lockDirOf(dir), "owner.json"), JSON.stringify({ ownerId: "o", pid: 424242, host: "h", acquiredAt: "2026-10-03T00:00:00Z", token: "t" }), "utf8");
    mkdirSync(join(dir, ".seed", "takeover"));
    const res = withProjectLock(dir, () => "ran", { host: "h", isAlive: () => false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.code).toBe("E_PROJECT_LOCKED");
    expect(existsSync(lockDirOf(dir))).toBe(true);
  });

  it("a takeover guard abandoned by a crashed contender is removed once it is old", () => {
    const dir = fresh();
    mkdirSync(lockDirOf(dir), { recursive: true });
    writeFileSync(join(lockDirOf(dir), "owner.json"), JSON.stringify({ ownerId: "o", pid: 424242, host: "h", acquiredAt: "2026-10-03T00:00:00Z", token: "t" }), "utf8");
    const guard = join(dir, ".seed", "takeover");
    mkdirSync(guard);
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    const res = withProjectLock(dir, () => "ran", { host: "h", isAlive: () => false, waitMs: 500 });
    expect(res).toEqual({ ok: true, value: "ran" });
    expect(readdirSync(join(dir, ".seed"))).toEqual([]);
  });

  it("a lock replaced by a live owner after the first judgement is never moved aside (re-judged under the guard)", () => {
    const dir = fresh();
    const write = (pid: number, token: string) => {
      mkdirSync(lockDirOf(dir), { recursive: true });
      writeFileSync(join(lockDirOf(dir), "owner.json"), JSON.stringify({ ownerId: "o", pid, host: "h", acquiredAt: "2026-10-03T00:00:00Z", token }), "utf8");
    };
    write(424242, "old");
    const res = withProjectLock(dir, () => "never", {
      host: "h",
      isAlive: (pid) => pid === 777,
      beforeTakeover: () => {
        rmSync(lockDirOf(dir), { recursive: true, force: true });
        write(777, "live");
      },
    });
    expect(res.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(lockDirOf(dir), "owner.json"), "utf8")).token).toBe("live");
    expect(readdirSync(join(dir, ".seed")).sort()).toEqual(["lock"]);
  });
});

describe("Project Store: a holder that keeps working, and a writer that lost its lock (E2 limit L4)", () => {
  const fresh = () => {
    const dir = makeTempDir();
    createProject(dir, { name: "Beat", seedVersion: "0.1.0" });
    return dir;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // a contender on another machine: it can only judge by age
  const foreign = { host: "another-machine", staleMs: 400 };

  it("an asynchronous holder that keeps its heartbeat is not taken over by a contender on another host, however long it works", async () => {
    const dir = fresh();
    let contended: { ok: boolean }[] = [];
    const held = await withProjectLockAsync(
      dir,
      async () => {
        for (let i = 0; i < 4; i++) {
          await sleep(300); // 1200 ms of work in all: three times the 400 ms a silent lock would be given
          contended.push(withProjectLock(dir, () => "stolen", foreign));
        }
        return "done";
      },
      { staleMs: 400 }
    );
    expect(held).toEqual({ ok: true, value: "done" });
    expect(contended.map((c) => c.ok)).toEqual([false, false, false, false]);
  });

  it("a holder that goes silent is taken over after staleMs, and its late save is refused and changes nothing", async () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    let late: ReturnType<typeof saveProjectHeld> | undefined;
    let taken: ReturnType<typeof withProjectLock<string>> | undefined;
    const held = await withProjectLockAsync(
      dir,
      async () => {
        await sleep(700); // silent for longer than staleMs: no heartbeat (heartbeatMs 0)
        taken = withProjectLock(dir, () => "took over", foreign);
        late = saveProjectHeld(dir, { ...opened.value.manifest, name: "late writer" }, opened.value.revision);
        return "done";
      },
      { staleMs: 400, heartbeatMs: 0 }
    );
    expect(taken).toEqual({ ok: true, value: "took over" });
    expect(late?.ok).toBe(false);
    expect((late as { errors: { code: string; message: string }[] }).errors[0]).toMatchObject({ code: "E_PROJECT_LOCKED" });
    expect((late as { errors: { message: string }[] }).errors[0]!.message).toContain("nothing was saved");
    const after = openProject(dir);
    expect(after.ok && after.value.manifest.name).toBe("Beat");
    expect(held.ok).toBe(true); // releasing a lock that is no longer ours is quiet and leaves the new owner's alone
  });

  it("saveProjectHeld refuses a caller that does not hold the lock", () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    const r = saveProjectHeld(dir, { ...opened.value.manifest, name: "x" }, opened.value.revision);
    expect(r.ok).toBe(false);
    expect((r as { errors: { message: string }[] }).errors[0]!.message).toContain("does not hold it");
  });

  it("a writer whose lock is taken over between the check and the write is refused at the last look", async () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    let result: ReturnType<typeof saveProjectHeld> | undefined;
    await withProjectLockAsync(dir, async () => {
      // simulate the takeover during the save: change the owner token the moment the manifest is about to be written
      const ownerPath = join(dir, ".seed", "lock", "owner.json");
      const manifest = { ...opened.value.manifest, name: "racing" };
      Object.defineProperty(manifest, "updated", {
        enumerable: true,
        get() {
          const o = JSON.parse(readFileSync(ownerPath, "utf8"));
          writeFileSync(ownerPath, JSON.stringify({ ...o, token: "someone-else" }));
          return opened.value.manifest.updated;
        },
      });
      result = saveProjectHeld(dir, manifest, opened.value.revision);
    });
    // the property read happens while the new manifest is cloned, before the last look
    expect(result?.ok).toBe(false);
    const after = openProject(dir);
    expect(after.ok && after.value.manifest.name).toBe("Beat");
  });

  it("a normal save under the async lock still works and a heartbeat file is cleaned up with the lock", async () => {
    const dir = fresh();
    const opened = openProject(dir);
    if (!opened.ok) throw new Error("open");
    const r = await withProjectLockAsync(
      dir,
      async () => {
        await sleep(120);
        return saveProjectHeld(dir, { ...opened.value.manifest, name: "kept" }, opened.value.revision);
      },
      { staleMs: 400 }
    );
    expect(r.ok && r.value.ok).toBe(true);
    expect(existsSync(join(dir, ".seed", "lock"))).toBe(false);
    const after = openProject(dir);
    expect(after.ok && after.value.manifest.name).toBe("kept");
  });
});
