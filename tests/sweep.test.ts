import { describe, expect, it } from "vitest";
import { evaluateGate, DEFAULT_MAX_CASES, type Actor, type PolicyStudy } from "../src/core/policy";
import { expandSweep, sweepCaseId, type SweepDefinition } from "../src/core/sweep";
import type { RegisteredCase } from "../src/core/runDispatcher";

const budget = { maxWallSeconds: 600, maxCores: 4, maxMemoryMB: 4096, maxDiskMB: 1000 };
const study = (extra: Partial<PolicyStudy["budget"]> = {}): PolicyStudy => ({
  studyId: "s",
  tier: "A1",
  budget: { ...budget, ...extra },
  parameters: [
    { id: "temp", min: 300, max: 900, unit: "K" },
    { id: "flow", min: 1, max: 50 }
  ]
});
const base: RegisteredCase = {
  artifact: { path: "m.json", revision: { hash: "a".repeat(64), counter: 1 } },
  inputs: [{ path: "m.json", sha256: "a".repeat(64) }],
  params: [
    { id: "temp", value: 500 },
    { id: "flow", value: 10 }
  ],
  settings: { scenario: "success", seedless: true },
  seed: 7
};
const cases = { base };
const agent: Actor = { kind: "agent", name: "a" };

describe("expanding a sweep", () => {
  it("one axis gives one case per value, in the order listed, each a full registered case", () => {
    const r = expandSweep("t", { base: "base", axes: [{ id: "temp", values: [300, 600, 900] }] }, cases, study());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.caseId)).toEqual(["t-001", "t-002", "t-003"]);
    expect(r.cases.map((c) => c.values)).toEqual([[{ id: "temp", value: 300 }], [{ id: "temp", value: 600 }], [{ id: "temp", value: 900 }]]);
    const c2 = r.cases[1]!.registered;
    expect(c2.params).toEqual([
      { id: "temp", value: 600 },
      { id: "flow", value: 10 }
    ]);
    expect(c2.settings).toEqual({ scenario: "success", seedless: true, temp: 600 });
    expect(c2.seed).toBe(7);
    expect(c2.inputs).toEqual(base.inputs);
  });

  it("two axes give every combination, the first axis changing slowest", () => {
    const r = expandSweep("g", { base: "base", axes: [{ id: "temp", values: [300, 400] }, { id: "flow", values: [1, 2, 3] }] }, cases, study());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.values.map((v) => v.value).join("/"))).toEqual(["300/1", "300/2", "300/3", "400/1", "400/2", "400/3"]);
    expect(new Set(r.cases.map((c) => c.caseId)).size).toBe(6);
  });

  it("does not change the base case or the definition, and the same input gives the same cases", () => {
    const def: SweepDefinition = { base: "base", axes: [{ id: "temp", values: [300, 400] }] };
    const before = JSON.stringify([cases, def]);
    const a = expandSweep("t", def, cases, study());
    const b = expandSweep("t", def, cases, study());
    expect(JSON.stringify([cases, def])).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (a.ok) {
      a.cases[0]!.registered.params[0]!.value = -1;
      a.cases[0]!.registered.settings!.scenario = "changed";
      expect(base.params[0]!.value).toBe(500);
      expect(base.settings!.scenario).toBe("success");
    }
  });

  it("case ids are the sweep id, a dash and a number of three digits", () => {
    expect(sweepCaseId("t", 1)).toBe("t-001");
    expect(sweepCaseId("t", 12)).toBe("t-012");
    expect(sweepCaseId("t", 1000)).toBe("t-1000");
  });

  it("a value in the study's bounds or outside them expands alike: the gate checks bounds before each case", () => {
    const r = expandSweep("t", { base: "base", axes: [{ id: "temp", values: [100, 5000] }] }, cases, study());
    expect(r.ok).toBe(true);
  });
});

describe("what a sweep may not be", () => {
  const bad = (def: unknown, s = study(), id = "t") => expandSweep(id, def as SweepDefinition, cases, s);
  const code = (r: ReturnType<typeof bad>) => (r.ok ? "ok" : r.errors[0]!.code);
  const field = (r: ReturnType<typeof bad>) => (r.ok ? "ok" : r.errors[0]!.field);

  it("over the study's case limit is refused, not shortened (default 10, or the study's maxCases)", () => {
    const eleven = { base: "base", axes: [{ id: "temp", values: Array.from({ length: DEFAULT_MAX_CASES + 1 }, (_, i) => 300 + i) }] };
    expect(code(bad(eleven))).toBe("E_BUDGET_EXCEEDED");
    expect(bad({ base: "base", axes: [{ id: "temp", values: Array.from({ length: 10 }, (_, i) => 300 + i) }] }).ok).toBe(true);
    expect(bad({ base: "base", axes: [{ id: "temp", values: Array.from({ length: 12 }, (_, i) => 300 + i) }] }, study({ maxCases: 12 })).ok).toBe(true);
    expect(code(bad({ base: "base", axes: [{ id: "temp", values: [300, 301, 302] }] }, study({ maxCases: 2 })))).toBe("E_BUDGET_EXCEEDED");
  });

  it("the limit is exact for a product too: 12 cases pass at maxCases 12 and are refused at 11; one axis over the limit names that axis", () => {
    const def = { base: "base", axes: [{ id: "temp", values: [300, 301, 302] }, { id: "flow", values: [1, 2, 3, 4] }] };
    expect(bad(def, study({ maxCases: 12 })).ok).toBe(true);
    expect(code(bad(def, study({ maxCases: 11 })))).toBe("E_BUDGET_EXCEEDED");
    expect(field(bad({ base: "base", axes: [{ id: "temp", values: Array.from({ length: 11 }, (_, i) => 300 + i) }] }))).toBe("/sweeps/t/axes/0/values");
  });

  it("the product of the axes counts, not each axis alone", () => {
    const def = { base: "base", axes: [{ id: "temp", values: [300, 301, 302, 303] }, { id: "flow", values: [1, 2, 3] }] };
    const r = bad(def);
    expect(code(r)).toBe("E_BUDGET_EXCEEDED");
    expect(field(r)).toBe("/sweeps/t/axes");
    expect(bad(def, study({ maxCases: 12 })).ok).toBe(true);
  });

  it("a parameter the study does not declare cannot be swept", () => {
    expect(field(bad({ base: "base", axes: [{ id: "scenario", values: [1] }] }))).toBe("/sweeps/t/axes/0/id");
    expect(code(bad({ base: "base", axes: [{ id: "scenario", values: [1] }] }))).toBe("E_SCHEMA_INVALID");
  });

  it.each(["__proto__", "constructor", "prototype"])("%s cannot be swept even if a study declared it", (name) => {
    const s = study();
    s.parameters.push({ id: name, min: 0, max: 1 });
    expect(code(bad({ base: "base", axes: [{ id: name, values: [1] }] }, s))).toBe("E_SCHEMA_INVALID");
  });

  it.each([
    ["an unknown base case", { base: "nope", axes: [{ id: "temp", values: [1] }] }, "/sweeps/t/base"],
    ["a base named like an Object member", { base: "constructor", axes: [{ id: "temp", values: [1] }] }, "/sweeps/t/base"],
    ["no axes", { base: "base", axes: [] }, "/sweeps/t/axes"],
    ["five axes", { base: "base", axes: [1, 2, 3, 4, 5].map(() => ({ id: "temp", values: [1] })) }, "/sweeps/t/axes"],
    ["a parameter on two axes", { base: "base", axes: [{ id: "temp", values: [300] }, { id: "temp", values: [400] }] }, "/sweeps/t/axes/1/id"],
    ["an empty axis", { base: "base", axes: [{ id: "temp", values: [] }] }, "/sweeps/t/axes/0/values"],
    ["a value listed twice", { base: "base", axes: [{ id: "temp", values: [300, 300] }] }, "/sweeps/t/axes/0/values"],
    ["0 and -0 as two values", { base: "base", axes: [{ id: "temp", values: [0, -0] }] }, "/sweeps/t/axes/0/values"],
    ["a text value", { base: "base", axes: [{ id: "temp", values: ["300"] }] }, "/sweeps/t/axes/0/values"],
    ["NaN", { base: "base", axes: [{ id: "temp", values: [Number.NaN] }] }, "/sweeps/t/axes/0/values"],
    ["Infinity", { base: "base", axes: [{ id: "temp", values: [Number.POSITIVE_INFINITY] }] }, "/sweeps/t/axes/0/values"],
    ["an axis that is not an object", { base: "base", axes: [null] }, "/sweeps/t/axes/0"],
    ["a definition that is not an object", null, "/sweeps/t"],
    ["axes that are not a list", { base: "base", axes: {} }, "/sweeps/t"]
  ])("%s is refused with the field named", (_name, def, f) => {
    const r = bad(def);
    expect(code(r)).toBe("E_SCHEMA_INVALID");
    expect(field(r)).toBe(f);
  });

  it.each(["", "a b", "../x", "x".repeat(57), "-x"])("a sweep id %j is refused", (id) => {
    expect(field(bad({ base: "base", axes: [{ id: "temp", values: [1] }] }, study(), id))).toBe("/sweepId");
  });
});

describe("the gate and maxCases", () => {
  const ctx = (s = study()) => ({ study: s });
  const sweep = (cases: unknown, extra = {}) =>
    evaluateGate({ operation: "run_sweep", actor: agent, studyId: "s", cases: cases as number, ...extra }, ctx());

  it("a sweep within the limit passes; over it is a budget stop that names the limit", () => {
    expect(sweep(10).allow).toBe(true);
    const d = sweep(11);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.errors[0]).toMatchObject({ code: "E_BUDGET_EXCEEDED", field: "/cases", range: { max: 10 } });
      expect(d.gateStop.rule).toBe("budget");
    }
  });

  it("the study's own maxCases replaces the default, upward or downward", () => {
    expect(evaluateGate({ operation: "run_sweep", actor: agent, studyId: "s", cases: 30 }, ctx(study({ maxCases: 30 }))).allow).toBe(true);
    expect(evaluateGate({ operation: "run_sweep", actor: agent, studyId: "s", cases: 3 }, ctx(study({ maxCases: 2 }))).allow).toBe(false);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, "3"])("a sweep that does not say how many cases (%s) is refused", (n) => {
    const d = sweep(n);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/cases" });
  });

  it("a single case is not held to the sweep limit", () => {
    expect(evaluateGate({ operation: "run_case", actor: agent, studyId: "s" }, ctx(study({ maxCases: 1 }))).allow).toBe(true);
  });

  it("a human is held to the limit too", () => {
    const d = evaluateGate({ operation: "run_sweep", actor: { kind: "human", name: "h" }, studyId: "s", cases: 11 }, ctx());
    expect(d.allow).toBe(false);
  });
});
