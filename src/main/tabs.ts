// The tab model: which tabs are open and which is active. Pure data, no Electron, so it is unit-tested directly.
// There is at most one tab per app and one Welcome tab (the page the + button opens).

export type TabKind = "welcome" | "app" | "report";

export interface Tab {
  id: string;
  kind: TabKind;
  appId?: string;
  reportId?: string;
  title: string;
}

export class TabModel {
  openReport(reportId: string, title: string): Tab {
    const existing = this.tabs.find(t => t.kind === "report" && t.reportId === reportId);
    if (existing) { this.activeId = existing.id; return existing; }
    return this.add({ id: `report:${reportId}`, kind: "report", reportId, title });
  }
  tabs: Tab[] = [];
  activeId: string | undefined;

  openWelcome(): Tab {
    const existing = this.tabs.find((t) => t.kind === "welcome");
    if (existing) { this.activeId = existing.id; return existing; }
    return this.add({ id: "welcome", kind: "welcome", title: "Welcome" });
  }

  openApp(appId: string, title: string): Tab {
    const existing = this.tabs.find((t) => t.kind === "app" && t.appId === appId);
    if (existing) { this.activeId = existing.id; return existing; }
    return this.add({ id: `app:${appId}`, kind: "app", appId, title });
  }

  /** Removes a tab. The neighbour to the right becomes active, else the one on the left. Returns the new active id. */
  close(id: string): string | undefined {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return this.activeId;
    this.tabs.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.tabs[i] ?? this.tabs[i - 1])?.id;
    return this.activeId;
  }

  activate(id: string): boolean {
    if (!this.tabs.some((t) => t.id === id)) return false;
    this.activeId = id;
    return true;
  }

  next(): void { this.step(1); }
  prev(): void { this.step(-1); }

  /** Ctrl+1..8 pick that tab; 9 picks the last one, as browsers do. */
  activateIndex(n: number): boolean {
    if (this.tabs.length === 0 || n < 1) return false;
    const t = n >= 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (!t) return false;
    this.activeId = t.id;
    return true;
  }

  move(id: string, to: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, t!);
  }

  private add(t: Tab): Tab {
    this.tabs.push(t);
    this.activeId = t.id;
    return t;
  }

  private step(d: number): void {
    if (this.tabs.length === 0) return;
    const i = Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId));
    this.activeId = this.tabs[(i + d + this.tabs.length) % this.tabs.length]!.id;
  }
}
