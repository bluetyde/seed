import { describe, expect, it } from "vitest";
import { compareQuantity, comparisonMarkdown, type CompareOk, type CompareQuantityEntry, type CompareRun } from "../src/core/compare";
import type { QuantityData } from "../src/core/quantityData";

// Plan 07 "Comparison" and its tests: refuses mismatched units, normalization and time grids; failed, cancelled, trip-terminated and stale
// runs stay in the table, marked; normalization and uncertainty on every row; the three kinds of variation kept apart.
const Q = "t_peak";
const entry = (over: Partial<CompareQuantityEntry> = {}): CompareQuantityEntry => ({ name: Q, unit: "K", normalization: "none", verification: "verified", ...over });
const scalar = (value: number, unit = "K", std?: number): QuantityData => ({ kind: "scalar", quantity: Q, unit, value, ...(std !== undefined ? { std } : {}) });
const series = (x: number[], values: number[], unit = "K", axisUnit = "s", axisName = "time", std?: number[]): QuantityData => ({
  kind: "series", quantity: Q, unit, axis: { name: axisName, unit: axisUnit }, x, values, ...(std !== undefined ? { std } : {}),
});
const run = (runId: string, data: QuantityData | undefined, e: CompareQuantityEntry | undefined = entry(), over: Partial<CompareRun> = {}): CompareRun => ({
  runId, state: "completed", ...(e !== undefined ? { quantities: [e] } : {}), ...(data !== undefined ? { data } : {}), ...over,
});
const ok = (r: ReturnType<typeof compareQuantity>): CompareOk => {
  if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.errors));
  return r;
};
const row = (r: CompareOk, id: string) => r.rows.find((x) => x.runId === id)!;

describe("scalars: compatible runs are compared", () => {
  it("same unit, same normalization: both used, difference from the reference, spread", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(600)), run("b", scalar(630))] }));
    expect(r.kind).toBe("scalar");
    expect(r.reference).toEqual({ runId: "a", unit: "K", normalization: "none" });
    expect(row(r, "a")).toMatchObject({ mark: "ok", used: true, value: 600 });
    expect(row(r, "b")).toMatchObject({ mark: "ok", used: true, value: 630, difference: { absolute: 30, relative: 0.05 } });
    expect(r.variation).toMatchObject({ compared: 2, spread: { min: 600, max: 630, range: 30 } });
  });

  it("a relative difference from a zero reference is null, not infinity", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(0)), run("b", scalar(5))] }));
    expect(row(r, "b").difference).toEqual({ absolute: 5, relative: null });
  });

  it("units are converted into the reference unit: kW against W, and degC against K with the offset", () => {
    const kw = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1500, "W"), entry({ unit: "W" })), run("b", scalar(2, "kW"), entry({ unit: "kW" }))] }));
    expect(row(kw, "b")).toMatchObject({ used: true, value: 2000, unit: "W", difference: { absolute: 500 } });
    const t = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(300, "K")), run("b", scalar(30, "degC"), entry({ unit: "degC" }))] }));
    expect(row(t, "b").value).toBeCloseTo(303.15, 9);
    const back = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(30, "degC"), entry({ unit: "degC" })), run("b", scalar(303.15, "K"))] }));
    expect(row(back, "b").value).toBeCloseTo(30, 9);
    expect(row(back, "b").difference).toMatchObject({ absolute: expect.closeTo(0, 9) });
  });

  it("the input is not changed", () => {
    const runs = [run("a", scalar(1)), run("b", scalar(2, "kK"), entry({ unit: "kK" }))];
    const before = JSON.stringify(runs);
    compareQuantity({ quantity: Q, runs });
    expect(JSON.stringify(runs)).toBe(before);
  });

  it("rows keep the order of the request, and the reference can be named", () => {
    const runs = [run("a", scalar(1)), run("b", scalar(2)), run("c", scalar(4))];
    const r = ok(compareQuantity({ quantity: Q, runs, reference: "c" }));
    expect(r.rows.map((x) => x.runId)).toEqual(["a", "b", "c"]);
    expect(r.reference.runId).toBe("c");
    expect(row(r, "a").difference).toMatchObject({ absolute: -3 });
  });
});

describe("scalars: incompatible runs are refused with the reason, and stay in the table", () => {
  const refused = (other: CompareRun, ref = run("a", scalar(600))) => {
    const r = ok(compareQuantity({ quantity: Q, runs: [ref, other] }));
    const b = row(r, other.runId);
    expect(b.used).toBe(false);
    expect(b.mark).toBe("refused");
    expect(r.rows).toHaveLength(2);
    return b;
  };

  it("another normalization", () => {
    const b = refused(run("b", scalar(1), entry({ normalization: "per-source-particle" })));
    expect(b.refusal?.code).toBe("normalization-mismatch");
    expect(b.reason).toContain("per-source-particle");
    expect(b.normalization).toBe("per-source-particle");
  });

  it("another kind of quantity (K against Pa)", () => {
    expect(refused(run("b", scalar(1e5, "Pa"), entry({ unit: "Pa" }))).refusal?.code).toBe("unit-mismatch");
  });

  it("a unit that cannot be read", () => {
    const b = refused(run("b", scalar(1, "furlongs"), entry({ unit: "furlongs" })));
    expect(b.refusal?.code).toBe("unit-mismatch");
    expect(b.reason).toContain("furlongs");
  });

  it("another declared dimension, even when the units look alike", () => {
    const b = refused(run("b", scalar(1), entry({ dimension: "frequency" })), run("a", scalar(1), entry({ dimension: "temperature" })));
    expect(b.refusal?.code).toBe("dimension-mismatch");
  });

  it("data in another unit than its results index says", () => {
    expect(refused(run("b", scalar(1, "kK"), entry({ unit: "K" }))).refusal?.code).toBe("data-mismatch");
  });

  it("a series against a scalar", () => {
    expect(refused(run("b", series([0, 1], [1, 2]))).refusal?.code).toBe("kind-mismatch");
  });

  it("a table", () => {
    const table: QuantityData = { kind: "table", quantity: Q, unit: "K", columns: [{ name: "v", unit: "K", role: "value" }], rows: [[1]] };
    expect(refused(run("b", table)).refusal?.code).toBe("table-unsupported");
  });

  it("another coordinate system, or one run declaring it and the other not", () => {
    const sys = (s: string) => entry({ coordinates: { system: s, axes: [{ name: "x", unit: "cm" }] } });
    expect(refused(run("b", scalar(1), sys("openmc-model")), run("a", scalar(1), sys("pin-local"))).refusal?.code).toBe("domain-mismatch");
    expect(refused(run("b", scalar(1), sys("pin-local")), run("a", scalar(1))).refusal?.code).toBe("domain-mismatch");
    expect(refused(run("b", scalar(1)), run("a", scalar(1), sys("pin-local"))).refusal?.code).toBe("domain-mismatch");
  });

  it("the same coordinate system is compatible", () => {
    const sys = entry({ coordinates: { system: "pin-local", axes: [{ name: "z", unit: "cm" }] } });
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1), sys), run("b", scalar(2), sys)] }));
    expect(row(r, "b").used).toBe(true);
  });
});

describe("runs that are not comparable stay in the table, marked", () => {
  const base = run("a", scalar(600));

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
    ["terminated-by-trip", "trip"],
    ["queued", "queued"],
    ["running", "running"],
  ])("a %s run is listed as %s with no value and is not used", (state, mark) => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, { runId: "x", state, native: { status: "scram" } }] }));
    expect(row(r, "x")).toMatchObject({ mark, used: false, state, native: { status: "scram" } });
    expect(row(r, "x").value).toBeUndefined();
    expect(row(r, "x").reason).toBeTruthy();
    expect(r.variation.compared).toBe(1);
  });

  it("a trip is described as not a completed run of the intended experiment", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, { runId: "x", state: "terminated-by-trip" }] }));
    expect(row(r, "x").reason).toContain("trip");
  });

  it("a stale run shows its value, labelled, and is not used", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("old", scalar(700), entry(), { stale: true })] }));
    expect(row(r, "old")).toMatchObject({ mark: "stale", used: false, value: 700, unit: "K" });
    expect(row(r, "old").reason).toContain("stale");
    expect(row(r, "old").difference).toBeUndefined();
    expect(r.variation.spread).toMatchObject({ min: 600, max: 600 });
  });

  it("a stale run is never the default reference", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("old", scalar(700), entry(), { stale: true }), base] }));
    expect(r.reference.runId).toBe("a");
  });

  it("a completed run without this quantity, or without its data, is marked and named", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("n", scalar(1), entry({ name: "other" })), run("d", undefined)] }));
    expect(row(r, "n")).toMatchObject({ mark: "no-quantity", used: false });
    expect(row(r, "n").reason).toContain(Q);
    expect(row(r, "d")).toMatchObject({ mark: "no-quantity", used: false });
    expect(row(r, "d").reason).toContain("data");
  });

  it("an unknown state is marked, not silently compared", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, { runId: "x", state: "weird" }] }));
    expect(row(r, "x")).toMatchObject({ mark: "failed", used: false });
    expect(row(r, "x").reason).toContain("weird");
  });

  it("the default reference skips runs that cannot be compared", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [{ runId: "f", state: "failed" }, base] }));
    expect(r.reference.runId).toBe("a");
  });
});

describe("when there is nothing to compare", () => {
  it("no comparable run: a typed error, not an empty table", () => {
    const r = compareQuantity({ quantity: Q, runs: [{ runId: "f", state: "failed" }] });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_PROP_MISSING", field: "/runs" }] });
  });

  it("a named reference that cannot be compared", () => {
    const r = compareQuantity({ quantity: Q, runs: [run("a", scalar(1)), { runId: "f", state: "failed" }], reference: "f" });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_PROP_MISSING", field: "/reference" }] });
    expect(compareQuantity({ quantity: Q, runs: [run("a", scalar(1))], reference: "nope" })).toMatchObject({ ok: false });
  });

  it("a table as the reference", () => {
    const table: QuantityData = { kind: "table", quantity: Q, unit: "K", columns: [{ name: "v", unit: "K", role: "value" }], rows: [[1]] };
    expect(compareQuantity({ quantity: Q, runs: [run("a", table)] })).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
  });

  it("bad requests", () => {
    expect(compareQuantity({ quantity: "", runs: [run("a", scalar(1))] })).toMatchObject({ ok: false, errors: [{ field: "/quantity" }] });
    expect(compareQuantity({ quantity: Q, runs: [] })).toMatchObject({ ok: false, errors: [{ field: "/runs" }] });
    expect(compareQuantity({ quantity: Q, runs: [run("a", scalar(1)), run("a", scalar(2))] })).toMatchObject({ ok: false, errors: [{ field: "/runs/1/runId" }] });
  });

  it("a single comparable run is shown with a note that there is no spread", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1))] }));
    expect(r.variation).toMatchObject({ compared: 1, spread: { range: 0 } });
    expect(r.notes.join(" ")).toContain("only one run");
  });
});

describe("uncertainty is shown where declared, never invented, and the kinds stay apart", () => {
  it("none declared: the rows say nothing and a note says none is assumed", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1)), run("b", scalar(2))] }));
    expect(row(r, "a").uncertainty).toEqual([]);
    expect(r.variation.uncertainty).toEqual({ statistical: null, input: null, model: null });
    expect(r.notes.join(" ")).toContain("none is assumed");
  });

  it("a scalar's std is statistical, and two of them give a difference in sigmas", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(100, "K", 3)), run("b", scalar(110, "K", 4))] }));
    expect(row(r, "b").uncertainty).toEqual([{ kind: "statistical", value: 4, unit: "K" }]);
    expect(row(r, "b").difference).toMatchObject({ absolute: 10, sigmas: 2 }); // 10 / sqrt(3^2 + 4^2)
    expect(r.variation.uncertainty.statistical).toBe(4);
    expect(r.notes.join(" ")).toContain("Monte Carlo sampling noise");
  });

  it("no sigmas when only one side has a statistical uncertainty", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(100)), run("b", scalar(110, "K", 4))] }));
    expect((row(r, "b").difference as { sigmas?: number }).sigmas).toBeUndefined();
  });

  it("input and model uncertainty come from the index entry and are not added to the statistical one", () => {
    const r = ok(
      compareQuantity({
        quantity: Q,
        runs: [
          run("a", scalar(100, "K", 2), entry({ uncertainty: { kind: "input", value: 5 } })),
          run("b", scalar(104, "K", 1), entry({ uncertainty: { kind: "model", value: 7, unit: "K" } })),
        ],
      })
    );
    expect(row(r, "a").uncertainty.map((u) => [u.kind, u.value])).toEqual([["statistical", 2], ["input", 5]]);
    expect(row(r, "b").uncertainty.map((u) => [u.kind, u.value])).toEqual([["statistical", 1], ["model", 7]]);
    expect(r.variation.uncertainty).toEqual({ statistical: 2, input: 5, model: 7 });
  });

  it("an uncertainty is converted with the values (a std in kW against a reference in W) and never gets the temperature offset", () => {
    const w = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1000, "W"), entry({ unit: "W" })), run("b", scalar(2, "kW", 0.5), entry({ unit: "kW" }))] }));
    expect(row(w, "b").uncertainty).toEqual([{ kind: "statistical", value: 500, unit: "W" }]);
    const t = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(300)), run("b", scalar(30, "degC", 2), entry({ unit: "degC" }))] }));
    expect(row(t, "b").uncertainty[0]!.value).toBeCloseTo(2, 9);
  });

  it("a refused run keeps no uncertainty in the comparison", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", scalar(1, "K", 1)), run("b", scalar(1, "K", 9), entry({ normalization: "per-hour" }))] }));
    expect(row(r, "b").uncertainty).toEqual([]);
    expect(r.variation.uncertainty.statistical).toBe(1);
  });
});

describe("series: the grid has to match", () => {
  const t = [0, 1, 2, 3];
  const base = run("a", series(t, [300, 310, 320, 330]));

  it("the same grid: differences point by point", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("b", series(t, [300, 312, 320, 336]))] }));
    expect(r.kind).toBe("series");
    expect(row(r, "b").used).toBe(true);
    expect(row(r, "b").difference).toMatchObject({ maxAbsolute: 6, rms: expect.closeTo(Math.sqrt((4 + 36) / 4), 9) });
    expect((row(r, "b").difference as { maxRelative: number }).maxRelative).toBeCloseTo(6 / 330, 9);
    expect(r.variation.spread).toEqual({ min: 300, max: 336, range: 6 });
  });

  it("an axis in other units of the same kind is converted before the grids are compared (ms against s)", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("b", series([0, 1000, 2000, 3000], [300, 310, 320, 330], "K", "ms"))] }));
    expect(row(r, "b").used).toBe(true);
    expect(row(r, "b").series!.x).toEqual(t);
  });

  it("values in other units are converted (degC against K)", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("b", series(t, [26.85, 36.85, 46.85, 56.85], "degC"), entry({ unit: "degC" }))] }));
    expect(row(r, "b").series!.y[0]).toBeCloseTo(300, 9);
    expect((row(r, "b").difference as { maxAbsolute: number }).maxAbsolute).toBeCloseTo(0, 9);
  });

  it("a different number of points is refused with both counts", () => {
    const b = row(ok(compareQuantity({ quantity: Q, runs: [base, run("b", series([0, 1, 2], [1, 2, 3]))] })), "b");
    expect(b.refusal?.code).toBe("grid-mismatch");
    expect(b.reason).toContain("3 points");
    expect(b.reason).toContain("4");
  });

  it("the same number of points on another grid is refused and names the first difference", () => {
    const b = row(ok(compareQuantity({ quantity: Q, runs: [base, run("b", series([0, 1, 2.5, 3], [1, 2, 3, 4]))] })), "b");
    expect(b.refusal?.code).toBe("grid-mismatch");
    expect(b.reason).toContain("point 2");
  });

  it("a small relative difference in the grid is accepted within the tolerance, and refused without it", () => {
    const nearly = run("b", series([0, 1, 2, 3.0000001], [300, 310, 320, 330]));
    expect(row(ok(compareQuantity({ quantity: Q, runs: [base, nearly] })), "b").refusal?.code).toBe("grid-mismatch");
    expect(row(ok(compareQuantity({ quantity: Q, runs: [base, nearly], gridTolerance: 1e-6 })), "b").used).toBe(true);
  });

  it("another axis (name or kind of unit) is refused", () => {
    expect(row(ok(compareQuantity({ quantity: Q, runs: [base, run("b", series(t, [1, 2, 3, 4], "K", "s", "depth"))] })), "b").refusal?.code).toBe("axis-mismatch");
    expect(row(ok(compareQuantity({ quantity: Q, runs: [base, run("b", series(t, [1, 2, 3, 4], "K", "cm"))] })), "b").refusal?.code).toBe("axis-mismatch");
  });

  it("the statistical uncertainty of a series is its largest std", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [run("a", series(t, [1, 2, 3, 4], "K", "s", "time", [0.1, 0.5, 0.2, 0.3])), run("b", series(t, [1, 2, 3, 4]))] }));
    expect(row(r, "a").uncertainty).toEqual([{ kind: "statistical", value: 0.5, unit: "K" }]);
  });

  it("a zero reference point is left out of the relative difference, and all-zero gives null", () => {
    const z = run("z", series(t, [0, 0, 0, 0]));
    const r = ok(compareQuantity({ quantity: Q, runs: [z, run("b", series(t, [1, 2, 3, 4]))] }));
    expect((row(r, "b").difference as { maxRelative: number | null }).maxRelative).toBeNull();
  });

  it("a stale series is shown and not used", () => {
    const r = ok(compareQuantity({ quantity: Q, runs: [base, run("old", series(t, [9, 9, 9, 9]), entry(), { stale: true })] }));
    expect(row(r, "old")).toMatchObject({ mark: "stale", used: false });
    expect(row(r, "old").series!.y).toEqual([9, 9, 9, 9]);
  });
});

describe("the Markdown table", () => {
  const md = (runs: CompareRun[]) => comparisonMarkdown(ok(compareQuantity({ quantity: Q, runs })));

  it("lists every run with its mark, normalization and uncertainty, and the reason for what was left out", () => {
    const text = md([
      run("a", scalar(100, "K", 3), entry({ normalization: "per-second" })),
      run("b", scalar(110, "K", 4), entry({ normalization: "per-second" })),
      { runId: "f", state: "failed" },
      { runId: "t", state: "terminated-by-trip" },
      run("old", scalar(1), entry({ normalization: "per-second" }), { stale: true }),
      run("c", scalar(5), entry({ normalization: "none" })),
    ]);
    for (const needle of ["| a |", "| b |", "| f |", "| t |", "| old |", "| c |", "FAILED", "TRIP", "STALE", "REFUSED", "compared", "per\\-second", "statistical 3 K", "none declared", "sigma"]) {
      expect(text).toContain(needle);
    }
    expect(text.split("\n").filter((l) => l.startsWith("| ")).length).toBe(1 + 6); // header and six runs
  });

  it("text from the runs cannot break the table or start a heading", () => {
    const text = md([run("a|b\n# head", scalar(1)), run("c", scalar(2), entry({ normalization: "none" }), { native: { status: "x|y" } })]);
    const lines = text.split("\n");
    expect(lines.some((l) => l.startsWith("# "))).toBe(false);
    for (const l of lines.filter((x) => x.startsWith("| a"))) {
      expect(l.match(/(?<!\\)\|/g)!.length).toBe(11); // 10 cells
    }
  });

  it("numbers are not mangled by the escaping", () => {
    const text = md([run("a", scalar(1.5)), run("b", scalar(2.5))]);
    expect(text).toContain("| 1.5 |");
    expect(text).toContain("| 2.5 |");
  });
});
