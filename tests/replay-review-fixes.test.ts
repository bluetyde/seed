// @covers R-STUDY-05
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFromHostFile } from "../src/core/fileRunHost";
import { sha256Hex } from "../src/core/canonical";
import { loadRunEvidence } from "../src/core/runEvidence";
import { budget, fixture, fixtureDirs } from "./helpers/replayFixture";

// Findings of the Codex review of replay (2026-10-24), each with the case that showed it.
afterEach(() => { for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("an uncertainty the results index declares", () => {
  async function evidenceWith(uncertainty: unknown) {
    const f = await fixture({ scenario: "success" });
    await runFromHostFile(f.file, { requestId: "o", caseId: "approved", budget });
    const run = readdirSync(join(f.project, "runs")).find((n) => n.startsWith("r-"))!;
    const runRoot = join(f.project, "runs", run);
    const record = JSON.parse(readFileSync(join(runRoot, "run-record.json"), "utf8"));
    const indexOut = record.outputs.find((o: { path: string }) => o.path.endsWith("results.json"));
    const index = JSON.parse(readFileSync(join(f.project, indexOut.path), "utf8"));
    // the fake adapter writes a series: a scalar takes its place, with the hashes that bind it
    const dataOut = record.outputs.find((o: { path: string }) => o.path === index.quantities[0].data.path);
    const scalar = JSON.stringify({ schema: "seed.quantity-data/0.2", kind: "scalar", quantity: "out", unit: "1", value: 3 });
    writeFileSync(join(f.project, dataOut.path), scalar);
    dataOut.sha256 = sha256Hex(Buffer.from(scalar));
    index.quantities[0].data.sha256 = dataOut.sha256;
    if (uncertainty !== undefined) index.quantities[0].uncertainty = uncertainty;
    const bytes = JSON.stringify(index);
    writeFileSync(join(f.project, indexOut.path), bytes);
    indexOut.sha256 = sha256Hex(Buffer.from(bytes));
    return loadRunEvidence(f.project, runRoot, record).quantities[0]!.data as { kind: string; std?: number };
  }
  it("a statistical uncertainty of a scalar whose data file has none is carried as its standard deviation", async () => {
    expect(await evidenceWith({ kind: "statistical", value: 0.5 })).toMatchObject({ kind: "scalar", std: 0.5 });
  });
  it("one of another kind, or in another unit, or none at all, is not turned into a standard deviation", async () => {
    expect((await evidenceWith({ kind: "model", value: 0.5 })).std).toBeUndefined();
    expect((await evidenceWith({ kind: "statistical", value: 0.5, unit: "W" })).std).toBeUndefined();
    expect((await evidenceWith(undefined)).std).toBeUndefined();
  });
});
