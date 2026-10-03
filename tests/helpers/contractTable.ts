import type { Family } from "../../src/core/validate";

export type Bound = {
  prop: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type ObjectSpec = {
  name: string;
  family: Family;
  fixture: string;
  pointer: string;
  required: string[];
  optional: string[];
  strict: boolean;
  enums: { prop: string; values: unknown[]; acceptedValues?: unknown[] }[];
  bounds: Bound[];
  arrayItems?: { prop: string; minItems?: number };
};

export const CONTRACT_TABLE: ObjectSpec[] = [
  // --- Section 0: Common Conventions ---
  {
    name: "common.budget",
    family: "adapter-request",
    fixture: "good/adapter-request-full-run.json",
    pointer: "/budget",
    required: ["maxWallSeconds", "maxCores", "maxMemoryMB", "maxDiskMB"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "maxWallSeconds", minimum: 1 },
      { prop: "maxCores", minimum: 1 },
      { prop: "maxMemoryMB", minimum: 1 },
      { prop: "maxDiskMB", minimum: 1 }
    ]
  },
  {
    name: "common.revision",
    family: "adapter-request",
    fixture: "good/adapter-request-full-open.json",
    pointer: "/artifact/revision",
    required: ["hash", "counter"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "hash", minLength: 64, maxLength: 64 },
      { prop: "counter", minimum: 0 }
    ]
  },
  {
    name: "common.actor",
    family: "adapter-request",
    fixture: "good/adapter-request-full-describe.json",
    pointer: "/actor",
    required: ["kind", "name"],
    optional: ["model", "toolVersion"],
    strict: true,
    enums: [
      { prop: "kind", values: ["human", "agent", "system"] }
    ],
    bounds: [
      { prop: "name", minLength: 1, maxLength: 80 },
      { prop: "model", minLength: 1, maxLength: 80 },
      { prop: "toolVersion", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "common.nativeStatus",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-status.json",
    pointer: "/result/native",
    required: ["status"],
    optional: ["detail"],
    strict: true,
    enums: [],
    bounds: [
      { prop: "status", minLength: 1, maxLength: 80 },
      { prop: "detail", minLength: 0, maxLength: 2000 }
    ]
  },
  {
    name: "common.typedError",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-validate.json",
    pointer: "/result/problems/0",
    required: ["code", "field", "message", "source"],
    optional: ["unit", "range"],
    strict: true,
    enums: [
      { prop: "source", values: ["seed", "app-content"] }
    ],
    bounds: [
      { prop: "message", minLength: 1, maxLength: 1000 },
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "common.typedError.range",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-validate.json",
    pointer: "/result/problems/0/range",
    required: [],
    optional: ["min", "max"],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "common.inputRef",
    family: "adapter-request",
    fixture: "good/adapter-request-full-run.json",
    pointer: "/snapshot/inputs/0",
    required: ["path", "sha256"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "path", minLength: 1, maxLength: 512 },
      { prop: "sha256", minLength: 64, maxLength: 64 }
    ]
  },

  // --- Section 1: Adapter Request Verbs ---
  {
    name: "request.describe",
    family: "adapter-request",
    fixture: "good/adapter-request-full-describe.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor"],
    optional: ["extensions"],
    strict: true,
    enums: [
      { prop: "verb", values: ["describe"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "request.open",
    family: "adapter-request",
    fixture: "good/adapter-request-full-open.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "artifact"],
    optional: ["extensions"],
    strict: true,
    enums: [
      { prop: "verb", values: ["open"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "request.open.artifact",
    family: "adapter-request",
    fixture: "good/adapter-request-full-open.json",
    pointer: "/artifact",
    required: ["path", "revision"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "path", minLength: 1, maxLength: 512 }
    ]
  },
  {
    name: "request.validate",
    family: "adapter-request",
    fixture: "good/adapter-request-full-validate.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "artifact"],
    optional: ["extensions", "operation"],
    strict: true,
    enums: [
      { prop: "verb", values: ["validate"] },
      { prop: "operation", values: ["run", "open"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "request.run",
    family: "adapter-request",
    fixture: "good/adapter-request-full-run.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "snapshot", "runDir", "budget"],
    optional: ["extensions", "settings", "seed", "cacheReuse"],
    strict: true,
    enums: [
      { prop: "verb", values: ["run"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "runDir", minLength: 1, maxLength: 512 },
      { prop: "seed", minimum: 0 }
    ]
  },
  {
    name: "request.run.snapshot",
    family: "adapter-request",
    fixture: "good/adapter-request-full-run.json",
    pointer: "/snapshot",
    required: ["inputs"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "inputs", minItems: 1 }
    ]
  },
  {
    name: "request.status",
    family: "adapter-request",
    fixture: "good/adapter-request-full-status.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "jobId"],
    optional: ["extensions"],
    strict: true,
    enums: [
      { prop: "verb", values: ["status"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "jobId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "request.cancel",
    family: "adapter-request",
    fixture: "good/adapter-request-full-cancel.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "jobId"],
    optional: ["extensions"],
    strict: true,
    enums: [
      { prop: "verb", values: ["cancel"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "jobId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "request.collect",
    family: "adapter-request",
    fixture: "good/adapter-request-full-collect.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "actor", "jobId", "runDir"],
    optional: ["extensions"],
    strict: true,
    enums: [
      { prop: "verb", values: ["collect"] }
    ],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "jobId", minLength: 1, maxLength: 64 },
      { prop: "runDir", minLength: 1, maxLength: 512 }
    ]
  },

  // --- Section 2: Adapter Reply Envelope and Results ---
  {
    name: "reply.envelope.ok",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "ok", "errors", "warnings", "result"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "errors", maxItems: 0 }
    ]
  },
  {
    name: "reply.envelope.error",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-error.json",
    pointer: "",
    required: ["schema", "verb", "requestId", "ok", "errors", "warnings"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "requestId", minLength: 1, maxLength: 64 },
      { prop: "errors", minItems: 1 }
    ]
  },
  {
    name: "reply.describe.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result",
    required: ["app", "formats", "capabilities", "parameters", "quantities", "oracleCoverage"],
    optional: ["engine", "oraclePin"],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "reply.describe.result.app",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/app",
    required: ["id", "name", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "reply.describe.result.engine",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/engine",
    required: ["name", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "reply.describe.result.formats",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/formats/0",
    required: ["id", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "reply.describe.result.parameters",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/parameters/0",
    required: ["id", "type"],
    optional: ["unit", "min", "max", "enum"],
    strict: true,
    enums: [
      { prop: "type", values: ["number", "integer", "string", "boolean"] }
    ],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 },
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "reply.describe.result.quantities",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/quantities/0",
    required: ["name", "unit", "normalization"],
    optional: [],
    strict: true,
    enums: [
      { prop: "normalization", values: ["none", "per-source-particle", "per-fission", "per-demand", "per-hour", "per-second", "per-watt"] }
    ],
    bounds: [
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "reply.describe.result.oracleCoverage",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/oracleCoverage/0",
    required: ["quantity", "domain"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "reply.describe.result.oraclePin",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-describe.json",
    pointer: "/result/oraclePin",
    required: ["sha256", "commit"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "sha256", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "reply.open.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-open.json",
    pointer: "/result",
    required: ["editor"],
    optional: [],
    strict: true,
    enums: [
      { prop: "editor", values: ["opened", "focused"] }
    ],
    bounds: []
  },
  {
    name: "reply.validate.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-validate.json",
    pointer: "/result",
    required: ["valid", "problems"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "reply.run.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-run.json",
    pointer: "/result",
    required: ["jobId", "runDir", "lifecycle"],
    optional: [],
    strict: true,
    enums: [
      { prop: "lifecycle", values: ["queued", "running"] }
    ],
    bounds: [
      { prop: "jobId", minLength: 1, maxLength: 64 },
      { prop: "runDir", minLength: 1, maxLength: 512 }
    ]
  },
  {
    name: "reply.status.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-full-status.json",
    pointer: "/result",
    required: ["jobId", "lifecycle", "native"],
    optional: ["startedAt", "finishedAt"],
    strict: true,
    enums: [
      { prop: "lifecycle", values: ["queued", "running", "completed", "failed", "cancelled", "interrupted", "terminated-by-trip"] }
    ],
    bounds: [
      { prop: "jobId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "reply.cancel.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-cancel.json",
    pointer: "/result",
    required: ["jobId", "lifecycle", "cancelled"],
    optional: [],
    strict: true,
    enums: [
      { prop: "lifecycle", values: ["queued", "running", "completed", "failed", "cancelled", "interrupted", "terminated-by-trip"] }
    ],
    bounds: [
      { prop: "jobId", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "reply.collect.result",
    family: "adapter-reply",
    fixture: "good/adapter-reply-collect.json",
    pointer: "/result",
    required: ["jobId", "lifecycle", "resultsIndex", "resultsSha256"],
    optional: [],
    strict: true,
    enums: [
      { prop: "lifecycle", values: ["completed"] }
    ],
    bounds: [
      { prop: "jobId", minLength: 1, maxLength: 64 },
      { prop: "resultsIndex", minLength: 1, maxLength: 512 },
      { prop: "resultsSha256", minLength: 64, maxLength: 64 }
    ]
  },

  // --- Section 3: Results Index ---
  {
    name: "resultsIndex",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "",
    required: ["schema", "runId", "status", "adapter", "engine", "inputHashes", "nativeStatus", "quantities"],
    optional: ["seed", "oracle", "extensions"],
    strict: true,
    enums: [
      { prop: "status", values: ["completed"] }
    ],
    bounds: [
      { prop: "runId", minLength: 1, maxLength: 64 },
      { prop: "seed", minimum: 0 },
      { prop: "inputHashes", minItems: 1 },
      { prop: "quantities", minItems: 1 }
    ]
  },
  {
    name: "resultsIndex.adapter",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/adapter",
    required: ["id", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "resultsIndex.engine",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/engine",
    required: ["name", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "resultsIndex.inputHashes",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/inputHashes/0",
    required: ["path", "sha256"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "path", minLength: 1, maxLength: 512 },
      { prop: "sha256", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "resultsIndex.oracle",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/oracle",
    required: ["entries", "verdict"],
    optional: [],
    strict: true,
    enums: [
      { prop: "verdict", values: ["pass", "fail", "not-run"] }
    ],
    bounds: []
  },
  {
    name: "resultsIndex.quantities",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0",
    required: ["name", "unit", "normalization", "provenance", "data", "verification"],
    optional: ["coordinates", "timeGrid", "uncertainty"],
    strict: true,
    enums: [
      { prop: "normalization", values: ["none", "per-source-particle", "per-fission", "per-demand", "per-hour", "per-second", "per-watt"] },
      { prop: "verification", values: ["verified", "unverified"] }
    ],
    bounds: [
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "resultsIndex.quantities.provenance",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/provenance",
    required: ["runId", "inputRevisions"],
    optional: ["mappingRecipe"],
    strict: true,
    enums: [],
    bounds: [
      { prop: "runId", minLength: 1, maxLength: 64 },
      { prop: "mappingRecipe", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "resultsIndex.quantities.data",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/data",
    required: ["path", "sha256"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "path", minLength: 1, maxLength: 512 },
      { prop: "sha256", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "resultsIndex.quantities.coordinates",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/coordinates",
    required: ["system", "axes"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "resultsIndex.quantities.coordinates.axes",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/coordinates/axes/0",
    required: ["name", "unit"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "resultsIndex.quantities.timeGrid",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/timeGrid",
    required: ["unit", "start", "stop", "count"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "unit", minLength: 1, maxLength: 40 },
      { prop: "count", minimum: 1 }
    ]
  },
  {
    name: "resultsIndex.quantities.uncertainty",
    family: "results-index",
    fixture: "good/results-index-full.json",
    pointer: "/quantities/0/uncertainty",
    required: ["kind", "value"],
    optional: ["unit"],
    strict: true,
    enums: [
      { prop: "kind", values: ["statistical", "input", "model"] }
    ],
    bounds: [
      { prop: "value", minimum: 0 },
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },

  // --- Section 4: Run Record ---
  {
    name: "runRecord",
    family: "run-record",
    fixture: "good/run-record-full.json",
    pointer: "",
    required: ["schema", "runId", "attempt", "adapter", "state", "inputs", "settings", "budget", "createdAt"],
    optional: ["engine", "dataLibrary", "jobId", "native", "seed", "budgetUsed", "startedAt", "finishedAt", "cacheKey", "outputs", "extensions"],
    strict: true,
    // Section 4: "Conditionals: state: 'completed' requires finishedAt and a non-empty outputs; state in failed, cancelled, interrupted, terminated-by-trip requires finishedAt; state: 'running' forbids finishedAt."
    // Because the base fixture has finishedAt and non-empty outputs, 'running' and 'queued' are excluded when setting state on this base.
    enums: [
      {
        prop: "state",
        values: ["queued", "running", "completed", "failed", "cancelled", "interrupted", "terminated-by-trip"],
        acceptedValues: ["completed", "failed", "cancelled", "interrupted", "terminated-by-trip"]
      }
    ],
    bounds: [
      { prop: "runId", minLength: 1, maxLength: 64 },
      { prop: "attempt", minimum: 1 },
      { prop: "seed", minimum: 0 },
      { prop: "jobId", minLength: 1, maxLength: 64 },
      { prop: "cacheKey", minLength: 64, maxLength: 64 },
      { prop: "inputs", minItems: 1 }
    ]
  },
  {
    name: "runRecord.adapter",
    family: "run-record",
    fixture: "good/run-record-full.json",
    pointer: "/adapter",
    required: ["id", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 }
    ]
  },
  {
    name: "runRecord.engine",
    family: "run-record",
    fixture: "good/run-record-full.json",
    pointer: "/engine",
    required: ["name", "version"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "runRecord.dataLibrary",
    family: "run-record",
    fixture: "good/run-record-full.json",
    pointer: "/dataLibrary",
    required: ["id"],
    optional: ["hash"],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 },
      { prop: "hash", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "runRecord.budgetUsed",
    family: "run-record",
    fixture: "good/run-record-full.json",
    pointer: "/budgetUsed",
    required: ["wallSeconds", "cores", "memoryMB", "diskMB"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "wallSeconds", minimum: 0 },
      { prop: "cores", minimum: 0 },
      { prop: "memoryMB", minimum: 0 },
      { prop: "diskMB", minimum: 0 }
    ]
  },

  // --- Section 5: Project Manifest ---
  {
    name: "project",
    family: "project",
    fixture: "good/project-full.json",
    pointer: "",
    required: ["schema", "projectId", "name", "created", "updated", "seedVersion", "folders", "artifacts", "materials"],
    optional: ["extensions"],
    strict: true,
    enums: [],
    bounds: [
      { prop: "projectId", minLength: 1, maxLength: 64 },
      { prop: "name", minLength: 1, maxLength: 120 },
      { prop: "seedVersion", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "project.folders",
    family: "project",
    fixture: "good/project-full.json",
    pointer: "/folders",
    required: ["models", "runs", "studies", "oracles"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "models", minLength: 1, maxLength: 512 },
      { prop: "runs", minLength: 1, maxLength: 512 },
      { prop: "studies", minLength: 1, maxLength: 512 },
      { prop: "oracles", minLength: 1, maxLength: 512 }
    ]
  },
  {
    name: "project.artifacts",
    family: "project",
    fixture: "good/project-full.json",
    pointer: "/artifacts/0",
    required: ["id", "app", "path", "format", "formatVersion", "revision"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 },
      { prop: "app", minLength: 1, maxLength: 64 },
      { prop: "path", minLength: 1, maxLength: 512 },
      { prop: "format", minLength: 1, maxLength: 40 },
      { prop: "formatVersion", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "project.materials",
    family: "project",
    fixture: "good/project-full.json",
    pointer: "/materials/0",
    required: ["id", "revision", "name", "sets"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 },
      { prop: "revision", minimum: 1 },
      { prop: "name", minLength: 1, maxLength: 120 }
    ]
  },
  {
    name: "project.materials.set",
    family: "project",
    fixture: "good/project-full.json",
    pointer: "/materials/0/sets/openmc.composition",
    required: ["schema"],
    optional: ["units", "source", "conditions", "ranges", "ref"],
    // Section 5: "Each value is an object with a required schema (string 1..80) and any other properties (opaque, preserved, never evaluated)."
    strict: false,
    enums: [],
    bounds: [
      { prop: "schema", minLength: 1, maxLength: 80 }
    ]
  },

  // --- Section 6: Study Lines ---
  {
    name: "study.header",
    family: "study",
    fixture: "good/study-full-header.json",
    pointer: "",
    required: ["type", "schema", "seq", "studyId", "created", "projectId", "question", "assumptions", "parameters", "budget", "tier", "startRevisions", "setBy"],
    optional: ["hypothesis", "prev", "hash"],
    strict: true,
    enums: [
      { prop: "type", values: ["header"] },
      { prop: "tier", values: ["A0", "A1", "A2", "A3"] }
    ],
    bounds: [
      { prop: "seq", minimum: 0, maximum: 0 },
      { prop: "studyId", minLength: 1, maxLength: 64 },
      { prop: "projectId", minLength: 1, maxLength: 64 },
      { prop: "question", minLength: 1, maxLength: 2000 },
      { prop: "hash", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "study.header.parameters",
    family: "study",
    fixture: "good/study-full-header.json",
    pointer: "/parameters/0",
    required: ["id", "min", "max"],
    optional: ["artifact", "unit"],
    strict: true,
    enums: [],
    bounds: [
      { prop: "id", minLength: 1, maxLength: 64 },
      { prop: "artifact", minLength: 1, maxLength: 64 },
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "study.header.startRevisions",
    family: "study",
    fixture: "good/study-full-header.json",
    pointer: "/startRevisions/0",
    required: ["artifact", "revision"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "artifact", minLength: 1, maxLength: 64 },
      { prop: "revision", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "study.header.setBy",
    family: "study",
    fixture: "good/study-full-header.json",
    pointer: "/setBy",
    required: ["kind", "name"],
    optional: ["model", "toolVersion"],
    strict: true,
    enums: [
      { prop: "kind", values: ["human"] }
    ],
    bounds: [
      { prop: "name", minLength: 1, maxLength: 80 },
      { prop: "model", minLength: 1, maxLength: 80 },
      { prop: "toolVersion", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "study.step",
    family: "study",
    fixture: "good/study-full-step.json",
    pointer: "",
    required: ["type", "schema", "seq", "time", "actor", "action", "reason", "inputsChanged", "runs"],
    optional: ["oracle", "gateStop", "prev", "hash"],
    strict: true,
    // Section 6: "action: 'gate-stop' requires gateStop; gateStop is forbidden otherwise."
    // Because gateStop is present on this fixture, only 'gate-stop' is valid for action on this base.
    enums: [
      { prop: "type", values: ["step"] },
      {
        prop: "action",
        values: ["validate", "run", "oracle", "edit", "compare", "collect", "cancel", "note", "gate-stop"],
        acceptedValues: ["gate-stop"]
      }
    ],
    bounds: [
      { prop: "seq", minimum: 1 },
      { prop: "reason", minLength: 1, maxLength: 2000 },
      { prop: "hash", minLength: 64, maxLength: 64 },
      { prop: "prev", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "study.step.inputsChanged",
    family: "study",
    fixture: "good/study-full-step.json",
    pointer: "/inputsChanged/0",
    required: ["artifact", "before", "after"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "artifact", minLength: 1, maxLength: 64 },
      { prop: "before", minLength: 64, maxLength: 64 },
      { prop: "after", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "study.step.oracle",
    family: "study",
    fixture: "good/study-full-step.json",
    pointer: "/oracle",
    required: ["set", "verdict"],
    optional: [],
    strict: true,
    enums: [
      { prop: "verdict", values: ["pass", "fail", "not-run"] }
    ],
    bounds: [
      { prop: "set", minLength: 1, maxLength: 80 }
    ]
  },
  {
    name: "study.step.gateStop",
    family: "study",
    fixture: "good/study-full-step.json",
    pointer: "/gateStop",
    required: ["request", "rule"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "request", minLength: 1, maxLength: 200 },
      { prop: "rule", minLength: 1, maxLength: 200 }
    ]
  },
  {
    name: "study.conclusion",
    family: "study",
    fixture: "good/study-full-conclusion.json",
    pointer: "",
    required: ["type", "schema", "seq", "time", "actor", "claims"],
    optional: ["prev", "hash"],
    strict: true,
    enums: [
      { prop: "type", values: ["conclusion"] }
    ],
    bounds: [
      { prop: "seq", minimum: 1 },
      { prop: "hash", minLength: 64, maxLength: 64 },
      { prop: "prev", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "study.conclusion.actor",
    family: "study",
    fixture: "good/study-full-conclusion.json",
    pointer: "/actor",
    required: ["kind", "name"],
    optional: ["model", "toolVersion"],
    strict: true,
    // Section 6: "A conclusion cannot be written by an actor of kind system."
    enums: [
      { prop: "kind", values: ["human", "agent"] }
    ],
    bounds: [
      { prop: "name", minLength: 1, maxLength: 80 },
      { prop: "model", minLength: 1, maxLength: 80 },
      { prop: "toolVersion", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "study.conclusion.claims",
    family: "study",
    fixture: "good/study-full-conclusion.json",
    pointer: "/claims/0",
    required: ["text", "runs", "oracles"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "text", minLength: 1, maxLength: 2000 }
    ]
  },

  // --- Section 7: Oracle Entry ---
  {
    name: "oracle.good",
    family: "oracle",
    fixture: "good/oracle-good.json",
    pointer: "",
    required: ["schema", "oracleId", "entryVersion", "adapter", "adapterVersions", "tag", "inputs", "expected", "source", "coverage", "toleranceHash", "tolerance"],
    optional: [],
    strict: true,
    // Section 7: "Tag rules: good requires the value form; bad-input requires refusalCode; known-limit requires verdict or refusalCode."
    enums: [
      {
        prop: "tag",
        values: ["good", "bad-input", "known-limit"],
        acceptedValues: ["good"]
      }
    ],
    bounds: [
      { prop: "oracleId", minLength: 1, maxLength: 64 },
      { prop: "entryVersion", minimum: 1 },
      { prop: "adapter", minLength: 1, maxLength: 64 },
      { prop: "adapterVersions", minItems: 1 },
      { prop: "inputs", minItems: 1 },
      { prop: "toleranceHash", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "oracle.badInput",
    family: "oracle",
    fixture: "good/oracle-bad-input.json",
    pointer: "",
    required: ["schema", "oracleId", "entryVersion", "adapter", "adapterVersions", "tag", "inputs", "expected", "source", "coverage", "toleranceHash"],
    optional: [],
    strict: true,
    // Section 7: "Tag rules: good requires the value form; bad-input requires refusalCode; known-limit requires verdict or refusalCode."
    enums: [
      {
        prop: "tag",
        values: ["good", "bad-input", "known-limit"],
        acceptedValues: ["bad-input", "known-limit"]
      }
    ],
    bounds: [
      { prop: "oracleId", minLength: 1, maxLength: 64 },
      { prop: "entryVersion", minimum: 1 },
      { prop: "adapter", minLength: 1, maxLength: 64 },
      { prop: "adapterVersions", minItems: 1 },
      { prop: "inputs", minItems: 1 },
      { prop: "toleranceHash", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "oracle.knownLimit",
    family: "oracle",
    fixture: "good/oracle-known-limit.json",
    pointer: "",
    required: ["schema", "oracleId", "entryVersion", "adapter", "adapterVersions", "tag", "inputs", "expected", "source", "coverage", "toleranceHash"],
    optional: [],
    strict: true,
    // Section 7: "Tag rules: good requires the value form; bad-input requires refusalCode; known-limit requires verdict or refusalCode."
    enums: [
      {
        prop: "tag",
        values: ["good", "bad-input", "known-limit"],
        acceptedValues: ["known-limit"]
      }
    ],
    bounds: [
      { prop: "oracleId", minLength: 1, maxLength: 64 },
      { prop: "entryVersion", minimum: 1 },
      { prop: "adapter", minLength: 1, maxLength: 64 },
      { prop: "adapterVersions", minItems: 1 },
      { prop: "inputs", minItems: 1 },
      { prop: "toleranceHash", minLength: 64, maxLength: 64 }
    ]
  },
  {
    name: "oracle.expected.value",
    family: "oracle",
    fixture: "good/oracle-good.json",
    pointer: "/expected",
    required: ["quantity", "value", "unit"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "unit", minLength: 1, maxLength: 40 }
    ]
  },
  {
    name: "oracle.expected.refusalCode",
    family: "oracle",
    fixture: "good/oracle-bad-input.json",
    pointer: "/expected",
    required: ["refusalCode"],
    optional: [],
    strict: true,
    enums: [],
    bounds: []
  },
  {
    name: "oracle.expected.verdict",
    family: "oracle",
    fixture: "good/oracle-known-limit.json",
    pointer: "/expected",
    required: ["verdict"],
    optional: [],
    strict: true,
    enums: [
      { prop: "verdict", values: ["out-of-domain", "truncated", "unsupported"] }
    ],
    bounds: []
  },
  {
    name: "oracle.tolerance",
    family: "oracle",
    fixture: "good/oracle-good.json",
    pointer: "/tolerance",
    required: ["abs", "rel"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "abs", minimum: 0 },
      { prop: "rel", minimum: 0 }
    ]
  },
  {
    name: "oracle.source",
    family: "oracle",
    fixture: "good/oracle-good.json",
    pointer: "/source",
    required: ["kind", "text"],
    optional: ["check"],
    strict: true,
    enums: [
      { prop: "kind", values: ["hand", "analytic", "published", "direct-engine"] }
    ],
    bounds: [
      { prop: "text", minLength: 1, maxLength: 2000 },
      { prop: "check", minLength: 1, maxLength: 2000 }
    ]
  },
  {
    name: "oracle.coverage",
    family: "oracle",
    fixture: "good/oracle-good.json",
    pointer: "/coverage",
    required: ["quantities", "domain"],
    optional: [],
    strict: true,
    enums: [],
    bounds: [
      { prop: "quantities", minItems: 1 },
      { prop: "domain", minLength: 1, maxLength: 500 }
    ]
  }
];
