import { randomUUID } from "node:crypto";
import { readHostJson } from "../core/hostFiles";
import { validateHostConfiguration } from "../core/fileRunHost";
import { supervisedRun } from "../mcp/supervisor";
import { requestHostCancellation } from "../core/hostControl";
import { exportStudyReport } from "../core/studyReportHost";

/** Desktop client of the same guarded host. No renderer-supplied authority or paths. */
export class Lesson {
  private state: HostLesson = { cases: [], busy: false, message: "Set up a trusted lesson configuration to run a calculation here." };
  private requestId?: string;
  constructor(private config: string | undefined, private header: string | undefined, private changed: () => void,
    private runCase = supervisedRun) {}
  snapshot(): HostLesson {
    try {
      this.state.cases = this.config ? Object.keys(validateHostConfiguration(readHostJson(this.config)).cases) : [];
    } catch (e) { this.state.cases = []; this.state.message = String(e); }
    return structuredClone(this.state);
  }
  async run(caseId: unknown): Promise<void> {
    if (this.state.busy) return;
    try {
      if (!this.config || typeof caseId !== "string") throw Error("Choose a registered lesson case.");
      const c = validateHostConfiguration(readHostJson(this.config));
      if (!Object.hasOwn(c.cases, caseId)) throw Error("Case is not registered.");
      this.requestId = `desktop-${randomUUID()}`;
      this.state = { cases: Object.keys(c.cases), busy: true, cancellable: true, message: "Calculation running. Closing SEED does not cancel it." };
      this.changed();
      const result = await this.runCase(this.config, { requestId: this.requestId, caseId, budget: c.study.budget });
      this.state.message = result.ok ? `Calculation ${result.state}.` : result.errors.map(e => e.message).join("\n");
      this.state.canSave = result.ok && ["completed", "cancelled", "terminated-by-trip"].includes(result.state);
    } catch (e) { this.state.message = e instanceof Error ? e.message : String(e); }
    finally { this.state.busy = false; this.state.cancellable = false; this.changed(); }
  }
  cancel(): void {
    if (!this.state.cancellable || !this.config || !this.requestId) return;
    const reply = requestHostCancellation(this.config, { requestId: this.requestId });
    this.state.message = reply.ok ? "Cancellation requested; waiting for confirmed stop." : reply.errors.map(e => e.message).join("\n");
    this.changed();
  }
  async save(): Promise<void> {
    if (this.state.busy || !this.state.canSave || !this.config || !this.requestId) return;
    this.state.busy = true; this.changed();
    try {
      const reply = await exportStudyReport(this.config, this.header, { requestId: this.requestId });
      this.state.message = reply.ok ? `Report saved: ${reply.report.html}\nNo scientific conclusion has been accepted.` : reply.errors.map(e => e.message).join("\n");
      if (reply.ok) this.state.canSave = false;
    } finally { this.state.busy = false; this.changed(); }
  }
}
