// @covers R-REP-02, R-SHELL-01, R-SHELL-03
import { describe, expect, it } from "vitest";
import { TabModel } from "../src/main/tabs";

const three = () => {
  const m = new TabModel();
  m.openApp("openmc", "OpenMC");
  m.openApp("nodal", "NODAL");
  m.openApp("vr", "Virtual Reactor");
  return m;
};

describe("TabModel", () => {
  it("keeps report versions independent of app tabs and focuses duplicate report identities", () => {
    const m = three(); m.openReport("one", "Report one"); m.openReport("two", "Report two"); m.openReport("one", "Report one");
    expect(m.tabs).toHaveLength(5); expect(m.activeId).toBe("report:one");
    m.close("report:one"); expect(m.tabs.filter(t => t.kind === "app")).toHaveLength(3);
    expect(m.tabs.find(t => t.id === "report:two")).toBeDefined();
  });
  it("opens one tab per app and re-activates it instead of duplicating", () => {
    const m = three();
    m.openApp("openmc", "OpenMC");
    expect(m.tabs.map((t) => t.id)).toEqual(["app:openmc", "app:nodal", "app:vr"]);
    expect(m.activeId).toBe("app:openmc");
  });

  it("opens a single Welcome tab", () => {
    const m = new TabModel();
    m.openWelcome();
    m.openWelcome();
    expect(m.tabs).toHaveLength(1);
  });

  it("closing the active tab activates its right neighbour, else the left one", () => {
    const m = three();
    m.activate("app:nodal");
    expect(m.close("app:nodal")).toBe("app:vr");
    expect(m.close("app:vr")).toBe("app:openmc");
    expect(m.close("app:openmc")).toBeUndefined();
    expect(m.tabs).toEqual([]);
  });

  it("closing a background tab keeps the active one", () => {
    const m = three();
    m.activate("app:vr");
    m.close("app:openmc");
    expect(m.activeId).toBe("app:vr");
  });

  it("next and prev wrap around", () => {
    const m = three();
    m.activate("app:vr");
    m.next();
    expect(m.activeId).toBe("app:openmc");
    m.prev();
    expect(m.activeId).toBe("app:vr");
  });

  it("Ctrl+N picks the Nth tab and 9 the last, ignoring numbers past the end", () => {
    const m = three();
    expect(m.activateIndex(2)).toBe(true);
    expect(m.activeId).toBe("app:nodal");
    expect(m.activateIndex(9)).toBe(true);
    expect(m.activeId).toBe("app:vr");
    expect(m.activateIndex(5)).toBe(false);
    expect(m.activeId).toBe("app:vr");
  });

  it("activating or closing an unknown tab changes nothing", () => {
    const m = three();
    expect(m.activate("app:nope")).toBe(false);
    m.close("app:nope");
    expect(m.tabs).toHaveLength(3);
  });

  it("moves a tab", () => {
    const m = three();
    m.move("app:vr", 0);
    expect(m.tabs.map((t) => t.appId)).toEqual(["vr", "openmc", "nodal"]);
  });
});
