import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import {
  checkOracleHash,
  checkProject,
  checkResultsIndex,
  verifyStudyLog
} from "../src/core/semantic";

describe("Semantic checks and canonical JSON", () => {
  describe("Golden values", () => {
    it("canonicalJson sorts keys and serializes nested objects and arrays", () => {
      const input = { b: 1, a: [true, null, "x", { z: 1, y: 2 }] };
      const expected = '{"a":[true,null,"x",{"y":2,"z":1}],"b":1}';
      expect(canonicalJson(input)).toBe(expected);
    });

    it("sha256Hex computes exact hex digest for strings", () => {
      expect(sha256Hex("abc")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      );
      expect(sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("matches golden oracle pin and hash", () => {
      const expected = { quantity: "p_top", value: 0.02, unit: "1" };
      const tolerance = { abs: 1e-12, rel: 0 };
      const obj = { expected, tolerance };
      const canonical = canonicalJson(obj);
      expect(canonical).toBe(
        '{"expected":{"quantity":"p_top","unit":"1","value":0.02},"tolerance":{"abs":1e-12,"rel":0}}'
      );
      expect(sha256Hex(canonical)).toBe(
        "eebf0627cf9ff85dda4644691ae49fae4b64d38fe5d864d17a9a5df11222eb81"
      );
    });

    it("matches golden refusal oracle pin and hash", () => {
      const expected = { refusalCode: "E_PROP_MISSING" };
      const obj = { expected, tolerance: null };
      const canonical = canonicalJson(obj);
      expect(canonical).toBe('{"expected":{"refusalCode":"E_PROP_MISSING"},"tolerance":null}');
      expect(sha256Hex(canonical)).toBe(
        "127d1e0fe66ba8635a27c05df81c4883cc47920ccbb50ef00cf04a1919ee2d6f"
      );
    });

    it("canonicalJson throws TypeError on undefined, functions, symbols, and non-finite numbers", () => {
      expect(() => canonicalJson(undefined)).toThrow(TypeError);
      expect(() => canonicalJson(() => {})).toThrow(TypeError);
      expect(() => canonicalJson(Symbol("test"))).toThrow(TypeError);
      expect(() => canonicalJson(BigInt(123))).toThrow(TypeError);
      expect(() => canonicalJson(NaN)).toThrow(TypeError);
      expect(() => canonicalJson(Infinity)).toThrow(TypeError);
      expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
    });
  });

  describe("checkProject", () => {
    const cleanProject = {
      schema: "seed.project/0.1",
      projectId: "proj-1",
      name: "Clean Project",
      created: "2026-10-03T12:00:00Z",
      updated: "2026-10-03T12:00:00Z",
      seedVersion: "0.1.0",
      folders: { models: "models", runs: "runs", studies: "studies", oracles: "oracles" },
      artifacts: [
        {
          id: "art-1",
          app: "openmc",
          path: "models/m1.xml",
          format: "xml",
          formatVersion: "1.0",
          revision: { hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", counter: 1 }
        },
        {
          id: "art-2",
          app: "openmc",
          path: "models/m2.xml",
          format: "xml",
          formatVersion: "1.0",
          revision: { hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", counter: 1 }
        }
      ],
      materials: [
        {
          id: "mat-1",
          revision: 1,
          name: "Material 1",
          sets: { "prop.thermal": { schema: "thermal/0.1" } }
        },
        {
          id: "mat-2",
          revision: 1,
          name: "Material 2",
          sets: { "prop.thermal": { schema: "thermal/0.1" } }
        }
      ]
    };

    it("returns empty array for clean project", () => {
      expect(checkProject(cleanProject)).toEqual([]);
    });

    it("detects duplicate artifact id", () => {
      const proj = {
        ...cleanProject,
        artifacts: [
          cleanProject.artifacts[0],
          { ...cleanProject.artifacts[1], id: "art-1" }
        ]
      };
      const errors = checkProject(proj);
      expect(errors.some((e) => e.field === "/artifacts/1/id")).toBe(true);
    });

    it("detects duplicate material id", () => {
      const proj = {
        ...cleanProject,
        materials: [
          cleanProject.materials[0],
          { ...cleanProject.materials[1], id: "mat-1" }
        ]
      };
      const errors = checkProject(proj);
      expect(errors.some((e) => e.field === "/materials/1/id")).toBe(true);
    });
  });

  describe("checkResultsIndex", () => {
    const cleanIndex = {
      schema: "seed.results-index/0.1",
      runId: "run-001",
      status: "completed",
      adapter: { id: "adapter-1", version: "1.0" },
      engine: { name: "engine-1", version: "1.0" },
      inputHashes: [{ path: "in.txt", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }],
      nativeStatus: { status: "ok" },
      quantities: [
        {
          name: "q1",
          unit: "1",
          normalization: "none",
          provenance: { runId: "run-001", inputRevisions: ["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"] },
          data: { path: "q1.txt", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
          verification: "verified"
        },
        {
          name: "q2",
          unit: "1",
          normalization: "none",
          provenance: { runId: "run-001", inputRevisions: ["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"] },
          data: { path: "q2.txt", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
          verification: "unverified"
        }
      ]
    };

    it("returns empty array for clean index", () => {
      expect(checkResultsIndex(cleanIndex)).toEqual([]);
    });

    it("detects provenance runId mismatch", () => {
      const idx = {
        ...cleanIndex,
        quantities: [
          cleanIndex.quantities[0],
          {
            ...cleanIndex.quantities[1],
            provenance: { ...cleanIndex.quantities[1]?.provenance, runId: "different-run" }
          }
        ]
      };
      const errors = checkResultsIndex(idx);
      expect(errors.some((e) => e.field === "/quantities/1/provenance/runId")).toBe(true);
    });

    it("detects duplicate quantity names", () => {
      const idx = {
        ...cleanIndex,
        quantities: [
          cleanIndex.quantities[0],
          {
            ...cleanIndex.quantities[1],
            name: "q1"
          }
        ]
      };
      const errors = checkResultsIndex(idx);
      expect(errors.some((e) => e.field === "/quantities/1/name")).toBe(true);
    });
  });

  describe("checkOracleHash", () => {
    const goldenPinOracle = {
      expected: { quantity: "p_top", value: 0.02, unit: "1" },
      tolerance: { abs: 1e-12, rel: 0 },
      toleranceHash: "eebf0627cf9ff85dda4644691ae49fae4b64d38fe5d864d17a9a5df11222eb81"
    };

    const goldenRefusalOracle = {
      expected: { refusalCode: "E_PROP_MISSING" },
      tolerance: null,
      toleranceHash: "127d1e0fe66ba8635a27c05df81c4883cc47920ccbb50ef00cf04a1919ee2d6f"
    };

    it("passes for golden pin oracle", () => {
      expect(checkOracleHash(goldenPinOracle)).toEqual([]);
    });

    it("passes for golden refusal oracle", () => {
      expect(checkOracleHash(goldenRefusalOracle)).toEqual([]);
    });

    it("fails when tolerance is changed", () => {
      const bad = {
        ...goldenPinOracle,
        tolerance: { abs: 1e-6, rel: 0 }
      };
      const errors = checkOracleHash(bad);
      expect(errors.some((e) => e.field === "/toleranceHash")).toBe(true);
    });

    it("fails when expected is changed", () => {
      const bad = {
        ...goldenPinOracle,
        expected: { quantity: "p_top", value: 0.05, unit: "1" }
      };
      const errors = checkOracleHash(bad);
      expect(errors.some((e) => e.field === "/toleranceHash")).toBe(true);
    });

    it("fails when tolerance is missing for a value oracle", () => {
      const bad = {
        expected: { quantity: "p_top", value: 0.02, unit: "1" },
        toleranceHash: goldenPinOracle.toleranceHash
      };
      const errors = checkOracleHash(bad);
      expect(errors.some((e) => e.field === "/tolerance")).toBe(true);
    });
  });

  describe("verifyStudyLog", () => {
    const rawHeader = {
      schema: "seed.study/0.1",
      type: "header",
      seq: 0,
      studyId: "study-01",
      created: "2026-10-03T12:00:00Z",
      projectId: "proj-1",
      question: "Study question?",
      assumptions: ["assumed"],
      parameters: [{ id: "p1", min: 0, max: 10 }],
      budget: { maxWallSeconds: 60, maxCores: 1, maxMemoryMB: 512, maxDiskMB: 512 },
      tier: "A0",
      startRevisions: [{ artifact: "art-1", revision: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }],
      setBy: { kind: "human", name: "Alice" }
    };

    const rawStep1 = {
      schema: "seed.study/0.1",
      type: "step",
      seq: 1,
      time: "2026-10-03T12:01:00Z",
      actor: { kind: "human", name: "Alice" },
      action: "run",
      reason: "first step run",
      inputsChanged: [],
      runs: ["run-1"]
    };

    const rawStep2 = {
      schema: "seed.study/0.1",
      type: "step",
      seq: 2,
      time: "2026-10-03T12:02:00Z",
      actor: { kind: "human", name: "Alice" },
      action: "run",
      reason: "second step run",
      inputsChanged: [],
      runs: ["run-2"]
    };

    const rawConclusion = {
      schema: "seed.study/0.1",
      type: "conclusion",
      seq: 3,
      time: "2026-10-03T12:03:00Z",
      actor: { kind: "human", name: "Alice" },
      claims: [{ text: "All goals met.", runs: ["run-1", "run-2"], oracles: [] }]
    };

    function buildHashedChain(rawObjects: Array<Record<string, unknown>>): string[] {
      let prevHash: string | null = null;
      return rawObjects.map((raw) => {
        const lineObj = { ...raw, prev: prevHash };
        const hash = sha256Hex(canonicalJson(lineObj));
        prevHash = hash;
        return JSON.stringify({ ...lineObj, hash });
      });
    }

    it("verifies a clean chain of header, 2 steps, and conclusion", () => {
      const lines = buildHashedChain([rawHeader, rawStep1, rawStep2, rawConclusion]);
      const errors = verifyStudyLog(lines);
      expect(errors).toEqual([]);
    });

    it("verifies a chainless log of the same lines", () => {
      const lines = [rawHeader, rawStep1, rawStep2, rawConclusion].map((o) => JSON.stringify(o));
      const errors = verifyStudyLog(lines);
      expect(errors).toEqual([]);
    });

    it("fails when reason is tampered after hashing", () => {
      const lines = buildHashedChain([rawHeader, rawStep1, rawStep2, rawConclusion]);
      const parsedStep1 = JSON.parse(lines[1] ?? "");
      parsedStep1.reason = "tampered reason";
      lines[1] = JSON.stringify(parsedStep1);

      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/2" && e.message.includes("hash does not match"))).toBe(true);
    });

    it("fails when prev hash is wrong", () => {
      const lines = buildHashedChain([rawHeader, rawStep1, rawStep2, rawConclusion]);
      const parsedStep2 = JSON.parse(lines[2] ?? "");
      parsedStep2.prev = "0000000000000000000000000000000000000000000000000000000000000000";
      lines[2] = JSON.stringify(parsedStep2);

      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/3" && e.message.includes("prev does not match"))).toBe(true);
    });

    it("fails when there is a seq gap", () => {
      const gappedStep2 = { ...rawStep2, seq: 3 };
      const gappedConclusion = { ...rawConclusion, seq: 4 };
      const lines = buildHashedChain([rawHeader, rawStep1, gappedStep2, gappedConclusion]);

      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/3" && e.message.includes("seq must increase by 1"))).toBe(true);
    });

    it("fails when first line is not a header", () => {
      const lines = buildHashedChain([rawStep1, rawStep2, rawConclusion]);
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/1" && e.message.includes("first line must be a header"))).toBe(true);
    });

    it("fails when header seq is not 0", () => {
      const badHeader = { ...rawHeader, seq: 1 };
      const lines = [JSON.stringify(badHeader)];
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/1")).toBe(true);
    });

    it("fails when conclusion is not the last line", () => {
      const lines = buildHashedChain([rawHeader, rawStep1, rawConclusion, rawStep2]);
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/3" && e.message.includes("conclusion must be the last line"))).toBe(true);
    });

    it("fails when there are two conclusions", () => {
      const secondConclusion = { ...rawConclusion, seq: 4 };
      const lines = buildHashedChain([rawHeader, rawStep1, rawStep2, rawConclusion, secondConclusion]);
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/5" && e.message.includes("at most one conclusion"))).toBe(true);
    });

    it("fails when only some lines carry hash", () => {
      const hashedLines = buildHashedChain([rawHeader, rawStep1]);
      const unhashedStep2 = JSON.stringify(rawStep2);
      const errors = verifyStudyLog([hashedLines[0] ?? "", hashedLines[1] ?? "", unhashedStep2]);
      expect(errors.some((e) => e.field === "line/3" && e.message.includes("every line must carry hash and prev"))).toBe(true);
    });

    it("fails for a non-JSON line with field '' and line number in message", () => {
      const lines = ["{ bad json"];
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "" && e.message.includes("line 1"))).toBe(true);
    });

    it("fails for a line failing schema and formats line/<n>/... field", () => {
      const badStep = {
        ...rawStep1,
        actor: { kind: "invalid-kind", name: "Alice" }
      };
      const lines = [JSON.stringify(rawHeader), JSON.stringify(badStep)];
      const errors = verifyStudyLog(lines);
      expect(errors.some((e) => e.field === "line/2/actor/kind")).toBe(true);
    });
  });
});
