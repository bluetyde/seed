import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/core/canonical";
import {
  acceptPins,
  comparePins,
  evaluateOracle,
  latestEntries,
  loadOracleEntries,
  pinsOf,
  runOracleSet,
  unverifiedQuantities,
  type IndexedOracle,
  type Observed,
  type OracleEntry
} from "../src/core/oracle";
import { evaluateGate } from "../src/core/policy";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "seed-oracle-"));
  dirs.push(d);
  return d;
}

const INPUT_SHA = sha256Hex("model");

/** A folder holding the model file every test entry names, so input hashes verify. */
function inputsDir(): string {
  const d = tmp();
  mkdirSync(join(d, "models"));
  writeFileSync(join(d, "models", "and.json"), "model");
  return d;
}

function entry(over: Record<string, unknown> = {}): OracleEntry {
  const base: Record<string, unknown> = {
    schema: "seed.oracle/0.1",
    oracleId: "pra-and",
    entryVersion: 1,
    adapter: "pra",
    adapterVersions: ["*"],
    tag: "good",
    inputs: [{ path: "models/and.json", sha256: INPUT_SHA }],
    expected: { quantity: "p_top", value: 0.02, unit: "1" },
    tolerance: { abs: 1e-9, rel: 0 },
    source: { kind: "hand", text: "0.1 x 0.2", check: "second method" },
    coverage: { quantities: ["p_top"], domain: "independent events" },
    ...over
  };
  if (!("toleranceHash" in over)) {
    base.toleranceHash = sha256Hex(canonicalJson({ expected: base.expected, tolerance: base.tolerance ?? null }));
  }
  return base as OracleEntry;
}
function indexed(e: OracleEntry): IndexedOracle {
  return { entry: e, file: `${e.oracleId}.json`, fileSha256: sha256Hex(canonicalJson(e)) };
}
const badInput = entry({
  oracleId: "pra-bad-prob",
  tag: "bad-input",
  expected: { refusalCode: "E_OUT_OF_DOMAIN" },
  tolerance: undefined,
  coverage: { quantities: ["probability"], domain: "input validation" }
});
const limit = entry({
  oracleId: "pra-unsupported",
  tag: "known-limit",
  expected: { verdict: "unsupported" },
  tolerance: undefined,
  coverage: { quantities: ["open-psa"], domain: "subset" }
});
delete (badInput as Record<string, unknown>).tolerance;
delete (limit as Record<string, unknown>).tolerance;

const GOOD: Observed = { kind: "value", quantity: "p_top", value: 0.02, unit: "1" };
const correct = async (e: OracleEntry): Promise<Observed> =>
  e.tag === "good" ? GOOD : e.tag === "bad-input" ? { kind: "refusal", code: "E_OUT_OF_DOMAIN" } : { kind: "verdict", verdict: "unsupported" };

describe("evaluateOracle", () => {
  const e = entry({ tolerance: { abs: 0.001, rel: 0.1 } });
  it.each([
    [0.02, "pass"],
    [0.02 + 0.001 + 0.1 * 0.02, "pass"],
    [0.02 - (0.001 + 0.1 * 0.02), "pass"],
    [0.0231, "fail"],
    [0.0169, "fail"],
    [Number.NaN, "fail"],
    [Number.POSITIVE_INFINITY, "fail"]
  ])("value %s -> %s", (value, verdict) => {
    expect(evaluateOracle(e, { kind: "value", quantity: "p_top", value, unit: "1" }).verdict).toBe(verdict);
  });
  it("the tolerance boundary is inclusive and exact (integers, no rounding)", () => {
    const t = entry({ expected: { quantity: "n", value: 10, unit: "1" }, tolerance: { abs: 2, rel: 0.5 }, coverage: { quantities: ["n"], domain: "d" } });
    const at = (value: number) => evaluateOracle(t, { kind: "value", quantity: "n", value, unit: "1" }).verdict;
    expect([at(17), at(3), at(17.5), at(2.5)]).toEqual(["pass", "pass", "fail", "fail"]);
  });
  it("a swapped unit or quantity fails even with the right number", () => {
    expect(evaluateOracle(e, { kind: "value", quantity: "p_top", value: 0.02, unit: "%" }).reason).toContain("unit");
    expect(evaluateOracle(e, { kind: "value", quantity: "p_other", value: 0.02, unit: "1" }).reason).toContain("quantity");
  });
  it("a number given as a string fails", () => {
    expect(evaluateOracle(e, { kind: "value", quantity: "p_top", value: "0.02", unit: "1" }).verdict).toBe("fail");
  });
  it("a refusal where a value is expected, and the reverse, fail", () => {
    expect(evaluateOracle(e, { kind: "refusal", code: "E_OUT_OF_DOMAIN" }).verdict).toBe("fail");
    expect(evaluateOracle(badInput, GOOD).verdict).toBe("fail");
    expect(evaluateOracle(limit, GOOD).verdict).toBe("fail");
  });
  it("refusal code and verdict must match exactly", () => {
    expect(evaluateOracle(badInput, { kind: "refusal", code: "E_OUT_OF_DOMAIN" }).verdict).toBe("pass");
    expect(evaluateOracle(badInput, { kind: "refusal", code: "E_UNITS" }).verdict).toBe("fail");
    expect(evaluateOracle(limit, { kind: "verdict", verdict: "unsupported" }).verdict).toBe("pass");
    expect(evaluateOracle(limit, { kind: "verdict", verdict: "truncated" }).verdict).toBe("fail");
  });
  it.each([null, undefined, 3, "x", [], {}])("garbage observation %j fails without throwing", (o) => {
    expect(evaluateOracle(e, o).verdict).toBe("fail");
  });
  it("an entry with a value but no tolerance fails rather than passing everything", () => {
    const broken = { ...e } as Record<string, unknown>;
    delete broken.tolerance;
    expect(evaluateOracle(broken as OracleEntry, GOOD).verdict).toBe("fail");
  });
});

describe("loadOracleEntries", () => {
  function write(dir: string, name: string, v: unknown) {
    writeFileSync(join(dir, name), typeof v === "string" ? v : JSON.stringify(v, null, 2));
  }
  it("loads valid entries, hashes each file and ignores other files", () => {
    const d = tmp();
    write(d, "a.json", entry());
    write(d, "b.json", badInput);
    write(d, "notes.txt", "ignore me");
    const r = loadOracleEntries(d);
    expect(r.errors).toEqual([]);
    expect(r.entries.map((i) => i.entry.oracleId)).toEqual(["pra-and", "pra-bad-prob"]);
    expect(r.entries[0]?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the file hash changes with any byte of the file", () => {
    const d = tmp();
    write(d, "a.json", entry());
    const h1 = loadOracleEntries(d).entries[0]?.fileSha256;
    write(d, "a.json", JSON.stringify(entry(), null, 4));
    expect(loadOracleEntries(d).entries[0]?.fileSha256).not.toBe(h1);
  });
  it("refuses bad JSON, schema errors and a tolerance changed without a new pin", () => {
    const d = tmp();
    write(d, "json.json", "{not json");
    write(d, "schema.json", { ...entry({ oracleId: "x1" }), tag: "mystery" });
    const tampered = entry({ oracleId: "x2" });
    tampered.tolerance = { abs: 0.5, rel: 0 };
    write(d, "tampered.json", tampered);
    write(d, "ok.json", entry({ oracleId: "x3" }));
    const r = loadOracleEntries(d);
    expect(r.entries.map((i) => i.entry.oracleId)).toEqual(["x3"]);
    expect(r.errors.map((e) => e.field.split("/")[0])).toEqual(expect.arrayContaining(["json.json", "schema.json", "tampered.json"]));
    expect(r.errors.find((e) => e.field.startsWith("tampered.json"))?.field).toBe("tampered.json/toleranceHash");
  });
  it("refuses a duplicate id and version, accepts a new version", () => {
    const d = tmp();
    write(d, "a.json", entry());
    write(d, "b.json", entry());
    write(d, "c.json", entry({ entryVersion: 2 }));
    const r = loadOracleEntries(d);
    expect(r.entries).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain("duplicate");
  });
  it("a missing folder is E_NOT_FOUND", () => {
    expect(loadOracleEntries(join(tmp(), "nope")).errors[0]?.code).toBe("E_NOT_FOUND");
  });
});

describe("runOracleSet", () => {
  const all = [indexed(entry()), indexed(badInput), indexed(limit)];
  const opts = (run: (e: OracleEntry) => Promise<Observed>, entries = all) => ({
    entries,
    adapter: { id: "pra", version: "1.0.0" },
    appCommit: "abc1234",
    baseDir: inputsDir(),
    run
  });

  it("the whole set is snapshotted before any callback: a callback cannot change what a later entry is judged against (Codex E0 review)", async () => {
    const second = entry({ oracleId: "pra-or", expected: { quantity: "p_top", value: 0.3, unit: "1" }, tolerance: { abs: 1e-9, rel: 0 } });
    const entries = [indexed(entry()), indexed(second)];
    const secondSha = entries[1]!.fileSha256; // as loaded, before the callback touches the object
    const result = await runOracleSet(opts(async (e) => {
      if (e.oracleId === "pra-and") {
        // reach the caller's own objects and widen the later entry's tolerance, re-hashing it so the pin still verifies
        const mine = entries[1]!.entry;
        mine.tolerance = { abs: 1e9, rel: 1 };
        mine.toleranceHash = sha256Hex(canonicalJson({ expected: mine.expected, tolerance: mine.tolerance }));
        return { kind: "value", quantity: "p_top", value: 0.02, unit: "1" };
      }
      return { kind: "value", quantity: "p_top", value: 99, unit: "1" }; // wrong by a lot
    }, entries));
    expect(result.results.find((r) => r.oracleId === "pra-or")!.verdict).toBe("fail");
    expect(result.verdict).toBe("fail");
    expect(result.blocked).toBe(true);
    // and the pins describe the entries as they were when the set started
    expect(result.pins.oracleFiles.find((f) => f.oracleId === "pra-or")!.sha256).toBe(secondSha);
  });

  it("a correct adapter passes and does not block", async () => {
    const r = await runOracleSet(opts(correct));
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(false);
    expect(r.results.map((x) => x.verdict)).toEqual(["pass", "pass", "pass"]);
  });
  it.each([
    ["perturbed output", async (e: OracleEntry) => (e.tag === "good" ? { ...GOOD, value: 0.0201 } : correct(e))],
    ["swapped units", async (e: OracleEntry) => (e.tag === "good" ? { ...GOOD, unit: "%" } : correct(e))],
    ["dropped refusal", async (e: OracleEntry) => (e.tag === "bad-input" ? GOOD : correct(e))],
    ["wrong refusal code", async (e: OracleEntry) => (e.tag === "bad-input" ? { kind: "refusal" as const, code: "E_UNITS" } : correct(e))],
    ["throwing adapter", async (e: OracleEntry) => { if (e.tag === "good") throw new Error("boom"); return correct(e); }]
  ])("%s fails the set and blocks the study (acceptance 3)", async (_n, run) => {
    const r = await runOracleSet(opts(run as never));
    expect(r.verdict).toBe("fail");
    expect(r.blocked).toBe(true);
    // The block reaches the gate.
    const d = evaluateGate(
      { operation: "run_case", actor: { kind: "agent", name: "a" }, studyId: "s" },
      { study: { studyId: "s", tier: "A3", budget: { maxWallSeconds: 1, maxCores: 1, maxMemoryMB: 1, maxDiskMB: 1 }, parameters: [] }, oracleBlocked: r.blocked }
    );
    expect(d.allow).toBe(false);
  });
  it("a thrown error is reported in the reason", async () => {
    const r = await runOracleSet(opts(async () => { throw new Error("boom"); }));
    expect(r.results[0]?.reason).toContain("boom");
  });
  it("a failed known-limit entry is recorded and marks its quantities unverified, but does not block", async () => {
    const r = await runOracleSet(opts(async (e) => (e.tag === "known-limit" ? { kind: "verdict", verdict: "truncated" } : correct(e))));
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(false);
    expect(r.blockedQuantities).toEqual(["open-psa"]);
    expect(unverifiedQuantities(["p_top", "open-psa", "other"], r, all)).toEqual(["open-psa", "other"]);
  });
  it("verified means a passed good entry covers it", async () => {
    const r = await runOracleSet(opts(correct));
    expect(unverifiedQuantities(["p_top", "probability", "unknown"], r, all)).toEqual(["probability", "unknown"]);
  });
  it("no entries, or none for this adapter, is not-run and blocked", async () => {
    for (const entries of [[], [indexed(entry({ adapter: "other" }))]]) {
      const r = await runOracleSet(opts(correct, entries));
      expect(r.verdict).toBe("not-run");
      expect(r.blocked).toBe(true);
    }
  });
  it("only refusal and limit entries passing is still blocked (no good entry)", async () => {
    const r = await runOracleSet(opts(correct, [indexed(badInput), indexed(limit)]));
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(true);
  });
  it("an entry that does not cover the adapter version is not-run and cannot make the set pass alone", async () => {
    const r = await runOracleSet(opts(correct, [indexed(entry({ adapterVersions: ["2.0.0"] }))]));
    expect(r.results[0]?.verdict).toBe("not-run");
    expect(r.verdict).toBe("not-run");
    expect(r.blocked).toBe(true);
    const ok = await runOracleSet(opts(correct, [indexed(entry({ adapterVersions: ["1.0.0"] }))]));
    expect(ok.verdict).toBe("pass");
  });
  it("an entry whose pin does not match is invalid and fails the set; its adapter is never called", async () => {
    let called = 0;
    const bad = entry({ toleranceHash: "0".repeat(64) });
    const r = await runOracleSet(opts(async (e) => { called++; return correct(e); }, [indexed(bad)]));
    expect(r.results[0]?.verdict).toBe("invalid");
    expect(r.verdict).toBe("fail");
    expect(called).toBe(0);
  });
  it("input hashes are checked when baseDir is given", async () => {
    const d = tmp();
    mkdirSync(join(d, "models"));
    writeFileSync(join(d, "models", "and.json"), "model");
    const ok = await runOracleSet({ ...opts(correct, [indexed(entry())]), baseDir: d });
    expect(ok.verdict).toBe("pass");
    writeFileSync(join(d, "models", "and.json"), "edited");
    const stale = await runOracleSet({ ...opts(correct, [indexed(entry())]), baseDir: d });
    expect(stale.results[0]?.verdict).toBe("invalid");
    expect(stale.results[0]?.reason).toContain("pinned hash");
    const missing = await runOracleSet({ ...opts(correct, [indexed(entry({ inputs: [{ path: "models/gone.json", sha256: INPUT_SHA }] }))]), baseDir: d });
    expect(missing.results[0]?.reason).toContain("cannot read");
    const escape = await runOracleSet({ ...opts(correct, [indexed(entry({ inputs: [{ path: "../x.json", sha256: INPUT_SHA }] }))]), baseDir: d });
    expect(escape.results[0]?.verdict).toBe("invalid");
  });
  it("only the newest entry version of each id runs", async () => {
    const seen: number[] = [];
    const v1 = indexed(entry({ entryVersion: 1 }));
    const v2 = indexed(entry({ entryVersion: 2 }));
    await runOracleSet(opts(async (e) => { seen.push(e.entryVersion); return correct(e); }, [v1, v2]));
    expect(seen).toEqual([2]);
    expect(latestEntries([v2, v1], "pra").map((i) => i.entry.entryVersion)).toEqual([2]);
  });
  it("records pins: app commit and each oracle file hash", async () => {
    const r = await runOracleSet(opts(correct));
    expect(r.pins.appCommit).toBe("abc1234");
    expect(r.pins.oracleFiles.map((f) => f.oracleId)).toEqual(["pra-and", "pra-bad-prob", "pra-unsupported"]);
  });
});

describe("pins", () => {
  const a = pinsOf([indexed(entry()), indexed(badInput)], "c1");
  it("no change, no flag", () => {
    expect(comparePins(a, pinsOf([indexed(entry()), indexed(badInput)], "c1"))).toEqual([]);
  });
  it("flags a new app commit, an edited file, a new version, an added and a removed entry", () => {
    expect(comparePins(a, pinsOf([indexed(entry()), indexed(badInput)], "c2"))).toEqual(["app commit c1 -> c2"]);
    const edited = { ...indexed(entry()), fileSha256: "f".repeat(64) };
    expect(comparePins(a, pinsOf([edited, indexed(badInput)], "c1"))).toEqual(["oracle file pra-and@1 changed"]);
    expect(comparePins(a, pinsOf([indexed(entry({ entryVersion: 2 })), indexed(badInput)], "c1"))).toEqual(["new oracle entry pra-and@2", "oracle entry pra-and@1 removed"].sort());
    expect(comparePins(a, pinsOf([indexed(entry()), indexed(badInput), indexed(limit)], "c1"))).toEqual(["new oracle entry pra-unsupported@1"]);
    expect(comparePins(a, pinsOf([indexed(entry())], "c1"))).toEqual(["oracle entry pra-bad-prob@1 removed"]);
  });
  it("a human cannot accept changed content under an existing entry version: a changed tolerance or expectation is a new version (Codex E0 review)", () => {
    const human = { kind: "human" as const, name: "u" };
    const before = pinsOf([indexed(entry())], "c1");
    const widened = entry({ tolerance: { abs: 1, rel: 1 } });
    const sameVersion = pinsOf([indexed(widened)], "c1");
    const refused = acceptPins(human, sameVersion, before);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]).toMatchObject({ code: "E_ORACLE_VERSION" });
    // the same change as a new version is accepted
    const v2 = entry({ tolerance: { abs: 1, rel: 1 }, entryVersion: 2 });
    expect(acceptPins(human, pinsOf([indexed(entry()), indexed(v2)], "c1"), before).ok).toBe(true);
    // unchanged content, a changed commit, and a first acceptance (no previous pins) are all fine
    expect(acceptPins(human, pinsOf([indexed(entry())], "c2"), before).ok).toBe(true);
    expect(acceptPins(human, sameVersion).ok).toBe(true);
  });

  it("a flagged change blocks run operations until a human accepts, and an agent cannot accept", () => {
    const study = { studyId: "s", tier: "A3" as const, budget: { maxWallSeconds: 1, maxCores: 1, maxMemoryMB: 1, maxDiskMB: 1 }, parameters: [] };
    const changed = pinsOf([indexed(entry()), indexed(badInput)], "c2");
    const flagged = comparePins(a, changed).length > 0;
    const run = { operation: "run_case", actor: { kind: "agent" as const, name: "a" }, studyId: "s" };
    expect(evaluateGate(run, { study, pinsChanged: flagged }).allow).toBe(false);
    expect(acceptPins({ kind: "agent", name: "a" }, changed).ok).toBe(false);
    expect(acceptPins({ kind: "system", name: "seed" }, changed).ok).toBe(false);
    const accepted = acceptPins({ kind: "human", name: "u" }, changed);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(comparePins(accepted.pins, changed)).toEqual([]);
      expect(evaluateGate(run, { study, pinsChanged: comparePins(accepted.pins, changed).length > 0 }).allow).toBe(true);
    }
  });
});

describe("review fixes (Codex, 2026-10-03)", () => {
  const set = (e: OracleEntry, extra: Record<string, unknown> = {}) => ({
    entries: [indexed(e)],
    adapter: { id: "pra", version: "1.0.0" },
    appCommit: "c",
    baseDir: inputsDir(),
    run: correct,
    ...extra
  });

  it("a comparison that overflows to infinity fails closed", () => {
    const e = entry({ expected: { quantity: "q", value: 1e308, unit: "1" }, tolerance: { abs: 0, rel: 1.8 }, coverage: { quantities: ["q"], domain: "d" } });
    const r = evaluateOracle(e, { kind: "value", quantity: "q", value: -1e308, unit: "1" });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toContain("overflow");
  });

  it("the callback cannot loosen the tolerance it is judged against, and gets only a copy", async () => {
    const e = entry({ expected: { quantity: "q", value: 1, unit: "1" }, tolerance: { abs: 0, rel: 0 }, coverage: { quantities: ["q"], domain: "d" } });
    const item = indexed(e);
    const r = await runOracleSet(
      set(e, {
        entries: [item],
        run: async (given: OracleEntry) => {
          (given.tolerance as { abs: number }).abs = 1000;
          (given.expected as { value: number }).value = 999;
          return { kind: "value", quantity: "q", value: 999, unit: "1" };
        }
      })
    );
    expect(r.results[0]?.verdict).toBe("fail");
    expect(r.verdict).toBe("fail");
    expect(item.entry.tolerance).toEqual({ abs: 0, rel: 0 });
    expect(item.entry.expected).toMatchObject({ value: 1 });
  });

  it("without baseDir the inputs are unchecked: the set is marked so and cannot clear the gate", async () => {
    const missing = entry({ inputs: [{ path: "models/missing.json", sha256: "0".repeat(64) }] });
    const r = await runOracleSet({ ...set(missing), baseDir: undefined });
    expect(r.inputsVerified).toBe(false);
    expect(r.blocked).toBe(true);
    const checked = await runOracleSet(set(entry()));
    expect(checked.inputsVerified).toBe(true);
    expect(checked.blocked).toBe(false);
  });

  it("an input reached through a link that leaves the oracle folder is refused", async () => {
    const base = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "and.json"), "model");
    try {
      symlinkSync(outside, join(base, "models"), "junction");
    } catch {
      return; // links not permitted here; the POSIX run covers this case
    }
    const r = await runOracleSet(set(entry(), { baseDir: base }));
    expect(r.results[0]?.verdict).toBe("invalid");
    expect(r.results[0]?.reason).toContain("outside");
  });

  it("an entry file that cannot be read is a typed error with its name, not a throw", () => {
    const d = tmp();
    writeFileSync(join(d, "ok.json"), JSON.stringify(entry()));
    try {
      symlinkSync(join(d, "nowhere.json"), join(d, "dangling.json"), "file");
    } catch {
      return;
    }
    const r = loadOracleEntries(d);
    expect(r.entries).toHaveLength(1);
    expect(r.errors.map((e) => [e.code, e.field])).toEqual([["E_NOT_FOUND", "dangling.json"]]);
  });
});
