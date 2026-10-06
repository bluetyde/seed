# Transfer recipe and approval (proposal)

Status 2026-10-06: **decided by the user (Q1 to Q4 all as recommended); core built (sections 2.1 to 2.8 without the gate wiring in the host and the study log, and without registering the applied revision in the project).** E4 step 4 of [TODO.md](../TODO.md), under [plan 08](plans/08-transfers-and-pipelines.md). It answers plan 08's open item "recipe file format and where it lives" and replaces FEED's provisional shapes (`feed.transfer-recipe/0.1`, FEED decision 0003). Data shapes and units it builds on: [contracts-v0.2-data-shapes.md](contracts-v0.2-data-shapes.md) (decided, built).

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
