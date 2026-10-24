import type { TypedError } from "./validate";
import { validate } from "./validate";
import { checkResultsAgainstRecord, checkResultsIndex, verifyStudyLog } from "./semantic";

export const COVERAGE_BASIS_NOTE =
  "A quantity is marked verified when a passed oracle entry of its adapter names that quantity. SEED matches by name only: it does not check that this model resembles the case the oracle ran (its fluid, geometry or regime). Verified therefore means the adapter reproduced a reference for a quantity of that name, not that this model is inside the verified range.";

export const EDUCATIONAL_USE_STATEMENT =
  "This report was produced for education. It is not a licensing-grade analysis, a safety assessment or a prediction of the behavior of any real plant. Results hold only under the stated assumptions and within the verified coverage.";

export type Series = {
  x: number[];
  y: number[];
  xLabel: string;
  yLabel: string;
  /** The sha256 of the data file these points were read from; it must equal the one in the run's results index (see requireBoundSeries). */
  dataSha256?: string;
};

export type ReportRun = {
  record: unknown;
  results?: unknown;
  series?: Record<string, Series>;
};

export type ReportInput = {
  studyLines: string[];
  runs: Record<string, ReportRun>;
  staleRunIds?: string[];
  generatedBy: string;
  /**
   * The verified head of the study record. When set, the record must be hash-chained (a log whose hashes were stripped is refused), the line at
   * `seq` must carry `hash` (a log cut short of that line is refused), and with `last` that line must be the final one.
   */
  studyAnchor?: { seq: number; hash: string; last?: boolean };
  /** When true every plotted series must carry `dataSha256`, equal to the data hash its results index lists for that quantity. */
  requireBoundSeries?: boolean;
};

export type ReportOutput = {
  html: string;
  markdown: string;
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeMarkdown(str: string): string {
  const flattened = str.replace(/[\r\n]/g, " ");
  return flattened.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

type StudyHeader = {
  schema: string;
  type: "header";
  seq: 0;
  studyId: string;
  created: string;
  projectId: string;
  question: string;
  hypothesis?: string;
  assumptions: string[];
  parameters: Array<{
    id: string;
    artifact?: string;
    min: number;
    max: number;
    unit?: string;
  }>;
  budget: {
    maxWallSeconds: number;
    maxCores: number;
    maxMemoryMB: number;
    maxDiskMB: number;
  };
  tier: "A0" | "A1" | "A2" | "A3";
  startRevisions: Array<{
    artifact: string;
    revision: string;
  }>;
  setBy: {
    kind: "human";
    name: string;
    model?: string;
    toolVersion?: string;
  };
};

type StudyStep = {
  schema: string;
  type: "step";
  seq: number;
  time: string;
  actor: {
    kind: "human" | "agent" | "system";
    name: string;
    model?: string;
    toolVersion?: string;
  };
  action:
    | "validate"
    | "run"
    | "oracle"
    | "edit"
    | "compare"
    | "collect"
    | "cancel"
    | "note"
    | "gate-stop";
  reason: string;
  inputsChanged: Array<{
    artifact: string;
    before: string;
    after: string;
  }>;
  runs: string[];
  oracle?: {
    set: string;
    verdict: "pass" | "fail" | "not-run";
  };
  gateStop?: {
    request: string;
    rule: string;
  };
};

type StudyConclusion = {
  schema: string;
  type: "conclusion";
  seq: number;
  time: string;
  actor: {
    kind: "human" | "agent";
    name: string;
    model?: string;
    toolVersion?: string;
  };
  claims: Array<{
    text: string;
    runs: string[];
    oracles: string[];
  }>;
};

type RunRecordType = {
  schema: string;
  runId: string;
  attempt: number;
  adapter: { id: string; version: string };
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "terminated-by-trip";
  inputs: Array<{ path: string; sha256: string }>;
  settings: Record<string, unknown>;
  budget: {
    maxWallSeconds: number;
    maxCores: number;
    maxMemoryMB: number;
    maxDiskMB: number;
  };
  createdAt: string;
  engine?: { name: string; version: string };
  dataLibrary?: { id: string; hash?: string };
  jobId?: string;
  native?: { status: string; detail?: string };
  seed?: number;
  budgetUsed?: {
    wallSeconds: number;
    cores: number;
    memoryMB: number;
    diskMB: number;
  };
  startedAt?: string;
  finishedAt?: string;
  cacheKey?: string;
  outputs?: Array<{ path: string; sha256: string }>;
};

type QuantityType = {
  name: string;
  unit: string;
  normalization: string;
  provenance: {
    runId: string;
    inputRevisions: string[];
    mappingRecipe?: string;
  };
  data: { path: string; sha256: string };
  verification: "verified" | "unverified";
  coordinates?: {
    system: string;
    axes: Array<{ name: string; unit: string }>;
  };
  timeGrid?: {
    unit: string;
    start: number;
    stop: number;
    count: number;
  };
  uncertainty?: {
    kind: "statistical" | "input" | "model";
    value: number;
    unit?: string;
  };
};

type ResultsIndexType = {
  schema: string;
  runId: string;
  status: "completed";
  adapter: { id: string; version: string };
  engine: { name: string; version: string };
  inputHashes: Array<{ path: string; sha256: string }>;
  nativeStatus: { status: string; detail?: string };
  quantities: QuantityType[];
  seed?: number;
  oracle?: {
    entries: string[];
    verdict: "pass" | "fail" | "not-run";
  };
};

function prefixField(field: string, runId: string): string {
  if (!field) {
    return `/runs/${runId}`;
  }
  if (field.startsWith("/")) {
    return `/runs/${runId}${field}`;
  }
  return `/runs/${runId}/${field}`;
}

/**
 * Run keys and series keys come from untrusted documents and may be names such as "constructor" or "__proto__":
 * copy them into objects without a prototype so lookups only ever see data the caller supplied.
 */
export function buildReport(
  input: ReportInput
): { ok: true; value: ReportOutput } | { ok: false; errors: TypedError[] } {
  const runs: Record<string, ReportRun> = Object.create(null);
  for (const [key, value] of Object.entries(input.runs ?? {})) {
    const series = value.series ? Object.assign(Object.create(null), value.series) : undefined;
    runs[key] = { ...value, ...(series ? { series } : {}) };
  }
  return buildReportChecked({ ...input, runs });
}

function extent(values: number[]): [number, number] {
  let lo = values[0] as number;
  let hi = values[0] as number;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * Null when a step is not a sampling summary or keeps the two figures apart; otherwise what is wrong. A summary lists outputs (" Output <key> (n ..): mean ...");
 * each one needs "; input spread " and "; sampling noise ". A report is refused rather than shown with a summary that merges the two or leaves one out.
 */
export function samplingSummaryProblem(reason: string): string | null {
  if (!/^(Backfilled from the audit log\. )?Sampling summary /.test(reason)) return null;
  const outputs = reason.split(" Output ").slice(1);
  if (outputs.length === 0) return "a sampling summary lists no output";
  for (const o of outputs) {
    const name = o.slice(0, o.indexOf(" (")) || "an output";
    if (!o.includes("; input spread ")) return `the sampling summary gives no input spread for ${name}: the spread over the inputs and the sampling noise are always given as two figures`;
    if (!o.includes("; sampling noise ")) return `the sampling summary gives no sampling noise for ${name}: the spread over the inputs and the sampling noise are always given as two figures`;
  }
  return null;
}

function buildReportChecked(
  input: ReportInput
): { ok: true; value: ReportOutput } | { ok: false; errors: TypedError[] } {
  // 1. verifyStudyLog(studyLines) returns errors -> return them
  const studyErrors = verifyStudyLog(input.studyLines);
  if (studyErrors.length > 0) {
    return { ok: false, errors: studyErrors };
  }

  // Parse study lines
  let header: StudyHeader | null = null;
  const steps: StudyStep[] = [];
  let conclusion: StudyConclusion | null = null;

  for (const line of input.studyLines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "header") {
      header = parsed as unknown as StudyHeader;
    } else if (parsed.type === "step") {
      steps.push(parsed as unknown as StudyStep);
    } else if (parsed.type === "conclusion") {
      conclusion = parsed as unknown as StudyConclusion;
    }
  }

  if (!header) {
    return {
      ok: false,
      errors: [
        {
          code: "E_SCHEMA_INVALID",
          field: "line/1",
          message: "first line must be a header",
          source: "seed"
        }
      ]
    };
  }

  // A sampling summary (docs/sampling.md) must give, for every output it lists, the input spread and the sampling noise as two figures (plan 09).
  for (const step of steps) {
    const problem = samplingSummaryProblem(typeof step.reason === "string" ? step.reason : "");
    if (problem !== null) {
      return { ok: false, errors: [{ code: "E_SCHEMA_INVALID", field: `/steps/${String(step.seq)}/reason`, message: problem, source: "seed" }] };
    }
  }

  // The anchor: the record must really end where the caller verified it to, and still carry its hash chain.
  if (input.studyAnchor) {
    const a = input.studyAnchor;
    const rows = input.studyLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const bad = (message: string): { ok: false; errors: TypedError[] } => ({
      ok: false,
      errors: [{ code: "E_SCHEMA_INVALID", field: "/studyLines", message, source: "seed" }],
    });
    if (rows.some((r) => typeof r.hash !== "string" || !("prev" in r))) return bad("the study record carries no complete hash chain");
    const at = rows.findIndex((r) => r.seq === a.seq);
    if (at < 0) return bad("the study record is shorter than its verified head (line " + a.seq + " is missing)");
    if (rows[at]!.hash !== a.hash) return bad("the study record does not end in its verified head (the hash at line " + a.seq + " differs)");
    if (a.last && at !== rows.length - 1) return bad("the study record has lines after its verified head");
  }

  // 3. A run ID cited in any step runs or in a conclusion claim runs is not a key of runs
  // -> E_PROP_MISSING, field /runs/<id>, message run cited in the study record is not provided.
  const citedRunIds: string[] = [];
  for (const step of steps) {
    if (Array.isArray(step.runs)) {
      for (const rId of step.runs) {
        if (typeof rId === "string" && !citedRunIds.includes(rId)) {
          citedRunIds.push(rId);
        }
      }
    }
  }
  if (conclusion && Array.isArray(conclusion.claims)) {
    for (const claim of conclusion.claims) {
      if (Array.isArray(claim.runs)) {
        for (const rId of claim.runs) {
          if (typeof rId === "string" && !citedRunIds.includes(rId)) {
            citedRunIds.push(rId);
          }
        }
      }
    }
  }

  // A run that no step and no claim cites does not belong in this report: the caller is passing more than the study record says
  for (const provided of Object.keys(input.runs)) {
    if (!citedRunIds.includes(provided)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_INVALID",
            field: `/runs/${provided}`,
            message: "run is not cited by any step or conclusion claim of the study record",
            source: "seed"
          }
        ]
      };
    }
  }

  for (const citedId of citedRunIds) {
    if (!(citedId in input.runs)) {
      return {
        ok: false,
        errors: [
          {
            code: "E_PROP_MISSING",
            field: `/runs/${citedId}`,
            message: "run cited in the study record is not provided",
            source: "seed"
          }
        ]
      };
    }
  }

  // 2. A run record or results index fails validate, or checkResultsIndex returns errors,
  // or a results index runId differs from its key, or a record runId differs from its key
  // -> return those errors with each field prefixed /runs/<runId>.
  // 4. A completed run with no results -> E_OUTPUT_INCOMPLETE, field /runs/<id>/results.
  // A run that is not completed but has results -> E_OUTPUT_INCOMPLETE.
  // 5. series checks
  const runKeys = Object.keys(input.runs).sort();

  for (const runId of runKeys) {
    const reportRun = input.runs[runId];
    if (!reportRun) {
      continue;
    }

    const recVal = validate("run-record", reportRun.record);
    if (!recVal.ok) {
      return {
        ok: false,
        errors: recVal.errors.map((e) => ({
          ...e,
          field: prefixField(e.field, runId)
        }))
      };
    }

    const record = reportRun.record as RunRecordType;
    if (record.runId !== runId) {
      return {
        ok: false,
        errors: [
          {
            code: "E_SCHEMA_INVALID",
            field: `/runs/${runId}/runId`,
            message: "run record runId does not match run key",
            source: "seed"
          }
        ]
      };
    }

    if (record.state === "completed") {
      if (reportRun.results === undefined || reportRun.results === null) {
        return {
          ok: false,
          errors: [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/runs/${runId}/results`,
              message: "completed run must have results",
              source: "seed"
            }
          ]
        };
      }
    } else {
      if (reportRun.results !== undefined && reportRun.results !== null) {
        return {
          ok: false,
          errors: [
            {
              code: "E_OUTPUT_INCOMPLETE",
              field: `/runs/${runId}/results`,
              message: "non-completed run must not have results",
              source: "seed"
            }
          ]
        };
      }
    }

    if (reportRun.results !== undefined && reportRun.results !== null) {
      const resVal = validate("results-index", reportRun.results);
      if (!resVal.ok) {
        return {
          ok: false,
          errors: resVal.errors.map((e) => ({
            ...e,
            field: prefixField(e.field, runId)
          }))
        };
      }

      const results = reportRun.results as ResultsIndexType;
      if (results.runId !== runId) {
        return {
          ok: false,
          errors: [
            {
              code: "E_SCHEMA_INVALID",
              field: `/runs/${runId}/runId`,
              message: "results index runId does not match run key",
              source: "seed"
            }
          ]
        };
      }

      const provenanceErrors = checkResultsAgainstRecord(reportRun.results, reportRun.record);
      if (provenanceErrors.length > 0) {
        return {
          ok: false,
          errors: provenanceErrors.map((e) => ({
            ...e,
            code: "E_OUTPUT_INCOMPLETE",
            field: prefixField(e.field, runId)
          }))
        };
      }

      const resSemErrors = checkResultsIndex(reportRun.results);
      if (resSemErrors.length > 0) {
        return {
          ok: false,
          errors: resSemErrors.map((e) => ({
            ...e,
            field: prefixField(e.field, runId)
          }))
        };
      }

      if (reportRun.series) {
        const qtyNames = new Set(results.quantities.map((q) => q.name));
        const seriesEntries = Object.entries(reportRun.series).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        );

        for (const [name, s] of seriesEntries) {
          if (!qtyNames.has(name)) {
            return {
              ok: false,
              errors: [
                {
                  code: "E_SCHEMA_INVALID",
                  field: `/runs/${runId}/series/${name}`,
                  message: `series key '${name}' is not a quantity of that run's results`,
                  source: "seed"
                }
              ]
            };
          }

          const listed = results.quantities.find((q) => q.name === name);
          if (s && (s.dataSha256 !== undefined || input.requireBoundSeries) && s.dataSha256 !== listed?.data.sha256) {
            return {
              ok: false,
              errors: [
                {
                  code: "E_OUTPUT_INCOMPLETE",
                  field: `/runs/${runId}/series/${name}/dataSha256`,
                  message: `the plotted series '${name}' is not bound to the data hash in the results index`,
                  source: "seed"
                }
              ]
            };
          }

          if (
            !s ||
            !Array.isArray(s.x) ||
            !Array.isArray(s.y) ||
            s.x.length !== s.y.length ||
            s.x.length === 0 ||
            s.x.some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
            s.y.some((v) => typeof v !== "number" || !Number.isFinite(v))
          ) {
            return {
              ok: false,
              errors: [
                {
                  code: "E_SCHEMA_INVALID",
                  field: `/runs/${runId}/series/${name}`,
                  message: `invalid series points for '${name}'`,
                  source: "seed"
                }
              ]
            };
          }
        }
      }
    }
  }

  // --- Building Content ---

  // Order of completed runs: first appearance in study steps (every provided run is cited, see above)
  const completedRunOrder: string[] = [];
  const completedRunIds = new Set<string>();
  const failedRunOrder: string[] = [];
  const failedRunIds = new Set<string>();

  for (const step of steps) {
    if (Array.isArray(step.runs)) {
      for (const rId of step.runs) {
        const r = input.runs[rId];
        if (r) {
          const rec = r.record as RunRecordType;
          if (rec.state === "completed") {
            if (!completedRunIds.has(rId)) {
              completedRunIds.add(rId);
              completedRunOrder.push(rId);
            }
          } else {
            if (!failedRunIds.has(rId)) {
              failedRunIds.add(rId);
              failedRunOrder.push(rId);
            }
          }
        }
      }
    }
  }

  // a run cited only by a conclusion claim still appears: after the runs of the steps, in ascending order
  for (const rId of runKeys) {
    const r = input.runs[rId];
    if (r && !completedRunIds.has(rId) && !failedRunIds.has(rId)) {
      const rec = r.record as RunRecordType;
      if (rec.state === "completed") {
        completedRunIds.add(rId);
        completedRunOrder.push(rId);
      } else {
        failedRunIds.add(rId);
        failedRunOrder.push(rId);
      }
    }
  }

  // Quantities verified & unverified counts
  let verifiedCount = 0;
  let unverifiedCount = 0;

  for (const rId of completedRunOrder) {
    const r = input.runs[rId];
    if (r && r.results) {
      const res = r.results as ResultsIndexType;
      for (const q of res.quantities) {
        if (q.verification === "verified") {
          verifiedCount++;
        } else if (q.verification === "unverified") {
          unverifiedCount++;
        }
      }
    }
  }

  // Link helper for HTML
  function runLinkHtml(rId: string): string {
    if (completedRunIds.has(rId)) {
      return `<a href="#run-${escapeHtml(rId)}">${escapeHtml(rId)}</a>`;
    }
    if (failedRunIds.has(rId)) {
      return `<a href="#failure-${escapeHtml(rId)}">${escapeHtml(rId)}</a>`;
    }
    return escapeHtml(rId);
  }

  // Stale runs set
  const staleSet = new Set(input.staleRunIds ?? []);

  // Agent sentence
  const agentSteps: number[] = [];
  const agentsMap = new Map<string, [string, string]>(); // JSON key of [name, model] -> [name, model], one entry per distinct pair

  for (const s of steps) {
    if (s.actor.kind === "agent") {
      agentSteps.push(s.seq);
      agentsMap.set(JSON.stringify([s.actor.name, s.actor.model ?? "unknown"]), [s.actor.name, s.actor.model ?? "unknown"]);
    }
  }
  if (conclusion && conclusion.actor.kind === "agent") {
    agentSteps.push(conclusion.seq);
    agentsMap.set(JSON.stringify([conclusion.actor.name, conclusion.actor.model ?? "unknown"]), [conclusion.actor.name, conclusion.actor.model ?? "unknown"]);
  }

  let agentSentence: string;
  if (agentSteps.length > 0 || agentsMap.size > 0) {
    const agentList = Array.from(agentsMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, [name, model]]) => `${name} (${model})`);
    agentSentence = `AI agents took part in steps: ${agentSteps.join(", ")}; agents: ${agentList.join(", ")}.`;
  } else {
    agentSentence = "No AI agent took part.";
  }

  // SVG plot generator
  function renderSvgAndTable(
    qName: string,
    captionText: string,
    series: Series
  ): { svgHtml: string; tableHtml: string; tableMd: string } {
    const [minX, maxX] = extent(series.x);
    const [minY, maxY] = extent(series.y);

    const left = 60;
    const right = 450;
    const top = 30;
    const bottom = 200;
    const width = right - left;
    const height = bottom - top;

    const points: string[] = [];
    for (let i = 0; i < series.x.length; i++) {
      const xVal = series.x[i]!;
      const yVal = series.y[i]!;
      const px = maxX === minX ? (left + right) / 2 : left + ((xVal - minX) / (maxX - minX)) * width;
      const py = maxY === minY ? (top + bottom) / 2 : bottom - ((yVal - minY) / (maxY - minY)) * height;
      points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    }

    const svgHtml = `<svg viewBox="0 0 480 240" role="img" aria-label="${escapeHtml(captionText)}">
<line x1="${left.toFixed(2)}" y1="${top.toFixed(2)}" x2="${left.toFixed(2)}" y2="${bottom.toFixed(2)}" stroke="currentColor" stroke-width="1" />
<line x1="${left.toFixed(2)}" y1="${bottom.toFixed(2)}" x2="${right.toFixed(2)}" y2="${bottom.toFixed(2)}" stroke="currentColor" stroke-width="1" />
<text x="255.00" y="230.00" text-anchor="middle" font-size="12">${escapeHtml(series.xLabel)}</text>
<text x="20.00" y="115.00" text-anchor="middle" font-size="12" transform="rotate(-90 20.00 115.00)">${escapeHtml(series.yLabel)}</text>
<polyline fill="none" stroke="currentColor" stroke-width="2" points="${points.join(" ")}" />
</svg>`;

    const tableRowsHtml = series.x
      .map(
        (xVal, i) =>
          `<tr><td>${String(xVal)}</td><td>${String(series.y[i]!)}</td></tr>`
      )
      .join("\n");

    const tableHtml = `<table>
<caption>Plotted values for ${escapeHtml(qName)}</caption>
<thead>
<tr>
<th scope="col">${escapeHtml(series.xLabel)}</th>
<th scope="col">${escapeHtml(series.yLabel)}</th>
</tr>
</thead>
<tbody>
${tableRowsHtml}
</tbody>
</table>`;

    const tableRowsMd = series.x
      .map(
        (xVal, i) =>
          `| ${String(xVal)} | ${String(series.y[i]!)} |`
      )
      .join("\n");

    const tableMd = `| ${escapeMarkdown(series.xLabel)} | ${escapeMarkdown(series.yLabel)} |
| --- | --- |
${tableRowsMd}`;

    return { svgHtml, tableHtml, tableMd };
  }

  // --- BUILD HTML ---
  const htmlParts: string[] = [];

  htmlParts.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Study ${escapeHtml(header.studyId)}</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 2rem; color: #111; max-width: 960px; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
th { background: #f5f5f5; }
.badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: bold; font-size: 0.85em; }
.badge-unverified { background: #ffebee; color: #c62828; }
.badge-verified { background: #e8f5e9; color: #2e7d32; }
.badge-stale { background: #fff3e0; color: #e65100; }
.warning { padding: 0.75rem; background: #fff3e0; border-left: 4px solid #f57c00; font-weight: bold; }
aside#educational-use { padding: 1rem; background: #e3f2fd; border-left: 4px solid #1976d2; margin: 1rem 0; }
svg { max-width: 480px; height: auto; display: block; margin: 1rem 0; }
</style>
</head>
<body>`);

  // 1. Title
  htmlParts.push(`<header>
<h1>Study ${escapeHtml(header.studyId)}</h1>
<p><strong>Project:</strong> ${escapeHtml(header.projectId)}</p>
<p><strong>Created:</strong> ${escapeHtml(header.created)}</p>
<p><strong>Generated By:</strong> ${escapeHtml(input.generatedBy)}</p>
</header>`);

  // 2. Educational use
  htmlParts.push(`<aside id="educational-use" role="note">
<p>${escapeHtml(EDUCATIONAL_USE_STATEMENT)}</p>
</aside>`);

  // 3. Question and hypothesis; then Assumptions
  htmlParts.push(`<section id="question-hypothesis">
<h2>Question and Hypothesis</h2>
<p><strong>Question:</strong> ${escapeHtml(header.question)}</p>
${header.hypothesis ? `<p><strong>Hypothesis:</strong> ${escapeHtml(header.hypothesis)}</p>` : ""}
<h3>Assumptions</h3>
${header.assumptions && header.assumptions.length > 0 ? `<ul>\n${header.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join("\n")}\n</ul>` : `<p>none stated</p>`}
</section>`);

  // 4. Parameters, bounds, budget and tier
  const paramRowsHtml =
    header.parameters.length > 0
      ? header.parameters
          .map(
            (p) =>
              `<tr><th scope="row">${escapeHtml(p.id)}</th><td>${p.artifact ? escapeHtml(p.artifact) : "-"}</td><td>${String(p.min)}</td><td>${String(p.max)}</td><td>${p.unit ? escapeHtml(p.unit) : "-"}</td></tr>`
          )
          .join("\n")
      : `<tr><td colspan="5">none</td></tr>`;

  htmlParts.push(`<section id="parameters-bounds-budget">
<h2>Parameters, Bounds, Budget and Tier</h2>
<table>
<caption>Parameters</caption>
<thead>
<tr>
<th scope="col">ID</th>
<th scope="col">Artifact</th>
<th scope="col">Min</th>
<th scope="col">Max</th>
<th scope="col">Unit</th>
</tr>
</thead>
<tbody>
${paramRowsHtml}
</tbody>
</table>
<p><strong>Budget:</strong> maxWallSeconds=${String(header.budget.maxWallSeconds)}, maxCores=${String(header.budget.maxCores)}, maxMemoryMB=${String(header.budget.maxMemoryMB)}, maxDiskMB=${String(header.budget.maxDiskMB)}</p>
<p><strong>Tier:</strong> ${escapeHtml(header.tier)}</p>
<p><strong>Set By:</strong> ${escapeHtml(header.setBy.name)} (${escapeHtml(header.setBy.kind)})</p>
</section>`);

  // 5. Inputs and revisions
  const startRevRowsHtml =
    header.startRevisions.length > 0
      ? header.startRevisions
          .map(
            (sr) =>
              `<tr><th scope="row">${escapeHtml(sr.artifact)}</th><td>${escapeHtml(sr.revision)}</td></tr>`
          )
          .join("\n")
      : `<tr><td colspan="2">none</td></tr>`;

  const allInputsChanged: Array<{
    stepSeq: number;
    artifact: string;
    before: string;
    after: string;
  }> = [];
  for (const s of steps) {
    if (Array.isArray(s.inputsChanged)) {
      for (const ic of s.inputsChanged) {
        allInputsChanged.push({
          stepSeq: s.seq,
          artifact: ic.artifact,
          before: ic.before,
          after: ic.after
        });
      }
    }
  }

  const inputsChangedRowsHtml =
    allInputsChanged.length > 0
      ? allInputsChanged
          .map(
            (ic) =>
              `<tr><th scope="row">${String(ic.stepSeq)}</th><td>${escapeHtml(ic.artifact)}</td><td>${escapeHtml(ic.before)}</td><td>${escapeHtml(ic.after)}</td></tr>`
          )
          .join("\n")
      : `<tr><td colspan="4">none</td></tr>`;

  htmlParts.push(`<section id="inputs-revisions">
<h2>Inputs and Revisions</h2>
<table>
<caption>Start Revisions</caption>
<thead>
<tr>
<th scope="col">Artifact</th>
<th scope="col">Revision</th>
</tr>
</thead>
<tbody>
${startRevRowsHtml}
</tbody>
</table>
<table>
<caption>Inputs Changed Across Steps</caption>
<thead>
<tr>
<th scope="col">Step</th>
<th scope="col">Artifact</th>
<th scope="col">Before</th>
<th scope="col">After</th>
</tr>
</thead>
<tbody>
${inputsChangedRowsHtml}
</tbody>
</table>
</section>`);

  // 6. Verification
  const oracleSteps = steps.filter((s) => s.oracle !== undefined);
  const oracleRowsHtml =
    oracleSteps.length > 0
      ? oracleSteps
          .map((s) => {
            const verdict = s.oracle!.verdict;
            const verdictDisplay =
              verdict === "fail"
                ? `<strong>FAIL</strong>`
                : escapeHtml(verdict);
            return `<tr><th scope="row">${String(s.seq)}</th><td>${escapeHtml(s.oracle!.set)}</td><td>${verdictDisplay}</td></tr>`;
          })
          .join("\n")
      : `<tr><td colspan="3">none</td></tr>`;

  htmlParts.push(`<section id="verification">
<h2>Verification</h2>
<table>
<caption>Verification Oracles</caption>
<thead>
<tr>
<th scope="col">Step</th>
<th scope="col">Set</th>
<th scope="col">Verdict</th>
</tr>
</thead>
<tbody>
${oracleRowsHtml}
</tbody>
</table>
<p>Quantities verified: ${String(verifiedCount)}, unverified: ${String(unverifiedCount)}</p>
<p class="coverage-basis">${escapeHtml(COVERAGE_BASIS_NOTE)}</p>
${unverifiedCount > 0 ? `<p class="warning">Warning: ${String(unverifiedCount)} quantities are unverified and outside verified coverage.</p>` : ""}
</section>`);

  // 7. Results
  htmlParts.push(`<section id="results">
<h2>Results</h2>`);

  if (completedRunOrder.length === 0) {
    htmlParts.push(`<p>none</p>`);
  } else {
    for (const rId of completedRunOrder) {
      const r = input.runs[rId]!;
      const rec = r.record as RunRecordType;
      const res = r.results as ResultsIndexType;
      const isStale = staleSet.has(rId);

      const inputHashesRowsHtml = rec.inputs
        .map(
          (inp) =>
            `<tr><th scope="row">${escapeHtml(inp.path)}</th><td>${escapeHtml(inp.sha256)}</td></tr>`
        )
        .join("\n");

      let figuresHtml = "";
      for (const q of res.quantities) {
        const captionText = `Run ${rId}: ${q.name} [${q.unit}; normalization ${q.normalization}]`;
        const captionHtml = `Run ${runLinkHtml(rId)}: ${escapeHtml(q.name)} [${escapeHtml(q.unit)}; normalization ${escapeHtml(q.normalization)}]`;

        let plotHtml = "";
        if (r.series && r.series[q.name]) {
          const plotData = renderSvgAndTable(
            q.name,
            captionText,
            r.series[q.name]!
          );
          plotHtml = `\n${plotData.svgHtml}\n${plotData.tableHtml}`;
        }

        const uncertaintyHtml = q.uncertainty
          ? `<p><strong>Uncertainty:</strong> ${escapeHtml(q.uncertainty.kind)} ${String(q.uncertainty.value)}${q.uncertainty.unit ? " " + escapeHtml(q.uncertainty.unit) : ""}</p>`
          : "";

        const verBadge =
          q.verification === "unverified"
            ? `<span class="badge badge-unverified">UNVERIFIED</span>`
            : `<span class="badge badge-verified">verified (by name)</span>`;

        figuresHtml += `\n<figure>
<figcaption>${captionHtml}</figcaption>
<p><strong>Data:</strong> ${escapeHtml(q.data.path)} (sha256: ${escapeHtml(q.data.sha256)})</p>
<p><strong>Verification:</strong> ${verBadge}</p>
${uncertaintyHtml}${plotHtml}
</figure>`;
      }

      htmlParts.push(`<section id="run-${escapeHtml(rId)}">
<h3>Run ${escapeHtml(rId)}${isStale ? ` <span class="badge badge-stale">STALE</span>` : ""}</h3>
<p><strong>Attempt:</strong> ${String(rec.attempt)}</p>
<p><strong>Adapter:</strong> ${escapeHtml(rec.adapter.id)} (version ${escapeHtml(rec.adapter.version)})</p>
${rec.engine ? `<p><strong>Engine:</strong> ${escapeHtml(rec.engine.name)} (version ${escapeHtml(rec.engine.version)})</p>` : res.engine ? `<p><strong>Engine:</strong> ${escapeHtml(res.engine.name)} (version ${escapeHtml(res.engine.version)})</p>` : ""}
${rec.seed !== undefined ? `<p><strong>Seed:</strong> ${String(rec.seed)}</p>` : res.seed !== undefined ? `<p><strong>Seed:</strong> ${String(res.seed)}</p>` : ""}
<table>
<caption>Input Hashes for Run ${escapeHtml(rId)}</caption>
<thead>
<tr>
<th scope="col">Path</th>
<th scope="col">SHA256</th>
</tr>
</thead>
<tbody>
${inputHashesRowsHtml}
</tbody>
</table>
${figuresHtml}
</section>`);
    }
  }
  htmlParts.push(`</section>`);

  // 8. Failures and refusals
  const gateStopSteps = steps.filter((s) => s.action === "gate-stop");
  htmlParts.push(`<section id="failures-refusals">
<h2>Failures and Refusals</h2>`);

  if (failedRunOrder.length === 0 && gateStopSteps.length === 0) {
    htmlParts.push(`<p>none</p>`);
  } else {
    if (failedRunOrder.length > 0) {
      const failedRowsHtml = failedRunOrder
        .map((rId) => {
          const r = input.runs[rId]!;
          const rec = r.record as RunRecordType;
          return `<tr id="failure-${escapeHtml(rId)}">
<th scope="row"><a href="#failure-${escapeHtml(rId)}">${escapeHtml(rId)}</a></th>
<td>${escapeHtml(rec.state)}</td>
<td>${escapeHtml(rec.native?.status ?? "-")}</td>
<td>${escapeHtml(rec.native?.detail ?? "-")}</td>
<td>${String(rec.attempt)}</td>
<td>${rec.finishedAt ? escapeHtml(rec.finishedAt) : "-"}</td>
</tr>`;
        })
        .join("\n");

      htmlParts.push(`<table>
<caption>Failed and Refused Runs</caption>
<thead>
<tr>
<th scope="col">Run ID</th>
<th scope="col">State</th>
<th scope="col">Native Status</th>
<th scope="col">Native Detail</th>
<th scope="col">Attempt</th>
<th scope="col">Finished At</th>
</tr>
</thead>
<tbody>
${failedRowsHtml}
</tbody>
</table>`);
    }

    if (gateStopSteps.length > 0) {
      const gateStopRowsHtml = gateStopSteps
        .map((s) => {
          return `<tr>
<th scope="row">${String(s.seq)}</th>
<td>${escapeHtml(s.gateStop?.request ?? "-")}</td>
<td>${escapeHtml(s.gateStop?.rule ?? "-")}</td>
<td>${escapeHtml(s.reason)}</td>
</tr>`;
        })
        .join("\n");

      htmlParts.push(`<table>
<caption>Gate Stops</caption>
<thead>
<tr>
<th scope="col">Step</th>
<th scope="col">Request</th>
<th scope="col">Rule</th>
<th scope="col">Reason</th>
</tr>
</thead>
<tbody>
${gateStopRowsHtml}
</tbody>
</table>`);
    }
  }
  htmlParts.push(`</section>`);

  // 9. Steps and actors
  const stepRowsHtml = steps
    .map((s) => {
      const actorStr = `${s.actor.name} (${s.actor.kind}${s.actor.model ? `, ${s.actor.model}` : ""})`;
      const runsStr =
        s.runs && s.runs.length > 0
          ? s.runs.map((rId) => runLinkHtml(rId)).join(", ")
          : "-";
      return `<tr>
<th scope="row">${String(s.seq)}</th>
<td>${escapeHtml(s.time)}</td>
<td>${escapeHtml(actorStr)}</td>
<td>${escapeHtml(s.action)}</td>
<td>${escapeHtml(s.reason)}</td>
<td>${runsStr}</td>
</tr>`;
    })
    .join("\n");

  htmlParts.push(`<section id="steps-actors">
<h2>Steps and Actors</h2>
<table>
<caption>Study Steps</caption>
<thead>
<tr>
<th scope="col">Seq</th>
<th scope="col">Time</th>
<th scope="col">Actor</th>
<th scope="col">Action</th>
<th scope="col">Reason</th>
<th scope="col">Runs</th>
</tr>
</thead>
<tbody>
${stepRowsHtml}
</tbody>
</table>
<p>${escapeHtml(agentSentence)}</p>
</section>`);

  // 10. Conclusion
  htmlParts.push(`<section id="conclusion">
<h2>Conclusion</h2>`);
  if (!conclusion) {
    htmlParts.push(`<p>No conclusion has been recorded.</p>`);
  } else {
    htmlParts.push(`<ul>`);
    for (const claim of conclusion.claims) {
      const runsStr =
        claim.runs && claim.runs.length > 0
          ? claim.runs.map((rId) => runLinkHtml(rId)).join(", ")
          : "none";
      const oraclesStr =
        claim.oracles && claim.oracles.length > 0
          ? claim.oracles.map((o) => escapeHtml(o)).join(", ")
          : "none";
      htmlParts.push(`<li>
<p>${escapeHtml(claim.text)}</p>
<p><strong>Runs:</strong> ${runsStr}</p>
<p><strong>Oracles:</strong> ${oraclesStr}</p>
</li>`);
    }
    htmlParts.push(`</ul>`);
  }
  htmlParts.push(`</section>`);

  // 11. Limits
  htmlParts.push(`<section id="limits">
<h2>Limits</h2>
<p>${escapeHtml(EDUCATIONAL_USE_STATEMENT)}</p>
<p>Quantities marked UNVERIFIED are outside the verified coverage of their adapter.</p>
<p>${escapeHtml(COVERAGE_BASIS_NOTE)}</p>
</section>`);

  htmlParts.push(`</body>\n</html>\n`);

  const htmlOutput = htmlParts.join("\n");

  // --- BUILD MARKDOWN ---
  const mdParts: string[] = [];

  // 1. Title
  mdParts.push(`# Study ${escapeMarkdown(header.studyId)}

Project: ${escapeMarkdown(header.projectId)}  
Created: ${escapeMarkdown(header.created)}  
Generated by: ${escapeMarkdown(input.generatedBy)}`);

  // 2. Educational use
  mdParts.push(`> ${EDUCATIONAL_USE_STATEMENT}`);

  // 3. Question and hypothesis; then Assumptions
  let qhMd = `## Question and Hypothesis

**Question:** ${escapeMarkdown(header.question)}`;
  if (header.hypothesis) {
    qhMd += `  \n**Hypothesis:** ${escapeMarkdown(header.hypothesis)}`;
  }
  qhMd += `\n\n### Assumptions\n\n`;
  if (header.assumptions && header.assumptions.length > 0) {
    qhMd += header.assumptions
      .map((a) => `- ${escapeMarkdown(a)}`)
      .join("\n");
  } else {
    qhMd += "none stated";
  }
  mdParts.push(qhMd);

  // 4. Parameters, bounds, budget and tier
  const paramRowsMd =
    header.parameters.length > 0
      ? header.parameters
          .map(
            (p) =>
              `| ${escapeMarkdown(p.id)} | ${p.artifact ? escapeMarkdown(p.artifact) : "-"} | ${String(p.min)} | ${String(p.max)} | ${p.unit ? escapeMarkdown(p.unit) : "-"} |`
          )
          .join("\n")
      : `| none | - | - | - | - |`;

  mdParts.push(`## Parameters, Bounds, Budget and Tier

| ID | Artifact | Min | Max | Unit |
| --- | --- | --- | --- | --- |
${paramRowsMd}

Budget: maxWallSeconds=${String(header.budget.maxWallSeconds)}, maxCores=${String(header.budget.maxCores)}, maxMemoryMB=${String(header.budget.maxMemoryMB)}, maxDiskMB=${String(header.budget.maxDiskMB)}  
Tier: ${escapeMarkdown(header.tier)}  
Set by: ${escapeMarkdown(header.setBy.name)} (${escapeMarkdown(header.setBy.kind)})`);

  // 5. Inputs and revisions
  const startRevRowsMd =
    header.startRevisions.length > 0
      ? header.startRevisions
          .map(
            (sr) =>
              `| ${escapeMarkdown(sr.artifact)} | ${escapeMarkdown(sr.revision)} |`
          )
          .join("\n")
      : `| none | - |`;

  const inputsChangedRowsMd =
    allInputsChanged.length > 0
      ? allInputsChanged
          .map(
            (ic) =>
              `| ${String(ic.stepSeq)} | ${escapeMarkdown(ic.artifact)} | ${escapeMarkdown(ic.before)} | ${escapeMarkdown(ic.after)} |`
          )
          .join("\n")
      : `| none | - | - | - |`;

  mdParts.push(`## Inputs and Revisions

### Start Revisions

| Artifact | Revision |
| --- | --- |
${startRevRowsMd}

### Inputs Changed

| Step | Artifact | Before | After |
| --- | --- | --- | --- |
${inputsChangedRowsMd}`);

  // 6. Verification
  const oracleRowsMd =
    oracleSteps.length > 0
      ? oracleSteps
          .map((s) => {
            const verdict = s.oracle!.verdict;
            const verdictDisplay =
              verdict === "fail" ? "FAIL" : escapeMarkdown(verdict);
            return `| ${String(s.seq)} | ${escapeMarkdown(s.oracle!.set)} | ${verdictDisplay} |`;
          })
          .join("\n")
      : `| none | - | - |`;

  let verMd = `## Verification

| Step | Set | Verdict |
| --- | --- | --- |
${oracleRowsMd}

Quantities verified: ${String(verifiedCount)}, unverified: ${String(unverifiedCount)}

${COVERAGE_BASIS_NOTE}`;
  if (unverifiedCount > 0) {
    verMd += `\n\n**Warning:** ${String(unverifiedCount)} quantities are unverified and outside verified coverage.`;
  }
  mdParts.push(verMd);

  // 7. Results
  if (completedRunOrder.length === 0) {
    mdParts.push(`## Results\n\nnone`);
  } else {
    const resultsRunsMd: string[] = [];
    for (const rId of completedRunOrder) {
      const r = input.runs[rId]!;
      const rec = r.record as RunRecordType;
      const res = r.results as ResultsIndexType;
      const isStale = staleSet.has(rId);

      const inputHashesRowsMd = rec.inputs
        .map(
          (inp) =>
            `| ${escapeMarkdown(inp.path)} | ${escapeMarkdown(inp.sha256)} |`
        )
        .join("\n");

      const figuresMdParts: string[] = [];
      for (const q of res.quantities) {
        const captionText = `Run ${rId}: ${q.name} [${q.unit}; normalization ${q.normalization}]`;
        const verText = q.verification === "unverified" ? "UNVERIFIED" : "verified (by name)";
        const uncertaintyMd = q.uncertainty
          ? `\nUncertainty: ${escapeMarkdown(q.uncertainty.kind)} ${String(q.uncertainty.value)}${q.uncertainty.unit ? " " + escapeMarkdown(q.uncertainty.unit) : ""}`
          : "";

        let plotMd = "";
        if (r.series && r.series[q.name]) {
          const plotData = renderSvgAndTable(
            q.name,
            captionText,
            r.series[q.name]!
          );
          plotMd = `\n\n${plotData.tableMd}`;
        }

        figuresMdParts.push(`Figure: Run \`${rId}\`: ${escapeMarkdown(q.name)} [${escapeMarkdown(q.unit)}; normalization ${escapeMarkdown(q.normalization)}] (Data: ${escapeMarkdown(q.data.path)}, sha256: ${escapeMarkdown(q.data.sha256)})
Verification: ${verText}${uncertaintyMd}${plotMd}`);
      }

      let runHeaderMd = `### Run \`${rId}\``;
      if (isStale) {
        runHeaderMd += ` STALE`;
      }

      let runMetaMd = `- Attempt: ${String(rec.attempt)}
- Adapter: ${escapeMarkdown(rec.adapter.id)} (${escapeMarkdown(rec.adapter.version)})`;
      if (rec.engine) {
        runMetaMd += `\n- Engine: ${escapeMarkdown(rec.engine.name)} (${escapeMarkdown(rec.engine.version)})`;
      } else if (res.engine) {
        runMetaMd += `\n- Engine: ${escapeMarkdown(res.engine.name)} (${escapeMarkdown(res.engine.version)})`;
      }
      if (rec.seed !== undefined) {
        runMetaMd += `\n- Seed: ${String(rec.seed)}`;
      } else if (res.seed !== undefined) {
        runMetaMd += `\n- Seed: ${String(res.seed)}`;
      }

      resultsRunsMd.push(`${runHeaderMd}

${runMetaMd}

#### Input Hashes

| Path | SHA256 |
| --- | --- |
${inputHashesRowsMd}

${figuresMdParts.join("\n\n")}`);
    }

    mdParts.push(`## Results\n\n${resultsRunsMd.join("\n\n")}`);
  }

  // 8. Failures and refusals
  if (failedRunOrder.length === 0 && gateStopSteps.length === 0) {
    mdParts.push(`## Failures and Refusals\n\nnone`);
  } else {
    const fParts: string[] = [`## Failures and Refusals`];
    if (failedRunOrder.length > 0) {
      const failedRowsMd = failedRunOrder
        .map((rId) => {
          const r = input.runs[rId]!;
          const rec = r.record as RunRecordType;
          return `| \`${rId}\` | ${escapeMarkdown(rec.state)} | ${escapeMarkdown(rec.native?.status ?? "-")} | ${escapeMarkdown(rec.native?.detail ?? "-")} | ${String(rec.attempt)} | ${rec.finishedAt ? escapeMarkdown(rec.finishedAt) : "-"} |`;
        })
        .join("\n");

      fParts.push(`### Failed and Refused Runs

| Run ID | State | Native Status | Native Detail | Attempt | Finished At |
| --- | --- | --- | --- | --- | --- |
${failedRowsMd}`);
    }

    if (gateStopSteps.length > 0) {
      const gateStopRowsMd = gateStopSteps
        .map((s) => {
          return `| ${String(s.seq)} | ${escapeMarkdown(s.gateStop?.request ?? "-")} | ${escapeMarkdown(s.gateStop?.rule ?? "-")} | ${escapeMarkdown(s.reason)} |`;
        })
        .join("\n");

      fParts.push(`### Gate Stops

| Step | Request | Rule | Reason |
| --- | --- | --- | --- |
${gateStopRowsMd}`);
    }

    mdParts.push(fParts.join("\n\n"));
  }

  // 9. Steps and actors
  const stepRowsMd = steps
    .map((s) => {
      const actorStr = `${s.actor.name} (${s.actor.kind}${s.actor.model ? `, ${s.actor.model}` : ""})`;
      const runsStr =
        s.runs && s.runs.length > 0
          ? s.runs.map((rId) => `\`${rId}\``).join(", ")
          : "-";
      return `| ${String(s.seq)} | ${escapeMarkdown(s.time)} | ${escapeMarkdown(actorStr)} | ${escapeMarkdown(s.action)} | ${escapeMarkdown(s.reason)} | ${runsStr} |`;
    })
    .join("\n");

  mdParts.push(`## Steps and Actors

| Seq | Time | Actor | Action | Reason | Runs |
| --- | --- | --- | --- | --- | --- |
${stepRowsMd}

${escapeMarkdown(agentSentence)}`);

  // 10. Conclusion
  let conclMd = `## Conclusion\n\n`;
  if (!conclusion) {
    conclMd += "No conclusion has been recorded.";
  } else {
    conclMd += conclusion.claims
      .map((c) => {
        const runsStr =
          c.runs && c.runs.length > 0
            ? c.runs.map((rId) => `\`${rId}\``).join(", ")
            : "none";
        const oraclesStr =
          c.oracles && c.oracles.length > 0
            ? c.oracles.map((o) => escapeMarkdown(o)).join(", ")
            : "none";
        return `- ${escapeMarkdown(c.text)}\n  - Runs: ${runsStr}\n  - Oracles: ${oraclesStr}`;
      })
      .join("\n");
  }
  mdParts.push(conclMd);

  // 11. Limits
  mdParts.push(`## Limits

> ${EDUCATIONAL_USE_STATEMENT}

Quantities marked UNVERIFIED are outside the verified coverage of their adapter.

${COVERAGE_BASIS_NOTE}`);

  const markdownOutput = mdParts.join("\n\n") + "\n";

  return {
    ok: true,
    value: {
      html: htmlOutput,
      markdown: markdownOutput
    }
  };
}
