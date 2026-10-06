# Contracts v0.2: candidates

Status 2026-10-05. Collected while building and testing the five adapters (RAFT, FEED, NODAL, OpenMC Studio, SNEED/PRA) against contracts v0.1 ([contracts.md](contracts.md)). Every item names its evidence, checked against the schemas and code on this date. Nothing here is decided: v0.1 works for all five adapters as it is, and a change goes through a new schema version and a migration. The list is for the user's final sign-off decision.

Kinds: **schema** (needs v0.2 and a migration), **text** (clarify the contract text, no schema change), **adapter** (not a contract matter).

## Decisions (user, 2026-10-05)

- Items 1, 2, 3, 4 and 7 (schema): accepted for v0.2.
- **Item 5 (`run.seed`): option B.** A request seed must equal the model's seed; deterministic apps refuse. Implemented: OpenMC now accepts the project's own seed (it refused any), `E_REQUEST_CONFLICT` otherwise; text in contracts.md 12.1.
- **Item 6 (`oraclePin`): keep it as it is; revisit for v0.3.**
- Items 8 to 13: accepted, now written down as contracts.md section 12 (v0.1.1). Item 9: wall-clock is host-enforced, cores by OpenMC only, memory and disk advisory; host-side disk enforcement is a follow-up (TODO). Item 10: the host is to check settings against `describe.parameters` (TODO). Item 11: implemented: the shared start flow stores a payload hash and answers `E_REQUEST_CONFLICT` for the same request id with other inputs, settings or seed. Item 13: an unmappable path is `E_PATH_UNMAPPABLE` (OpenMC changed).
- **Final sign-off of v0.1: given by the user on 2026-10-05** (with the v0.1.1 clarifications of contracts.md section 12). v0.2 starts from items 1 to 4 and 7; item 6 waits for v0.3.

## Schema changes

| # | Candidate | Evidence | Proposal |
|---|---|---|---|
| 1 | `validate` cannot see the whole case | The validate request carries one `artifact` and an `operation` (`run` or `open`) and nothing else (`schema/adapter-request.schema.json`). OpenMC's script check needs the project and the script, so it can only run at `run`; NODAL validates the model but never its commands file. | Let `validate` take the same `snapshot.inputs` and `settings` as `run` (a dry run of exactly that request), with `artifact` optional. |
| 2 | Oracle entries have no settings | `schema/oracle.schema.json` has `inputs`, `expected`, `tolerance` and `coverage`, no run settings. SNEED's rare-event, min-cut-upper-bound and product-order-limit rows cannot be entries, so 11 of its 13 numerical rows are (SNEED `docs/plans/11-seed-adapter.md`); OpenMC would need thread count and seed. | Add `settings` to the entry, inside the pinned hash and passed to the run. |
| 3 | Result data files have no standard shape | Quantity `data` is a hashed file whose content is the adapter's own: a scalar (`{value}`) for PRA, a series (`{t, values}`) for NODAL and FEED, tally bins (`{bins:[{labels, mean, std}]}`) and cut sets elsewhere. Each oracle observer in the tests is hand-written per adapter (`values.at(-1)` versus `.value`), and per-bin uncertainty has no place (only one quantity-level `uncertainty`). | Define three kinds (scalar, series, table) with required fields and optional per-point uncertainty; the oracle runner, reports and agents read them generically. |
| 4 | `unit` is a free string | OpenMC had to invent `cm`, `reaction`, `particle`, `event` for quantities that are per source particle; PRA uses `1`. Nothing says how a count or a per-source quantity is written. | A `kind`/dimension tag or a small unit vocabulary; at least state the rule for dimensionless counts and per-source quantities. |
| 5 | `run.seed` has three behaviors | The request has `seed` (integer >= 0). All five adapters refuse it as `E_UNSUPPORTED` (the seed is part of the model or project) except RAFT, which accepts a seed equal to the case's. | Remove it from `run`, or define it as "must equal the model's seed". |
| 6 | `describe.oraclePin` is never used | It is in the contract; no adapter returns it and nothing reads it. | Remove it, or implement it with the oracle runner's pins. |
| 7 | Snapshot inputs have no roles | OpenMC needs a project and a script, NODAL a model and a commands file; both adapters pick roles through free `settings` keys (`project`, `model`, `commands`). | Optional `role` on `snapshot.inputs[]`. Natural companion of item 1. |

## Text clarifications (no schema change)

| # | Clarification | Evidence |
|---|---|---|
| 8 | `open` is optional | All five adapters answer `open` with `E_VERB_UNKNOWN` (their editors are web apps). Say so, and let `capabilities` advertise it. |
| 9 | Which budget fields are enforced, and by whom | The host enforces the wall-clock limit itself (`wallLimitMs` in `src/core/runManager.ts`); FEED, OpenMC and PRA also pass it to their runner as a timeout, RAFT and NODAL rely on the host alone. Cores are used only by OpenMC (a thread limit); memory and disk by no adapter (the adapter docs say so). Write which fields are enforced by the host, which by the adapter, and which are advisory. |
| 10 | Who validates settings against `describe.parameters` | `describe` declares types, bounds and enums (SNEED: `method`, `limitOrder`), but the host does not check requests against them; each adapter re-implements unknown-setting and bounds checks. Either the host checks (and the shared module gets the hook) or the text says adapters must. Recommendation: the host checks. |
| 11 | In-flight idempotency | `requestId` is the idempotency key, but a second start while the first is still launching was undefined. The shared flow (docs/adapters-shared.md) now waits for the first and returns the same job; payload comparison (`E_REQUEST_CONFLICT` for a different payload) is the host's (RunManager's `cacheKey`), adapters only guard the run folder. Write both down. |
| 12 | Cancel before the launch commits | The job's process id is recorded after the start, so a cancel in that window is refused `E_NOT_OWNED` (safe; retry shows the final state). Document it. |
| 13 | Paths into WSL | Adapters map drive-letter paths to `/mnt/<d>/...` themselves; a UNC project is a setup error. `E_PATH_UNMAPPABLE` exists in `src/core/paths.ts` for the same cases. Say which side maps. |

## Not a contract issue

- **Error codes.** The contract already lets adapters add their own codes matching `^[EW]_[A-Z0-9_]{2,40}$` (contracts.md section 0.6; SNEED passes `E_CYCLE` and `E_PROB_RANGE` through). The OpenMC adapter reports a script that is not what Studio generates as `E_STALE_REVISION` with `SCRIPT_MISMATCH` in the message; `E_SCRIPT_MISMATCH` would be legal and clearer. That is an adapter change (its tests name the current code).
- **Normalization.** The current list is enough (`per-source-particle` for OpenMC, `none` for SNEED, which the user left to the recommendation).

## Recommendation

Sign off v0.1 as the contract all five adapters implement, with the v0.1.1 clarifications of section 12 (done). Plan v0.2 for items 1 to 4 and 7; `oraclePin` (6) waits for v0.3. None of them blocks anything that works today.
