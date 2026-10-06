import { describe, expect, it } from "vitest";
import { parseUnit, toSI, unitMismatch, DIMENSIONS, type Dimension } from "../src/core/units";

const mismatch = (u: string, d: Dimension) => unitMismatch(u, d);

describe("unit grammar", () => {
  it("reads products, quotients, powers, prefixes and counted things", () => {
    for (const u of ["1", "cm", "W/m^3", "eV", "keV", "reaction/particle", "MW/m", "degC", "mm", "mb", "event/hour", "kg/s", "Pa", "1/s"]) {
      expect(parseUnit(u).ok, u).toBe(true);
    }
  });

  it.each(["", "W/m/s", "furlong", "W m", "m^", "m^0", "xW", "kparticle", "mhour", "W*", "*W", "degC/s", "a".repeat(41)])("refuses %j", (u) => {
    expect(parseUnit(u).ok).toBe(false);
  });

  it("gets factors right", () => {
    expect(toSI(1, "cm", "length")).toBeCloseTo(0.01, 15);
    expect(toSI(1, "mm", "length")).toBeCloseTo(0.001, 15);
    expect(toSI(2, "MW", "power")).toBe(2e6);
    expect(toSI(1, "kW/m", "power-per-length")).toBe(1000);
    expect(toSI(1, "W/cm^3", "power-per-volume")).toBeCloseTo(1e6, 6);
    expect(toSI(1, "eV", "energy")).toBe(1.602176634e-19);
    expect(toSI(1, "hour", "time")).toBe(3600);
    expect(toSI(1, "kg/hour", "mass-flow")).toBeCloseTo(1 / 3600, 15);
    expect(() => toSI(1, "bar", "pressure")).toThrow();
  });

  it("converts Celsius with its offset, and only as a temperature", () => {
    expect(toSI(20, "degC", "temperature")).toBeCloseTo(293.15, 12);
    expect(toSI(300, "K", "temperature")).toBe(300);
    expect(mismatch("degC", "length")).not.toBeNull();
    expect(() => toSI(1, "degC", "other")).not.toThrow();
  });
});

describe("dimensions: W, W/m and W/m^3 are distinct (plan 08)", () => {
  it("accepts a unit only for its own dimension", () => {
    expect(mismatch("W", "power")).toBeNull();
    expect(mismatch("W/m", "power-per-length")).toBeNull();
    expect(mismatch("W/m^3", "power-per-volume")).toBeNull();
    expect(mismatch("W/m^2", "heat-flux")).toBeNull();
    for (const [u, d] of [["W/m", "power"], ["W", "power-per-length"], ["W/m^3", "power-per-length"], ["W/m", "power-per-volume"], ["W", "heat-flux"], ["J", "power"], ["m", "time"]] as const) {
      expect(mismatch(u, d), `${u} as ${d}`).not.toBeNull();
    }
  });

  it("treats probability, count and rate by their own rules", () => {
    expect(mismatch("1", "probability")).toBeNull();
    expect(mismatch("1", "dimensionless")).toBeNull();
    expect(mismatch("reaction", "probability")).not.toBeNull();
    expect(mismatch("reaction", "count")).toBeNull();
    expect(mismatch("reaction/particle", "count")).not.toBeNull();
    expect(mismatch("1", "count")).not.toBeNull();
    expect(mismatch("1/s", "rate")).toBeNull();
    expect(mismatch("event/hour", "rate")).toBeNull();
    expect(mismatch("event^2/s", "rate")).not.toBeNull();
    expect(mismatch("W", "rate")).not.toBeNull();
    expect(mismatch("s", "rate")).not.toBeNull();
  });

  it("refuses a counted thing inside a physical dimension and passes `other`", () => {
    expect(mismatch("eV/particle", "energy")).not.toBeNull();
    expect(mismatch("eV/particle", "other")).toBeNull();
    expect(mismatch("furlong", "other")).not.toBeNull();
  });

  it("toSI refuses a wrong or unknown unit instead of passing the value through", () => {
    expect(() => toSI(1, "W/m", "power")).toThrow();
    expect(() => toSI(1, "furlong", "length")).toThrow();
  });

  it("knows every dimension the schema lists", () => {
    expect(DIMENSIONS).toHaveLength(15);
  });
});
