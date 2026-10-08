# Guarded host CLI

The first public calculation entry point is `src/cli/seed.ts`. Build with Node 24 and `npm run build`. A trusted local setup selects an absolute host configuration path through `SEED_HOST_CONFIG`, then runs `node dist/cli/seed.js run`. Send one JSON request on stdin; stdout contains one `seed.cli-reply/0.1` JSON reply. Exit codes are 0 for completion, 1 for a calculation failure, and 2 for refusal or setup failure. With npm, use `npm run --silent seed:cli -- run` to avoid npm messages on stdout.

Example request (budget must fit the configured study):

```json
{"requestId":"lesson-1","caseId":"approved-case","budget":{"maxWallSeconds":30,"maxCores":1,"maxMemoryMB":512,"maxDiskMB":512}}
```

The client cannot provide an actor, policy, executable, input path, parameters or approval. Unknown fields and verbs are refused. The `cancel` verb accepts only the original requestId, as does the human-only `recover`, which lives in the separate admin entry (`node dist/cli/admin.js recover`, `SEED_ADMIN_HOST_CONFIG`, never in the agent CLI); see [cancellation and recovery](cancellation-recovery.md). Input is bounded to 1 MiB and must finish within ten seconds. There is no CLI approval or configuration-writing command.

The `report` verb also accepts only the original requestId. With a trusted external human `SEED_STUDY_HEADER`, it saves a guarded single-case study/report bundle; see [setup and limits](study-report.md).

## Trusted setup

`schema/host.schema.json` defines the provisional local `seed.host/0.1` format. `saveHostConfiguration` validates and atomically writes it from trusted setup code. The file contains:

- Absolute project, existing external state directory and adapter executable paths; adapter ID/version and arguments.
- Host actor and study tier, budget, parameter bounds, and optional human-approved scoped grants.
- Registered cases with artifact revision, hashed input files, settings, seed and complete parameter values.
- Runtime bundle path and SHA256, app repository and oracle directories, and accepted app/oracle pins.
- An external oracle evidence file and its SHA256. This is a real `runOracleSet` result, not a client assertion.

Configuration, state and oracle evidence must reside outside the project. Protect these locations using the host account's filesystem permissions. The host rechecks configuration and runtime bytes, actual oracle files and inputs, app commit and evidence before admission. Revocation is read on the next request. The project manifest selects the runs folder. RAFT's runtime environment override is supplied by the host for each adapter process.

This is a trusted local file format, not a signed policy format. Configuration authors can change authority and accepted evidence. Who signs production policies and the final policy format remain open decisions.

## Records and process ownership

All configurations using the same canonical runtime must share the same external state directory. An exclusive engine lease covers admission and execution across cooperating CLI processes, including different projects. The project writer lock also covers the run. Hosts choosing different state directories do not coordinate.

The engine directory contains `admissions.jsonl`: request/configuration snapshot, policy decision and outcome. Rows have sequence numbers and a SHA256 chain. File content is flushed before launch; the chain detects accidental modification and is not a signature. A partial, corrupt or full journal blocks further admission rather than resetting history. Files and journals are limited to 8 MiB. Parent-directory metadata persistence across power loss depends on the operating system.

An abandoned lease is deliberately not taken over automatically. Inspect its owner record, admission history and relevant adapter/runner processes before human recovery; process death does not prove the underlying calculation stopped. Recovery and journal rotation are future work. If a completed run cannot write its terminal record, the reply reports the logging failure and retains the run ID.

## Remaining E2 work

The [stdio MCP route](mcp.md) now reuses the guarded file host; future GUI routes must do the same. Owner-mediated cancellation and bounded human crash recovery now exist. General host-death cleanup, resource enforcement, a complete study/report demonstration and E2 review remain unfinished. Budget admission alone does not impose OS CPU, memory or disk limits. RAFT acceptance uses its synthetic library and establishes transport agreement, not independent validation of every physics quantity.

Verification: `npm test` builds the CLI before tests; `npm run test:e2:raft` requires a built RAFT checkout selected by `SEED_RAFT_REPO`, and exercises the real CLI as well as oracle/direct agreement.

## Conclusion proposal

After saving a registered report, `node dist/cli/seed.js draft-conclusion` accepts JSON on stdin with exactly `reportId` and `claims`. A claim contains `text`, `runs` and `oracles`; use the report's run ID or an oracle-set ID recorded in its study. The reply returns an opaque draft ID and hashes. This stores a draft only. Human review/acceptance uses a separate native desktop confirmation and trusted reviewer setup; no acceptance CLI or MCP tool exists. See [record contracts and limits](conclusion-review.md).

`node dist/cli/seed.js query` takes `{requestId, caseId, query}` on stdin and answers a read-only question about a registered model ([query-model.md](query-model.md)); exit 0 answered, 2 refused. `node dist/cli/seed.js note` takes `{noteId, text, runs?}` on stdin and adds a note to the live study record ([study-record.md](study-record.md)); `node dist/cli/seed.js sweep` runs a registered sweep ([sweeps.md](sweeps.md)). Runs write their steps to the record themselves when the host environment has `SEED_STUDY_HEADER`.
