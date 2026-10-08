/**
 * `query_model` (docs/query-model.md): ask a registered model exact, read-only questions. The host side. A client names a registered case and a
 * structured query; it never names a path, an actor or a grant. The host checks the model file against the revision registered for the case,
 * passes the gate (`query_model`, tier A0), asks the adapter's `query` verb (only an adapter that advertises the `query-model` capability is
 * asked), checks that the adapter answered about exactly that file, and records the question and the answer's hash in the host's own query log
 * before it returns anything. A query runs no solver, writes no project file, and a model that changed while it was asked is a refusal.
 */
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { callAdapter } from "./adapterClient";
import { canonicalJson, sha256Hex } from "./canonical";
import { allCases, validateHostConfiguration } from "./fileRunHost";
import { appendAdmission, inside, readHostJson, regularFile, safeChild } from "./hostFiles";
import { evaluateGate } from "./policy";
import { openProject, withProjectLock } from "./projectStore";
import type { TypedError } from "./validate";

export type QueryOutcome =
  | { ok: true; caseId: string; modelSha256: string; answer: Record<string, unknown>; receipt: { seq: number; hash: string } }
  | { ok: false; errors: TypedError[] };

export const MAX_QUERY_BYTES = 8192;
export const MAX_ANSWER_BYTES = 1_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fail = (code: string, message: string, field = ""): QueryOutcome => ({ ok: false, errors: [{ code, field, message, source: "seed" }] });

export async function queryFromHostFile(file: string, request: unknown): Promise<QueryOutcome> {
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request)) return fail("E_SCHEMA_INVALID", "the request is an object with requestId, caseId and query");
    const r = request as Record<string, unknown>;
    if (Object.keys(r).sort().join() !== "caseId,query,requestId") return fail("E_SCHEMA_INVALID", "the request has exactly these fields: requestId, caseId, query (no path, actor or grant is accepted)");
    if (typeof r.requestId !== "string" || !ID.test(r.requestId)) return fail("E_SCHEMA_INVALID", "requestId must be 1 to 64 characters of letters, digits, dot, underscore or dash", "/requestId");
    if (typeof r.caseId !== "string" || !ID.test(r.caseId)) return fail("E_SCHEMA_INVALID", "caseId must be a registered case id", "/caseId");
    if (r.query === null || typeof r.query !== "object" || Array.isArray(r.query)) return fail("E_SCHEMA_INVALID", "query must be an object", "/query");
    const queryText = canonicalJson(r.query);
    if (Buffer.byteLength(queryText) > MAX_QUERY_BYTES) return fail("E_SCHEMA_INVALID", `the query is larger than ${MAX_QUERY_BYTES} bytes`, "/query");
    const requestId = r.requestId, caseId = r.caseId, query = r.query as Record<string, unknown>;

    if (!isAbsolute(file)) return fail("E_SETUP_REQUIRED", "SEED_HOST_CONFIG must be an absolute path");
    regularFile(file);
    const configBytes = readFileSync(file);
    const configHash = sha256Hex(configBytes);
    const c = validateHostConfiguration(JSON.parse(configBytes.toString("utf8")));
    const project = realpathSync(c.projectRoot), state = realpathSync(c.stateRoot);
    if (inside(project, realpathSync(file)) || inside(project, state)) throw Error("host configuration and state must be outside the project");
    const opened = openProject(project);
    if (!opened.ok) return { ok: false, errors: opened.errors };
    const projectId = opened.value.manifest.projectId as string;

    const registered = allCases(c)[caseId];
    if (!registered) return fail("E_NOT_FOUND", "no registered case has this id", "/caseId");
    const artifact = registered.artifact;
    const readModel = () => {
      const abs = safeChild(project, artifact.path);
      if (!inside(project, realpathSync(abs))) throw Error("the model leaves the project");
      regularFile(abs);
      return sha256Hex(readFileSync(abs));
    };
    let before: string;
    try {
      before = readModel();
    } catch {
      return fail("E_NOT_FOUND", "the model file of this case cannot be read", "/caseId");
    }
    if (before !== artifact.revision.hash) return fail("E_STALE_REVISION", "the model file is not the revision registered for this case", "/caseId");

    const decision = evaluateGate(
      { operation: "query_model", actor: c.actor, studyId: c.study.studyId, inputRevisions: [{ artifact: artifact.path, revision: before }] },
      { study: c.study, grants: c.grants },
    );
    if (!decision.allow) return { ok: false, errors: decision.errors };

    const described = await callAdapter(
      c.adapter,
      { schema: "seed.adapter-request/0.1", verb: "describe", requestId: "query-describe", actor: c.actor },
      { projectRoot: project, timeoutMs: 60000 },
    );
    if (!described.ok) return { ok: false, errors: described.errors };
    const dReply = described.reply as { ok: boolean; errors: TypedError[]; result?: { capabilities?: string[] } };
    if (!dReply.ok) return { ok: false, errors: dReply.errors };
    if (!dReply.result?.capabilities?.includes("query-model")) return fail("E_UNSUPPORTED", "this adapter does not answer model queries (it does not advertise the query-model capability)");

    const answered = await callAdapter(
      c.adapter,
      { schema: "seed.adapter-request/0.1", verb: "query", requestId, actor: c.actor, artifact: { path: artifact.path, revision: { hash: before, counter: artifact.revision.counter } }, query },
      { projectRoot: project, timeoutMs: 60000 },
    );
    let result: { ok: true; answer: Record<string, unknown>; modelSha256: string } | { ok: false; errors: TypedError[] };
    if (!answered.ok) result = { ok: false, errors: answered.errors };
    else {
      const reply = answered.reply as { ok: boolean; errors: TypedError[]; result?: { answer: Record<string, unknown>; modelSha256: string } };
      if (!reply.ok || !reply.result) result = { ok: false, errors: reply.errors.length ? reply.errors : [{ code: "E_APP_FAILED", field: "", message: "the adapter refused the query without a reason", source: "app-content" }] };
      else if (reply.result.modelSha256 !== before) result = { ok: false, errors: [{ code: "E_APP_FAILED", field: "/result/modelSha256", message: "the adapter answered about another model than the one asked", source: "seed" }] };
      else if (Buffer.byteLength(canonicalJson(reply.result.answer)) > MAX_ANSWER_BYTES) result = { ok: false, errors: [{ code: "E_APP_FAILED", field: "/result/answer", message: `the answer is larger than ${MAX_ANSWER_BYTES} bytes`, source: "seed" }] };
      else result = { ok: true, answer: reply.result.answer, modelSha256: reply.result.modelSha256 };
    }
    // A model that changed while it was asked is not answered, however the adapter replied.
    // A file that can no longer be read is the same refusal, and it is recorded like any other outcome after the adapter ran.
    if (result.ok) {
      let after: string | null;
      try {
        after = readModel();
      } catch {
        after = null;
      }
      if (after !== before) result = { ok: false, errors: [{ code: "E_STALE_REVISION", field: "/caseId", message: after === null ? "the model file could not be read after the query ran" : "the model file changed while the query ran", source: "seed" }] };
    }

    // No answer without a record: the question, the model and the answer's hash go to the host's own chained query log first.
    const logRoot = safeChild(state, "queries", true);
    mkdirSync(logRoot, { recursive: true });
    const logDir = safeChild(logRoot, sha256Hex(project).slice(0, 32), true);
    mkdirSync(logDir, { recursive: true });
    // The lock is the log folder's own (a `.seed` folder inside it, in the host's state): a query never touches the project folder.
    const logged = withProjectLock(logDir, () =>
      appendAdmission(logDir, {
        phase: "query",
        actor: c.actor,
        projectId,
        configHash,
        event: {
          requestId,
          caseId,
          model: { path: artifact.path, sha256: before },
          queryHash: sha256Hex(queryText),
          ok: result.ok,
          ...(result.ok ? { answerHash: sha256Hex(canonicalJson(result.answer)) } : { codes: result.errors.map((e) => e.code) }),
        },
      }),
    );
    if (!logged.ok) return fail("E_INTERNAL", "the query could not be recorded, so it is not answered");
    if (!result.ok) return result;
    return { ok: true, caseId, modelSha256: result.modelSha256, answer: result.answer, receipt: { seq: logged.value.seq, hash: logged.value.hash } };
  } catch (e) {
    // An operating-system error (ENOENT and the like) names a path of this machine: the client gets a fixed sentence. Our own messages and codes pass.
    const code = (e as { code?: unknown })?.code;
    const ours = typeof code === "string" && /^E_[A-Z_]+$/.test(code);
    const system = typeof code === "string" && !ours;
    return fail(ours ? code : "E_INTERNAL", e instanceof Error && !system ? e.message : "the query could not be completed");
  }
}
