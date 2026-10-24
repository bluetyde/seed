// @covers R-STUDY-05
import { describe, expect, it } from "vitest";
import { compareReplay, identityDifferences, replayMarkdown, type ReplayPolicy, type ReplayRun } from "../src/core/replay";
import type { QuantityData } from "../src/core/quantityData";

// Replay (acceptance A7): the second run of a case either reproduces the first within the adapter's policy, or every difference is listed.

const scalar = (value: number, std?: number, unit = "1"): QuantityData => ({ kind: "scalar", quantity: "k", unit, value, ...(std === undefined ? {} : { std }) });
const series = (values: number[], std?: number[], x = values.map((_, i) => i)): QuantityData => ({ kind: "series", quantity: "p", unit: "W", axis: { name: "t", unit: "s" }, x, values, ...(std ? { std } : {}) });
const run = (runId: string, data: QuantityData = scalar(1), over: Partial<ReplayRun> = {}): ReplayRun => ({
  runId, state: "completed", adapter: { id: "raft", version: "0.1.0" }, engine: { name: "raft", version: "1.2.3" }, dataLibrary: { id: "endf8", hash: "a".repeat(64) },
  seed: 7, inputs: [{ path: "case.json", sha256: "b".repeat(64) }, { path: "mesh.json", sha256: "c".repeat(64) }], settings: { steps: 10, mode: "fast" },
  quantities: [{ name: data.quantity, unit: data.unit, normalization: "per-run", data }], ...over,
});
const exact: ReplayPolicy = { mode: "exact" };
const tol: ReplayPolicy = { mode: "tolerance", abs: 1e-6, rel: 1e-4 };
const stat: ReplayPolicy = { mode: "statistical", sigmas: 3 };
const ok = (r: ReturnType<typeof compareReplay>) => { if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

describe("identity: the runs must have been made the same way", () => {
  it("identical runs have no difference", () => {
    expect(identityDifferences(run("a"), run("b"))).toEqual([]);
  });

  it.each([
    ["the adapter id", { adapter: { id: "other", version: "0.1.0" } }, "adapter.id"],
    ["the adapter version", { adapter: { id: "raft", version: "0.2.0" } }, "adapter.version"],
    ["the engine name", { engine: { name: "x", version: "1.2.3" } }, "engine.name"],
    ["the engine version", { engine: { name: "raft", version: "1.2.4" } }, "engine.version"],
    ["the data library id", { dataLibrary: { id: "endf7", hash: "a".repeat(64) } }, "dataLibrary.id"],
    ["the data library hash", { dataLibrary: { id: "endf8", hash: "d".repeat(64) } }, "dataLibrary.hash"],
    ["the seed", { seed: 8 }, "seed"],
    ["a missing seed", { seed: undefined }, "seed"],
    ["a changed input", { inputs: [{ path: "case.json", sha256: "e".repeat(64) }, { path: "mesh.json", sha256: "c".repeat(64) }] }, "inputs[case.json].sha256"],
    ["an extra input", { inputs: [{ path: "case.json", sha256: "b".repeat(64) }, { path: "mesh.json", sha256: "c".repeat(64) }, { path: "z.json", sha256: "f".repeat(64) }] }, "inputs[z.json]"],
    ["a missing input", { inputs: [{ path: "case.json", sha256: "b".repeat(64) }] }, "inputs[mesh.json]"],
    ["a setting", { settings: { steps: 11, mode: "fast" } }, "settings"],
  ])("%s is listed and makes the replay not comparable", (_name, over, field) => {
    const d = identityDifferences(run("a"), run("b", scalar(1), over as Partial<ReplayRun>));
    expect(d.map((x) => x.field)).toEqual([field]);
    const r = ok(compareReplay({ original: run("a"), replay: run("b", scalar(1), over as Partial<ReplayRun>), policy: exact }));
    expect(r.verdict).toBe("not-comparable");
    expect(r.quantities).toEqual([]);
    expect(r.differences.map((x) => x.field)).toEqual([field]);
    expect(r.notes.join(" ")).toMatch(/not made the same way/);
  });

  it("an engine that one run does not report differs in its name and its version", () => {
    const d = identityDifferences(run("a"), run("b", scalar(1), { engine: undefined }));
    expect(d.map((x) => x.field)).toEqual(["engine.name", "engine.version"]);
    expect(identityDifferences(run("a", scalar(1), { engine: undefined }), run("b", scalar(1), { engine: undefined }))).toEqual([]);
  });

  it("lists every difference, not only the first", () => {
    const r = ok(compareReplay({ original: run("a"), replay: run("b", scalar(1), { seed: 9, engine: { name: "raft", version: "2.0.0" }, dataLibrary: { id: "endf8", hash: "d".repeat(64) } }), policy: exact }));
    expect(r.differences.map((x) => x.field)).toEqual(["engine.version", "dataLibrary.hash", "seed"]);
  });

  it("does not care about the order of the inputs or of the keys in the settings", () => {
    const r = run("b", scalar(1), { inputs: [...run("a").inputs].reverse(), settings: { mode: "fast", steps: 10 } });
    expect(identityDifferences(run("a"), r)).toEqual([]);
  });

  it("does not compare values when the runs were made differently, even if they differ a lot", () => {
    const r = ok(compareReplay({ original: run("a", scalar(1)), replay: run("b", scalar(99), { seed: 8 }), policy: exact }));
    expect(r.verdict).toBe("not-comparable");
    expect(r.quantities).toEqual([]);
  });
});

describe("the runs themselves", () => {
  it("an original that did not complete, or is stale, cannot be reproduced", () => {
    for (const over of [{ state: "failed" }, { state: "cancelled" }, { state: "terminated-by-trip" }, { state: "completed", stale: true }]) {
      const r = ok(compareReplay({ original: run("a", scalar(1), over), replay: run("b"), policy: exact }));
      expect(r.verdict).toBe("not-comparable");
      expect(r.differences[0]).toMatchObject({ kind: "state", field: "original.state" });
    }
  });

  it("a replay that did not complete differs: it did not reproduce", () => {
    const r = ok(compareReplay({ original: run("a"), replay: run("b", scalar(1), { state: "failed" }), policy: exact }));
    expect(r.verdict).toBe("differs");
    expect(r.differences[0]).toMatchObject({ kind: "state", field: "replay.state" });
  });

  it("a run cannot be replayed against itself", () => {
    const r = compareReplay({ original: run("a"), replay: run("a"), policy: exact });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["no mode", {}],
    ["an unknown mode", { mode: "loose" }],
    ["exact with extra fields", { mode: "exact", abs: 1 }],
    ["tolerance with nothing", { mode: "tolerance" }],
    ["tolerance with a negative bound", { mode: "tolerance", abs: -1, rel: 0 }],
    ["tolerance with both bounds zero", { mode: "tolerance", abs: 0, rel: 0 }],
    ["tolerance with a bound that is not a number", { mode: "tolerance", abs: "1", rel: 0 }],
    ["tolerance with a bound that is infinite", { mode: "tolerance", abs: Infinity, rel: 0 }],
    ["statistical with no sigmas", { mode: "statistical" }],
    ["statistical with zero sigmas", { mode: "statistical", sigmas: 0 }],
    ["statistical with too many sigmas", { mode: "statistical", sigmas: 11 }],
    ["statistical with sigmas that are not a number", { mode: "statistical", sigmas: NaN }],
  ])("refuses a policy with %s", (_n, policy) => {
    const r = compareReplay({ original: run("a"), replay: run("b"), policy: policy as ReplayPolicy });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/policy" });
  });

  it.each([
    ["a run with no id", { runId: "" }],
    ["a run with no adapter", { adapter: undefined }],
    ["a run with inputs that are not a list", { inputs: "x" }],
    ["a run with an input that has no hash", { inputs: [{ path: "a" }] }],
    ["a run whose quantities are not a list", { quantities: null }],
    ["a seed that is not a whole number", { seed: 1.5 }],
    ["a negative seed", { seed: -1 }],
  ])("refuses %s", (_n, over) => {
    expect(compareReplay({ original: run("a", scalar(1), over as Partial<ReplayRun>), replay: run("b"), policy: exact }).ok).toBe(false);
    expect(compareReplay({ original: run("a"), replay: run("b", scalar(1), over as Partial<ReplayRun>), policy: exact }).ok).toBe(false);
  });
});

describe("policy exact", () => {
  it("identical numbers reproduce, for a scalar, a series and a table", () => {
    expect(ok(compareReplay({ original: run("a", scalar(1.25, 0.1)), replay: run("b", scalar(1.25, 0.1)), policy: exact })).verdict).toBe("reproduced");
    expect(ok(compareReplay({ original: run("a", series([1, 2, 3])), replay: run("b", series([1, 2, 3])), policy: exact })).verdict).toBe("reproduced");
    const table = (v: number): QuantityData => ({ kind: "table", quantity: "t", unit: "W", columns: [{ name: "c", unit: "W", role: "value" }], rows: [[v], [2]] });
    expect(ok(compareReplay({ original: run("a", table(1)), replay: run("b", table(1)), policy: exact })).verdict).toBe("reproduced");
  });

  it("one unit in the last place is a difference", () => {
    const r = ok(compareReplay({ original: run("a", scalar(1)), replay: run("b", scalar(1 + Number.EPSILON)), policy: exact }));
    expect(r.verdict).toBe("differs");
    expect(r.quantities[0]).toMatchObject({ verdict: "differs", maxAbsDiff: Number.EPSILON });
    expect(r.differences).toEqual([{ kind: "value", field: "k", detail: "the numbers are not identical", original: undefined, replay: undefined }]);
  });

  it("the same values with a different declared uncertainty are not identical", () => {
    expect(ok(compareReplay({ original: run("a", scalar(1, 0.1)), replay: run("b", scalar(1, 0.2)), policy: exact })).verdict).toBe("differs");
  });

  it("one changed point of a series, and one changed table cell, are found", () => {
    expect(ok(compareReplay({ original: run("a", series([1, 2, 3])), replay: run("b", series([1, 2, 3.5])), policy: exact })).quantities[0]).toMatchObject({ verdict: "differs", maxAbsDiff: 0.5, points: 3 });
    const t = (s: string): QuantityData => ({ kind: "table", quantity: "t", unit: "W", columns: [{ name: "n", unit: "1", role: "label" }], rows: [[s]] });
    expect(ok(compareReplay({ original: run("a", t("x")), replay: run("b", t("y")), policy: exact })).verdict).toBe("differs");
  });
});

describe("policy tolerance", () => {
  it("a difference inside the absolute or the relative bound is within tolerance, and never called identical", () => {
    const r = ok(compareReplay({ original: run("a", scalar(1)), replay: run("b", scalar(1 + 5e-7)), policy: tol }));
    expect(r.verdict).toBe("reproduced-within-tolerance");
    expect(ok(compareReplay({ original: run("a", scalar(1000)), replay: run("b", scalar(1000.05)), policy: tol })).verdict).toBe("reproduced-within-tolerance");
  });

  it("a difference outside both bounds differs, and the largest differences are reported", () => {
    const r = ok(compareReplay({ original: run("a", series([1, 100, 3])), replay: run("b", series([1, 100.5, 3])), policy: tol }));
    expect(r.verdict).toBe("differs");
    expect(r.quantities[0]!.maxAbsDiff).toBeCloseTo(0.5, 12);
    expect(r.quantities[0]!.maxRelDiff).toBeCloseTo(0.5 / 100.5, 12);
    expect(r.quantities[0]!.reason).toMatch(/outside the tolerance/);
  });

  it("identical numbers are reproduced even under a tolerance", () => {
    expect(ok(compareReplay({ original: run("a", scalar(2)), replay: run("b", scalar(2)), policy: tol })).verdict).toBe("reproduced");
  });

  it("the bound is the sum of the absolute part and the relative part of the larger value", () => {
    const p: ReplayPolicy = { mode: "tolerance", abs: 0.1, rel: 0.1 };
    // allowed difference between 10 and 11 is 0.1 + 0.1 * 11 = 1.2
    expect(ok(compareReplay({ original: run("a", scalar(10)), replay: run("b", scalar(11)), policy: p })).verdict).toBe("reproduced-within-tolerance");
    expect(ok(compareReplay({ original: run("a", scalar(10)), replay: run("b", scalar(11.3)), policy: p })).verdict).toBe("differs");
  });
});

describe("policy statistical", () => {
  it("values within the combined sigmas are within tolerance, outside differ, and the worst point is named", () => {
    const within = ok(compareReplay({ original: run("a", scalar(1, 0.01)), replay: run("b", scalar(1.02, 0.01)), policy: stat }));
    expect(within.verdict).toBe("reproduced-within-tolerance");
    expect(within.quantities[0]!.worstSigmas).toBeCloseTo(0.02 / Math.sqrt(2e-4), 9);
    const s = ok(compareReplay({ original: run("a", series([1, 1, 1], [0.01, 0.01, 0.01])), replay: run("b", series([1, 1, 1.1], [0.01, 0.01, 0.01])), policy: stat }));
    expect(s.verdict).toBe("differs");
    expect(s.quantities[0]).toMatchObject({ worstIndex: 2 });
    expect(s.quantities[0]!.worstSigmas).toBeGreaterThan(3);
  });

  it("the number of sigmas is the policy's, not a fixed three", () => {
    const a = run("a", scalar(1, 0.01)), b = run("b", scalar(1.04, 0.01)); // 2.83 combined sigmas
    expect(ok(compareReplay({ original: a, replay: b, policy: { mode: "statistical", sigmas: 3 } })).verdict).toBe("reproduced-within-tolerance");
    expect(ok(compareReplay({ original: a, replay: b, policy: { mode: "statistical", sigmas: 2 } })).verdict).toBe("differs");
  });

  it("an uncertainty is never invented: a run without one is not comparable", () => {
    expect(ok(compareReplay({ original: run("a", scalar(1, 0.01)), replay: run("b", scalar(1)), policy: stat })).quantities[0]).toMatchObject({ verdict: "not-comparable", code: "no-uncertainty" });
    expect(ok(compareReplay({ original: run("a", series([1, 2])), replay: run("b", series([1, 2], [0.1, 0.1])), policy: stat })).quantities[0]).toMatchObject({ code: "no-uncertainty" });
    expect(ok(compareReplay({ original: run("a", series([1, 2], [0.1, 0.1])), replay: run("b", series([1, 2], [0.1])), policy: stat })).quantities[0]).toMatchObject({ code: "no-uncertainty" });
  });

  it("identical values and uncertainties reproduce; a difference with no spread at all differs", () => {
    expect(ok(compareReplay({ original: run("a", scalar(1, 0.01)), replay: run("b", scalar(1, 0.01)), policy: stat })).verdict).toBe("reproduced");
    expect(ok(compareReplay({ original: run("a", scalar(1, 0)), replay: run("b", scalar(1.0001, 0)), policy: stat })).verdict).toBe("differs");
  });

  it("a series or a table with no points is not 'reproduced': nothing was compared", () => {
    const emptyTable: QuantityData = { kind: "table", quantity: "t", unit: "W", columns: [{ name: "c", unit: "W", role: "value" }], rows: [] };
    expect(ok(compareReplay({ original: run("a", emptyTable), replay: run("b", emptyTable), policy: exact })).quantities[0]).toMatchObject({ verdict: "not-comparable", code: "shape-mismatch" });
    expect(ok(compareReplay({ original: run("a", emptyTable), replay: run("b", emptyTable), policy: exact })).verdict).toBe("not-comparable");
    const emptySeries = series([]);
    expect(ok(compareReplay({ original: run("a", emptySeries), replay: run("b", emptySeries), policy: tol })).verdict).toBe("not-comparable");
  });

  it("a table is compared statistically by the std column of each value column; a table with none is not comparable", () => {
    const cols = [{ name: "c", unit: "W", role: "value" as const }, { name: "s", unit: "W", role: "std" as const, of: "c" }];
    const t = (v: number, s: number): QuantityData => ({ kind: "table", quantity: "t", unit: "W", columns: cols, rows: [[v, s], [10, 1]] });
    // 1.0 against 2.0 with deviations 0.5 and 0.5: 1.41 sigmas, inside 3
    expect(ok(compareReplay({ original: run("a", t(1, 0.5)), replay: run("b", t(2, 0.5)), policy: stat })).quantities[0]).toMatchObject({ verdict: "reproduced-within-tolerance" });
    // 1.0 against 5.0: 5.6 sigmas
    const far = ok(compareReplay({ original: run("a", t(1, 0.5)), replay: run("b", t(5, 0.5)), policy: stat }));
    expect(far.quantities[0]).toMatchObject({ verdict: "differs" });
    expect(far.quantities[0]!.worstSigmas).toBeGreaterThan(5);
    const bare: QuantityData = { kind: "table", quantity: "t", unit: "W", columns: [{ name: "c", unit: "W", role: "value" }], rows: [[1]] };
    expect(ok(compareReplay({ original: run("a", bare), replay: run("b", bare), policy: stat })).quantities[0]).toMatchObject({ verdict: "not-comparable", code: "no-uncertainty" });
  });
});

describe("quantities that do not match up", () => {
  it("a quantity in only one run is a difference", () => {
    const b = run("b", scalar(1));
    b.quantities.push({ name: "extra", unit: "1", normalization: "per-run", data: { ...scalar(2), quantity: "extra" } });
    const r = ok(compareReplay({ original: run("a"), replay: b, policy: exact }));
    expect(r.verdict).toBe("differs");
    expect(r.differences).toEqual([{ kind: "quantity", field: "extra", original: "absent", replay: "present", detail: "only the replay has this quantity" }]);
    const r2 = ok(compareReplay({ original: b, replay: run("a2"), policy: exact }));
    expect(r2.differences[0]).toMatchObject({ field: "extra", original: "present", replay: "absent" });
  });

  it("a different unit or normalization, a different kind, or a different grid is not comparable, with the reason", () => {
    const u = ok(compareReplay({ original: run("a", scalar(1, undefined, "1")), replay: run("b", scalar(1, undefined, "pcm")), policy: exact }));
    expect(u.quantities[0]).toMatchObject({ verdict: "not-comparable", code: "unit-mismatch" });
    const n = run("b"); n.quantities[0]!.normalization = "per-source";
    expect(ok(compareReplay({ original: run("a"), replay: n, policy: exact })).quantities[0]).toMatchObject({ code: "normalization-mismatch" });
    const sc = scalar(1), se = { ...series([1]), quantity: "k", unit: "1" } as QuantityData;
    expect(ok(compareReplay({ original: run("a", sc), replay: run("b", se), policy: exact })).quantities[0]).toMatchObject({ code: "kind-mismatch" });
    expect(ok(compareReplay({ original: run("a", series([1, 2, 3])), replay: run("b", series([1, 2, 3], undefined, [0, 1, 2.5])), policy: exact })).quantities[0]).toMatchObject({ code: "grid-mismatch" });
    expect(ok(compareReplay({ original: run("a", series([1, 2, 3])), replay: run("b", series([1, 2])), policy: exact })).quantities[0]).toMatchObject({ code: "grid-mismatch" });
  });

  it("a table with other columns or rows is not comparable", () => {
    const t = (rows: number[][]): QuantityData => ({ kind: "table", quantity: "t", unit: "W", columns: [{ name: "c", unit: "W", role: "value" }], rows });
    expect(ok(compareReplay({ original: run("a", t([[1]])), replay: run("b", t([[1], [2]])), policy: exact })).quantities[0]).toMatchObject({ code: "shape-mismatch" });
  });
});

describe("the verdict of the whole replay is the worst quantity's", () => {
  const two = (a1: QuantityData, a2: QuantityData): ReplayRun => ({ ...run("x"), quantities: [{ name: "k", unit: "1", normalization: "per-run", data: a1 }, { name: "p", unit: "W", normalization: "per-run", data: a2 }] });
  const verdictOf = (o: ReplayRun, r: ReplayRun, policy: ReplayPolicy = tol) => ok(compareReplay({ original: { ...o, runId: "a" }, replay: { ...r, runId: "b" }, policy })).verdict;

  it("differs beats not-comparable beats within tolerance beats reproduced", () => {
    const base = two(scalar(1), series([1, 2]));
    expect(verdictOf(base, two(scalar(1), series([1, 2])))).toBe("reproduced");
    expect(verdictOf(base, two(scalar(1 + 1e-9), series([1, 2])))).toBe("reproduced-within-tolerance");
    const gridOff = two(scalar(1), series([1, 2], undefined, [0, 5]));
    expect(verdictOf(base, gridOff)).toBe("not-comparable");
    expect(verdictOf(base, two(scalar(1 + 1e-9), series([1, 2], undefined, [0, 5])))).toBe("not-comparable");
    expect(verdictOf(base, two(scalar(2), gridOff.quantities[1]!.data))).toBe("differs");
  });

  it("a replay with no quantities at all says so", () => {
    const r = ok(compareReplay({ original: { ...run("a"), quantities: [] }, replay: { ...run("b"), quantities: [] }, policy: exact }));
    expect(r.verdict).toBe("reproduced");
    expect(r.notes.join(" ")).toMatch(/no quantities/);
  });
});

describe("what the function does not do", () => {
  it("does not change what it was given", () => {
    const o = run("a", series([1, 2, 3], [0.1, 0.1, 0.1])), r = run("b", series([1, 2, 3.01], [0.1, 0.1, 0.1]));
    const before = JSON.stringify([o, r]);
    compareReplay({ original: o, replay: r, policy: stat });
    expect(JSON.stringify([o, r])).toBe(before);
  });

  it("gives the same answer for the same input", () => {
    const o = run("a", scalar(1)), r = run("b", scalar(1.00001));
    expect(JSON.stringify(compareReplay({ original: o, replay: r, policy: tol }))).toBe(JSON.stringify(compareReplay({ original: o, replay: r, policy: tol })));
  });
});

describe("the Markdown", () => {
  it("writes the verdict, the differences and the quantities, and escapes text that comes from runs", () => {
    const hostile = "x|**y**\n# head <b>";
    const r = ok(compareReplay({ original: run("a"), replay: run("b", scalar(1), { seed: 9, adapter: { id: "raft", version: hostile } }), policy: exact }));
    const md = replayMarkdown(r);
    expect(md).toContain("**not-comparable**");
    expect(md).toContain("| adapter.version |");
    expect(md).not.toContain(hostile);
    expect(md).toContain("x\\|\\*\\*y\\*\\* \\# head \\<b\\>".replace("\\#", "#"));
    expect(md.split("\n").filter((l) => l.startsWith("| adapter.version")).length).toBe(1);
    const q = ok(compareReplay({ original: run("a", scalar(1)), replay: run("b", scalar(1.5)), policy: exact }));
    const md2 = replayMarkdown(q);
    expect(md2).toContain("| k | 1 | differs | 0.500000 |");
  });
});
