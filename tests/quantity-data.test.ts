import { describe, expect, it } from "vitest";
import { readQuantityData, type IndexEntryView } from "../src/core/quantityData";
import { checkResultsAgainstRecord } from "../src/core/semantic";
import { validate } from "../src/core/validate";

const entry = (name: string, unit: string, extra: Partial<IndexEntryView> = {}): IndexEntryView => ({ name, unit, ...extra });
const timeAxis = { system: "time", axes: [{ name: "t", unit: "s" }] };
const ok = (r: ReturnType<typeof readQuantityData>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const fails = (r: ReturnType<typeof readQuantityData>, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors[0]!.code).toBe(code);
    if (field !== undefined) expect(r.errors[0]!.field).toBe(field);
  }
};

const v2 = (o: object) => ({ schema: "seed.quantity-data/0.2", ...o });

describe("v0.2 files", () => {
  it("reads a scalar, a series and a table", () => {
    const s = ok(readQuantityData(v2({ quantity: "p", kind: "scalar", unit: "1", value: 0.25, std: 0.01 }), entry("p", "1")));
    expect(s.data).toMatchObject({ kind: "scalar", value: 0.25, std: 0.01 });
    expect(s.converted).toBe(false);
    const ser = ok(readQuantityData(v2({ quantity: "T", kind: "series", unit: "K", axis: { name: "t", unit: "s" }, x: [0, 1, 2], values: [300, 310, 320], min: [299, 309, 319], max: [301, 311, 321] }), entry("T", "K")));
    expect(ser.data.kind).toBe("series");
    const tab = ok(readQuantityData(v2({ quantity: "h", kind: "table", unit: "eV", columns: [{ name: "cell", unit: "1", role: "label" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }], rows: [["fuel", 1.5, 0.1], [["a", "b"], 2, 0]] }), entry("h", "eV")));
    expect(tab.data.kind).toBe("table");
  });

  it("refuses what the schema or the cross-field rules forbid", () => {
    const series = (o: object) => v2({ quantity: "T", kind: "series", unit: "K", axis: { name: "t", unit: "s" }, x: [0, 1], values: [1, 2], ...o });
    fails(readQuantityData(v2({ quantity: "p", kind: "volume", unit: "1" }), entry("p", "1")), "E_SCHEMA_INVALID");
    fails(readQuantityData(v2({ quantity: "p", kind: "scalar", unit: "1", value: "3" }), entry("p", "1")), "E_SCHEMA_INVALID");
    fails(readQuantityData(v2({ quantity: "p", kind: "scalar", unit: "1", value: 1, extra: 1 }), entry("p", "1")), "E_SCHEMA_INVALID");
    fails(readQuantityData(v2({ quantity: "p", kind: "scalar", unit: "1", value: 1, std: -1 }), entry("p", "1")), "E_SCHEMA_INVALID");
    fails(readQuantityData(series({ values: [1] }), entry("T", "K")), "E_SCHEMA_INVALID", "/values");
    fails(readQuantityData(series({ x: [0, 0] }), entry("T", "K")), "E_SCHEMA_INVALID", "/x");
    fails(readQuantityData(series({ x: [1, 0] }), entry("T", "K")), "E_SCHEMA_INVALID", "/x");
    fails(readQuantityData(series({ std: [1] }), entry("T", "K")), "E_SCHEMA_INVALID", "/std");
    fails(readQuantityData(series({ min: [5, 5], max: [4, 6] }), entry("T", "K")), "E_SCHEMA_INVALID", "/min");
    fails(readQuantityData(series({ axis: { name: "t", unit: "furlong" } }), entry("T", "K")), "E_UNITS", "/axis/unit");
    fails(readQuantityData(JSON.stringify(series({})).slice(0, 20), entry("T", "K")), "E_SCHEMA_INVALID");
    fails(readQuantityData([1], entry("T", "K")), "E_SCHEMA_INVALID");
  });

  it("refuses table rows that do not fit their columns", () => {
    const cols = [{ name: "cell", unit: "1", role: "label" }, { name: "mean", unit: "eV", role: "value" }, { name: "std", unit: "eV", role: "std", of: "mean" }];
    const t = (o: object) => v2({ quantity: "h", kind: "table", unit: "eV", columns: cols, rows: [["a", 1, 0.1]], ...o });
    ok(readQuantityData(t({}), entry("h", "eV")));
    fails(readQuantityData(t({ rows: [["a", 1]] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/rows/0");
    fails(readQuantityData(t({ rows: [["a", "x", 0.1]] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/rows/0/1");
    fails(readQuantityData(t({ rows: [[3, 1, 0.1]] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/rows/0/0");
    fails(readQuantityData(t({ rows: [["a", 1, -0.1]] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/rows/0/2");
    fails(readQuantityData(t({ columns: [cols[0], cols[1], { ...cols[2], of: "nope" }] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/columns/2/of");
    fails(readQuantityData(t({ columns: [cols[0], { ...cols[1], of: "cell" }, cols[2]] }), entry("h", "eV")), "E_SCHEMA_INVALID", "/columns/1/of");
    fails(readQuantityData(t({ columns: [cols[0], cols[0], cols[2]] }), entry("h", "eV")), "E_SCHEMA_INVALID");
    fails(readQuantityData(t({ columns: [cols[0], { ...cols[1], unit: "furlong" }, cols[2]] }), entry("h", "eV")), "E_UNITS", "/columns/1/unit");
  });

  it("holds the file to the index entry's name, unit and dimension", () => {
    const f = v2({ quantity: "p", kind: "scalar", unit: "W", value: 1 });
    fails(readQuantityData(f, entry("other", "W")), "E_SCHEMA_INVALID", "/quantity");
    fails(readQuantityData(f, entry("p", "kW")), "E_UNITS", "/unit");
    ok(readQuantityData(f, entry("p", "W", { dimension: "power" })));
    fails(readQuantityData(f, entry("p", "W", { dimension: "power-per-length" })), "E_UNITS", "/unit");
    fails(readQuantityData(f, entry("p", "W", { dimension: "nonsense" })), "E_UNITS", "/dimension");
  });
});

describe("the five v0.1 shapes convert", () => {
  it("RAFT and NODAL series (with NODAL's envelope)", () => {
    const raft = ok(readQuantityData({ quantity: "power", unit: "W", t: [0, 1], values: [1, 2] }, entry("power", "W", { coordinates: timeAxis })));
    expect(raft.converted).toBe(true);
    expect(raft.data).toMatchObject({ kind: "series", axis: { name: "t", unit: "s" }, x: [0, 1], values: [1, 2] });
    const nodal = ok(readQuantityData({ quantity: "T", kind: "temperature", location: "core", unit: "K", t: [0, 1], values: [1, 2], min: [0, 1], max: [2, 3] }, entry("T", "K", { coordinates: timeAxis })));
    expect(nodal.data).toMatchObject({ kind: "series", min: [0, 1], max: [2, 3], meta: { kind: "temperature", location: "core" } });
  });

  it("FEED scalar, time series and radial profile", () => {
    const sc = ok(readQuantityData({ quantity: "temperature_peak", unit: "K", values: [812.5] }, entry("temperature_peak", "K")));
    expect(sc.data).toMatchObject({ kind: "scalar", value: 812.5 });
    const rad = ok(readQuantityData({ quantity: "profile", unit: "K", r: [0.001, 0.002], values: [900, 800], region: ["fuel", "fuel"], note: "cell-centre" }, entry("profile", "K", { coordinates: { system: "radial", axes: [{ name: "r", unit: "m" }] } })));
    expect(rad.data).toMatchObject({ kind: "series", axis: { name: "r", unit: "m" }, labels: ["fuel", "fuel"] });
    fails(readQuantityData({ quantity: "profile", unit: "K", values: [1, 2] }, entry("profile", "K")), "E_SCHEMA_INVALID");
  });

  it("OpenMC tally bins become a table with per-bin std", () => {
    const r = ok(readQuantityData({ quantity: "Ball:flux", tally: "Ball", score: "flux", unit: "cm", normalization: "per-source-particle", filters: ["cell"], bins: [{ labels: ["1"], mean: 4, std: 0 }, { labels: ["2"], mean: 3, std: 0.1 }] }, entry("Ball:flux", "cm")));
    expect(r.data).toMatchObject({ kind: "table", rows: [[["1"], 4, 0], [["2"], 3, 0.1]], meta: { tally: "Ball", score: "flux" } });
    if (r.data.kind === "table") expect(r.data.columns.map((c) => c.role)).toEqual(["label", "value", "std"]);
    fails(readQuantityData({ quantity: "x", unit: "cm", bins: [{ labels: ["1"], mean: 1, std: -1 }] }, entry("x", "cm")), "E_SCHEMA_INVALID");
  });

  it("PRA scalar and cut sets", () => {
    const sc = ok(readQuantityData({ quantity: "top_event_probability", method: "exact", unit: "1", value: 0.002 }, entry("top_event_probability", "1")));
    expect(sc.data).toMatchObject({ kind: "scalar", value: 0.002, meta: { method: "exact" } });
    const cs = ok(readQuantityData({ quantity: "minimal_cut_sets", unit: "1", cutSets: [{ events: ["a", "b"], probability: 0.1 }] }, entry("minimal_cut_sets", "1")));
    expect(cs.data).toMatchObject({ kind: "table", rows: [[["a", "b"], 0.1]] });
    fails(readQuantityData({ quantity: "minimal_cut_sets", unit: "1", cutSets: [{ events: ["a"] }] }, entry("minimal_cut_sets", "1")), "E_SCHEMA_INVALID");
  });

  it("refuses a v0.1 file whose name or unit differs from the index entry, and unknown shapes", () => {
    fails(readQuantityData({ quantity: "a", unit: "K", values: [1] }, entry("b", "K")), "E_SCHEMA_INVALID", "/quantity");
    fails(readQuantityData({ quantity: "a", unit: "K", values: [1] }, entry("a", "degC")), "E_UNITS", "/unit");
    fails(readQuantityData({ quantity: "a", unit: "K", values: [1, 2] }, entry("a", "K")), "E_SCHEMA_INVALID");
    fails(readQuantityData({ hello: 1 }, entry("a", "K")), "E_SCHEMA_INVALID");
  });
});

describe("results-index v0.2 and dimension", () => {
  const base = (schema: string, q: object) => ({
    schema, runId: "run-1", status: "completed", adapter: { id: "a", version: "1" }, engine: { name: "e", version: "1" },
    inputHashes: [{ path: "m.json", sha256: "a".repeat(64) }],
    nativeStatus: { status: "ok", detail: "ok" },
    quantities: [{ name: "q", unit: "W", normalization: "none", provenance: { runId: "run-1", inputRevisions: ["a".repeat(64)] }, data: { path: "d.json", sha256: "b".repeat(64) }, verification: "unverified", ...q }]
  });
  const rec = { inputs: [{ path: "m.json", sha256: "a".repeat(64) }] };

  it("accepts v0.1 without a dimension and v0.2 with one; refuses an unknown dimension", () => {
    expect(validate("results-index", base("seed.results-index/0.1", {})).ok).toBe(true);
    expect(validate("results-index", base("seed.results-index/0.2", { dimension: "power" })).ok).toBe(true);
    expect(validate("results-index", base("seed.results-index/0.2", { dimension: "wattage" })).ok).toBe(false);
    expect(validate("results-index", base("seed.results-index/0.3", {})).ok).toBe(false);
  });

  it("semantic check: a dimension needs v0.2 and a matching unit", () => {
    expect(checkResultsAgainstRecord(base("seed.results-index/0.2", { dimension: "power" }), rec)).toEqual([]);
    const v1 = checkResultsAgainstRecord(base("seed.results-index/0.1", { dimension: "power" }), rec);
    expect(v1[0]).toMatchObject({ code: "E_SCHEMA_VERSION", field: "/quantities/0/dimension" });
    const bad = checkResultsAgainstRecord(base("seed.results-index/0.2", { dimension: "power-per-volume" }), rec);
    expect(bad[0]).toMatchObject({ code: "E_UNITS", field: "/quantities/0/unit" });
  });
});
