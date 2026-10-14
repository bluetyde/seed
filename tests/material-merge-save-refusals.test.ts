// @covers R-MAT-01
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdminCli } from "../src/cli/admin";
import { writeHostJson } from "../src/core/hostFiles";
import { fixture, fixtureDirs, lines } from "./helpers/replayFixture";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// What the verb does when the project store refuses the write itself (a project that changed after the merge read it, a lock held by someone else):
// the store's own refusal is passed on as it is, nothing is claimed written, and the refusal is logged. The store is replaced here by one that refuses.
const refusal = vi.hoisted(() => ({ code: "" as string }));
vi.mock("../src/core/projectStore", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/core/projectStore")>();
  return {
    ...m,
    saveProject: (...a: Parameters<typeof m.saveProject>) =>
      refusal.code ? { ok: false as const, errors: [{ code: refusal.code, field: "/revision", message: `the store refused: ${refusal.code}`, source: "seed" as const }] } : m.saveProject(...a),
  };
});
afterEach(() => { refusal.code = ""; for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("a refusal of the project store itself", () => {
  it.each(["E_STALE_REVISION", "E_PROJECT_LOCKED"])("%s is passed on as it is; the file is unchanged and the log says refused", async (code) => {
    const f = await fixture();
    writeHostJson(f.file, { ...f.config, actor: { kind: "human", name: "FIXTURE, not a person" } });
    const before = readFileSync(join(f.project, "seed.project.json"), "utf8");
    refusal.code = code;
    const entry = { id: "fuel", revision: 1, name: "Fuel", sets: { "openmc.composition": { schema: "openmc.composition/0.1", density: 10 } } };
    const r = await runAdminCli(["import-materials"], Readable.from([JSON.stringify({ ownedSets: ["openmc.composition"], entries: [entry] })]), f.file);
    expect(r).toMatchObject({ code: 2, reply: { ok: false, errors: [{ code, message: `the store refused: ${code}` }] } });
    expect(readFileSync(join(f.project, "seed.project.json"), "utf8")).toBe(before);
    expect(lines(join(f.state, "materials.jsonl")).map((x) => x.event).at(-1)).toMatchObject({ phase: "refused", errors: [{ code }] });
  });
});
