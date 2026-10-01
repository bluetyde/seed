// The host's page under the bar, for the tabs that are not showing a running app: Welcome, an app that is starting, or one that failed.
// Plain script (no imports); the types come from ../types.d.ts.

(() => {
  const root = document.getElementById("page")!;
  const STATUS_TEXT: Record<TabStatus, string> = { idle: "Not open", starting: "Starting…", running: "Open", error: "Failed to start" };

  function welcome(s: HostState): HTMLElement[] {
    const out: HTMLElement[] = [
      el("h1", {}, "Experiment Studio"),
      el("p", { class: "sub" }, "Open an app in a tab. Each app keeps its own saved settings, and the host starts and stops its server for you."),
    ];
    const cards = el("div", { class: "cards" });
    for (const a of s.apps) {
      cards.append(el("section", { class: "card", "data-app": a.id },
        el("h2", {}, svgNode(a.icon, 18), a.name),
        el("div", { class: "st" }, el("span", { class: `dot ${a.status}` }), STATUS_TEXT[a.status]),
        el("button", { class: "btn", type: "button", "data-open-app": a.id, onclick: () => window.host.openApp(a.id) }, a.status === "idle" || a.status === "error" ? "Open" : "Switch to tab")));
    }
    out.push(s.apps.length ? cards : el("p", { class: "note" }, "No apps are registered. Use Help → Edit the app list."));
    if (s.registryProblems.length) {
      out.push(el("div", { class: "problems", role: "alert" }, el("b", {}, "Some entries in the app list were skipped:"), el("ul", {}, ...s.registryProblems.map((p) => el("li", {}, p)))));
    }
    out.push(el("p", { class: "note" }, `App list: ${s.registrySource}`));
    return out;
  }

  function starting(t: HostTab): HTMLElement[] {
    return [el("h1", {}, t.title), el("div", { class: "status-line", role: "status" }, el("span", { class: "spin" }), `Starting ${t.title}. The first start can take a minute.`)];
  }

  function failed(t: HostTab): HTMLElement[] {
    return [
      el("h1", {}, `${t.title} did not open`),
      el("p", { class: "sub", role: "alert" }, t.error?.message ?? "Unknown error."),
      el("div", { class: "status-line" }, el("button", { class: "btn", type: "button", "data-retry": t.id, onclick: () => window.host.retry(t.id) }, "Try again"), el("button", { class: "btn secondary", type: "button", onclick: () => window.host.menu("editRegistry") }, "Edit the app list")),
      t.error?.output ? el("pre", { class: "out", "aria-label": "Output from the app" }, t.error.output) : el("p", { class: "note" }, "The app printed nothing."),
    ];
  }

  function render(s: HostState): void {
    const t = s.tabs.find((x) => x.id === s.activeId);
    const kids = !t || t.kind === "welcome" ? welcome(s) : t.status === "error" ? failed(t) : starting(t);
    root.replaceChildren(...kids);
  }

  window.host.onState(render);
  void window.host.getState().then(render);
})();
