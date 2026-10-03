# Plan 03: Adapters and transport

The seven verbs, how the core talks to each app, and what an adapter must and must not do. Milestone E0 (decide and prove with a fake), E2 (first real adapter).

## Principles

- An adapter is thin. It maps a verb to an app's existing entry point and normalizes the reply. It does not change the app's physics or its native format.
- Native contracts stay authoritative. SEED metadata wraps them; it does not add unchecked fields to strict schemas. Schema changes need an explicit migration.
- Every app stays usable without SEED. An adapter must not alter standalone launch.

## Verbs

| Verb | Required behaviour | Must not |
|---|---|---|
| `describe` | App and engine versions, native formats, capabilities, typed parameters, output quantities, **the oracle coverage it claims** | Report a capability it cannot run |
| `open` | Open or focus an editor on an artifact at a revision | Start a calculation; write to the artifact |
| `validate` | Structured errors: missing property, unsupported feature, unit, domain; per field | Return a bare failure or a free-text-only error |
| `run` | Execute an immutable snapshot; return job ID and run location | Read a live editable model; start without a gate pass |
| `status` | Lifecycle plus native status and diagnostics | Hide a trip or partial output behind "ok" |
| `cancel` | Stop that job's own process tree | Touch another job, another agent's server, WSL itself |
| `collect` | Results index, hashes, units, mappings, diagnostics | Index incomplete output as a result |

These are semantic operations, not endpoint names.

## Transport options (decide in E0 against a fake)

| Option | For | Against |
|---|---|---|
| A. CLI per app (`app adapter <verb> --json`) | Simple, no ports, easy for CI and agents, matches how apps already start | Process start cost; streaming status needs polling or a file |
| B. Local service per app (loopback, token) | Live status, cancellation, fits the shell's existing token pattern | Ports to allocate; auth to get right; another process to own |
| C. In-process library (apps import a package) | Fastest | Couples SEED to each app's language and release; breaks "thin" |
| D. A (default) plus B only where an app already runs a server | Uses what exists; no new servers | Two code paths to test |

Leaning toward D, decided after the inventory (TODO E0 task 1) shows each app's real entry points. The decision records the rejected options and why.

Agents reach SEED through **one MCP server** that wraps the core; an agent never talks to an app's own port. A plain CLI over the same command set serves scripts and CI (decision D1, [../DECISIONS.md](../DECISIONS.md)); the CLI is built first and MCP wraps it.

## Reply rules

- Typed errors: `{code, field, message, unit?, range?, source}`; `source` is `seed` or `app-content`. Text derived from app content is escaped and labelled.
- Idempotence: the same snapshot and settings give the same run ID, or the reply says plainly that it does not.
- Versioned: every message carries a schema ID and version; an unknown version is refused with a code, not partially interpreted.
- Bounded: every reply has a size limit; large data is a reference plus a hash.

## Inventory (E0, first task)

One row per verb per app: what exists today, the entry point, and what is missing. Start with OpenMC Studio, NODAL Studio and Virtual Reactor (existing run, model and results contracts: for example NODAL's `docs/run-manifest.md`, `results-format.md`, `runtime-protocol.md`; RAFT's library format and scenario/session). PRA and Fuel Performance Studio have plans only and are listed as `not built`.

## Fake adapter

Scripted behaviours selected by the input: success, validation failure (each error kind), crash, hang, partial output, trip, stale revision, slow output, huge output, instruction-like text in a field. It is the transport's proving ground and the base for harness tests 1 to 6 ([plan 05](05-agent-harness.md)). It lives in this repo and is not shipped as an app.

## Tests

- Each verb against the fake, good and bad.
- Unknown schema version refused.
- `cancel` kills only the job's tree (a sibling job and an unrelated process survive).
- A reply containing instruction-like text is stored and shown as data and starts nothing.
- Standalone launch of each real app is unchanged after its adapter lands.
