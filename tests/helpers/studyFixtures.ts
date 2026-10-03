import { canonicalJson, sha256Hex } from "../../src/core/canonical";
import type { Series } from "../../src/core/report";

export const SAMPLE_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const SAMPLE_SHA256_2 =
  "eebf0627cf9ff85dda4644691ae49fae4b64d38fe5d864d17a9a5df11222eb81";

export function makeHeader(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "seed.study/0.1",
    type: "header",
    seq: 0,
    studyId: "study-01",
    created: "2026-10-03T12:00:00Z",
    projectId: "proj-1",
    question: "How does core power evolve under perturbation?",
    hypothesis: "Core power will stabilize within 5 seconds.",
    assumptions: ["Uniform moderator temperature", "No xenon transient"],
    parameters: [
      { id: "coolant_flow", artifact: "art-1", min: 100, max: 200, unit: "kg/s" }
    ],
    budget: {
      maxWallSeconds: 300,
      maxCores: 4,
      maxMemoryMB: 2048,
      maxDiskMB: 4096
    },
    tier: "A1",
    startRevisions: [{ artifact: "art-1", revision: SAMPLE_SHA256 }],
    setBy: { kind: "human", name: "Alice" },
    ...overrides
  };
}

export function makeStep(
  seq: number,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema: "seed.study/0.1",
    type: "step",
    seq,
    time: "2026-10-03T12:01:00Z",
    actor: { kind: "human", name: "Alice" },
    action: "run",
    reason: `Run simulation step ${seq}`,
    inputsChanged: [],
    runs: [`run-${seq}`],
    ...overrides
  };
}

export function makeConclusion(
  seq: number,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema: "seed.study/0.1",
    type: "conclusion",
    seq,
    time: "2026-10-03T12:15:00Z",
    actor: { kind: "human", name: "Alice" },
    claims: [
      {
        text: "Perturbation stabilized within 4.2 seconds under nominal flow.",
        runs: ["run-1"],
        oracles: ["orc-1"]
      }
    ],
    ...overrides
  };
}

export function buildStudyLog(rawObjects: Array<Record<string, unknown>>): string[] {
  let prevHash: string | null = null;
  return rawObjects.map((raw) => {
    const lineObj = { ...raw, prev: prevHash };
    const hash = sha256Hex(canonicalJson(lineObj));
    prevHash = hash;
    return JSON.stringify({ ...lineObj, hash });
  });
}

export function makeRunRecord(
  runId: string,
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "terminated-by-trip" = "completed",
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const isFinished =
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "interrupted" ||
    state === "terminated-by-trip";

  const rec: Record<string, unknown> = {
    schema: "seed.run-record/0.1",
    runId,
    attempt: 1,
    adapter: { id: "openmc-adapter", version: "0.1.0" },
    state,
    inputs: [{ path: "models/core.xml", sha256: SAMPLE_SHA256 }],
    settings: { tolerance: 1e-4 },
    budget: {
      maxWallSeconds: 300,
      maxCores: 4,
      maxMemoryMB: 2048,
      maxDiskMB: 4096
    },
    createdAt: "2026-10-03T12:00:00Z",
    engine: { name: "OpenMC", version: "0.14.0" },
    native: { status: state === "completed" ? "0" : "1", detail: state === "completed" ? "clean exit" : "error occurred" },
    ...overrides
  };

  if (isFinished && !("finishedAt" in rec)) {
    rec.finishedAt = "2026-10-03T12:05:00Z";
  }

  if (state === "completed" && !("outputs" in rec)) {
    rec.outputs = [{ path: "results/output.h5", sha256: SAMPLE_SHA256 }];
  }

  return rec;
}

export function makeQuantity(
  name: string,
  verification: "verified" | "unverified" = "verified",
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    name,
    unit: "W",
    normalization: "none",
    provenance: {
      runId: "run-1",
      inputRevisions: [SAMPLE_SHA256]
    },
    data: { path: `data/${name}.csv`, sha256: SAMPLE_SHA256 },
    verification,
    ...overrides
  };
}

export function makeResultsIndex(
  runId: string,
  quantities?: Array<Record<string, unknown>>,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const qs = quantities ?? [makeQuantity("power", "verified", { provenance: { runId, inputRevisions: [SAMPLE_SHA256] } })];
  // ensure quantities have runId in provenance
  const fixedQs = qs.map((q) => {
    const prov = (q.provenance as Record<string, unknown> | undefined) ?? {};
    return {
      ...q,
      provenance: {
        ...prov,
        runId
      }
    };
  });

  return {
    schema: "seed.results-index/0.1",
    runId,
    status: "completed",
    adapter: { id: "openmc-adapter", version: "0.1.0" },
    engine: { name: "OpenMC", version: "0.14.0" },
    inputHashes: [{ path: "models/core.xml", sha256: SAMPLE_SHA256 }],
    nativeStatus: { status: "0", detail: "normal completion" },
    quantities: fixedQs,
    ...overrides
  };
}

export function makeSeries(
  pointsCount: number = 5,
  xLabel: string = "Time (s)",
  yLabel: string = "Power (W)"
): Series {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < pointsCount; i++) {
    x.push(i);
    y.push(100 + i * 10);
  }
  return { x, y, xLabel, yLabel };
}
