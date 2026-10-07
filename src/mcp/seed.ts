import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { supervisedRun } from "./supervisor";
import { requestHostCancellation } from "../core/hostControl";
import { exportStudyReport } from "../core/studyReportHost";
import { addStudyNote } from "../core/studyNoteHost";
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
export function createSeedMcpServer(hostConfig: string, transferHostConfig = process.env.SEED_TRANSFER_HOST_CONFIG): McpServer {
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
