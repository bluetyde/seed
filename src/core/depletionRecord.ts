/**
 * The depletion record as a transfer source (docs/transfer-recipe.md section 8). A depletion record (`studio.depletion/0.1`, written by OpenMC
 * Studio, kind `depletion-record/1` in record-kinds.json) is a project file, not a quantity of an adapter run. SEED checks the generic part here,
 * before a target app sees anything: the record's id is the SHA-256 of its canonical text (Studio's `record_id`: sorted keys, no spaces, the
 * top-level `id` left out, number and string tokens exactly as written), the region exists, the time lies inside the record (never extrapolated).
 * The physical meaning of the number is the target's.
 *
 * Time rule (the same as the receiving app's reader): the record's burnup is cumulative at the END of each step; inside a step it is linear from
 * the previous end; at t = 0 it is 0. A time below 0 or above the last step end is refused.
 */
import { createHash } from "node:crypto";
import type { TypedError } from "./validate";

export const DEPLETION_KIND = "depletion-record/1";
export const DEPLETION_SCHEMA = "studio.depletion/0.1";
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/** The unit conversions SEED knows for a field of a record kind: the recipe must state exactly one of these. */
export const RECORD_CONVERSIONS = [
  { record: DEPLETION_KIND, field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 1e-3, basis: "heavy-metal" },
] as const;

const err = (code: string, field: string, message: string): TypedError => ({ code, field, message, source: "seed" });

/** Studio's canonical form, computed on the tokens of the text so `190.0` and `1e-05` stay as the writer printed them. Throws on malformed text. */
export function canonicalRecordText(text: string): string {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') {
      if (i >= text.length) throw Error("unterminated string");
      i += text[i] === "\\" ? 2 : 1;
    }
    i++;
    return text.slice(start, i);
  };
  const value = (top: boolean): string => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const members: [string, string][] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return "{}";
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        i++; // the colon
        const v = value(false);
        if (!(top && JSON.parse(k) === "id")) members.push([k, v]);
        ws();
        if (text[i++] === "}") break;
      }
      members.sort((a, b) => {
        const x = JSON.parse(a[0]) as string, y = JSON.parse(b[0]) as string;
        return x < y ? -1 : x > y ? 1 : 0;
      });
      return "{" + members.map(([k, v]) => k + ":" + v).join(",") + "}";
    }
    if (c === "[") {
      i++;
      const items: string[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return "[]";
      }
      for (;;) {
        items.push(value(false));
        ws();
        if (text[i++] === "]") break;
      }
      return "[" + items.join(",") + "]";
    }
    if (c === '"') return str();
    const start = i;
    while (i < text.length && !",]} \t\n\r".includes(text[i]!)) i++;
    if (i === start) throw Error("unexpected character");
    return text.slice(start, i);
  };
  const out = value(true);
  ws();
  if (i !== text.length) throw Error("text after the record");
  return out;
}

/** What a record must say its numbers are, word for word as Studio writes it. */
const RECORD_UNITS = { time_steps_days: "days", burnup_mwd_per_tu: "MWd per tonne of initial heavy metal" } as const;

export type ParsedDepletion = {
  recordId: string;
  timeStepsDays: number[];
  regions: { name: string; burnupMwdPerTu: number[] }[];
};

/** Reads a record's text: valid JSON of the right schema, an id that matches its content, and the numbers a burnup lookup needs. */
export function parseDepletion(text: string): { ok: true; record: ParsedDepletion } | { ok: false; errors: TypedError[] } {
  const bad = (code: string, field: string, message: string) => ({ ok: false as const, errors: [err(code, field, message)] });
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) return bad("E_RECORD_INVALID", "", "the record is larger than 8 MiB");
  // bytes that are not UTF-8 were turned into U+FFFD when the file was read: the text no longer says which bytes the file has, so the file hash
  // pinned for it cannot be trusted to stand for this text
  if (text.includes(String.fromCharCode(0xfffd))) return bad("E_RECORD_INVALID", "", "the record is not valid UTF-8 text");
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return bad("E_RECORD_INVALID", "", "the record is not valid JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return bad("E_RECORD_INVALID", "", "the record is not a JSON object");
  if (doc.schema !== DEPLETION_SCHEMA) return bad("E_RECORD_INVALID", "/schema", `expected ${DEPLETION_SCHEMA}, got ${JSON.stringify(doc.schema)}`);
  if (typeof doc.id !== "string" || !/^[0-9a-f]{64}$/.test(doc.id)) return bad("E_RECORD_INVALID", "/id", "the record has no id (64 lowercase hex digits), so it cannot be pinned");
  let canonical: string;
  try {
    canonical = canonicalRecordText(text);
  } catch (e) {
    return bad("E_RECORD_INVALID", "", "the record text cannot be read: " + (e instanceof Error ? e.message : "malformed"));
  }
  if (createHash("sha256").update(canonical, "utf8").digest("hex") !== doc.id) {
    return bad("E_RECORD_ID", "/id", "the record's id does not match its content (it was changed after it was written)");
  }
  const steps = doc.time_steps_days;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0)) {
    return bad("E_RECORD_INVALID", "/time_steps_days", "time_steps_days must be a non-empty list of numbers above 0");
  }
  // the times are summed to the end of each step: a sum that leaves the range of numbers would make every time inside it map to a wrong value
  if (!Number.isFinite(steps.reduce((a: number, d: number) => a + d, 0))) return bad("E_RECORD_INVALID", "/time_steps_days", "the steps add up to more than a number can hold");
  // the units are the record's own declaration: only the ones SEED converts from are accepted, never assumed
  const declared = doc.provenance?.units;
  if (declared?.time_steps_days !== RECORD_UNITS.time_steps_days || declared?.burnup_mwd_per_tu !== RECORD_UNITS.burnup_mwd_per_tu) {
    return bad("E_RECORD_INVALID", "/provenance/units", `the record must declare time_steps_days as ${JSON.stringify(RECORD_UNITS.time_steps_days)} and burnup_mwd_per_tu as ${JSON.stringify(RECORD_UNITS.burnup_mwd_per_tu)}`);
  }
  if (!Array.isArray(doc.regions) || doc.regions.length === 0) return bad("E_RECORD_INVALID", "/regions", "the record has no regions");
  const regions: ParsedDepletion["regions"] = [];
  for (const [n, r] of (doc.regions as any[]).entries()) {
    const b = r?.burnup_mwd_per_tu;
    if (typeof r?.name !== "string" || r.name.length === 0) return bad("E_RECORD_INVALID", `/regions/${n}/name`, "a region has no name");
    if (!Array.isArray(b) || b.length !== steps.length || !b.every((x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0)) {
      return bad("E_RECORD_INVALID", `/regions/${n}/burnup_mwd_per_tu`, "burnup_mwd_per_tu must hold one number (0 or more) per time step");
    }
    // burnup is cumulative: a value below the one before it would send a later transfer back to an earlier state
    if (b.some((x: number, i: number) => i > 0 && x < b[i - 1])) return bad("E_RECORD_INVALID", `/regions/${n}/burnup_mwd_per_tu`, "burnup_mwd_per_tu is cumulative and must not decrease from one step to the next");
    regions.push({ name: r.name, burnupMwdPerTu: b });
  }
  if (new Set(regions.map((r) => r.name)).size !== regions.length) return bad("E_RECORD_INVALID", "/regions", "two regions have the same name");
  return { ok: true, record: { recordId: doc.id, timeStepsDays: steps, regions } };
}

/** The burnup (MWd/tU, heavy-metal basis) of one region at a time in days from the start of the record. */
export function burnupAt(record: ParsedDepletion, region: string, tDays: number): { ok: true; value: number; interpolated: boolean } | { ok: false; errors: TypedError[] } {
  const r = record.regions.find((x) => x.name === region);
  if (!r) return { ok: false, errors: [err("E_REGION_UNKNOWN", "/source/region", `the record has no region ${JSON.stringify(region)} (it has ${record.regions.map((x) => JSON.stringify(x.name)).join(", ")})`)] };
  const ends: number[] = [];
  record.timeStepsDays.reduce((acc, d) => (ends.push(acc + d), acc + d), 0);
  const last = ends[ends.length - 1]!;
  if (typeof tDays !== "number" || !Number.isFinite(tDays) || tDays < 0 || tDays > last) {
    return { ok: false, errors: [err("E_TIME_MAPPING", "/source/time", `time ${tDays} is outside the record (0 to ${last} days); it is never extrapolated`)] };
  }
  if (tDays === 0) return { ok: true, value: 0, interpolated: false };
  for (let i = 0; i < ends.length; i++) {
    if (tDays <= ends[i]!) {
      const t0 = i === 0 ? 0 : ends[i - 1]!;
      const b0 = i === 0 ? 0 : r.burnupMwdPerTu[i - 1]!;
      const b1 = r.burnupMwdPerTu[i]!;
      if (tDays === ends[i]) return { ok: true, value: b1, interpolated: false };
      return { ok: true, value: b0 + ((tDays - t0) / (ends[i]! - t0)) * (b1 - b0), interpolated: true };
    }
  }
  return { ok: true, value: r.burnupMwdPerTu[r.burnupMwdPerTu.length - 1]!, interpolated: false };
}
