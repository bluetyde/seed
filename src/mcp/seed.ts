import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { supervisedInstall, supervisedReplay, supervisedRun, supervisedSampling } from "./supervisor";
import { listComponentsFromHost } from "../core/installHost";
import { requestHostCancellation } from "../core/hostControl";
import { exportStudyReport } from "../core/studyReportHost";
import { addStudyNote } from "../core/studyNoteHost";
import { queryFromHostFile, MAX_QUERY_BYTES } from "../core/queryHost";
import { applyTransferFromHost, proposeTransfer, transferStatus } from "../core/transferHost";

export const MAX_MCP_BYTES = 1_048_576;
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const requestSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    caseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    budget: z
      .object({
        maxWallSeconds: positiveInteger,
        maxCores: positiveInteger,
        maxMemoryMB: positiveInteger,
        maxDiskMB: positiveInteger,
      })
      .strict(),
  })
  .strict();

/** The path is selected once by the trusted process environment, never by MCP arguments. */
export function createSeedMcpServer(hostConfig: string, transferHostConfig = process.env.SEED_TRANSFER_HOST_CONFIG, installHostConfig = process.env.SEED_INSTALL_HOST_CONFIG): McpServer {
  const studyHeader = process.env.SEED_STUDY_HEADER;
  const server = new McpServer(
    { name: "seed", version: "0.1.0" },
    {
      instructions:
        "Run only host-registered cases. Authority, approved inputs and oracle evidence come from the trusted SEED host. No approval/configuration tools. Calls wait for terminal results; cancellation or disconnect does not stop a calculation. Keep the connection open and allow the configured wall budget plus cleanup time.",
    },
  );
  server.registerTool(
    "seed_run_case",
    {
      title: "Run an approved SEED case",
      description:
        "Run one registered case through SEED's guarded host. Host policy, scoped approvals, input revisions and oracle/runtime pins are checked; admission is recorded before launch. Only requestId, caseId and a positive-integer budget are accepted. Refusal and calculation failure return isError with typed SEED errors. One active case per engine using shared host state. Budget admission does not enforce OS CPU/memory/disk limits. Synthetic RAFT results have limited validation coverage. Use seed_cancel_calculation for an actual stop; cancelling the MCP request alone does not stop it. Recovery is a human CLI action; no approval tool exists.",
      inputSchema: requestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async request => {
      const outcome = await supervisedRun(hostConfig, request);
      const reply = { schema: "seed.mcp-reply/0.1", ...outcome };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !outcome.ok || outcome.state !== "completed",
      };
    },
  );
  server.registerTool(
    "seed_cancel_calculation",
    {
      title: "Request calculation cancellation",
      description:
        "Request actual cancellation of this host's active calculation by its original requestId. Fresh host policy and scoped cancellation approval are checked again by the calculation owner, which durably audits before calling the adapter. A cancellation-requested reply acknowledges the request, not a confirmed stop; the original run call supplies the terminal result. No PID, native job ID, path or actor is accepted. Abandoned owners require human CLI recovery.",
      inputSchema: z.object({ requestId: z.string().min(1).max(256) }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async request => {
      const reply = { schema: "seed.mcp-reply/0.1", ...requestHostCancellation(hostConfig, request) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  server.registerTool(
    "seed_export_study_report",
    {
      title: "Save a single-case study report",
      description:
        "Save immutable HTML, Markdown, hash-chained study steps and admission/oracle evidence for a terminal guarded run. Only its original requestId is accepted. Human study header and output directory are host-selected; fresh append-step policy applies. Completed quantity plots currently support RAFT. No conclusion or approval is invented; existing verification and stale labels remain. Existing bundles are never overwritten.",
      inputSchema: z.object({ requestId: z.string().min(1).max(256) }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async request => {
      const reply = {
        schema: "seed.mcp-reply/0.1",
        ...(await exportStudyReport(hostConfig, studyHeader, request)),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  server.registerTool(
    "seed_query_model",
    {
      title: "Ask a registered model an exact question",
      description:
        `Ask a registered case's model a read-only, structured question (for NODAL: summary, list, connected, neighbors; see the adapter's query documentation). Only requestId, caseId and a query object are accepted: no path, actor or grant. The model file must still be the revision registered for the case. The answer is a fact about the model file, not a physical result, and carries the model's sha256 so a claim can cite exactly which model was asked. Nothing is run and no project file is written; every query is recorded in the host's query log before it is answered. The query is limited to ${MAX_QUERY_BYTES} bytes. An adapter that does not advertise the query-model capability refuses.`,
      inputSchema: z
        .object({
          requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          caseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          query: z.record(z.unknown()),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async request => {
      const reply = { schema: "seed.mcp-reply/0.1", ...(await queryFromHostFile(hostConfig, request)) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  server.registerTool(
    "seed_add_study_note",
    {
      title: "Add a note to the study record",
      description:
        "Add one free-text note (as the host's registered actor) to the live study record, optionally citing runs of this project. A note is data: it is stored and shown in reports, never acted on. It passes the gate (append_step, tier A1 or a grant), is limited to 1500 characters and 20 run ids, and the same noteId with the same content is recorded once. Everything else in the record (runs, outcomes, refusals, the oracle set) is written by the host from its own evidence; there is no tool to edit or delete a row.",
      inputSchema: z
        .object({
          noteId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          text: z.string().min(1).max(1500),
          runs: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).max(20).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async request => {
      const reply = { schema: "seed.mcp-reply/0.1", ...addStudyNote(hostConfig, request) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  server.registerTool(
    "seed_replay_run",
    {
      title: "Replay a completed run and compare",
      description:
        "Run the registered case of an earlier completed run again and say whether the new run reproduces it. Only requestId (the replay's own), originalRequestId and a budget are accepted; no case, input, path or tolerance. Nothing runs unless the original is proven from the audit log, is completed and current, and the host configuration is the one it was admitted under (so never across an engine, adapter or input change); the replay is then a guarded run like any other. The comparison uses the adapter's own policy (exact, a tolerance, or statistical) and answers reproduced, reproduced-within-tolerance, differs or not-comparable, listing every difference. A verdict is a result, not an error; a refusal is an error. Cancel it with seed_cancel_calculation and the replay's requestId.",
      inputSchema: z
        .object({
          requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          originalRequestId: z.string().min(1).max(256),
          budget: requestSchema.shape.budget,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async request => {
      const reply = { schema: "seed.mcp-reply/0.1", ...(await supervisedReplay(hostConfig, request)) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  server.registerTool(
    "seed_run_sampling",
    {
      title: "Run a registered sampling study",
      description:
        "Run a sampling study the host registered: its points are drawn from distributions a person declared, each run through the guarded path like a sweep case, then summarised. The reply gives per output the mean, the spread over the inputs, and the sampling noise the adapter reported as a separate figure that is never added to the spread, with quantiles, convergence and correlations. Only requestId, the registered samplingId and a per-case budget are accepted: no value, distribution, seed or count. The call waits for every point; it is held by a detached owner, so a client that disconnects does not stop an admitted point, and seed_cancel_calculation with a point's own request id (the requestId, a dot and the case id) stops that point.",
      inputSchema: z
        .object({
          requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          samplingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/),
          budget: requestSchema.shape.budget,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async request => {
      const reply = { schema: "seed.mcp-reply/0.1", ...(await supervisedSampling(hostConfig, request)) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        structuredContent: reply,
        isError: !reply.ok,
      };
    },
  );
  // Components: only when the trusted environment names an install host. Granting, revoking and removing are human verbs of the admin CLI and have no tool here.
  if (installHostConfig) {
    const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    const reply = (outcome: unknown) => {
      const r = { schema: "seed.mcp-reply/0.1", ...(outcome as object) } as { ok?: boolean };
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }], structuredContent: r as Record<string, unknown>, isError: !r.ok };
    };
    server.registerTool(
      "seed_list_components",
      {
        title: "List installable components",
        description:
          "Read which components each configured app has (core, add-ons, libraries), their versions, sizes, capabilities, whether this machine can install them, what is installed already and which install is in flight. Nothing is changed. Use it to choose the add-on ids for seed_install_component.",
        inputSchema: z.object({ app: id.optional() }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (request) => reply(listComponentsFromHost(installHostConfig, request)),
    );
    server.registerTool(
      "seed_install_component",
      {
        title: "Install the core of an app and chosen add-ons",
        description:
          "Ask the trusted SEED host to install the core of an app and the add-ons in select, with the libraries they need. It works only inside a grant a person issued for this actor, this app and these add-ons, with a download and disk ceiling that every request spends from; without one it is refused and says what to grant. Only app, select and an optional requestId are accepted: no manifest, url, command or path. The call waits for the end of the install, which runs in a process that finishes even if this connection closes; a run that was stopped is settled at the next start.",
        inputSchema: z.object({ requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), app: id, select: z.array(id).max(16).default([]) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (request) => reply(await supervisedInstall(installHostConfig, request)),
    );
  }
  // Transfers: only when the trusted environment names a transfer host. Approval is a human verb of the admin CLI and has no tool here.
  if (transferHostConfig) {
    const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const answer = (outcome: unknown) => {
      const reply = { schema: "seed.mcp-reply/0.1", ...(outcome as object) } as { ok?: boolean };
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }], structuredContent: reply as Record<string, unknown>, isError: !reply.ok };
    };
    const recipeId = z.object({ recipeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) }).strict();
    server.registerTool(
      "seed_propose_transfer",
      {
        title: "Propose a reviewed transfer",
        description:
          "Write a transfer recipe (seed.transfer-recipe/0.2) that moves one quantity of a completed run into another app's input. It is checked against the source run (units and dimension, declared normalization, revisions) and the target before it is saved, and it does nothing until a human approves exactly this content. The agent cannot approve, enable or change a tolerance after approval.",
        inputSchema: z.object({ recipe: z.record(z.string(), z.unknown()) }).strict(),
        annotations,
      },
      async (request) => answer(await proposeTransfer(transferHostConfig, request)),
    );
    server.registerTool(
      "seed_transfer_status",
      {
        title: "Where a transfer recipe stands",
        description: "Read the state of a recipe (proposed, approved, applied, stale or invalid) and the reasons, from the project and the host's records.",
        inputSchema: recipeId,
        annotations: { ...annotations, readOnlyHint: true },
      },
      async (request) => answer(await transferStatus(transferHostConfig, request)),
    );
    server.registerTool(
      "seed_apply_transfer",
      {
        title: "Apply an approved transfer",
        description:
          "Apply a recipe a human approved: the target app's own command maps the data (its coverage and conservation checks decide), and SEED writes the new target file and revision with provenance. Refused when there is no valid approval for this exact content and these exact revisions, when anything changed since, or when the oracle sets are not clear.",
        inputSchema: recipeId,
        annotations,
      },
      async (request) => answer(await applyTransferFromHost(transferHostConfig, request)),
    );
  }
  return server;
}

export async function startSeedMcp(hostConfig = process.env.SEED_HOST_CONFIG): Promise<McpServer> {
  if (!hostConfig) throw Error("set SEED_HOST_CONFIG in the trusted host environment");
  const server = createSeedMcpServer(hostConfig);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_MCP_BYTES });
  server.server.onerror = () => {
    process.stderr.write("SEED MCP protocol/transport error\n");
  };
  // EOF stops new requests. In-flight host operations retain the lease and finish their journal.
  process.stdin.once("end", () => {
    void transport.close();
  });
  process.stdout.on("error", () => {
    void transport.close();
  });
  await server.connect(transport);
  return server;
}
if (require.main === module) {
  startSeedMcp().catch(() => {
    process.stderr.write("SEED MCP setup failed; check SEED_HOST_CONFIG\n");
    process.exitCode = 2;
    process.stdin.destroy();
  });
}
