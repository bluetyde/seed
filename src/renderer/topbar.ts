// The top bar: a menu row and a tab row. Everything here is the host's; once an app is running it is all the host shows.
// Plain script (no imports); the types come from ../types.d.ts.

(() => {
  const root = document.getElementById("bar")!;
  let state: HostState | undefined;
  let openMenu: string | undefined;

  interface Item { label: string; action?: MenuAction; key?: string; disabled?: boolean; sep?: boolean }
  const MENUS: Record<string, Item[]> = {
    File: [
      { label: "New tab", action: "newTab", key: "Ctrl+T" },
      { label: "Close tab", action: "closeTab", key: "Ctrl+W" },
      { sep: true, label: "" },
      { label: "Quit", action: "quit" },
    ],
    View: [
      { label: "Reload tab", action: "reloadTab", key: "Ctrl+R" },
      { label: "Next tab", action: "nextTab", key: "Ctrl+Tab" },
      { label: "Previous tab", action: "prevTab", key: "Ctrl+Shift+Tab" },
      { sep: true, label: "" },
      { label: "Full screen", action: "fullscreen" },
      { label: "Developer tools for this app", action: "devTools" },
    ],
    Window: [
      { label: "Welcome", action: "newTab" },
    ],
    Help: [
      { label: "Edit the app list…", action: "editRegistry" },
      { label: "Reload the app list", action: "reloadRegistry" },
      { sep: true, label: "" },
      { label: "About Experiment Studio", action: "about" },
    ],
  };

  function setMenu(name: string | undefined): void {
    openMenu = name;
    window.host.setBarExpanded(name !== undefined);
    render();
  }

  function menuRow(): HTMLElement {
    const row = el("div", { class: "menurow", role: "menubar", "aria-label": "Menu" }, el("div", { class: "brandmark" }, svgNode("flask", 16), "Experiment Studio"));
    for (const name of Object.keys(MENUS)) {
      row.append(el("button", {
        class: "mbtn", type: "button", role: "menuitem", "aria-haspopup": "true", "aria-expanded": String(openMenu === name), "data-menu": name,
        onclick: () => setMenu(openMenu === name ? undefined : name),
        onmouseenter: () => { if (openMenu && openMenu !== name) setMenu(name); },
      }, name));
    }
    row.append(el("span", { class: "spacer" }));
    const n = state?.registryProblems.length ?? 0;
    if (n > 0) row.append(el("button", { class: "chip", type: "button", title: (state?.registryProblems ?? []).join("\n"), onclick: () => window.host.menu("editRegistry") }, `${n} app entr${n === 1 ? "y" : "ies"} skipped`));
    return row;
  }

  function tabRow(): HTMLElement {
    const row = el("div", { class: "tabrow", role: "tablist", "aria-label": "Open apps" });
    for (const t of state?.tabs ?? []) {
      const selected = t.id === state?.activeId;
      const label = t.kind === "app" ? `${t.title} (${t.status})` : t.title;
      row.append(el("div", { class: "tabwrap", style: "display:flex" },
        el("button", {
          class: "tab", type: "button", role: "tab", "aria-selected": String(selected), "data-tab": t.id, title: label, tabindex: selected ? "0" : "-1",
          onclick: () => window.host.activate(t.id),
          onauxclick: (e: MouseEvent) => { if (e.button === 1) window.host.close(t.id); },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "ArrowRight") { e.preventDefault(); window.host.menu("nextTab"); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); window.host.menu("prevTab"); }
          },
        }, svgNode(t.icon, 16), el("span", { class: "ttl" }, t.title), t.kind === "app" ? el("span", { class: `dot ${t.status}`, "aria-hidden": "true" }) : null,
        el("span", { class: "x", role: "button", "aria-label": `Close ${t.title}`, title: "Close tab (Ctrl+W)", "data-close": t.id, onclick: (e: MouseEvent) => { e.stopPropagation(); window.host.close(t.id); } }, svgNode("close", 12)))));
    }
    row.append(el("button", { class: "plus", type: "button", "aria-label": "Open another app", title: "Open another app (Ctrl+T)", "data-action": "new-tab", onclick: () => window.host.newTab() }, svgNode("plus", 16)));
    return row;
  }

  function menuPopup(): HTMLElement[] {
    if (!openMenu) return [];
    const items = MENUS[openMenu] ?? [];
    const left = (document.querySelector(`[data-menu="${openMenu}"]`) as HTMLElement | null)?.getBoundingClientRect().left ?? 0;
    const apps = openMenu === "Window" ? (state?.apps ?? []) : [];
    const menu = el("div", { class: "menu", role: "menu", style: `left:${left}px;top:32px` },
      ...items.map((i) => i.sep ? el("hr") : el("button", { type: "button", role: "menuitem", disabled: i.disabled, onclick: () => { setMenu(undefined); if (i.action) window.host.menu(i.action); } }, i.label, i.key ? el("small", {}, i.key) : null)),
      ...(apps.length ? [el("hr"), ...apps.map((a) => el("button", { type: "button", role: "menuitem", "data-open-app": a.id, onclick: () => { setMenu(undefined); window.host.openApp(a.id); } }, a.name, a.status !== "idle" ? el("small", {}, a.status) : null))] : []));
    return [el("div", { class: "backdrop", onclick: () => setMenu(undefined) }), menu];
  }

  function render(): void {
    root.replaceChildren(el("div", { class: "bar" }, menuRow(), tabRow()), ...menuPopup());
  }

  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenu) setMenu(undefined); });
  window.host.onState((s) => { state = s; render(); });
  void window.host.getState().then((s) => { state = s; render(); });
})();
