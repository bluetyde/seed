// @covers R-XFER-07
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The transfers an app's runner declares, as the adapters pass them on in describe (adapters/shared/util.cjs, used by the FEED and OpenMC adapters).
const { cleanTransfers, droppedTransfers } = createRequire(__filename)("../adapters/shared/util.cjs") as { cleanTransfers: (x: unknown) => unknown[]; droppedTransfers: (x: unknown) => string[] };
const good = { field: "fuel-temperature", accepts: [{ dimension: "temperature", normalization: "none" }] };

describe("cleanTransfers", () => {
  it("keeps a well-formed declaration and drops a malformed one, never repairing it", () => {
    expect(cleanTransfers([good])).toEqual([good]);
    expect(cleanTransfers([good, { field: "bad field", accepts: good.accepts }, { field: "x", accepts: [] }, { field: "y", accepts: [{ dimension: "" }] }, { field: "z", accepts: [{ dimension: "temperature", normalization: "per-bad" }] }, null, 7])).toEqual([good]);
  });
  it("says nothing for anything that is not a list, and takes at most 20", () => {
    expect(cleanTransfers(undefined)).toEqual([]);
    expect(cleanTransfers({ field: "a" })).toEqual([]);
    expect(cleanTransfers(Array.from({ length: 30 }, (_, i) => ({ field: `f${i}`, accepts: good.accepts })))).toHaveLength(20);
  });
});

describe("droppedTransfers", () => {
  it("names what cleanTransfers left out, so that describe can say it", () => {
    expect(droppedTransfers([good])).toEqual([]);
    expect(droppedTransfers([good, { field: "bad field", accepts: good.accepts }, { field: "x", accepts: [] }, null, { field: "ok-field", accepts: [{ dimension: "temperature" }, { dimension: "" }] }]))
      .toEqual(['"bad field"', '"x"', "entry 4", '"ok-field"']);
    expect(droppedTransfers("nothing")).toEqual([]);
    expect(droppedTransfers(Array.from({ length: 22 }, () => good))).toEqual(["2 further entries beyond the first 20"]);
  });
});
