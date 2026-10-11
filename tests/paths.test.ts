// @covers R-CORE-05, R-CORE-13, R-SHELL-05
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  isPortableRelative,
  resolveInside,
  toPortableRelative,
  toWindows,
  toWsl
} from "../src/core/paths";

function createLcg(seed = 123456789) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("paths", () => {
  describe("toWsl case table (1-21)", () => {
    it("1. maps Windows drive path with spaces to /mnt/<letter>/...", () => {
      expect(toWsl("C:\\Users\\a b\\f.txt")).toEqual({
        ok: true,
        value: "/mnt/c/Users/a b/f.txt"
      });
    });

    it("2. maps Windows forward-slash drive path to /mnt/<letter>/...", () => {
      expect(toWsl("c:/Users/x")).toEqual({
        ok: true,
        value: "/mnt/c/Users/x"
      });
    });

    it("3. maps Windows drive root C:\\ to /mnt/c", () => {
      expect(toWsl("C:\\")).toEqual({
        ok: true,
        value: "/mnt/c"
      });
    });

    it("4. normalizes .. in Windows drive path before mapping", () => {
      expect(toWsl("D:\\data\\..\\x")).toEqual({
        ok: true,
        value: "/mnt/d/x"
      });
    });

    it("5. normalizes . and repeated separators and trailing slash", () => {
      expect(toWsl("C:\\a\\.\\b\\\\c\\")).toEqual({
        ok: true,
        value: "/mnt/c/a/b/c"
      });
    });

    it("6. maps extended-length drive path \\\\?\\C:\\...", () => {
      expect(toWsl("\\\\?\\C:\\Windows\\System32")).toEqual({
        ok: true,
        value: "/mnt/c/Windows/System32"
      });
    });

    it("7. maps \\\\wsl$\\Ubuntu\\... with matching distro option", () => {
      expect(toWsl("\\\\wsl$\\Ubuntu\\home\\u\\p", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "/home/u/p"
      });
    });

    it("8. maps \\\\wsl.localhost\\ubuntu\\... with case-insensitive distro match", () => {
      expect(toWsl("\\\\wsl.localhost\\ubuntu\\home\\u", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "/home/u"
      });
    });

    it("9. maps \\\\wsl$\\Ubuntu (distro root) to /", () => {
      expect(toWsl("\\\\wsl$\\Ubuntu", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "/"
      });
    });

    it("10. rejects \\\\wsl$\\Debian\\... when distro option is Ubuntu", () => {
      const res = toWsl("\\\\wsl$\\Debian\\home", { distro: "Ubuntu" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("11. rejects WSL-UNC path when distro option is missing", () => {
      const res = toWsl("\\\\wsl$\\Ubuntu\\home");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("12. rejects standard UNC path as unmappable to WSL", () => {
      const res = toWsl("\\\\server\\share\\dir");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("13. rejects UNC path without share as E_PATH_INVALID", () => {
      const res = toWsl("\\\\server");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_INVALID");
      }
    });

    it("14. rejects \\\\?\\UNC\\... as unmappable to WSL", () => {
      const res = toWsl("\\\\?\\UNC\\server\\share\\x");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("15. rejects device paths \\\\.\\COM1 as unmappable", () => {
      const res = toWsl("\\\\.\\COM1");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("16. rejects bare drive C: and drive-relative C:foo as E_PATH_INVALID", () => {
      const r1 = toWsl("C:");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_INVALID");

      const r2 = toWsl("C:foo");
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe("E_PATH_INVALID");
    });

    it("17. rejects empty string and NUL character as E_PATH_INVALID", () => {
      const r1 = toWsl("");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_INVALID");

      const r2 = toWsl("C:\\a\u0000b");
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe("E_PATH_INVALID");
    });

    it("18. rejects C:\\.. as E_PATH_TRAVERSAL", () => {
      const res = toWsl("C:\\..");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_TRAVERSAL");
      }
    });

    it("19. normalizes POSIX path /home/u/../v to /home/v and preserves /mnt/c/Users", () => {
      expect(toWsl("/home/u/../v")).toEqual({
        ok: true,
        value: "/home/v"
      });
      expect(toWsl("/mnt/c/Users")).toEqual({
        ok: true,
        value: "/mnt/c/Users"
      });
    });

    it("20. rejects relative path a/b as E_PATH_INVALID", () => {
      const res = toWsl("a/b");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_INVALID");
      }
    });

    it("21. respects custom mntRoot and rejects mntRoot with trailing slash", () => {
      expect(toWsl("C:\\a\\b", { mntRoot: "/drives" })).toEqual({
        ok: true,
        value: "/drives/c/a/b"
      });

      const res = toWsl("C:\\a", { mntRoot: "/drives/" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_INVALID");
      }
    });
  });

  describe("toWindows case table (22-38)", () => {
    it("22. maps /mnt/c/Users/a b to C:\\Users\\a b", () => {
      expect(toWindows("/mnt/c/Users/a b")).toEqual({
        ok: true,
        value: "C:\\Users\\a b"
      });
    });

    it("23. maps /mnt/c and /mnt/c/ to C:\\", () => {
      expect(toWindows("/mnt/c")).toEqual({
        ok: true,
        value: "C:\\"
      });
      expect(toWindows("/mnt/c/")).toEqual({
        ok: true,
        value: "C:\\"
      });
    });

    it("24. maps /mnt/cc/x to \\\\wsl.localhost\\Ubuntu\\mnt\\cc\\x", () => {
      expect(toWindows("/mnt/cc/x", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\mnt\\cc\\x"
      });
    });

    it("25. maps /mnt/data to \\\\wsl.localhost\\Ubuntu\\mnt\\data", () => {
      expect(toWindows("/mnt/data", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\mnt\\data"
      });
    });

    it("26. maps /home/u/p to \\\\wsl.localhost\\Ubuntu\\home\\u\\p", () => {
      expect(toWindows("/home/u/p", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\home\\u\\p"
      });
    });

    it("27. rejects /home/u/p without distro option as E_PATH_UNMAPPABLE", () => {
      const res = toWindows("/home/u/p");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_UNMAPPABLE");
      }
    });

    it("28. maps / with distro to \\\\wsl.localhost\\Ubuntu without trailing backslash", () => {
      expect(toWindows("/", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu"
      });
    });

    it("29. rejects posix path with backslash in segment as E_PATH_INVALID", () => {
      const res = toWindows("/home/a\\b", { distro: "Ubuntu" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_INVALID");
      }
    });

    it("30. rejects /.. as E_PATH_TRAVERSAL", () => {
      const res = toWindows("/..", { distro: "Ubuntu" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_TRAVERSAL");
      }
    });

    it("31. normalizes already-Windows drive path C:/x/y to C:\\x\\y and c:\\ to C:\\", () => {
      expect(toWindows("C:/x/y")).toEqual({
        ok: true,
        value: "C:\\x\\y"
      });
      expect(toWindows("c:\\")).toEqual({
        ok: true,
        value: "C:\\"
      });
    });

    it("32. normalizes \\\\wsl$\\Ubuntu\\home\\u to \\\\wsl.localhost\\Ubuntu\\home\\u without distro option", () => {
      expect(toWindows("\\\\wsl$\\Ubuntu\\home\\u")).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\home\\u"
      });
    });

    it("33. normalizes UNC path \\\\server\\share\\a\\..\\b to \\\\server\\share\\b", () => {
      expect(toWindows("\\\\server\\share\\a\\..\\b")).toEqual({
        ok: true,
        value: "\\\\server\\share\\b"
      });
    });

    it("34. rejects UNC traversal above share root as E_PATH_TRAVERSAL", () => {
      const res = toWindows("\\\\server\\share\\..");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_TRAVERSAL");
      }
    });

    it("35. unwraps \\\\?\\C:\\x to C:\\x and \\\\?\\UNC\\srv\\sh\\x to \\\\srv\\sh\\x", () => {
      expect(toWindows("\\\\?\\C:\\x")).toEqual({
        ok: true,
        value: "C:\\x"
      });
      expect(toWindows("\\\\?\\UNC\\srv\\sh\\x")).toEqual({
        ok: true,
        value: "\\\\srv\\sh\\x"
      });
    });

    it("36. normalizes /mnt/c/.. to /mnt and maps to \\\\wsl.localhost\\Ubuntu\\mnt", () => {
      expect(toWindows("/mnt/c/..", { distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\mnt"
      });
    });

    it("37. rejects relative path a/b as E_PATH_INVALID", () => {
      const res = toWindows("a/b");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_INVALID");
      }
    });

    it("38. respects custom mntRoot for drive mapping and falls back for other paths", () => {
      expect(toWindows("/mnt/d/x", { mntRoot: "/drives", distro: "Ubuntu" })).toEqual({
        ok: true,
        value: "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\x"
      });
      expect(toWindows("/drives/d/x", { mntRoot: "/drives" })).toEqual({
        ok: true,
        value: "D:\\x"
      });
    });
  });

  describe("classifyPath (39)", () => {
    it("classifies C:\\x as windows", () => {
      expect(classifyPath("C:\\x")).toEqual({
        ok: true,
        value: { kind: "windows", normalized: "C:\\x" }
      });
    });

    it("classifies \\\\s\\h as windows", () => {
      expect(classifyPath("\\\\s\\h")).toEqual({
        ok: true,
        value: { kind: "windows", normalized: "\\\\s\\h" }
      });
    });

    it("classifies \\\\wsl$\\U\\x as windows with normalized \\\\wsl.localhost\\U\\x", () => {
      expect(classifyPath("\\\\wsl$\\U\\x")).toEqual({
        ok: true,
        value: { kind: "windows", normalized: "\\\\wsl.localhost\\U\\x" }
      });
    });

    it("classifies /x as posix by default and wsl with assumeWsl:true", () => {
      expect(classifyPath("/x")).toEqual({
        ok: true,
        value: { kind: "posix", normalized: "/x" }
      });
      expect(classifyPath("/x", { assumeWsl: true })).toEqual({
        ok: true,
        value: { kind: "wsl", normalized: "/x" }
      });
    });

    it("classifies a/b and a\\b as relative with normalized a/b", () => {
      expect(classifyPath("a/b")).toEqual({
        ok: true,
        value: { kind: "relative", normalized: "a/b" }
      });
      expect(classifyPath("a\\b")).toEqual({
        ok: true,
        value: { kind: "relative", normalized: "a/b" }
      });
    });

    it("rejects bare drive C: as E_PATH_INVALID", () => {
      const res = classifyPath("C:");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("E_PATH_INVALID");
    });

    it("rejects single leading backslash \\a as E_PATH_INVALID", () => {
      const res = classifyPath("\\a");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("E_PATH_INVALID");
    });

    it("classifies /mnt/c/x as posix (or wsl with assumeWsl)", () => {
      expect(classifyPath("/mnt/c/x")).toEqual({
        ok: true,
        value: { kind: "posix", normalized: "/mnt/c/x" }
      });
      expect(classifyPath("/mnt/c/x", { assumeWsl: true })).toEqual({
        ok: true,
        value: { kind: "wsl", normalized: "/mnt/c/x" }
      });
    });
  });

  describe("isPortableRelative", () => {
    it("accepts valid portable relative paths", () => {
      const validCases = ["a/b.txt", "a b/c", ".hidden/x", "a..b/c", "...", "ü/ñ"];
      for (const p of validCases) {
        expect(isPortableRelative(p)).toEqual({ ok: true, value: p });
      }
      const len512 = "a".repeat(512);
      expect(isPortableRelative(len512)).toEqual({ ok: true, value: len512 });
    });

    it("rejects invalid portable relative paths with exact error codes", () => {
      const invalidTests: [string, "E_PATH_INVALID" | "E_PATH_TRAVERSAL"][] = [
        ["/a", "E_PATH_INVALID"],
        ["a\\b", "E_PATH_INVALID"],
        ["a:b", "E_PATH_INVALID"],
        ["../a", "E_PATH_TRAVERSAL"],
        ["a/../b", "E_PATH_TRAVERSAL"],
        ["..", "E_PATH_TRAVERSAL"],
        ["../a:b", "E_PATH_TRAVERSAL"],
        ["a/./b", "E_PATH_INVALID"],
        [".", "E_PATH_INVALID"],
        ["a//b", "E_PATH_INVALID"],
        ["a/", "E_PATH_INVALID"],
        ["", "E_PATH_INVALID"],
        ["a\u0000b", "E_PATH_INVALID"],
        ["x".repeat(513), "E_PATH_INVALID"]
      ];

      for (const [p, code] of invalidTests) {
        const res = isPortableRelative(p);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe(code);
        }
      }
    });
  });

  describe("toPortableRelative", () => {
    it("converts valid paths and resolves . segments", () => {
      expect(toPortableRelative("a\\b\\c")).toEqual({ ok: true, value: "a/b/c" });
      expect(toPortableRelative(".\\a")).toEqual({ ok: true, value: "a" });
      expect(toPortableRelative("a\\.\\b\\\\c")).toEqual({ ok: true, value: "a/b/c" });
    });

    it("rejects invalid paths with exact error codes", () => {
      const invalidTests: [string, "E_PATH_INVALID" | "E_PATH_TRAVERSAL"][] = [
        ["a\\..\\b", "E_PATH_TRAVERSAL"],
        ["C:\\a", "E_PATH_INVALID"],
        ["\\a", "E_PATH_INVALID"],
        [".", "E_PATH_INVALID"],
        ["./", "E_PATH_INVALID"]
      ];

      for (const [p, code] of invalidTests) {
        const res = toPortableRelative(p);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe(code);
        }
      }
    });
  });

  describe("resolveInside (41-48)", () => {
    it("41. resolves models/a.json inside C:\\proj", () => {
      expect(resolveInside("C:\\proj", "models/a.json")).toEqual({
        ok: true,
        value: "C:\\proj\\models\\a.json"
      });
    });

    it("42. resolves a\\..\\b inside C:\\proj\\", () => {
      expect(resolveInside("C:\\proj\\", "a\\..\\b")).toEqual({
        ok: true,
        value: "C:\\proj\\b"
      });
    });

    it("43. rejects ..\\other and ..\\proj2\\x escaping C:\\proj", () => {
      const r1 = resolveInside("C:\\proj", "..\\other");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_TRAVERSAL");

      const r2 = resolveInside("C:\\proj", "..\\proj2\\x");
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe("E_PATH_TRAVERSAL");
    });

    it("44. resolves ..\\proj\\x inside C:\\Proj by case-insensitivity and fails when caseInsensitive:false", () => {
      expect(resolveInside("C:\\Proj", "..\\proj\\x")).toEqual({
        ok: true,
        value: "C:\\proj\\x"
      });

      const res = resolveInside("C:\\Proj", "..\\proj\\x", { caseInsensitive: false });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_PATH_TRAVERSAL");
      }
    });

    it("45. checks resolveInside on /a/b", () => {
      const r1 = resolveInside("/a/b", "../bc/x");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_TRAVERSAL");

      expect(resolveInside("/a/b", "c/../d")).toEqual({
        ok: true,
        value: "/a/b/d"
      });

      const r2 = resolveInside("/a/b", "/etc");
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe("E_PATH_TRAVERSAL");

      const r3 = resolveInside("/a/b", "C:\\x");
      expect(r3.ok).toBe(false);
      if (!r3.ok) expect(r3.error.code).toBe("E_PATH_TRAVERSAL");

      const r4 = resolveInside("/a/b", "x\u0000");
      expect(r4.ok).toBe(false);
      if (!r4.ok) expect(r4.error.code).toBe("E_PATH_INVALID");
    });

    it("46. checks relative root, root / with x and / with ..", () => {
      const r1 = resolveInside("a/b", "x");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_INVALID");

      expect(resolveInside("/", "x")).toEqual({
        ok: true,
        value: "/x"
      });

      const r2 = resolveInside("/", "..");
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.code).toBe("E_PATH_TRAVERSAL");
    });

    it("47. resolves x inside \\\\srv\\sh\\p and rejects ..\\..\\q", () => {
      expect(resolveInside("\\\\srv\\sh\\p", "x")).toEqual({
        ok: true,
        value: "\\\\srv\\sh\\p\\x"
      });

      const r = resolveInside("\\\\srv\\sh\\p", "..\\..\\q");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("E_PATH_TRAVERSAL");
    });

    it("48. rejects .. leaving /a/b and allows . as root itself", () => {
      const r1 = resolveInside("/a/b", "..");
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("E_PATH_TRAVERSAL");

      expect(resolveInside("/a/b", ".")).toEqual({
        ok: true,
        value: "/a/b"
      });
    });
  });

  describe("Extra required property tests", () => {
    it("(a) seeded round-trip property test for 500 Windows drive paths", () => {
      const rand = createLcg(42);
      const driveLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const charPool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-üñéα";

      for (let i = 0; i < 500; i++) {
        const drive = driveLetters[Math.floor(rand() * driveLetters.length)]!;
        const numSegments = 1 + Math.floor(rand() * 6);
        const segments: string[] = [];

        for (let s = 0; s < numSegments; s++) {
          const segLen = 1 + Math.floor(rand() * 8);
          let segChars = "";
          for (let c = 0; c < segLen; c++) {
            segChars += charPool[Math.floor(rand() * charPool.length)]!;
          }
          // Optionally add an extension with dot inside name
          if (rand() > 0.5) {
            segChars += ".ext";
          }
          // Ensure not . or .. or empty
          if (segChars === "." || segChars === ".." || segChars.trim() === "") {
            segChars = `seg${s}`;
          }
          segments.push(segChars);
        }

        const P = `${drive}:\\${segments.join("\\")}`;
        const normalizedP = `${drive.toUpperCase()}:\\${segments.join("\\")}`;

        const wsl = toWsl(P);
        expect(wsl.ok).toBe(true);
        if (!wsl.ok) continue;

        const win = toWindows(wsl.value);
        expect(win.ok).toBe(true);
        if (!win.ok) continue;

        expect(win.value).toBe(normalizedP);

        // Reverse for the mapped WSL paths
        const wslReverse = toWsl(win.value);
        expect(wslReverse.ok).toBe(true);
        if (wslReverse.ok) {
          expect(wslReverse.value).toBe(wsl.value);
        }
      }
    });

    it("(b) every function returns a typed result without throwing for 200 random strings", () => {
      const rand = createLcg(987654321);
      const pool = ["/", "\\", ":", ".", "?", "$", "a", "Z", "0", "\u0000", " "];
      const validErrorCodes = new Set(["E_PATH_INVALID", "E_PATH_TRAVERSAL", "E_PATH_UNMAPPABLE"]);

      for (let i = 0; i < 200; i++) {
        const len = Math.floor(rand() * 40);
        let str = "";
        for (let j = 0; j < len; j++) {
          str += pool[Math.floor(rand() * pool.length)]!;
        }

        const r1 = classifyPath(str);
        if (!r1.ok) expect(validErrorCodes.has(r1.error.code)).toBe(true);

        const r2 = toWsl(str, { distro: "Ubuntu" });
        if (!r2.ok) expect(validErrorCodes.has(r2.error.code)).toBe(true);

        const r3 = toWindows(str, { distro: "Ubuntu" });
        if (!r3.ok) expect(validErrorCodes.has(r3.error.code)).toBe(true);

        const r4 = isPortableRelative(str);
        if (!r4.ok) expect(validErrorCodes.has(r4.error.code)).toBe(true);

        const r5 = toPortableRelative(str);
        if (!r5.ok) expect(validErrorCodes.has(r5.error.code)).toBe(true);

        const r6 = resolveInside("C:\\root", str);
        if (!r6.ok) expect(validErrorCodes.has(r6.error.code)).toBe(true);

        const r7 = resolveInside(str, "child");
        if (!r7.ok) expect(validErrorCodes.has(r7.error.code)).toBe(true);
      }
    });

    it("(c) toWsl and toWindows are idempotent on their own output kind", () => {
      const inputs = [
        "C:\\Users\\a b\\f.txt",
        "c:/Users/x",
        "C:\\",
        "D:\\data\\..\\x",
        "/home/u/v",
        "/mnt/c/data",
        "\\\\wsl$\\Ubuntu\\home\\u\\p"
      ];

      for (const inp of inputs) {
        const wsl = toWsl(inp, { distro: "Ubuntu" });
        if (wsl.ok) {
          const wslAgain = toWsl(wsl.value, { distro: "Ubuntu" });
          expect(wslAgain.ok).toBe(true);
          if (wslAgain.ok) {
            expect(wslAgain.value).toBe(wsl.value);
          }
        }

        const win = toWindows(inp, { distro: "Ubuntu" });
        if (win.ok) {
          const winAgain = toWindows(win.value, { distro: "Ubuntu" });
          expect(winAgain.ok).toBe(true);
          if (winAgain.ok) {
            expect(winAgain.value).toBe(win.value);
          }
        }
      }
    });
  });
});
