# ADR: local file host for guarded runs

Status: Proposed production format; implemented as local v0.1 on 2026-10-04.

## Context

E2 needs a public CLI without allowing client requests to supply their own authority or oracle verdicts. Separate processes also need shared engine ownership and durable admission evidence. D1-D4 require common core enforcement, project files and app-owned oracles.

## Decision

Use an externally provisioned, schema-validated host file, a per-runtime exclusive directory lease and an append-only hash-chained journal. The CLI accepts registered case IDs and budgets and calls the same RunDispatcher as library clients. Configuration and evidence live outside projects. No client approval writer is exposed. The contract and limitations are in [host-cli.md](host-cli.md).

## Options

| Option | Benefits | Costs |
| --- | --- | --- |
| Local files and leases (selected) | Fits current project-file design; inspectable; no background service | Cooperative ownership; manual crash recovery; bounded journals |
| Local database and daemon | Central ownership and recovery; easier concurrent clients | Service lifecycle, migrations and extra deployment work |
| Client-provided policy | Simple request shape | Cannot establish trusted authority; rejected |

## Consequences

The host account controls configuration and accepted pins. The hash chain is not an authentication mechanism. All hosts for an engine must share state. Interrupted hosts leave leases for inspection. OS resource enforcement and signed policies are not supplied by this implementation.

## Action items

- MCP over the same file host implemented 2026-10-04; add calculation cancellation with verified process ownership.
- Define recovery and journal rotation before unattended operation.
- Complete a reproducible study/report demonstration and E2 review.
- Obtain the owner's decision on production policy format and signing authority.
