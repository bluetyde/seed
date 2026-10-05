import { randomUUID } from "node:crypto";
import { readHostJson } from "../core/hostFiles";
import { validateHostConfiguration } from "../core/fileRunHost";
import { supervisedRun } from "../mcp/supervisor";
import { requestHostCancellation } from "../core/hostControl";
import { exportStudyReport } from "../core/studyReportHost";
import { lessonHistory, saveLessonIntent } from "../core/lessonHistory";
import { proposeReportConclusion } from "../core/conclusionDraft";

/** Desktop client of the same guarded host. No renderer-supplied authority or paths. */
export class Lesson {
  private state: HostLesson = { cases: [], busy: false, message: "Set up a trusted lesson configuration to run a calculation here." };
  private requestId?: string;
  private operating = false;
  private observedAfter = Date.now();
  private lastStatus = "";
  private preserveMessage = false;
  private offset = 0;
  notice(message: string): void { this.state.message = message; this.preserveMessage = true; this.changed(); }
  async propose(text: unknown, reportId: unknown): Promise<void> {
    if (this.operating || !this.config || !this.state.reportId || reportId !== this.state.reportId) return;
    this.operating = true;
    try {
      const result = await proposeReportConclusion(this.config, this.state.reportId, text);
      this.notice(result.ok ? "Conclusion draft saved. It has not been accepted. Use Review conclusion drafts." : result.errors.map(e => e.message).join("; "));
    } catch (error) { this.notice(String(error)); }
    finally { this.operating = false; }
  }
  page(offset: unknown): void { if (Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) < 1000 && (offset as number) % 50 === 0) { this.offset = offset as number; this.changed(); } }
  select(requestId: unknown): void {
    if (this.operating || typeof requestId !== "string" || !this.config) return;
    try {
      if (!lessonHistory(this.config, this.observedAfter).items.some(i => i.requestId === requestId)) return;
      this.requestId = requestId; this.lastStatus = ""; this.snapshot(); this.changed();
    } catch (e) { this.state.message = String(e); this.changed(); }
  }
  constructor(private config: string | undefined, private header: string | undefined, private changed: () => void,
    private runCase = supervisedRun, private openReport: (id: string) => Promise<void> = async () => {}) {}
  async openSaved(): Promise<void> {
    if (!this.state.reportId) return;
    try {
      await this.openReport(this.state.reportId);
      if (this.state.message.startsWith("Report saved, but could not open:")) this.state.message = "Report opened. No scientific conclusion has been accepted.";
    }
    catch (e) { this.state.message = `Report saved, but could not open: ${e instanceof Error ? e.message : String(e)}. Use Open report to retry.`; }
    this.preserveMessage = true; this.changed();
  }
  snapshot(): HostLesson {
    try {
      this.state.cases = this.config ? Object.keys(validateHostConfiguration(readHostJson(this.config)).cases) : [];
      if (this.config) {
        const history = lessonHistory(this.config, this.observedAfter);
        this.state.history = history.items.slice(this.offset, this.offset + 50); this.state.historyOffset = this.offset; this.state.historyTotal = history.items.length; this.state.blocked = history.blocked;
        if (history.warning) this.state.message = history.warning;
        if (!this.operating) {
          this.requestId ??= history.items[0]?.requestId;
          const selected = history.items.find(i => i.requestId === this.requestId);
          this.state.canSave = !!selected?.canSave; this.state.cancellable = !!selected?.cancellable;
          this.state.busy = selected?.status === "running"; this.state.reportId = selected?.reportId;
          const statusKey = selected ? selected.requestId + selected.status + (selected.reportId ?? "") + (selected.reportError ?? "") : "";
          if (selected && statusKey !== this.lastStatus) { if (!this.preserveMessage) this.state.message = `${selected.caseId}: ${selected.status}${selected.reportError ? ". " + selected.reportError : ""}`; this.lastStatus = statusKey; }
          this.preserveMessage = false;
        }
        if (history.warning) this.state.message = history.warning;
        if (!history.items.length && this.state.message.startsWith("Set up a trusted lesson")) this.state.message = "Choose a registered case to begin.";
      }
    } catch (e) {
      const active = this.state.busy && !!this.requestId;
      this.state.cases = []; this.state.history = []; this.state.canSave = false; this.state.cancellable = active;
      this.state.reportId = undefined; this.state.blocked = true; this.state.message = `Lesson history unavailable: ${String(e)}${active ? ". Cancellation will still use fresh host checks." : ""}`;
    }
    return structuredClone(this.state);
  }
  async run(caseId: unknown): Promise<void> {
    if (this.operating || this.snapshot().blocked || this.state.busy) return;
    try {
      if (!this.config || typeof caseId !== "string") throw Error("Choose a registered lesson case.");
      const c = validateHostConfiguration(readHostJson(this.config));
      if (!Object.hasOwn(c.cases, caseId)) throw Error("Case is not registered.");
      this.requestId = `desktop-${randomUUID()}`;
      saveLessonIntent(this.config, this.requestId, caseId);
      this.operating = true;
      this.state = { cases: Object.keys(c.cases), busy: true, cancellable: true, message: "Calculation running. Closing SEED does not cancel it." };
      this.changed();
      const result = await this.runCase(this.config, { requestId: this.requestId, caseId, budget: c.study.budget });
      this.state.message = result.ok ? `Calculation ${result.state}.` : result.errors.map(e => e.message).join("\n");
      this.state.canSave = result.ok && ["completed", "cancelled", "terminated-by-trip"].includes(result.state);
    } catch (e) { this.state.message = e instanceof Error ? e.message : String(e); }
    finally { this.state.busy = false; this.state.cancellable = false; this.operating = false; this.preserveMessage = true; this.changed(); }
  }
  cancel(): void {
    if (!this.state.cancellable || !this.config || !this.requestId) return;
    const reply = requestHostCancellation(this.config, { requestId: this.requestId });
    this.state.message = reply.ok ? "Cancellation requested; waiting for confirmed stop." : reply.errors.map(e => e.message).join("\n");
    this.changed();
  }
  async save(): Promise<void> {
    if (this.operating || this.state.busy || !this.state.canSave || !this.config || !this.requestId) return;
    this.operating = true;
    this.state.busy = true; this.changed();
    try {
      const reply = await exportStudyReport(this.config, this.header, { requestId: this.requestId });
      this.state.message = reply.ok ? `Report saved: ${reply.report.html}\nNo scientific conclusion has been accepted.` : reply.errors.map(e => e.message).join("\n");
      if (reply.ok) { this.state.canSave = false; this.state.reportId = reply.reportId; await this.openSaved(); }
    } finally { this.state.busy = false; this.operating = false; this.preserveMessage = true; this.changed(); }
  }
}
