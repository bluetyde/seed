import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyInstall, parseRegistry, type AppEntry } from "../src/main/apps";
import { parseCatalog } from "../src/main/catalog";
import { InstallStore } from "../src/main/store";
import { tempDir } from "./helpers/repo";
import { writeFileSync } from "node:fs";

const ok = { id: "demo", name: "Demo", url: "https://github.com/o/r.git", branch: "main", folder: "demo" };
const cat = (...repos: unknown[]) => parseCatalog(JSON.stringify({ repos }));

describe("catalog", () => {
  it("accepts the shipped catalog, and every default app that names a catalog entry has one", () => {
    const c = parseCatalog(readFileSync(join(__dirname, "..", "catalog.json"), "utf-8"));
    expect(c.problems).toEqual([]);
    const apps = parseRegistry(readFileSync(join(__dirname, "..", "apps.default.json"), "utf-8")).apps;
    for (const a of apps) if (a.catalog) expect(c.repos.map((r) => r.id)).toContain(a.catalog);
  });

  it.each([
    ["not github", { ...ok, url: "https://example.com/o/r.git" }, "https://github.com"],
    ["path-like folder", { ...ok, folder: "../x" }, "folder"],
    ["step outside the repo", { ...ok, steps: [{ label: "x", command: "npm", args: [], cwd: "../.." }] }, "inside the repository"],
    ["absolute step cwd", { ...ok, steps: [{ label: "x", command: "npm", args: [], cwd: "C:\\Windows" }] }, "inside the repository"],
    ["bad prerequisite", { ...ok, prerequisites: [{ id: "x" }] }, "prerequisite"],
  ])("rejects %s by name", (_n, entry, msg) => {
    const r = cat(entry, { ...ok, id: "second" });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(msg);
    expect(r.repos.map((x) => x.id)).toEqual(["second"]);
  });

  it("allows a local address only when asked (tests)", () => {
    const local = { ...ok, url: "C:/tmp/origin.git" };
    expect(cat(local).repos).toHaveLength(0);
    expect(parseCatalog(JSON.stringify({ repos: [local] }), true).repos).toHaveLength(1);
  });
});

describe("applyInstall", () => {
  const base: AppEntry = { id: "a", name: "A", icon: "app", healthPath: "/", urlPath: "/", startTimeoutMs: 1000, catalog: "a", start: { command: "node", args: ["{install}/x.js"], cwd: "{install}\\web", env: { P: "{install}" } } };

  it("fills in the install folder everywhere it is used", () => {
    const r = applyInstall(base, "D:\\apps\\a");
    expect(r.start).toEqual({ command: "node", args: ["D:\\apps\\a/x.js"], cwd: "D:\\apps\\a\\web", env: { P: "D:\\apps\\a" } });
    expect(r.missingInstall).toBeUndefined();
  });

  it("an app that is not installed has no start command and says so", () => {
    const r = applyInstall(base, undefined);
    expect(r.missingInstall).toBe(true);
    expect(r.start).toBeUndefined();
  });

  it("an app without a catalog entry is left exactly as it is", () => {
    const { catalog: _c, ...custom } = base;
    expect(applyInstall(custom, undefined)).toBe(custom);
  });
});

describe("InstallStore", () => {
  it("saves and loads paths and the install root, and starts from the default", () => {
    const file = join(tempDir(), "installs.json");
    const s = new InstallStore(file, "D:\\default");
    expect(s.load()).toEqual({ installRoot: "D:\\default", paths: {} });
    s.setPath("a", "X:\\a");
    s.setRoot("E:\\apps");
    expect(new InstallStore(file, "D:\\default").load()).toEqual({ installRoot: "E:\\apps", paths: { a: "X:\\a" } });
    s.setPath("a", undefined);
    expect(s.load().paths).toEqual({});
  });

  it("a damaged file is an error, not silently empty settings", () => {
    const file = join(tempDir(), "installs.json");
    writeFileSync(file, "{nope");
    expect(() => new InstallStore(file, "D:\\default").load()).toThrow();
  });
});
