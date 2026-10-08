import { DEFAULT_MAX_CASES, type PolicyStudy } from "./policy";
import type { RegisteredCase } from "./runDispatcher";
import type { TypedError } from "./validate";

/**
 * A sweep is registered by the host, like a case: the client names a sweep and a budget, never a value. It varies
 * study parameters (the human declared their bounds in the study) of one registered base case. Every combination of
 * the axes' values becomes a registered case of its own, with its own run record, and a value goes both into the
 * case's `params` (the gate checks it against the study bounds before each case) and into its `settings`.
 */
export type SweepAxis = { id: string; values: number[] };
export type SweepDefinition = { base: string; axes: SweepAxis[] };
export type ExpandedCase = { caseId: string; registered: RegisteredCase; values: { id: string; value: number }[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_AXES = 4;
/** The most cases any sweep is expanded to, whatever the study limit says. */
export const HARD_MAX_CASES = 10000;

const bad = (field: string, message: string): { ok: false; errors: TypedError[] } => ({
  ok: false,
  errors: [{ code: "E_SCHEMA_INVALID", field, message, source: "seed" }]
});

/** The id of case number `index` (1-based) of a sweep: the sweep id, a dash and three digits or more. */
export function sweepCaseId(sweepId: string, index: number): string {
  return `${sweepId}-${String(index).padStart(3, "0")}`;
}

/**
 * The cases of a sweep, in a fixed order (the first axis changes slowest). Pure: the same inputs give the same
 * cases. A definition that cannot be expanded is an error naming what is wrong, never a shorter sweep.
 */
export function expandSweep(
  sweepId: string,
  def: SweepDefinition,
  cases: Readonly<Record<string, RegisteredCase>>,
  study: PolicyStudy
): { ok: true; cases: ExpandedCase[] } | { ok: false; errors: TypedError[] } {
  if (typeof sweepId !== "string" || !ID.test(sweepId)) return bad("/sweepId", "a sweep id is 1 to 56 letters, digits, dots, dashes or underscores");
  if (def === null || typeof def !== "object" || typeof def.base !== "string" || !Array.isArray(def.axes)) {
    return bad(`/sweeps/${sweepId}`, "a sweep names a base case and a list of axes");
  }
  if (!Object.hasOwn(cases, def.base)) return bad(`/sweeps/${sweepId}/base`, `base case ${def.base} is not registered`);
  const base = cases[def.base] as RegisteredCase;
  if (def.axes.length < 1 || def.axes.length > MAX_AXES) {
    return bad(`/sweeps/${sweepId}/axes`, `a sweep has 1 to ${MAX_AXES} axes`);
  }
  // The study's limit is a number a person typed: however large, a sweep is never expanded past a fixed ceiling, so a configuration cannot
  // ask the host to build a billion cases before any request is judged.
  const limit = Math.min(study.budget.maxCases ?? DEFAULT_MAX_CASES, HARD_MAX_CASES);
  const seen = new Set<string>();
  let total = 1;
  for (let a = 0; a < def.axes.length; a++) {
    const axis = def.axes[a] as SweepAxis;
    const at = `/sweeps/${sweepId}/axes/${a}`;
    if (axis === null || typeof axis !== "object" || typeof axis.id !== "string" || !Array.isArray(axis.values)) {
      return bad(at, "an axis names a study parameter and lists its values");
    }
    if (FORBIDDEN_KEYS.has(axis.id)) return bad(`${at}/id`, `${axis.id} cannot be swept`);
    if (!study.parameters.some((b) => b.id === axis.id)) {
      return bad(`${at}/id`, `${axis.id} is not a parameter of the study; only parameters with human-declared bounds can be swept`);
    }
    if (seen.has(axis.id)) return bad(`${at}/id`, `${axis.id} is on two axes`);
    seen.add(axis.id);
    if (axis.values.length < 1) return bad(`${at}/values`, "an axis needs at least one value");
    if (axis.values.length > limit) {
      return { ok: false, errors: [{ code: "E_BUDGET_EXCEEDED", field: `${at}/values`, message: `the axis has ${axis.values.length} values, over the study limit of ${limit} cases`, source: "seed", range: { max: limit } }] };
    }
    const values = new Set<number>();
    for (const v of axis.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) return bad(`${at}/values`, "every value is a finite number");
      const key = v === 0 ? 0 : v; // -0 and 0 are one value
      if (values.has(key)) return bad(`${at}/values`, `the value ${v} is listed twice`);
      values.add(key);
    }
    total *= axis.values.length;
    if (total > limit) {
      return { ok: false, errors: [{ code: "E_BUDGET_EXCEEDED", field: `/sweeps/${sweepId}/axes`, message: `the sweep has more than ${limit} cases (the study limit)`, source: "seed", range: { max: limit } }] };
    }
  }

  const out: ExpandedCase[] = [];
  const pick = new Array<number>(def.axes.length).fill(0);
  for (let n = 1; n <= total; n++) {
    const registered = structuredClone(base);
    const settings: Record<string, unknown> = { ...(registered.settings ?? {}) };
    const values: { id: string; value: number }[] = [];
    def.axes.forEach((axis, a) => {
      const value = axis.values[pick[a] as number] as number;
      values.push({ id: axis.id, value });
      settings[axis.id] = value;
      const param = registered.params.find((p) => p.id === axis.id);
      if (param !== undefined) param.value = value;
      else registered.params.push({ id: axis.id, value });
    });
    registered.settings = settings;
    out.push({ caseId: sweepCaseId(sweepId, n), registered, values });
    for (let a = def.axes.length - 1; a >= 0; a--) {
      pick[a] = (pick[a] as number) + 1;
      if ((pick[a] as number) < (def.axes[a] as SweepAxis).values.length) break;
      pick[a] = 0;
    }
  }
  return { ok: true, cases: out };
}
