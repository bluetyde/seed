import { describe, expect, it } from "vitest";
import { isPortableRelative, toWindows } from "../src/core/paths";

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

describe("paths: edge cases added by the dispatcher", () => {
  it("counts characters, not UTF-16 units, for the 512 limit (matches the relPath schema)", () => {
    const astral512 = String.fromCodePoint(0x1f600).repeat(512);
    expect(isPortableRelative(astral512).ok).toBe(true);
    const astral513 = String.fromCodePoint(0x1f600).repeat(513);
    const r = isPortableRelative(astral513);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_PATH_INVALID");
  });

  it("refuses a distro name that cannot form a UNC segment", () => {
    for (const distro of ["", "Ub" + BACKSLASH + "untu", "a/b", "x" + NUL + "y"]) {
      const r = toWindows("/home/u", { distro });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("E_PATH_INVALID");
    }
    const expected = BACKSLASH + BACKSLASH + "wsl.localhost" + BACKSLASH + "Ubuntu-24.04" + BACKSLASH + "home" + BACKSLASH + "u";
    expect(toWindows("/home/u", { distro: "Ubuntu-24.04" })).toEqual({ ok: true, value: expected });
  });
});
