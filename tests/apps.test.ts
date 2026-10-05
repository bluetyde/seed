import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRegistry } from "../src/main/apps";

const ok = { id: "demo", name: "Demo", healthPath: "/health", urlPath: "/", start: { command: "node", args: ["x.js", "{port}"] } };
const reg = (...apps: unknown[]) => parseRegistry(JSON.stringify({ apps }));

describe("registry", () => {
  it.each(["apps.default.json", "apps.windows.json"])("accepts %s with no problems", (file) => {
    const r = parseRegistry(readFileSync(join(__dirname, "..", file), "utf-8"));
    expect(r.problems).toEqual([]);
    expect(r.apps.map((a) => a.id)).toEqual(["openmc-studio", "nodal-studio", "virtual-reactor", "feed"]);
  });

  it("fills defaults", () => {
    const r = reg(ok);
    expect(r.problems).toEqual([]);
    expect(r.apps[0]).toMatchObject({ icon: "app", startTimeoutMs: 60_000 });
  });

  it.each([
    ["bad id", { ...ok, id: "Bad Id" }, "id must be"],
    ["no name", { ...ok, name: " " }, "name is required"],
    ["health path", { ...ok, healthPath: "health" }, "healthPath"],
    ["url path", { ...ok, urlPath: "" }, "urlPath"],
    ["empty command", { ...ok, start: { command: "", args: [] } }, "start.command"],
    ["args not strings", { ...ok, start: { command: "node", args: [1] } }, "start.args"],
    ["quote in cwd", { ...ok, start: { command: "node", args: [], cwd: "C:\\a'b" } }, "start.cwd"],
    ["remote attach", { ...ok, start: undefined, attachUrl: "http://example.com/" }, "attachUrl must be http on this computer"],
    ["https attach", { ...ok, start: undefined, attachUrl: "https://127.0.0.1/" }, "attachUrl must be http"],
    ["nothing to open", { ...ok, start: undefined }, "needs start or attachUrl"],
    ["timeout", { ...ok, startTimeoutMs: 5 }, "startTimeoutMs"],
  ])("rejects %s by name and keeps going", (_n, entry, msg) => {
    const r = reg(entry, { ...ok, id: "second" });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(msg);
    expect(r.apps.map((a) => a.id)).toEqual(["second"]);
  });

  it("rejects duplicate ids and bad JSON", () => {
    expect(reg(ok, ok).problems[0]).toContain("duplicate id");
    expect(parseRegistry("{nope").problems[0]).toContain("not valid JSON");
    expect(parseRegistry("{}").problems[0]).toContain('"apps" array');
  });
});
