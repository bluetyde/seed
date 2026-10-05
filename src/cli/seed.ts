import type { Readable } from "node:stream";
import { runFromHostFile } from "../core/fileRunHost";
import { requestHostCancellation } from "../core/hostControl";
import { exportStudyReport } from "../core/studyReportHost";
import { proposeConclusion } from "../core/conclusionDraft";

export const MAX_CLI_BYTES = 1_048_576;
export function readRequest(stream: Readable, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (error) {
        stream.pause();
        reject(error);
      } else resolve(value);
    };
    const onError = (e: Error) => finish(e);
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_CLI_BYTES) return finish(new Error("request exceeds 1 MiB"));
      chunks.push(bytes);
    };
    const onEnd = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new Error("stdin must contain one JSON request"));
      }
    };
    const timer = setTimeout(() => finish(new Error("request input timed out")), timeoutMs);
    stream.on("error", onError);
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}
export async function runCli(
  argv: string[],
  stream: Readable,
  hostConfig = process.env.SEED_HOST_CONFIG,
): Promise<{ code: number; reply: unknown }> {
  const failure = (message: string, code = "E_SCHEMA_INVALID") => ({
    code: 2,
    reply: {
      schema: "seed.cli-reply/0.1",
      ok: false,
      errors: [{ code, field: "", message, source: "seed" }],
    },
  });
  if (argv.length !== 1 || !["run", "cancel", "report", "draft-conclusion"].includes(argv[0]!))
    return failure(
      "usage: node dist/cli/seed.js run|cancel|report|draft-conclusion; request JSON on stdin; no approval or configuration verbs",
      "E_VERB_UNKNOWN",
    );
  if (!hostConfig) return failure("set SEED_HOST_CONFIG in the trusted host environment", "E_SETUP_REQUIRED");
  let request: unknown;
  try {
    request = await readRequest(stream);
  } catch (e) {
    return failure(e instanceof Error ? e.message : "invalid input");
  }
  const outcome =
    argv[0] === "draft-conclusion"
      ? await proposeConclusion(hostConfig, request)
      : argv[0] === "report"
        ? await exportStudyReport(hostConfig, process.env.SEED_STUDY_HEADER, request)
        : argv[0] === "cancel"
          ? requestHostCancellation(hostConfig, request)
          : await runFromHostFile(hostConfig, request);
  return {
    code: !outcome.ok ? 2 : argv[0] !== "run" || outcome.state === "completed" ? 0 : 1,
    reply: { schema: "seed.cli-reply/0.1", ...outcome },
  };
}
if (require.main === module) {
  runCli(process.argv.slice(2), process.stdin)
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
          errors: [{ code: "E_INTERNAL", field: "", message: "CLI failed", source: "seed" }],
        }) + "\n",
        () => {
          process.exitCode = 2;
          process.stdin.destroy();
        },
      );
    });
}
