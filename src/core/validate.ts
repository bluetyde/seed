import fs from "node:fs";
import path from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

export type TypedError = {
  code: string;
  field: string;
  message: string;
  unit?: string;
  range?: { min?: number; max?: number };
  source: "seed" | "app-content";
};

export type Family =
  | "adapter-request"
  | "adapter-reply"
  | "results-index"
  | "run-record"
  | "project"
  | "study"
  | "oracle";

export const FAMILIES: readonly Family[] = [
  "adapter-request",
  "adapter-reply",
  "results-index",
  "run-record",
  "project",
  "study",
  "oracle"
] as const;

/** Index versions the host reads: v0.2 adds the optional `dimension` of a quantity. */
export const RESULTS_INDEX_SCHEMAS: readonly string[] = ["seed.results-index/0.1", "seed.results-index/0.2"];

const schemaDir = path.join(__dirname, "..", "..", "schema");

let ajvInstance: Ajv2020 | null = null;
const validators = new Map<Family, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({
      allErrors: true,
      strict: true,
      discriminator: true
    });
    const commonPath = path.join(schemaDir, "common.schema.json");
    const commonSchema = JSON.parse(fs.readFileSync(commonPath, "utf8")) as object;
    ajvInstance.addSchema(commonSchema);

    for (const family of FAMILIES) {
      const familyPath = path.join(schemaDir, `${family}.schema.json`);
      const familySchema = JSON.parse(fs.readFileSync(familyPath, "utf8")) as object;
      ajvInstance.addSchema(familySchema);
    }
  }
  return ajvInstance;
}

function getValidator(family: Family): ValidateFunction {
  let validator = validators.get(family);
  if (!validator) {
    const ajv = getAjv();
    const compiled = ajv.getSchema(`https://seed.invalid/schema/${family}.schema.json`);
    if (!compiled) {
      throw new Error(`Schema for family ${family} not found`);
    }
    validator = compiled;
    validators.set(family, validator);
  }
  return validator;
}

function formatField(err: ErrorObject): string {
  if (
    (err.keyword === "required" || err.keyword === "dependentRequired") &&
    typeof err.params?.missingProperty === "string"
  ) {
    const parent = err.instancePath;
    return parent ? `${parent}/${err.params.missingProperty}` : `/${err.params.missingProperty}`;
  }
  if (err.keyword === "additionalProperties" && typeof err.params?.additionalProperty === "string") {
    const parent = err.instancePath;
    return parent ? `${parent}/${err.params.additionalProperty}` : `/${err.params.additionalProperty}`;
  }
  if (err.keyword === "discriminator" && typeof err.params?.tag === "string") {
    const parent = err.instancePath;
    return parent ? `${parent}/${err.params.tag}` : `/${err.params.tag}`;
  }
  return err.instancePath;
}

export function coreErrorCodes(): string[] {
  const codesPath = path.join(schemaDir, "error-codes.json");
  const content = fs.readFileSync(codesPath, "utf8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return Object.keys(parsed);
}

export function validate(
  family: Family,
  data: unknown
): { ok: true } | { ok: false; errors: TypedError[] } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      errors: [
        {
          code: "E_SCHEMA_INVALID",
          field: "",
          message: "expected object",
          source: "seed"
        }
      ]
    };
  }

  const record = data as Record<string, unknown>;
  if (typeof record.schema === "string" && /^seed\.[a-z-]+\/[0-9]+\.[0-9]+$/.test(record.schema)) {
    const accepted = family === "results-index" ? RESULTS_INDEX_SCHEMAS.includes(record.schema) : record.schema === `seed.${family}/0.1`;
    if (!accepted) {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_VERSION",
            field: "/schema",
            message: "unsupported schema family or version",
            source: "seed"
          }
        ]
      };
    }
  }

  const validator = getValidator(family);
  const isValid = validator(data);
  if (isValid) {
    return { ok: true };
  }

  const rawErrors = validator.errors ?? [];
  const typedErrors: TypedError[] = [];
  for (const err of rawErrors) {
    const field = formatField(err);
    const message = err.message ?? "validation failed";
    typedErrors.push({
      code: "E_SCHEMA_INVALID",
      field,
      message,
      source: "seed"
    });
  }

  const seen = new Set<string>();
  const uniqueErrors: TypedError[] = [];
  for (const err of typedErrors) {
    const key = `${err.code}\0${err.field}\0${err.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueErrors.push(err);
    }
  }

  uniqueErrors.sort((a, b) => {
    if (a.field !== b.field) {
      return a.field < b.field ? -1 : 1;
    }
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  return {
    ok: false,
    errors: uniqueErrors
  };
}
