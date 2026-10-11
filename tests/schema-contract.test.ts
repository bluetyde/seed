// @covers R-CORE-04, R-CORE-10
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "../src/core/validate";
import { CONTRACT_TABLE, type ObjectSpec } from "./helpers/contractTable";

const MARKER = "ZZ-INSTANCE-MARKER-ZZ";
const vectorsDir = path.join(__dirname, "..", "schema", "vectors");

function resolvePointer(
  doc: unknown,
  pointer: string,
  specName: string,
  fixture: string
): Record<string, unknown> {
  if (pointer === "") {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`Pointer "${pointer}" in ${fixture} for ${specName} is not an object`);
    }
    return doc as Record<string, unknown>;
  }
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let curr: unknown = doc;
  for (const part of parts) {
    if (curr === null || typeof curr !== "object") {
      throw new Error(
        `Failed to resolve pointer "${pointer}" at segment "${part}" in fixture "${fixture}" for spec "${specName}"`
      );
    }
    curr = (curr as Record<string, unknown>)[part];
  }
  if (curr === null || typeof curr !== "object" || Array.isArray(curr)) {
    throw new Error(
      `Resolved value for pointer "${pointer}" in fixture "${fixture}" for spec "${specName}" is not an object`
    );
  }
  return curr as Record<string, unknown>;
}

function propField(pointer: string, prop: string): string {
  return pointer === "" ? `/${prop}` : `${pointer}/${prop}`;
}

describe("Schema Contract Enforcement", () => {
  for (const spec of CONTRACT_TABLE) {
    describe(`${spec.name} (${spec.family} @ "${spec.pointer}")`, () => {
      const fixturePath = path.join(vectorsDir, spec.fixture);
      if (!fs.existsSync(fixturePath)) {
        throw new Error(`Fixture file not found: ${spec.fixture} for spec ${spec.name}`);
      }
      const raw = fs.readFileSync(fixturePath, "utf8");
      const baseDoc = JSON.parse(raw) as unknown;

      // 1. Fixture completeness
      it("fixture completeness", () => {
        const baseRes = validate(spec.family, baseDoc);
        expect(
          baseRes.ok,
          `Base fixture ${spec.fixture} failed validation: ${JSON.stringify(baseRes.ok ? [] : baseRes.errors)}`
        ).toBe(true);

        const targetObj = resolvePointer(baseDoc, spec.pointer, spec.name, spec.fixture);
        for (const req of spec.required) {
          expect(
            targetObj,
            `fixture ${spec.fixture} lacks required property "${req}" at ${spec.pointer}: add a fuller good fixture`
          ).toHaveProperty(req);
        }

        const propsToCheck = new Set<string>();
        for (const e of spec.enums) {
          propsToCheck.add(e.prop);
        }
        for (const b of spec.bounds) {
          propsToCheck.add(b.prop);
        }
        for (const opt of spec.optional) {
          propsToCheck.add(opt);
        }

        for (const prop of propsToCheck) {
          if (!(prop in targetObj) || targetObj[prop] === undefined) {
            expect.fail(
              `fixture ${spec.fixture} lacks ${prop} at ${spec.pointer}: add a fuller good fixture`
            );
          }
        }
      });

      // 2. Required properties
      for (const p of spec.required) {
        it(`required: missing property "${p}" fails at expected pointer`, () => {
          const clone = structuredClone(baseDoc);
          const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
          delete targetObj[p];
          const res = validate(spec.family, clone);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            const expected = propField(spec.pointer, p);
            const match = res.errors.some((err) => err.field === expected);
            expect(
              match,
              `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
            ).toBe(true);
            for (const err of res.errors) {
              expect(err.message).not.toContain(MARKER);
            }
          }
        });
      }

      // 3. Strict (no additional properties)
      if (spec.strict) {
        it("strict: unexpected property zzUnknown fails at expected pointer", () => {
          const clone = structuredClone(baseDoc);
          const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
          targetObj.zzUnknown = 1;
          const res = validate(spec.family, clone);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            const expected = propField(spec.pointer, "zzUnknown");
            const match = res.errors.some((err) => err.field === expected);
            expect(
              match,
              `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
            ).toBe(true);
            for (const err of res.errors) {
              expect(err.message).not.toContain(MARKER);
            }
          }
        });
      }

      // 4. Enums
      for (const enumSpec of spec.enums) {
        it(`enums: invalid value for "${enumSpec.prop}" fails at expected pointer`, () => {
          const clone = structuredClone(baseDoc);
          const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
          targetObj[enumSpec.prop] = MARKER;
          const res = validate(spec.family, clone);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            const expected = propField(spec.pointer, enumSpec.prop);
            const match = res.errors.some((err) => err.field === expected);
            expect(
              match,
              `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
            ).toBe(true);
            for (const err of res.errors) {
              expect(err.message).not.toContain(MARKER);
            }
          }
        });

        const accepted = enumSpec.acceptedValues ?? enumSpec.values;
        for (const val of accepted) {
          it(`enums: accepts value ${JSON.stringify(val)} for "${enumSpec.prop}"`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[enumSpec.prop] = val;
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected value ${JSON.stringify(val)} to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }
      }

      // 5. Bounds
      for (const bound of spec.bounds) {
        const expected = propField(spec.pointer, bound.prop);

        if (bound.maxLength !== undefined) {
          it(`bounds: maxLength + 1 for "${bound.prop}" fails at expected pointer`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = "a".repeat(bound.maxLength! + 1);
            const res = validate(spec.family, clone);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              const match = res.errors.some((err) => err.field === expected);
              expect(
                match,
                `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
              ).toBe(true);
              for (const err of res.errors) {
                expect(err.message).not.toContain(MARKER);
              }
            }
          });

          it(`bounds: maxLength for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = "a".repeat(bound.maxLength!);
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected maxLength to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }

        if (bound.minLength !== undefined) {
          if (bound.minLength > 0) {
            it(`bounds: minLength - 1 for "${bound.prop}" fails at expected pointer`, () => {
              const clone = structuredClone(baseDoc);
              const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
              targetObj[bound.prop] = "a".repeat(bound.minLength! - 1);
              const res = validate(spec.family, clone);
              expect(res.ok).toBe(false);
              if (!res.ok) {
                const match = res.errors.some((err) => err.field === expected);
                expect(
                  match,
                  `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
                ).toBe(true);
                for (const err of res.errors) {
                  expect(err.message).not.toContain(MARKER);
                }
              }
            });
          }

          it(`bounds: minLength for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = "a".repeat(bound.minLength!);
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected minLength to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }

        if (bound.maximum !== undefined) {
          it(`bounds: maximum + 1 for "${bound.prop}" fails at expected pointer`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = bound.maximum! + 1;
            const res = validate(spec.family, clone);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              const match = res.errors.some((err) => err.field === expected);
              expect(
                match,
                `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
              ).toBe(true);
              for (const err of res.errors) {
                expect(err.message).not.toContain(MARKER);
              }
            }
          });

          it(`bounds: maximum for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = bound.maximum!;
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected maximum to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }

        if (bound.minimum !== undefined) {
          it(`bounds: minimum - 1 for "${bound.prop}" fails at expected pointer`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = bound.minimum! - 1;
            const res = validate(spec.family, clone);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              const match = res.errors.some((err) => err.field === expected);
              expect(
                match,
                `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
              ).toBe(true);
              for (const err of res.errors) {
                expect(err.message).not.toContain(MARKER);
              }
            }
          });

          it(`bounds: minimum for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            targetObj[bound.prop] = bound.minimum!;
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected minimum to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }

        if (bound.maxItems !== undefined) {
          it(`bounds: maxItems + 1 for "${bound.prop}" fails at expected pointer`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            const baseArr = Array.isArray(targetObj[bound.prop])
              ? (targetObj[bound.prop] as unknown[])
              : [];
            const sampleItem = baseArr[0] ?? {
              path: "models/core.inp",
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            };
            const newArr: unknown[] = [];
            for (let i = 0; i <= bound.maxItems!; i++) {
              newArr.push(structuredClone(sampleItem));
            }
            targetObj[bound.prop] = newArr;
            const res = validate(spec.family, clone);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              const match = res.errors.some((err) => err.field === expected);
              expect(
                match,
                `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
              ).toBe(true);
              for (const err of res.errors) {
                expect(err.message).not.toContain(MARKER);
              }
            }
          });

          it(`bounds: maxItems for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            const baseArr = Array.isArray(targetObj[bound.prop])
              ? (targetObj[bound.prop] as unknown[])
              : [];
            const sampleItem = baseArr[0] ?? {
              path: "models/core.inp",
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            };
            const newArr: unknown[] = [];
            for (let i = 0; i < bound.maxItems!; i++) {
              newArr.push(structuredClone(sampleItem));
            }
            targetObj[bound.prop] = newArr;
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected maxItems to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }

        if (bound.minItems !== undefined) {
          it(`bounds: minItems - 1 for "${bound.prop}" fails at expected pointer`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            const baseArr = Array.isArray(targetObj[bound.prop])
              ? (targetObj[bound.prop] as unknown[])
              : [];
            targetObj[bound.prop] = baseArr.slice(0, bound.minItems! - 1);
            const res = validate(spec.family, clone);
            expect(res.ok).toBe(false);
            if (!res.ok) {
              const match = res.errors.some((err) => err.field === expected);
              expect(
                match,
                `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
              ).toBe(true);
              for (const err of res.errors) {
                expect(err.message).not.toContain(MARKER);
              }
            }
          });

          it(`bounds: minItems for "${bound.prop}" is accepted`, () => {
            const clone = structuredClone(baseDoc);
            const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
            const baseArr = Array.isArray(targetObj[bound.prop])
              ? (targetObj[bound.prop] as unknown[])
              : [];
            const sampleItem = baseArr[0] ?? {
              path: "models/core.inp",
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            };
            const newArr: unknown[] = [...baseArr];
            while (newArr.length < bound.minItems!) {
              newArr.push(structuredClone(sampleItem));
            }
            targetObj[bound.prop] = newArr.slice(0, bound.minItems!);
            const res = validate(spec.family, clone);
            expect(
              res.ok,
              `Expected minItems to be accepted, got: ${JSON.stringify(res.ok ? [] : res.errors)}`
            ).toBe(true);
          });
        }
      }

      // 6. Wrong type
      for (const p of spec.required) {
        it(`wrong type: replacing required property "${p}" fails at expected pointer`, () => {
          const clone = structuredClone(baseDoc);
          const targetObj = resolvePointer(clone, spec.pointer, spec.name, spec.fixture);
          const orig = targetObj[p];
          const badValue = typeof orig === "object" && orig !== null ? 12345 : { zz: 1 };
          targetObj[p] = badValue;
          const res = validate(spec.family, clone);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            const expected = propField(spec.pointer, p);
            const match = res.errors.some((err) => err.field === expected);
            expect(
              match,
              `Expected error at field "${expected}", got: ${JSON.stringify(res.errors)}`
            ).toBe(true);
            for (const err of res.errors) {
              expect(err.message).not.toContain(MARKER);
            }
          }
        });
      }
    });
  }
});
