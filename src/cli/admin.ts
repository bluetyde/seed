import type { Readable } from "node:stream";
import { recoverHostCalculation } from "../core/hostControl";
import { releaseLessonReservation } from "../core/lessonHistory";
import { approveTransfer } from "../core/transferHost";
import { clearOracleFailure, oracleJournalStatus, recordOracleEvaluation } from "../core/oracleJournalHost";
import { readRequest } from "./seed";

/**
 * Human-only maintenance, kept out of the CLI that agents are given (src/cli/seed.ts, which has no such verb).
 * It reads its own configuration variable, SEED_ADMIN_HOST_CONFIG, so an agent's SEED_HOST_CONFIG never reaches it,
 * and the operation itself still requires the configured actor to be a human.
 */
export const ADMIN_VERBS = ["release-intent-reservation", "recover", "approve-transfer", "oracle-record", "oracle-clear", "oracle-status"];

export async function runAdminCli(
  argv: string[],
  stream: Readable,
  hostConfig = process.env.SEED_ADMIN_HOST_CONFIG,
  transferHostConfig = process.env.SEED_ADMIN_TRANSFER_HOST_CONFIG,
): Promise<{ code: number; reply: unknown }> {
  const failure = (message: string, code = "E_SCHEMA_INVALID") => ({
    code: 2,
    reply: {
      schema: "seed.cli-reply/0.1",
      ok: false,
      errors: [{ code, field: "", message, source: "seed" }],
    },
  });
  if (argv.length !== 1 || !ADMIN_VERBS.includes(argv[0]!)) {
    return failure(
      `usage: node dist/cli/admin.js ${ADMIN_VERBS.join("|")}; request JSON on stdin`,
      "E_VERB_UNKNOWN",
    );
  }
  if (argv[0] === "approve-transfer" ? !transferHostConfig : !hostConfig) {
    return failure(
      argv[0] === "approve-transfer"
        ? "set SEED_ADMIN_TRANSFER_HOST_CONFIG to a transfer host configuration whose actor is a human"
        : "set SEED_ADMIN_HOST_CONFIG to a host configuration whose actor is a human",
      "E_SETUP_REQUIRED",
    );
  }
  let request: unknown;
  try {
    request = await readRequest(stream);
  } catch (e) {
    return failure(e instanceof Error ? e.message : "invalid input");
  }
  const outcome =
    argv[0] === "approve-transfer"
      ? await approveTransfer(transferHostConfig!, request)
      : argv[0] === "recover"
        ? await recoverHostCalculation(hostConfig!, request)
        : argv[0] === "oracle-record"
          ? recordOracleEvaluation(hostConfig!, request)
          : argv[0] === "oracle-clear"
            ? clearOracleFailure(hostConfig!, request)
            : argv[0] === "oracle-status"
              ? oracleJournalStatus(hostConfig!, request)
              : releaseLessonReservation(hostConfig!, request);
  return { code: outcome.ok ? 0 : 2, reply: { schema: "seed.cli-reply/0.1", ...outcome } };
}

if (require.main === module) {
  runAdminCli(process.argv.slice(2), process.stdin)
    .then(({ code, reply }) => {
      process.stdout.write(JSON.stringify(reply) + "\n", () => {
        process.exitCode = code;
        process.stdin.destroy();
      });
    })
    .catch(() => {
      process.stdout.write(
        JSON.stringify({
          schema: "seed.cli-reply/0.1",
          ok: false,
          errors: [{ code: "E_INTERNAL", field: "", message: "admin CLI failed", source: "seed" }],
        }) + "\n",
        () => {
          process.exitCode = 2;
          process.stdin.destroy();
        },
      );
    });
}
