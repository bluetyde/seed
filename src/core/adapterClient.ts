import { spawn } from "node:child_process";
import { killTree } from "./procTree";
import { type TypedError, validate } from "./validate";

export type AdapterSpec = { command: string; args: string[] };
export type CallOptions = { projectRoot: string; timeoutMs: number; signal?: AbortSignal };
export type AdapterOutcome =
  | { ok: true; reply: unknown }          // reply already validated as seed.adapter-reply/0.1 and matched to the request
  | { ok: false; errors: TypedError[] };  // transport or protocol failure

export const MAX_REPLY_BYTES = 1_048_576;

function cleanStderrTail(raw: string): string {
  const stripped = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  return stripped.length > 500 ? stripped.slice(-500) : stripped;
}

function makeAppFailed(baseMsg: string, stderrTail: string): TypedError {
  const hasStderr = stderrTail.length > 0;
  return {
    code: "E_APP_FAILED",
    field: "",
    message: hasStderr ? `${baseMsg} (stderr: ${stderrTail})` : baseMsg,
    source: hasStderr ? "app-content" : "seed",
  };
}

export function callAdapter(
  spec: AdapterSpec,
  request: unknown,
  opts: CallOptions
): Promise<AdapterOutcome> {
  const reqVal = validate("adapter-request", request);
  if (!reqVal.ok) {
    return Promise.resolve({ ok: false, errors: reqVal.errors });
  }

  if (opts.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      errors: [
        {
          code: "E_CANCELLED",
          field: "",
          message: "operation cancelled",
          source: "seed",
        },
      ],
    });
  }

  const reqObj = request as { verb: string; requestId: string };
  const verb = reqObj.verb;
  const requestId = reqObj.requestId;

  return new Promise<AdapterOutcome>((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    const child = spawn(spec.command, [...spec.args, verb], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SEED_PROJECT_ROOT: opts.projectRoot },
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (opts.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };

    if (opts.timeoutMs > 0) {
      timer = setTimeout(async () => {
        if (finished) return;
        finished = true;
        cleanup();
        const stopped = child.pid === undefined ? true : await killTree(child.pid);
        resolve({
          ok: false,
          errors: [
            {
              code: "E_TIMEOUT",
              field: "",
              message: stopped ? "adapter timed out" : "adapter timed out and its process could not be stopped",
              source: "seed",
            },
          ],
        });
      }, opts.timeoutMs);
    }

    if (opts.signal) {
      onAbort = async () => {
        if (finished) return;
        finished = true;
        cleanup();
        const stopped = child.pid === undefined ? true : await killTree(child.pid);
        resolve({
          ok: false,
          errors: [
            {
              code: "E_CANCELLED",
              field: "",
              message: stopped ? "operation cancelled" : "operation cancelled but the adapter process could not be stopped",
              source: "seed",
            },
          ],
        });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrRaw = "";

    child.stdout.on("data", async (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_REPLY_BYTES) {
        if (finished) return;
        finished = true;
        cleanup();
        child.stdout.destroy();
        child.stderr.destroy();
        const stopped = child.pid === undefined ? true : await killTree(child.pid);
        const tail = cleanStderrTail(stderrRaw);
        resolve({
          ok: false,
          errors: [makeAppFailed(stopped ? "reply too large" : "reply too large and the adapter process could not be stopped", tail)],
        });
      } else {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrRaw = (stderrRaw + chunk.toString("utf8")).slice(-2000);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));

    child.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      const tail = cleanStderrTail(stderrRaw);
      resolve({
        ok: false,
        errors: [makeAppFailed(`failed to spawn adapter: ${err.message}`, tail)],
      });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      cleanup();

      const tail = cleanStderrTail(stderrRaw);

      if (code !== 0) {
        const exitMsg = code !== null ? `adapter exited with code ${code}` : `adapter exited with signal ${signal}`;
        resolve({
          ok: false,
          errors: [makeAppFailed(exitMsg, tail)],
        });
        return;
      }

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      if (stdoutText.trim().length === 0) {
        resolve({
          ok: false,
          errors: [makeAppFailed("reply is empty", tail)],
        });
        return;
      }

      let replyObj: unknown;
      try {
        replyObj = JSON.parse(stdoutText);
      } catch {
        resolve({
          ok: false,
          errors: [makeAppFailed("reply is not valid JSON", tail)],
        });
        return;
      }

      const replyVal = validate("adapter-reply", replyObj);
      if (!replyVal.ok) {
        resolve({
          ok: false,
          errors: [makeAppFailed("reply does not match the schema", tail), ...replyVal.errors],
        });
        return;
      }

      const replyRecord = replyObj as Record<string, unknown>;
      if (replyRecord.verb !== verb) {
        resolve({
          ok: false,
          errors: [makeAppFailed("reply verb does not match", tail)],
        });
        return;
      }

      if (replyRecord.requestId !== requestId) {
        resolve({
          ok: false,
          errors: [makeAppFailed("reply requestId does not match", tail)],
        });
        return;
      }

      resolve({
        ok: true,
        reply: replyObj,
      });
    });
  });
}
