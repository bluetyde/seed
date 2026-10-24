/**
 * The loop controller of a feedback coupling (docs/coupling-controller.md, docs/coupling-prerequisites.md sections 4.3 and 4.5, plan 09).
 * Pure: no file, no clock, no `Math.random`, no knowledge of any app. One pass of the real loop (run app A with the current iterate, transfer,
 * run app B, transfer back) is a function the host injects; this module only decides, after each pass, whether to go on, and keeps the records.
 *
 * Pass k calls `pass(iterate, k)`. The pass returns `calc`, the value of each exchanged quantity the apps compute when started from `iterate`.
 *   change_i = |calc_i - iterate_i| / max(|calc_i|, floor_i)          (relative change, with an absolute scale for tiny values)
 *   growth (diverged) is measured on the absolute residual, scale_i = max(|calc_i of pass 1|, floor_i) fixed once, because the denominator of
 *   the relative change moves with the iterate and hides a growing residual.
 *   next_i   = iterate_i + relaxation * (calc_i - iterate_i)          (under-relaxation; relaxation 1 means next = calc)
 * Checks after each pass, in this order: engine-failure, conservation, finite and range (diverged), converged, stalled, diverged (growth),
 * oscillating; then the next pass, or `not-converged` when the maximum is reached. Only a `converged` outcome has a `result`.
 */

export const HARD_MAX_PASSES = 25;
export const DEFAULT_FLOOR = 1e-12;
export const DEFAULT_RELAXATION = 1;
export const DEFAULT_CONSECUTIVE = 2;
/** Passes of strictly growing change that mean divergence. */
export const GROWTH_PASSES = 3;
/** Passes looked at for an oscillation. */
export const OSCILLATION_WINDOW = 4;
/** A residual that keeps at least this share of its value two passes earlier has not decayed. */
export const OSCILLATION_KEEP = 0.9;
/** A residual within this many standard deviations of noise is not distinguishable from noise. */
export const NOISE_SIGMAS = 2;

export type Exchanged = { id: string; tolerance: number; floor?: number; min?: number; max?: number };
export type LoopDefinition = { exchanged: Exchanged[]; maxPasses: number; relaxation: number; consecutive: number };
export type PassSuccess = { ok: true; calc: Record<string, number>; noise?: Record<string, number>; conservation?: { ok: boolean; message?: string } };
export type PassFailure = { ok: false; reason: string };
export type PassFunction = (iterate: Record<string, number>, index: number) => Promise<PassSuccess | PassFailure>;
export type CouplingState = "converged" | "not-converged" | "diverged" | "oscillating" | "stalled" | "engine-failure" | "conservation" | "refused";
export type PassRecord = {
  index: number;
  iterate: Record<string, number>;
  calc: Record<string, number>;
  change: Record<string, number>;
  relaxation: number;
  next: Record<string, number>;
  noise?: Record<string, number>;
  conservation?: { ok: boolean; message?: string };
};
export type CouplingOutcome = { state: CouplingState; reason: string; passes: PassRecord[]; result?: { iterate: Record<string, number>; passes: number } };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Checks a loop definition from outside (untyped) and returns a normalised copy: `relaxation` defaults to 1 and `consecutive` to 2 when
 * omitted, `maxPasses` and `exchanged` are required. Every problem found is listed, each naming the field.
 */
export function validateLoop(def: unknown): { ok: true; def: LoopDefinition } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(def)) return { ok: false, errors: ["a loop definition is an object with exchanged, maxPasses, relaxation and consecutive"] };
  for (const k of Object.keys(def)) {
    if (!["exchanged", "maxPasses", "relaxation", "consecutive"].includes(k)) errors.push(`a loop has exchanged, maxPasses, relaxation and consecutive; not ${k}`);
  }

  const maxPasses = def.maxPasses;
  if (!Number.isInteger(maxPasses)) errors.push("maxPasses is a whole number from 1 to " + HARD_MAX_PASSES);
  else if ((maxPasses as number) < 1) errors.push(`maxPasses is ${String(maxPasses)}; it must be at least 1`);
  else if ((maxPasses as number) > HARD_MAX_PASSES) errors.push(`maxPasses is ${String(maxPasses)}, over the hard ceiling of ${HARD_MAX_PASSES} passes`);

  const relaxation = def.relaxation === undefined ? DEFAULT_RELAXATION : def.relaxation;
  if (!isNum(relaxation) || relaxation <= 0 || relaxation > 1) errors.push("relaxation is a number above 0 and at most 1");

  const consecutive = def.consecutive === undefined ? DEFAULT_CONSECUTIVE : def.consecutive;
  if (!Number.isInteger(consecutive) || (consecutive as number) < 2) errors.push("consecutive is a whole number of at least 2");

  const exchanged: Exchanged[] = [];
  if (!Array.isArray(def.exchanged) || def.exchanged.length < 1) errors.push("exchanged lists at least one quantity");
  else {
    const seen = new Set<string>();
    def.exchanged.forEach((q: unknown, i: number) => {
      const at = `exchanged[${i}]`;
      if (!isObject(q)) { errors.push(`${at} is an object with id and tolerance`); return; }
      for (const k of Object.keys(q)) {
        if (!["id", "tolerance", "floor", "min", "max"].includes(k)) errors.push(`${at} has id, tolerance, floor, min and max; not ${k}`);
      }
      let idOk = false;
      if (typeof q.id !== "string" || !ID.test(q.id) || FORBIDDEN_KEYS.has(q.id)) errors.push(`${at}.id is a name of letters, digits, dots, dashes, colons or underscores`);
      else if (seen.has(q.id)) errors.push(`${at}.id ${q.id} is listed twice (duplicate id)`);
      else { seen.add(q.id); idOk = true; }
      if (!isNum(q.tolerance) || q.tolerance < 1e-15 || q.tolerance >= 1) errors.push(`${at}.tolerance is a relative tolerance of at least 1e-15 and below 1`);
      if (q.floor !== undefined && (!isNum(q.floor) || q.floor < 1e-200)) errors.push(`${at}.floor is a number of at least 1e-200`);
      if (q.min !== undefined && !isNum(q.min)) errors.push(`${at}.min is a finite number`);
      if (q.max !== undefined && !isNum(q.max)) errors.push(`${at}.max is a finite number`);
      if (isNum(q.min) && isNum(q.max) && q.min > q.max) errors.push(`${at}.min ${q.min} is above max ${q.max}`);
      if (idOk && isNum(q.tolerance) && q.tolerance >= 1e-15 && q.tolerance < 1 && (q.floor === undefined || q.floor >= 1e-200) && (q.floor === undefined || isNum(q.floor)) && (q.min === undefined || isNum(q.min)) && (q.max === undefined || isNum(q.max))) {
        const e: Exchanged = { id: q.id as string, tolerance: q.tolerance };
        if (q.floor !== undefined) e.floor = q.floor as number;
        if (q.min !== undefined) e.min = q.min as number;
        if (q.max !== undefined) e.max = q.max as number;
        exchanged.push(e);
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, def: { exchanged, maxPasses: maxPasses as number, relaxation: relaxation as number, consecutive: consecutive as number } };
}

const refused = (reason: string): CouplingOutcome => ({ state: "refused", reason, passes: [] });
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs the loop. Never throws for a bad pass: a pass that fails or throws ends the loop as `engine-failure`. The objects passed in are not
 * changed and the outcome shares no object with them (nor with the objects handed to the pass function, which gets a fresh copy each time).
 */
export async function runCoupling(def: LoopDefinition, initial: Record<string, number>, pass: PassFunction): Promise<CouplingOutcome> {
  const v = validateLoop(def);
  if (!v.ok) return refused("the loop definition is refused: " + v.errors.join("; "));
  const loop = v.def;
  const qs = loop.exchanged;
  if (!isObject(initial)) return refused("the initial iterate is an object with one number for each exchanged quantity");
  const start: Record<string, number> = {};
  const problems: string[] = [];
  for (const q of qs) {
    if (!Object.hasOwn(initial, q.id)) problems.push(`the initial iterate has no value for ${q.id}`);
    else if (!isNum(initial[q.id])) problems.push(`the initial value of ${q.id} is not a finite number`);
    else start[q.id] = initial[q.id] as number;
  }
  if (problems.length > 0) return refused("the initial iterate is refused: " + problems.join("; "));

  const passes: PassRecord[] = [];
  const norms: number[] = []; // R_k: largest |residual| / (tolerance * scale) over quantities, the scale fixed at pass 1
  const scales: Record<string, number> = {};
  const residuals: Record<string, number>[] = []; // calc - iterate, per pass
  let iterate = start;
  let convergedRun = 0;
  let stalledRun = 0;
  const end = (state: CouplingState, reason: string): CouplingOutcome => ({ state, reason, passes });

  for (let k = 1; k <= loop.maxPasses; k++) {
    let raw: PassSuccess | PassFailure;
    try {
      raw = await pass({ ...iterate }, k);
    } catch (e) {
      return end("engine-failure", `pass ${k} threw: ${messageOf(e)}`);
    }
    if (!isObject(raw) || typeof raw.ok !== "boolean") return end("engine-failure", `pass ${k} did not return a pass result`);
    if (!raw.ok) return end("engine-failure", `pass ${k} failed: ${typeof raw.reason === "string" ? raw.reason : "no reason given"}`);
    const ok = raw as PassSuccess;
    if (!isObject(ok.calc)) return end("engine-failure", `pass ${k} returned no calc values`);

    const calc: Record<string, number> = {};
    for (const q of qs) {
      if (!Object.hasOwn(ok.calc, q.id) || typeof ok.calc[q.id] !== "number") return end("engine-failure", `pass ${k} left out a value for ${q.id}`);
      calc[q.id] = ok.calc[q.id] as number;
    }
    let noise: Record<string, number> | undefined;
    if (ok.noise !== undefined) {
      if (!isObject(ok.noise)) return end("engine-failure", `pass ${k} returned noise that is not an object`);
      noise = {};
      for (const q of qs) {
        if (!Object.hasOwn(ok.noise, q.id)) continue;
        const s = ok.noise[q.id];
        if (!isNum(s) || s < 0) return end("engine-failure", `pass ${k} reported a noise for ${q.id} that is not a finite number of at least 0`);
        noise[q.id] = s;
      }
    }
    let conservation: { ok: boolean; message?: string } | undefined;
    if (ok.conservation !== undefined) {
      if (!isObject(ok.conservation) || typeof ok.conservation.ok !== "boolean") return end("engine-failure", `pass ${k} returned a conservation result that is not { ok }`);
      conservation = { ok: ok.conservation.ok };
      if (typeof ok.conservation.message === "string") conservation.message = ok.conservation.message;
    }

    const change: Record<string, number> = {};
    const next: Record<string, number> = {};
    const resid: Record<string, number> = {};
    let norm = 0;
    for (const q of qs) {
      const x = iterate[q.id] as number;
      const c = calc[q.id] as number;
      resid[q.id] = c - x;
      change[q.id] = Math.abs(c - x) / Math.max(Math.abs(c), q.floor ?? DEFAULT_FLOOR);
      next[q.id] = x + loop.relaxation * (c - x);
      if (k === 1) scales[q.id] = Math.max(Math.abs(c), q.floor ?? DEFAULT_FLOOR);
      norm = Math.max(norm, Math.abs(c - x) / (q.tolerance * (scales[q.id] as number)));
    }
    const record: PassRecord = { index: k, iterate: { ...iterate }, calc, change, relaxation: loop.relaxation, next };
    if (noise !== undefined) record.noise = noise;
    if (conservation !== undefined) record.conservation = conservation;
    passes.push(record);
    norms.push(norm);
    residuals.push(resid);

    // 2. conservation
    if (conservation !== undefined && !conservation.ok) {
      return end("conservation", conservation.message !== undefined && conservation.message !== "" ? conservation.message : `the conservation check failed at pass ${k}`);
    }
    // 3. finite and range
    for (const q of qs) {
      const c = calc[q.id] as number;
      if (!Number.isFinite(c) || !Number.isFinite(next[q.id] as number)) return end("diverged", `${q.id} is not a finite number at pass ${k}`);
      if (q.min !== undefined && c < q.min) return end("diverged", `${q.id} is ${c} at pass ${k}, below its range minimum ${q.min}`);
      if (q.max !== undefined && c > q.max) return end("diverged", `${q.id} is ${c} at pass ${k}, above its range maximum ${q.max}`);
    }
    // 4. converged
    const within = qs.map((q) => (change[q.id] as number) <= q.tolerance);
    convergedRun = within.every(Boolean) ? convergedRun + 1 : 0;
    if (convergedRun >= loop.consecutive) {
      return { state: "converged", reason: `every exchanged quantity changed by no more than its tolerance on ${loop.consecutive} passes in a row (passes ${k - loop.consecutive + 1} to ${k})`, passes, result: { iterate: { ...calc }, passes: k } };
    }
    // 5. stalled
    let allOk = noise !== undefined;
    let someNoiseOnly = false;
    if (noise !== undefined) {
      qs.forEach((q, i) => {
        const noiseOk = Math.abs(resid[q.id] as number) <= NOISE_SIGMAS * (noise[q.id] ?? 0);
        if (!(within[i] || noiseOk)) allOk = false;
        if (noiseOk && !within[i]) someNoiseOnly = true;
      });
    }
    stalledRun = allOk && someNoiseOnly ? stalledRun + 1 : 0;
    if (stalledRun >= loop.consecutive) {
      return end("stalled", `the tolerance is below the noise the apps reported: for ${loop.consecutive} passes in a row every change is within its tolerance or ${NOISE_SIGMAS} standard deviations of noise, and some only within the noise`);
    }
    // 6. diverged by growth
    if (norms.length > GROWTH_PASSES) {
      let grew = true;
      for (let j = norms.length - GROWTH_PASSES; j < norms.length; j++) if (!((norms[j] as number) > (norms[j - 1] as number))) grew = false;
      if (grew) return end("diverged", `the largest residual (in tolerances, on the scale of pass 1) grew on ${GROWTH_PASSES} passes in a row, up to pass ${k}`);
    }
    // 7. oscillating (not when this pass is inside every tolerance)
    if (convergedRun === 0 && residuals.length >= OSCILLATION_WINDOW) {
      const w = residuals.slice(-OSCILLATION_WINDOW);
      for (const q of qs) {
        const r = w.map((p) => p[q.id] as number);
        let alternates = true;
        for (let j = 1; j < r.length; j++) if (!((r[j] as number) * (r[j - 1] as number) < 0)) alternates = false;
        if (!alternates) continue;
        let keeps = true;
        for (let j = 2; j < r.length; j++) if (Math.abs(r[j] as number) < OSCILLATION_KEEP * Math.abs(r[j - 2] as number)) keeps = false;
        if (keeps) return end("oscillating", `${q.id} changed sign on each of the last ${OSCILLATION_WINDOW} passes without decaying (pass ${k})`);
      }
    }
    iterate = next;
  }
  return end("not-converged", `${loop.maxPasses} passes done without convergence; the passes are kept as evidence and no result is produced`);
}
