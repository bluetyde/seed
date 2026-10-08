# `query_model`: ask a registered model exact questions

Status 2026-10-08: built and tested (NODAL is the first app). From the research session's Plan 1 step 4; the user decided the verb and its read-only tier (D2, 2026-10-08).

A client (an agent, the CLI, an MCP tool) names a **registered case** and a **structured query**. SEED checks that the model file is still the revision registered for the case, asks the app's own read-only `query` command, and returns the app's answer unchanged together with the model's SHA-256, so a claim can cite exactly which file was asked. Nothing is run, no project file is written, and an answer is **a fact about the model file, not a physical result** (no `verification` label applies; the answer says what the file contains, never that it is right).

## What the client can send

`{requestId, caseId, query}` and nothing else: no path, no actor, no grant (a request with another field is refused as `E_SCHEMA_INVALID`).

- `requestId`, `caseId`: ids (1 to 64 characters of letters, digits, dot, underscore, dash). The case must be registered in the host configuration; a sweep's case ids work too.
- `query`: a JSON object of at most 8192 bytes. Its vocabulary belongs to the app. NODAL's is in its own `docs/model-query.md`: `summary`, `list` (kind, name and tag globs, nominal size, diameter and elevation ranges), `connected`, `neighbors`.

## What the host does, in order (`src/core/queryHost.ts`)

1. Checks the request shape and the query size.
2. Reads the model file registered for the case (it must be inside the project, a regular file, not a link) and compares its SHA-256 with the registered revision: another file is `E_STALE_REVISION`.
3. Passes the gate: operation `query_model`, **tier A0** (any registered actor). It is read-only: it carries no budget, takes no engine, and an oracle set that failed does not block it (it runs no calculation and says nothing about physics).
4. Asks the adapter's `describe` and requires the capability `query-model`; an adapter without it is `E_UNSUPPORTED` and is not asked to query.
5. Calls the adapter's `query` verb with the registered artifact and the query.
6. Checks the reply: an object `answer` of at most 1,000,000 bytes, and a `modelSha256` equal to the file's hash (an answer about another file is `E_APP_FAILED`).
7. Reads the model again: a file that changed while the query ran is `E_STALE_REVISION` and is not answered.
8. **Writes the query record before answering** (below). If the record cannot be written, the query is refused with `E_INTERNAL` ("could not be recorded, so it is not answered").
9. Returns `{ok: true, caseId, modelSha256, answer, receipt: {seq, hash}}`, or the typed errors.

## The query record

A hash-chained log in the host's state folder: `<state>/queries/<first 32 hex of the SHA-256 of the project's real path>/admissions.jsonl`, the same format as the run host's admission log (`seed.admission/0.1`, one row for every query that reached the adapter's `query` verb, whether the adapter answered or refused it; a refusal by the host's own earlier checks (request shape, stale file, gate, missing capability, describe failure) is returned but not logged). A row holds the phase `query`, the actor, the project id, the host configuration hash and `{requestId, caseId, model: {path, sha256}, queryHash, ok, answerHash | codes}`: the question and the answer are identified by hash, not stored. The log has its own writer lock (a `.seed` folder inside the log folder, in the state, never in the project). A query is **not yet a step of the study record**; the receipt `{seq, hash}` names its row.

## The adapter contract (additive to v0.1)

A new adapter verb **`query`**, offered only by adapters that list the capability **`query-model`** in `describe`. The contract version stays 0.1: an adapter that does not know the verb never receives it.

- Request: `{schema: "seed.adapter-request/0.1", verb: "query", requestId, actor, artifact: {path, revision}, query: {object}}`.
- Reply result: `{answer: {object}, modelSha256: "<64 hex>"}` (`schema/adapter-reply.schema.json`). A refusal is the usual typed errors; a code matching `^[EW]_[A-Z0-9_]{2,40}$` needs no registration.
- The adapter must read only the named file, never run a solver, and never write to the project.

**NODAL** (`adapters/nodal/cli.cjs`): checks the path stays inside the project, that the file's hash is the requested revision, writes the query to a file in the operating system's temporary folder (never the project), runs the NODAL runner's `--query` mode (`python -m nodal_studio.run MODEL --query QUERY`), and returns NODAL's answer unchanged apart from dropping its `ok` flag. NODAL's `E_QUERY_UNKNOWN_PART` stays; its other `E_QUERY_*` become `E_QUERY_INVALID`; `E_QUERY_MODEL` (a file that is not a NODAL model) becomes `E_SCHEMA_INVALID`. NODAL's `--query` is Python only.

## Surfaces

- CLI: `node dist/cli/seed.js query`, request JSON on stdin; exit 0 when answered, 2 when refused. No admin form: it needs no human.
- MCP: `seed_query_model` (`readOnlyHint: true`), inputs `requestId`, `caseId`, `query`, no more. The host configuration comes from the trusted environment as for `seed_run_case`.

## Four questions, exactly (`tests/query-model.test.ts`, run against the real NODAL runner)

A hand-built model: NODAL's five-part drain (`source`, `jin`, `pipe1`, `jout`, `sink`) plus three loose pipes.

| Question | Query | Answer (by inspection of the model) |
|---|---|---|
| How many of each kind? | `{"op": "summary"}` | 8 parts, 4 links: 2 boundary volumes, 2 junctions, 4 pipes; 2 with a nominal size |
| Which pipes have a 3-inch bore? | `{"op": "list", "kind": "pipe", "diameter": {"near": 3, "tolerance": 0.01, "unit": "in"}}` | `p3derived` (diameter derived from the flow area) and `p3stored` (stored), each saying which |
| Is the source connected to the sink? | `{"op": "connected", "a": "source", "b": "sink"}` | yes, `source, jin, pipe1, jout, sink`, 4 hops |
| What touches `pipe1`? | `{"op": "neighbors", "part": "pipe1"}` | `jin` and `jout` |

Each answer equals what NODAL's own command prints for the same model and query, through the host function, the CLI and the MCP tool.

## Not done

- A query is not a step of the study record yet (the receipt names the log row).
- Only NODAL answers. Another app adds the capability and the verb in its adapter.
- No natural-language front end: the agent writes the structured query.
- A model that is still being drawn (open ports) can be asked: NODAL only requires the schema to hold.
- The adapter and host do not limit how many queries a client asks; each is cheap and logged. A rate rule belongs with per-agent budgets (TODO, ideas).

Tests: `tests/query-model.test.ts` (33: the host's refusals and every way an adapter can misbehave with a stub adapter, the four questions against real NODAL, the NODAL adapter called directly, the CLI and the MCP tool). Mutations: `scripts/mutate-query-model.cjs`, 28 mutants, all caught.
