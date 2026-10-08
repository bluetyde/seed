# SEED MCP access

SEED exposes a local stdio MCP server over the same FileRunHost used by the guarded CLI. It uses the official MCP TypeScript SDK (v1 CommonJS-compatible package; pinned in package-lock.json). No HTTP listener or app private port is opened. The implementation follows the SDK's [stdio server documentation](https://ts.sdk.modelcontextprotocol.io/server).

## Start and connect

Install the updated locked dependencies with `npm ci --include=dev`, then `npm run build`. Configure your MCP client to launch Node directly:

```json
{
  "mcpServers": {
    "seed": {
      "command": "C:/absolute/path/to/node.exe",
      "args": ["C:/absolute/path/to/experiment-studio/dist/mcp/seed.js"],
      "env": { "SEED_HOST_CONFIG": "C:/absolute/external/host.json" }
    }
  }
}
```

Replace all paths with actual installed locations. The `mcpServers` envelope is client-specific; the command, arguments and environment are the required values. Use direct Node to keep stdout exclusively JSON-RPC. For manual launch, `npm run --silent seed:mcp` also suppresses npm banners. The trusted host file and evidence must be provisioned first; see [host-cli.md](host-cli.md). SEED does not automatically configure your AI client.

## Tool contract

The calculation tool is `seed_run_case`; `seed_cancel_calculation` requests an actual stop through the live owner ([details](cancellation-recovery.md)). Discovery exposes its strict input schema and limitations. Supply the same request as the CLI:

```json
{"requestId":"lesson-mcp-1","caseId":"approved-case","budget":{"maxWallSeconds":30,"maxCores":1,"maxMemoryMB":512,"maxDiskMB":512}}
```

Actor, configuration path, executable, policy, grants, parameters, settings, input paths and oracle verdicts cannot be supplied by the client. Unknown fields, including nested budget fields, are refused. `requestId` is limited to 256 characters, case IDs to 64; budget values must be positive safe integers. Unknown tools are refused. There is no approval, configuration-writing or recovery tool; human recovery is available through the CLI for the supported abandoned-run case.

`seed_export_study_report` accepts only the terminal calculation's original `requestId`. Set the external human header through `SEED_STUDY_HEADER` before starting the MCP server; export checks fresh append-step policy and writes a new immutable study/report bundle in the project. See [single-case study/report setup and limits](study-report.md).

`seed_query_model` asks a registered case's model a read-only structured question (`requestId`, `caseId`, `query`; no path, actor or grant): the answer is a fact about the model file, with the file's SHA-256 and a receipt for the host's query log; see [query-model.md](query-model.md). `readOnlyHint: true`.

`seed_add_study_note` adds one note to the live study record ([study-record.md](study-record.md)): `{noteId, text, runs?}`, text 1 to 1500 characters, at most 20 run ids of this project. It passes the gate as `append_step` (tier A1 or a grant), is recorded as the host's actor, is stored as data, and the same note is recorded once. It needs the human study header (`SEED_STUDY_HEADER`) in the server environment; without one there is no record and the tool says so. There is no tool to edit or delete a row.

Successful calls return text JSON plus identical structuredContent with `schema: seed.mcp-reply/0.1`, the run ID and terminal state. A refusal or failed calculation sets `isError: true`; host outcomes contain typed SEED errors. Protocol/schema errors rejected by the SDK use MCP's error response conventions and do not enter the host admission journal. Host refusals use its existing logging behavior; setup/lease failures before journal access cannot write an admission row.

Every admitted call rereads the selected host file. Host policy/grant revocation and changed evidence therefore affect subsequent calls on an existing connection. The host applies the same oracle/input/runtime/app pin checks, pre-launch journal and shared engine lease as the CLI. Requests naming the same project and request ID retain core retry/idempotency behavior; the tool does not promise unconditional idempotence after configuration changes.

## Lifecycle and limits

Calls wait for the terminal host outcome. Set the client's call timeout to the study's wall budget plus setup/cleanup time; MCP clients often have shorter defaults. Cancelling the MCP request is **not calculation cancellation**. A detached per-call supervisor runs FileRunHost, keeps the engine lease and records the terminal outcome independently of the MCP server process. It may no longer deliver a reply to the cancelled client.

On stdin EOF, the server stops accepting requests; an admitted calculation finishes its host records before the process exits. The calculation supervisor survives an MCP client terminating its server after closing stdin. Killing the supervisor itself or terminating its entire process tree is different: it can leave an adapter/runner and abandoned lease. Human inspection/recovery is still required. Do not treat client transport close as proof the calculation stopped; clients may kill their child server rather than send EOF.

The stdio buffer is bounded to 1 MiB. Oversized input closes the transport; malformed protocol data is reported on stderr without echoing client content. This buffer cap is not a throughput/rate limit or an OS resource limit. Actual calculation cancellation now uses the separate cancellation tool. No GUI controls, HTTP authentication or complete study/report workflow are added here. All configurations for a runtime must share host state to coordinate ownership. RAFT remains limited to the validation domain documented by its app/oracles.

## Verification

`npm test` builds the server and tests official SDK client discovery/calls over real subprocesses, malformed/oversized frames, missing setup, authority overrides, persistent grant revocation, changed evidence, CLI/MCP competition, cancelled requests, stdin disconnect and SDK client shutdown beyond its termination grace period. `SEED_RAFT_REPO=<built checkout> npm run test:e2:raft` additionally compares a real MCP calculation with CLI and direct/adapter evidence. These checks do not imply measured-reactor validation.
