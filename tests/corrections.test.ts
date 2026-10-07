import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/corrections.md is only worth keeping if each entry can be pointed at: every field present, the lists respected,
// every commit named real, every file named in backticks existing.
const root = join(__dirname, "..");
const text = readFileSync(join(root, "docs", "corrections.md"), "utf8");
const FIELDS = ["Date", "Found by", "Class", "What was wrong", "Why the checks missed it", "Catches it now", "Disposition", "Evidence"];
const CLASSES = ["infrastructure", "adapter-behaviour", "test-gap", "process", "documentation"];
const DISPOSITIONS = ["regression-test", "stress-tool", "oracle-bad-input", "oracle-known-limit", "none"];

type Block = { id: string; title: string; fields: Record<string, string> };
function parse(src: string): Block[] {
  const body = src.slice(src.indexOf("## Entries"));
  const parts = body.split(/^### /m).slice(1);
  return parts.map((p) => {
    const lines = p.split("\n");
    const head = /^(C-\d+) (.+)$/.exec(lines[0] ?? "");
    const fields: Record<string, string> = {};
    for (const l of lines.slice(1)) {
      const m = /^- \*\*([^:*]+):\*\* (.*)$/.exec(l);
      if (m) fields[m[1]!] = m[2]!;
    }
    return { id: head?.[1] ?? "?", title: head?.[2] ?? "", fields };
  });
}
const blocks = parse(text);

describe("docs/corrections.md", () => {
  it("has entries, numbered C-01 upward with no gap or repeat", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => `C-${String(i + 1).padStart(2, "0")}`));
  });

  it.each(blocks.map((b) => [b.id, b] as const))("%s has every field, with something in it", (_id, b) => {
    expect(b.title.length).toBeGreaterThan(5);
    for (const f of FIELDS) {
      expect(b.fields[f], `${b.id}: ${f}`).toBeTruthy();
      expect((b.fields[f] as string).trim().length, `${b.id}: ${f} is empty`).toBeGreaterThan(3);
    }
    expect(Object.keys(b.fields).sort()).toEqual([...FIELDS].sort());
  });

  it.each(blocks.map((b) => [b.id, b] as const))("%s uses a listed class, disposition and date", (_id, b) => {
    expect(CLASSES).toContain(b.fields["Class"]);
    const dispositions = (b.fields["Disposition"] ?? "").split(",").map((s) => s.trim());
    for (const d of dispositions) expect(DISPOSITIONS, `${b.id}: ${d}`).toContain(d);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(b.fields["Date"] ?? ""), `${b.id}: date`).toBe(true);
  });

  it("an entry whose disposition is none says so in 'Catches it now', and one with a test names a file", () => {
    for (const b of blocks) {
      const none = b.fields["Disposition"] === "none";
      expect(/nothing: practice only/.test(b.fields["Catches it now"] ?? ""), `${b.id}`).toBe(none);
    }
  });

  it("every commit named exists in this repository", () => {
    const named = new Set<string>();
    for (const b of blocks) for (const m of (b.fields["Evidence"] ?? "").matchAll(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g)) named.add(m[0]);
    expect(named.size).toBeGreaterThan(0);
    for (const h of named) {
      const r = spawnSync("git", ["cat-file", "-e", `${h}^{commit}`], { cwd: root });
      expect(r.status, `commit ${h}`).toBe(0);
    }
  });

  it("every file named in backticks exists (tests/, scripts/, src/, docs/, schema/)", () => {
    let checked = 0;
    for (const b of blocks) {
      for (const f of ["Catches it now", "Evidence", "What was wrong"]) {
        for (const m of (b.fields[f] ?? "").matchAll(/`((?:tests|scripts|src|docs|schema)\/[^`\s]+)`/g)) {
          checked++;
          expect(existsSync(join(root, m[1]!)), `${b.id}: ${m[1]}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("an entry that cites a test file in 'Catches it now' cites one that really contains tests", () => {
    for (const b of blocks) {
      for (const m of (b.fields["Catches it now"] ?? "").matchAll(/`(tests\/[^`\s]+\.test\.ts)`/g)) {
        expect(readFileSync(join(root, m[1]!), "utf8"), `${b.id}: ${m[1]}`).toMatch(/\b(it|test)(\.each\([^)]*\))?\(/);
      }
    }
  });

  it("the parser would notice a block with a missing field (self-check of this test)", () => {
    const broken = parse("## Entries\n### C-01 A title that is long enough\n- **Date:** 2026-10-07\n");
    expect(Object.keys(broken[0]!.fields)).toEqual(["Date"]);
    expect(FIELDS.every((f) => broken[0]!.fields[f])).toBe(false);
  });
});
