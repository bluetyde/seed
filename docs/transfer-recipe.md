# Transfer recipe and approval (proposal)

Status 2026-10-06: **decided by the user (Q1 to Q4 all as recommended); core and host wiring built (section 6), a coolant boundary from NODAL (section 7); not yet the study-log steps.** E4 step 4 of [TODO.md](../TODO.md), under [plan 08](plans/08-transfers-and-pipelines.md). It answers plan 08's open item "recipe file format and where it lives" and replaces FEED's provisional shapes (`feed.transfer-recipe/0.1`, FEED decision 0003). Data shapes and units it builds on: [contracts-v0.2-data-shapes.md](contracts-v0.2-data-shapes.md) (decided, built).

## 1. What already exists

- **Operations** (`src/core/policy.ts`): `propose_transfer` is tier A2 (writes a proposal, cannot enable it); `enable_transfer` needs a **human grant** even at A3. A grant names the actor, the operation and the exact input revisions, expires, and only a human can issue it (`issueGrant`). A failed oracle set or changed pins blocks `propose_transfer`.
- **An approval pattern** (`src/core/conclusionReview.ts`): drafts and human reviews are host records in the host state folder, outside the project, bound to the project id and root and to the content by hash; an agent cannot write them.
- **The receiving end** (FEED `src/core/transfer.ts`, 81 tests, Codex reviewed): FEED checks units, normalization, coverage, conservation, revisions and the boundary form, and maps heating bins to axial slices. Its recipe and source shapes are FEED-owned and provisional, and its approval is a digest only ("anyone who can edit a recipe can recompute it").
- **Result data** is readable generically (`readQuantityData`: scalar, series, table, each with unit and optional `dimension`).

## 2. Proposal

### 2.1 Division of work

| Who | Does |
|---|---|
| SEED core | Owns the recipe file, its states, the approval record, source resolution (which run, which quantity, which data file hash), the checks that need only SEED's records and the generic data shapes (units and dimension, normalization declared, revisions current, run is verified and from this project, source and target inputs unchanged since approval, no cycles), invalidation, and the provenance written into the downstream run record. |
| Target app (FEED first) | Owns the physical mapping and its physical checks: coverage of the target region, bin-to-slice overlap, conservation within the tolerance fixed in the recipe, boundary form completeness. The mapping is a **pure function of (recipe, source data, target input) -> new target input**, run by the app's own code (FEED's `mapHeating` / `applyToCase`). |
| Source app adapter | Supplies a quantity that is fit to be a source: a `dimension`, a unit, a `normalization`, per-bin volume or region where the mapping needs it. A quantity without a `dimension`, or whose normalization the recipe does not resolve, is refused by SEED before the app is called. |

Reason: D3 (apps own physics and oracles). A generic mapper in SEED would duplicate FEED's, which is already reviewed, and could not know the target's region rules.

### 2.2 The recipe file `seed.transfer-recipe/0.2`

One JSON file per transfer, in the project's new folder `transfers/<recipeId>.json` (a fifth entry under `folders`, optional; a project without one has no transfers). It is part of the project (reviewable, diffable, committed) and carries **no approval**.

```
{ "schema": "seed.transfer-recipe/0.2",
  "recipeId": "<id>",
  "proposedBy": { actor },  "proposedAt": "<time>",
  "source": { "runId", "resultsSha256", "quantity": "<name>", "dataSha256",
              "unit", "dimension", "normalization", "revisionPins": [ {artifact, revision} ] },
  "target": { "app": "<adapter id>", "artifact": "<project artifact id>", "revision": "<sha256>",
              "field": "<app-declared transfer kind, for example heating-to-pin | coolant-boundary>" },
  "units":  { "to": "<unit>", "factor-source": "<how normalization is resolved>" },
  "normalization": { "kind": "source-rate | total-power | none", "value": { "value", "unit" }, "origin": "<where the number comes from>" },
  "mapping": { "spatial": { ... }, "time": { "kind": "steady | series", ... }, "extrapolation": "refused" },
  "tolerance": { "conservation": <relative>, "fixedBefore": "mapping" },
  "applicability": { "range": ..., "note": "..." } }
```

`mapping.spatial` and the `target.field` vocabulary are declared by the target app in its `describe` (`transfers: [{field, accepts: [{dimension, normalization}], parameters}]`: an additive, optional field of the existing reply; v0.1 adapters without it have no transfers). The recipe's digest is `sha256(canonicalJson(recipe))`.

### 2.3 States and where they live

`proposed` (recipe file written by an agent at A2 or a human) -> `approved` (a human approval record for this digest) -> `applied` (a new target revision exists, with the run record naming the recipe and the source run) -> `stale` (any pinned revision changed). Only `approved` recipes can be applied.

### 2.4 The approval record `seed.transfer-approval/0.2`

Written only by the host's human path, into host state beside the conclusion reviews, never into the project and never by an MCP tool:

```
{ "schema": "seed.transfer-approval/0.2", "approvalId", "projectId", "projectRoot",
  "recipeId", "recipeDigest", "inputRevisions": [ source and target revisions ],
  "approvedBy": { kind: "human", name }, "approvedAt", "expires", "grantId" }
```

It is the existing `enable_transfer` grant made concrete: the grant's `inputRevisions` are the recipe's source and target revisions, so any change to either makes the gate stop it (`findGrant` already compares exact sets). Editing a recipe after approval changes its digest and voids the approval. This gives the identity and tamper evidence FEED's digest lacks; its limit is the D4 threat model (an agent with shell access can edit host state; the record stops mistakes through MCP and CLI, not a hostile shell).

### 2.5 Refusal table (plan 08 plus the checks above)

Each refusal is a typed error naming the recipe, with `source: "seed"` or `"app-content"`.

| Check | Code | By |
|---|---|---|
| Units missing, unknown, or not valid for the quantity's dimension | `E_UNITS` | SEED |
| Quantity has no `dimension`, or the recipe's dimension differs | `E_UNITS` (field `/source/dimension`) | SEED |
| Per-source-particle (or other normalized) score without a declared normalization in the recipe | `E_NORMALIZATION_MISSING` | SEED |
| Source run not completed, not from this project, results or data hash differs from the pin, or its oracle set is not clear | `E_STALE_REVISION` / `E_OUTPUT_INCOMPLETE` | SEED |
| Target revision differs from the pin (any edit after approval) | `E_STALE_REVISION` | SEED |
| Recipe not approved, approval expired, recipe edited after approval, grant does not name these revisions | `E_NOT_PERMITTED` (gate stop in the study log) | SEED |
| Agent tries to enable or edit the tolerance | `E_NOT_PERMITTED` | SEED |
| A cycle in the pipeline graph | `E_RECIPE_CYCLE` | SEED |
| Coverage incomplete (never extrapolated) | `E_COVERAGE` | app |
| Conservation outside the recipe's tolerance | `E_CONSERVATION` | app |
| Boundary form missing or incomplete | `E_BOUNDARY_INCOMPLETE` | app |
| Uncertainty missing where the target needs it | `E_UNCERTAINTY_MISSING` | app |

New codes are adapter-style codes (the contract lets hosts and adapters add codes matching `^[EW]_[A-Z0-9_]{2,40}$`); FEED already uses the app ones.

### 2.6 Invalidation and provenance

An applied transfer records `{recipeId, recipeDigest, approvalId, sourceRunId, sourceResultsSha256, targetRevisionBefore, targetRevisionAfter}` in the target's next run record (`provenance.mappingRecipe` already exists in the results index). Changing the source model, the source run's data or the target before the transfer marks the recipe `stale`: a stale recipe cannot be applied and its downstream runs are shown as based on a stale transfer, never silently reused.

### 2.7 How the transfer runs

`apply_transfer(recipeId)` is a host operation (tier A1 once approved; the gate checks the approval): SEED loads and re-validates the recipe, reads the source through `readQuantityData`, runs the SEED-side checks, then calls the target app's transfer entry point with the recipe, the source data and the target input; the app returns the new input (or typed refusals); SEED writes it as a new target revision through `new_revision` rules and records the provenance. The entry point is the app's own CLI (`transfer` command beside `describe`/`validate`/`run`, request on stdin and reply on stdout like the adapter verbs), **not** a new adapter verb: contracts v0.1 stay as signed off.

### 2.8 Built and tested against fake apps first (plan 08)

A fake source app emitting a scripted heating field (a table with units, dimension, normalization) and a fake target with a trivial mapping, then: each refusal row fires; the good case passes; a deliberately lossy mapping fails conservation; a cyclic definition is refused; an upstream change marks downstream stale; a uniform field to a uniform target reproduces the total exactly. Then FEED's real `transfer` entry point replaces the fake target (FEED's side: expose `mapHeating`/`applyToCase` behind that CLI and accept this recipe in place of its provisional one), and the OpenMC heating source (E4 step 2) replaces the fake source.

## 3. Questions for the user

- **Q1. Who computes the mapping?** (recommended) The target app, behind its own `transfer` CLI, with SEED doing the generic checks. The alternative is a generic SEED mapper for all targets: less app work, but it duplicates FEED's reviewed code and cannot know each target's region rules.
- **Q2. Where do recipes live?** (recommended) In the project (`transfers/`, a new optional `folders.transfers`), approvals in host state outside the project like the conclusion reviews. The alternative is everything in host state: simpler, but a recipe would not travel or diff with the project.
- **Q3. Approval authenticity.** (recommended) Host record plus grant and digest, within the D4 threat model (no signature). A cryptographic signature by the reviewer needs identity management SEED does not have; it can be added later as a field without changing the recipe.
- **Q4. The target entry point.** (recommended) An app CLI command `transfer`, not a new adapter verb. A verb would be a v0.2 contract change to what you just signed off; a separate command leaves v0.1 intact and lets FEED add it on its own schedule.

## 4. What I would build, in order, if approved

1. Schemas `transfer-recipe` and `transfer-approval` (new families, vectors good and bad), optional `folders.transfers` (project schema 0.2 migration note), and the optional `transfers` array in `describe`.
2. `src/core/transfer.ts`: recipe load and digest, state evaluation (proposed, approved, applied, stale), the SEED-side checks, the pipeline graph (cycle refusal, stale propagation), the approval record writer on the human path, and `apply_transfer` against a fake target command; tests with fake apps, then mutation checks.
3. Gate wiring (`propose_transfer`, `enable_transfer`, `apply_transfer`) and study-log steps (a gate stop is recorded as today).
4. A message in `messages/fuel-performance-studio.md` with the recipe schema and the `transfer` command contract for FEED's agent to adopt.

## 5. FEED, the first target (2026-10-06)

FEED built its `transfer` command on this recipe (FEED `docs/transfer-heating.md`; `node dist/cli/headless.js transfer`; `describe.transfers` lists `heating-to-pin`). Choices made there and confirmed here: `units.to` is `W` (FEED converts the bins to watts and slices them itself; it sets the case heat rate in W/m); a `total-power` normalization is the **pin's** total, not the core's, and the recipe states `pinBinCount` so a partial export cannot hand missing bins' power to the rest; `mapping.spatial` is FEED's vocabulary (`pin`, `frame`, `slices`, `applyTo`, `pinBinCount`, `columns`); the source table has a `pin` label, `z_min` and `z_max` coordinates (length), optionally `volume`, one value column and its `std`, and `meta.frame`. One transfer sets one slice (`applyTo`); several slices are several recipes. The SEED adapter passes `describe.transfers` through (`adapters/feed`), and `tests/feed-transfer.test.ts` runs the real command behind `applyTransfer` with expected heat rates computed independently from the bins.

## 6. Host wiring (2026-10-06)

`src/core/transferHost.ts`, with the CLI (`src/cli/seed.ts`), the admin CLI (`src/cli/admin.ts`) and the MCP server (`src/mcp/seed.ts`). Tests: `tests/transfer-host.test.ts` (fake source and target apps, real project store, real oracle evidence per app, real approval records, the real CLI entry points and the MCP tools in process).

**Configuration** `seed.transfer-host/0.1` (`schema/transfer-host.schema.json`), selected by the trusted environment, never by a request: the project root, the state root (both outside each other; the configuration file outside the project), the actor and the study (tier, budget), and for every app its adapter identity, its hash-pinned oracle evidence and accepted pins, and, for a target, its `transfer` command and the transfer fields it declares (copied from `describe.transfers` by trusted setup). Agent: `SEED_TRANSFER_HOST_CONFIG`. Human approval: `SEED_ADMIN_TRANSFER_HOST_CONFIG`, whose actor must be a human.

| Verb | Who | What it does |
|---|---|---|
| `transfer-propose` `{recipe}` (CLI, MCP `seed_propose_transfer`) | agent, tier A2 | Checks the recipe against the source run (read from the project's runs folder) and the target (units and dimension, normalization, revisions, the target's declared fields), refuses a cycle, applies the `propose_transfer` gate with the oracle flags of the source and target apps, and only then saves it in the project's `transfers/` folder. A recipe that is invalid or stale is refused and nothing is saved. |
| `transfer-status` `{recipeId}` (CLI, MCP `seed_transfer_status`) | agent | The state (proposed, approved, applied, stale, invalid) and the reasons. Read only. |
| `approve-transfer` `{recipeId, recipeDigest, expiresInHours?}` (admin CLI only, **no MCP tool**) | human | Records an approval for exactly the recipe content whose digest the reviewer read (at most 168 hours), for the proposer, bound to the exact source and target revisions. Refused for anything that is not a clean proposal. Written to host state, outside the project. |
| `transfer-apply` `{recipeId}` (CLI, MCP `seed_apply_transfer`) | agent | The \`enable_transfer\` gate through the approval, the SEED-side checks, the oracle sets of both apps clear (writing a new target revision is a new revision in effect), the target's own \`transfer\` command (FEED's coverage and conservation checks decide), then the new target file is written, the artifact's revision becomes \`{hash of the new content, counter + 1}\` through the project store (the old file is put back if the project cannot record it), an applied record is saved in host state and the provenance returned. |

Every decision (request, refusal, outcome) is appended to a hash-chained journal in the state folder (`transfer-journal/admissions.jsonl`, the same format as the run host's). An **applied** recipe stays applied while its source and the target it produced stand, whatever became of its approval; a later change of either makes it stale.

Not done: a transfer does not yet appear as a step in the study log (the journal records it); cylindrical and other source shapes; a real FEED command behind the host test (the core is tested with real FEED in `tests/feed-transfer.test.ts` and `tests/openmc-heating.test.ts`, the host with a fake target).

## 7. A coolant boundary from NODAL (2026-10-06)

A convective boundary needs two things from one run, and a fuel case needs them for an identified axial region: the coolant's bulk temperature and the heat transfer coefficient (plan 08: a bulk temperature alone is not a complete boundary). The recipe grew for that, additively:

- `source.additional[]`: further quantities of the same run, each `{role, quantity, dataSha256, unit, dimension, normalization, unitTo?}`. The **role** is the name the target gives it (`heat-transfer-coefficient`). Each is checked exactly like the primary quantity (index entry, pinned hash, unit, dimension, readable data) and must be absolute (normalization `none`); roles and quantities are unique. `unitTo` is the unit the target should receive it in and must fit the dimension.
- `mapping.time.select`: for a **steady** transfer from a time series SEED picks the sample before the app sees anything: `{kind: "last"}` or `{kind: "at", t}`. At a time between two samples the value is linear between them and flagged `interpolated`; a time outside the series is refused (`E_TIME_MAPPING`), never extrapolated. A series with no `select` is refused too. The chosen samples (quantity, time, value, interpolated) are recorded in the provenance.
- `describe.transfers[].accepts[].additional`: the roles (and dimensions) a target takes with that primary quantity. A recipe matches an entry only when it carries exactly those roles.
- Request to the target (`seed.transfer-request/0.2`): `source.selected` for the primary series, and `source.additional[]` with `{role, quantity, data, selected}` for the others.
- New dimension `heat-transfer-coefficient` (W/m2/K, a different dimension from `heat-flux`, W/m2).

The NODAL adapter now writes `seed.quantity-data/0.2` series and a `seed.results-index/0.2` with dimensions for the channels it knows (temperature, wall temperature, pressure, mass flow, heat transfer coefficient, time) when their units are the matching ones (K or degC, Pa, kg/s, W/m2/K, s); another pair stays free text and the quantity is not offered to transfers. `tests/nodal-boundary.test.ts` runs the heated-pipe model through the adapter (real NODAL): `t_out` (coolant temperature at the pipe outlet) and `h_surf` (the wall's coefficient) become the primary and the `heat-transfer-coefficient` role of a recipe for a fake boundary target, the boundary values equal the committed golden vector's last values, and a time between two samples equals the golden vector's linear mean.

What SEED cannot check: that the NODAL cell and the heat structure the two channels belong to are the axial region the recipe's `mapping.spatial.region` names. The recipe states the region (the target's vocabulary); the human who approves reads both. A shared geometry convention across NODAL and the fuel case stays an open item of plan 08.

## 8. A record as the source: the burnup into FEED (2026-10-08)

A transfer's source has been a **quantity of an adapter run** (recipe `seed.transfer-recipe/0.2`). FEED needs a burnup that comes from a **project file**, the depletion record OpenMC Studio writes (`studio.depletion/0.1`, record kind `depletion-record/1`, listed `planned` in `record-kinds.json` until Studio pins the schema hash that makes it `defined`: the owner freezes the format, SEED does not). The recipe grew a second form, `seed.transfer-recipe/0.3`, with a record source; the 0.2 form is unchanged. Code: `src/core/depletionRecord.ts` (the record), `src/core/transfer.ts` (`validateRecipe`, `evaluateRecordTransfer`, `applyRecordTransfer`), `src/core/transferHost.ts`; schema `schema/transfer-recipe-record.schema.json`; tests `tests/transfer-record.test.ts` (43, with Studio's own record `tests/fixtures/depletion/pin_record.json` and a fake target `tests/fixtures/fake-transfer/burnup-target.cjs`); mutations `scripts/mutate-transfer-record.cjs` (26, all caught).

```
{ "schema": "seed.transfer-recipe/0.3", "recipeId": "...", "proposedBy": {actor}, "proposedAt": "...",
  "source": { "kind": "record", "record": "depletion-record/1", "artifact": "<project artifact id of the record>",
              "recordSha256": "<sha256 of the file>", "recordId": "<the record's own id, 64 hex>",
              "region": "UO2 3.5%", "time": 5,                      // days from the start of the record
              "revisionPins": [ { "artifact": "<same artifact>", "revision": "<recordSha256>" } ] },
  "target": { "app": "feed", "artifact": "<case>", "revision": "<sha256>", "field": "burnup" },
  "units":  { "field": "burnup_mwd_per_tu", "from": "MWd/tU", "to": "MWd/kgHM", "factor": 0.001, "basis": "heavy-metal" } }
```

**What SEED checks before the target sees anything** (states and approval are the same as for a run source; the pin is the record's artifact at the file's hash, so an approval covers exactly this record):

| Check | Code |
|---|---|
| The unit conversion is the one SEED knows for the field (MWd/tU to MWd/kgHM, 1e-3, heavy metal) | `E_UNITS` |
| The record file exists, is the pinned file (hash) and has the pinned id | `E_OUTPUT_INCOMPLETE` / `E_STALE_REVISION` |
| The record is a `studio.depletion/0.1` with an id, whose id equals the SHA-256 of its canonical text (Studio's rule: sorted keys, no spaces, the top-level `id` left out, number and string tokens as written, so `190.0` is not `190`) | `E_RECORD_INVALID` / `E_RECORD_ID` |
| The region exists in the record | `E_REGION_UNKNOWN` |
| The time lies inside the record: cumulative burnup at the **end** of each step, linear inside a step from the previous end, 0 at t = 0; never extrapolated | `E_TIME_MAPPING` |
| The target declares the field and accepts a `burnup` source (`describe.transfers`) | `E_UNSUPPORTED` / `E_UNITS` |

**The request to the target** (`seed.transfer-request/0.3`, its own `transfer` command, same transport): `recipe`, `recipeDigest`, `source: {kind: "record", record, recordId, recordSha256, region, time, quantity: {name: "burnup", dimension: "burnup", unit: "MWd/kgHM", basis: "heavy-metal", value}, original: {unit: "MWd/tU", value}, interpolated}` and `target: {artifact, revision, content}`. The target maps it into its case (FEED: `burnup.value`, `basis`, and a `source` text containing the record id) and replies as for any transfer. Its physical refusals stay its own (FEED: fuel conductivity `uo2-nfi`, steady only, 0 to 62 MWd/kgHM). **The applied record** names the record (`sourceRecordId`, `sourceRecordSha256`) instead of a run. Only the target app's oracle evidence is checked for a record source (there is no run and no source adapter).

**Against FEED's real command (2026-10-08, `tests/feed-burnup-e2e.test.ts`, 9 tests, run with `SEED_FEED_REPO` at a FEED checkout with the burnup transfer, branch `claude/burnup-transfer` or later, built):** propose, approve and apply on FEED's own example case and Studio's real record, with the command line of FEED's runner and the `describe.transfers` its real `describe` reports; days 5, 1, 3 and 0 give 0.19, 0.038, 0.114 and 0 MWd/kgHM; the day-5 case equals FEED's own expected case apart from the case id, the name and the provenance entry; FEED's own refusals (a burnup above 62 MWd/kgHM, a fuel that is not `uo2-nfi`) come back through SEED and leave the case untouched; SEED refuses a time past the record before FEED is asked. The real run found one gap the fake target hid: the transfer-host configuration schema rejected the `parameters` of a transfer field that FEED's `describe` reports; it now accepts them (`schema/transfer-host.schema.json`).

Not done: a record from another kind or another field (each needs an entry in `RECORD_CONVERSIONS`); regions finer than a material (held with FEED).

