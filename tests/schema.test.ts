import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreErrorCodes, FAMILIES, validate, type Family } from "../src/core/validate";

const vectorsDir = path.join(__dirname, "..", "schema", "vectors");
const indexPath = path.join(vectorsDir, "index.json");

type IndexEntry =
  | { file: string; family: Family; valid: true }
  | { file: string; family: Family; valid: false; expect: { code: string; field: string } };

describe("Schema vectors and validation", () => {
  const rawIndex = fs.readFileSync(indexPath, "utf8");
  const indexEntries = JSON.parse(rawIndex) as IndexEntry[];

  it("matches index entries exactly with files under good/ and bad/", () => {
    const goodDir = path.join(vectorsDir, "good");
    const badDir = path.join(vectorsDir, "bad");

    const goodFiles = fs.readdirSync(goodDir).map((f) => `good/${f}`);
    const badFiles = fs.readdirSync(badDir).map((f) => `bad/${f}`);
    const diskFiles = new Set([...goodFiles, ...badFiles]);

    const indexFiles = new Set(indexEntries.map((e) => e.file));

    expect(indexFiles).toEqual(diskFiles);
  });

  it("has at least one good fixture for every family", () => {
    for (const fam of FAMILIES) {
      const goodEntries = indexEntries.filter((e) => e.family === fam && e.valid);
      expect(goodEntries.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers every core error code in errors of some good fixture", () => {
    const coreCodes = coreErrorCodes();
    expect(coreCodes.length).toBe(25);

    const seenCodes = new Set<string>();
    for (const entry of indexEntries) {
      if (entry.valid) {
        const filePath = path.join(vectorsDir, entry.file);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
          errors?: Array<{ code: string }>;
        };
        if (Array.isArray(data.errors)) {
          for (const err of data.errors) {
            if (typeof err.code === "string") {
              seenCodes.add(err.code);
            }
          }
        }
      }
    }

    for (const code of coreCodes) {
      expect(seenCodes.has(code)).toBe(true);
    }
  });

  it("validates all fixtures with ok matching valid and bad fixtures matching expect", () => {
    for (const entry of indexEntries) {
      const filePath = path.join(vectorsDir, entry.file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      const res = validate(entry.family, data);

      expect(res.ok).toBe(entry.valid);

      if (!entry.valid) {
        if (!res.ok) {
          const match = res.errors.some(
            (err) => err.code === entry.expect.code && err.field === entry.expect.field
          );
          expect(
            match,
            `Expected fixture ${entry.file} to have error code "${entry.expect.code}" at field "${entry.expect.field}", but got: ${JSON.stringify(res.errors)}`
          ).toBe(true);
        }
      }
    }
  });

  it("never includes the ZZ-INSTANCE-MARKER-ZZ marker string in any error message", () => {
    const marker = "ZZ-INSTANCE-MARKER-ZZ";
    let markerFixtureCount = 0;

    for (const entry of indexEntries) {
      if (!entry.valid) {
        const filePath = path.join(vectorsDir, entry.file);
        const rawContent = fs.readFileSync(filePath, "utf8");
        if (rawContent.includes(marker)) {
          markerFixtureCount++;
        }

        const data = JSON.parse(rawContent) as unknown;
        const res = validate(entry.family, data);
        if (!res.ok) {
          for (const err of res.errors) {
            expect(err.message.includes(marker)).toBe(false);
          }
        }
      }
    }

    expect(markerFixtureCount).toBeGreaterThanOrEqual(10);
  });

  it("returns E_SCHEMA_INVALID at field '' when input is null", () => {
    const res = validate("adapter-request", null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      const first = res.errors[0];
      expect(first?.code).toBe("E_SCHEMA_INVALID");
      expect(first?.field).toBe("");
      expect(first?.source).toBe("seed");
    }
  });

  it("produces deterministic output order across repeated calls", () => {
    for (const entry of indexEntries.slice(0, 10)) {
      const filePath = path.join(vectorsDir, entry.file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      const run1 = validate(entry.family, data);
      const run2 = validate(entry.family, data);
      expect(run1).toEqual(run2);
    }
  });
});
