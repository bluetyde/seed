import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "../src/core/validate";

// describe.resources (E2 exit): what a run of each app costs, as measured by scripts/measure-resources.cjs and kept in
// adapters/shared/resources.json. The adapters' own describe replies are compared with this file in the real-app tests.
const all = JSON.parse(readFileSync(join(__dirname, "..", "adapters", "shared", "resources.json"), "utf8")) as Record<string, any>;
const reply = (resources: unknown) => ({
  schema: "seed.adapter-reply/0.1",
  ok: true,
  verb: "describe",
  requestId: "req-1",
  warnings: [],
  errors: [],
  result: {
    app: { id: "demo", name: "Demo", version: "1" },
    formats: [{ id: "demo.case", version: "1" }],
    capabilities: ["run"],
    parameters: [],
    quantities: [],
    oracleCoverage: [],
    ...(resources === undefined ? {} : { resources }),
  },
});
const withEdit = (id: string, edit: (r: any) => void) => {
  const r = structuredClone(all[id]);
  edit(r);
  return r;
};

describe("describe.resources", () => {
  it("is optional", () => {
    expect(validate("adapter-reply", reply(undefined))).toEqual({ ok: true });
  });

  it.each(["raft", "feed", "nodal", "openmc", "pra"])("the measured figures of %s are accepted and say how and when they were measured", (id) => {
    expect(validate("adapter-reply", reply(all[id]))).toEqual({ ok: true });
    expect(all[id].measured.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(all[id].wallSeconds.max).toBeGreaterThanOrEqual(all[id].wallSeconds.typical);
    expect(all[id].memoryMB.peak).toBeGreaterThan(0);
  });

  it.each([
    ["no measurement record", withEdit("raft", (r) => delete r.measured)],
    ["a negative time", withEdit("raft", (r) => (r.wallSeconds.typical = -1))],
    ["a typical time without a maximum", withEdit("raft", (r) => delete r.wallSeconds.max)],
    ["zero cores", withEdit("raft", (r) => (r.cores = 0))],
    ["a text memory figure", withEdit("raft", (r) => (r.memoryMB.peak = "big"))],
    ["a date that is not a date", withEdit("raft", (r) => (r.measured.date = "yesterday"))],
    ["an unknown field", withEdit("raft", (r) => (r.gpus = 1))],
  ])("refuses %s", (_name, bad) => {
    const v = validate("adapter-reply", reply(bad));
    expect(v.ok).toBe(false);
  });
});
