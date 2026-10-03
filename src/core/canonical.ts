import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("canonicalJson does not support undefined");
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`canonicalJson does not support type ${typeof value}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((key) => {
      return JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key]);
    });
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError("Unsupported value in canonicalJson");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
