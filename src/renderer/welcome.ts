// The host's page under the bar, for the tabs that are not showing a running app: Welcome, an app that is starting, or one that failed.
// Plain script (no imports); the types come from ../types.d.ts.

(() => {
  const root = document.getElementById("page")!;
  const STATUS_TEXT: Record<TabStatus, string> = { idle: "Not open", starting: "Starting…", running: "Open", error: "Failed to start" };

  const INSTALL_TEXT: Record<HostInstall["state"], string> = {
    "not-installed": "Not installed", installed: "Installed", "up-to-date": "Installed, up to date", "update-available": "Update available", blocked: "Needs attention",
  };

  /** One app: whether it is open, whether it is installed, and the buttons that fit. */
  function card(a: HostApp, i: HostInstall | undefined): HTMLElement {
    const kids: (HTMLElement | null)[] = [el("h2", {}, svgNode(a.icon, 18), a.name)];
    const job = i?.job;
    const busy = job?.running === true;
    if (!i) {
      kids.push(el("div", { class: "st" }, el("span", { class: `dot ${a.status}` }), STATUS_TEXT[a.status]));
    } else {
      kids.push(el("div", { class: "st" }, el("span", { class: `dot ${i.state === "blocked" ? "error" : i.state === "not-installed" ? "idle" : a.status === "idle" ? "idle" : a.status}` }), `${INSTALL_TEXT[i.state]}${a.status !== "idle" ? ` · ${STATUS_TEXT[a.status].toLowerCase()}` : ""}`));
      if (i.path) kids.push(el("div", { class: "path", title: i.path }, `${i.path}${i.branch ? `  (${i.branch}${i.head ? ` @ ${i.head}` : ""})` : ""}`));
      if (i.state === "update-available") kids.push(el("div", { class: "msg" }, `${i.behind} new commit${i.behind === 1 ? "" : "s"} on GitHub.`));
      if (i.message) kids.push(el("div", { class: "msg warn" }, i.message));
      if (i.notes && i.state === "not-installed") kids.push(el("div", { class: "msg" }, i.notes));
      for (const p of i.prerequisites.filter((x) => !x.ok)) kids.push(el("div", { class: "msg warn", role: "alert" }, `${p.when === "install" ? "Missing" : "Needed to run"}: ${p.label}. ${p.fix ?? ""}`));
      if (i.candidate && i.state === "not-installed") kids.push(el("div", { class: "msg" }, `Found an existing copy at ${i.candidate}.`));
    }
    if (job) {
      kids.push(job.running
        ? el("div", { class: "status-line", role: "status" }, el("span", { class: "spin" }), `${job.step}…`)
        : job.error ? el("div", { class: "msg err", role: "alert" }, job.error) : null);
      if (job.lines.length) {
        const pre = el("pre", { class: "out small", "aria-label": `Output for ${a.name}` }, job.lines.join("\n"));
        kids.push(el("details", { open: job.running || !!job.error }, el("summary", {}, "Output"), pre));
      }
    }
    const row = el("div", { class: "btnrow" });
    const btn = (label: string, onclick: () => void, kind = "", extra: Record<string, string> = {}) => row.append(el("button", { class: `btn ${kind}`.trim(), type: "button", onclick, ...extra }, label));
    if (busy) {
      btn("Cancel", () => window.host.cancelJob(a.id), "secondary", { "data-cancel": a.id });
    } else if (i && i.state === "not-installed") {
      btn("Install", () => window.host.install(a.id), "", { "data-install": a.id });
      if (i.candidate) btn("Use the existing copy", () => window.host.useFound(a.id), "secondary", { "data-use-found": a.id });
      btn("Choose a folder…", () => window.host.adopt(a.id), "secondary", { "data-adopt": a.id });
    } else {
      if (a.available) btn(a.status === "idle" || a.status === "error" ? "Open" : "Switch to tab", () => window.host.openApp(a.id), "", { "data-open-app": a.id });
      if (i && i.state !== "blocked") {
        if (i.state === "update-available") btn("Update", () => window.host.update(a.id), "", { "data-update": a.id });
        btn("Check for updates", () => window.host.checkUpdates(a.id), "secondary", { "data-check": a.id });
        btn("Reinstall dependencies", () => window.host.install(a.id), "secondary", { "data-install": a.id });
      }
      if (i && i.state === "blocked") btn("Install again", () => window.host.install(a.id), "", { "data-install": a.id });
      if (i && i.path) btn("Forget this copy", () => window.host.forget(a.id), "secondary", { "data-forget": a.id });
    }
    kids.push(row);
    return el("section", { class: "card", "data-app": a.id, "data-install-state": i?.state ?? "" }, ...kids);
  }

  function welcome(s: HostState): HTMLElement[] {
    const out: HTMLElement[] = [
      el("h1", {}, "SEED"),
      el("p", { class: "sub" }, "System for Engineering and Experimental Design. Open an app in a tab. Each app keeps its own saved settings, and the host starts and stops its server for you."),
    ];
    const cards = el("div", { class: "cards" });
    const lesson = s.lesson;
    const lessonButtons = el("div", { class: "btnrow" });
    for (const caseId of lesson.cases) lessonButtons.append(el("button", { class: "btn", type: "button", disabled: lesson.busy, "data-lesson-case": caseId,
      onclick: () => window.host.runLesson(caseId) }, `Run ${caseId}`));
    if (lesson.cancellable) lessonButtons.append(el("button", { class: "btn secondary", type: "button", onclick: () => window.host.cancelLesson() }, "Cancel calculation"));
    if (lesson.canSave && !lesson.busy) lessonButtons.append(el("button", { class: "btn", type: "button", onclick: () => window.host.saveLesson() }, "Save study report"));
    if (lesson.reportId) lessonButtons.append(el("button", { class: "btn secondary", type: "button", onclick: () => window.host.openLessonReport() }, "Open report"));
    out.push(el("section", { class: "card", "data-lesson": "" }, el("h2", {}, "Calculation lesson"),
      el("p", { class: "note" }, "Runs approved cases with the configured study budget. Results keep their verification labels."),
      el("p", { role: "status", "data-lesson-status": "" }, lesson.message), lessonButtons));
    for (const a of s.apps) cards.append(card(a, s.installs.find((i) => i.id === a.id)));
    out.splice(2, 0, el("div", { class: "toolrow" }, el("button", { class: "btn secondary", type: "button", "data-check-all": "", onclick: () => window.host.checkUpdates() }, "Check all for updates"),
      el("span", { class: "path" }, `New installs go to ${s.installRoot}`), el("button", { class: "btn secondary", type: "button", onclick: () => window.host.chooseInstallRoot() }, "Change…")));
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
