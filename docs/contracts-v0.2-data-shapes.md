# Contracts v0.2: result data shapes, units and dimensions (proposal)

Status 2026-10-06: **proposal, not decided.** Covers candidates 3 and 4 of [contracts-v0.2-candidates.md](contracts-v0.2-candidates.md) (the user accepted both for v0.2). No schema file changes until the user approves this text. First step of the E4 order in [TODO.md](../TODO.md); the FEED transfer intake (its decision 0003) and the recipe schema read result data through whatever this fixes.

## 1. What exists today (checked in the adapters, 2026-10-06)

Every quantity in a `seed.results-index/0.1` points at a hashed data file. The index already carries `unit`, `normalization`, `coordinates`, `timeGrid` and a quantity-level `uncertainty`. The files differ:

| Adapter | File content | Notes |
|---|---|---|
| RAFT | `{quantity, unit, t[], values[]}` | series over time |
| NODAL | `{quantity, kind, location, unit, t[], values[], min[]?, max[]?}` | series, optional envelope |
| FEED | scalar `{quantity, unit, values:[x]}`; time series `{t[], values[]}`; radial `{r[], values[], region[]}` | a scalar is a one-element `values`; the axis is named `t` or `r` |
| OpenMC | `{quantity, tally, score, unit, normalization, filters, bins:[{labels, mean, std}]}` | table with per-bin uncertainty |
| PRA | scalar `{quantity, method, unit, value}`; cut sets `{cutSets:[{events[], probability}]}` | scalar uses `value`; cut sets are a table with a list-valued cell |

Consequences: each oracle observer in `tests/*-oracles.test.ts` reads its own shape (`values.at(-1)` against `.value`); a transfer cannot find the axis, the per-bin uncertainty or the bin labels without knowing the adapter; nothing says a unit string means a dimension.

## 2. Proposal: one envelope, three kinds

Data file schema `seed.quantity-data/0.2` (new file `schema/quantity-data.schema.json`). Common fields:

```
{ "schema": "seed.quantity-data/0.2",
  "quantity": "<name, equal to the index entry>",
  "kind": "scalar" | "series" | "table",
  "unit": "<same as the index entry>",
  ... kind-specific fields ... }
```

The index entry stays the authority for `unit`, `normalization`, `coordinates`, `timeGrid` and `provenance`; the file repeats `quantity` and `unit` so a loose file is self-describing, and the host checks they agree (disagreement = a result the adapter must not index, `E_RESULT_INCOMPLETE`).

| Kind | Fields | Rules |
|---|---|---|
| `scalar` | `value` (finite number), `std`? (>= 0) | one number. FEED's one-element `values` becomes `value`. |
| `series` | `axis: {name, unit}`, `x[]` (strictly increasing), `values[]`, `std[]`?, `min[]`?, `max[]`? | all arrays the same length, finite. Covers time series (`axis.name` `t`) and radial or axial profiles (`r`, `z`). `min`/`max` is NODAL's envelope; `std` is per-point uncertainty. |
| `table` | `columns: [{name, unit, role}]`, `rows: [[...]]` | `role` is `label` (string or string list, an identifier, e.g. a filter bin or cut set events), `coordinate` (number with a unit, e.g. a bin's lower edge) or `value`/`std` (numbers; a `std` column names its value column in `of`). OpenMC bins and PRA cut sets are tables. |

Why three kinds and not more: every current file fits one of them with a mechanical conversion, and a transfer needs only "give me the values, their axis or labels, and the uncertainty". A mesh or a field on a grid is a later kind (OpenMC mesh tallies are refused by the adapter today); the `kind` enum is how it is added without breaking readers (an unknown kind is a refusal, never a guess).

A host-side reader (`src/core/quantityData.ts`) validates a data file against the schema and the index entry, and returns one typed object. Oracle observers, reports and transfers use it instead of hand-written parsing. A file in the v0.1 shapes keeps working: the reader converts the five known shapes (a compatibility table in the reader, tested against stored fixtures), so no adapter has to change in the same commit, and the adapters move over one at a time.

## 3. Proposal: units and dimensions

Today `unit` is a free string (<= 40 characters). The contract keeps it a string but fixes how it is written, and adds an optional `dimension` tag the transfer checks read.

**Unit grammar (v0.2).** A unit is a product or quotient of the tokens below, written with `*`, `/` and integer powers `^n` (`W/m^3`, `eV/particle`, `cm`). No spaces, no prefixes inside the token list except the SI ones listed, one `/` at most.

| Group | Tokens |
|---|---|
| SI base and derived | `m`, `s`, `kg`, `K`, `Pa`, `W`, `J`, `N`, `A`, `mol`, `Hz` and the prefixes `k`, `M`, `G`, `m`, `u`, `c` on them (the Celsius scale is `degC`, a temperature, never mixed into a product) |
| Nuclear | `eV`, `keV`, `MeV`, `b` (barn), `cm` |
| Counted things (named, not dimensional) | `particle`, `reaction`, `event`, `fission`, `demand`, `hour` |
| Dimensionless | `1` |

The rule for counts and per-source quantities, which OpenMC had to invent: a count is a counted-thing token (`reaction`), and a quantity "per source particle" is written `<unit>/particle` when the unit is a physical unit of the score (heating: `eV/particle`; flux: `cm` track length per source particle stays `cm`, and the index's `normalization: per-source-particle` says what it is per). **Open for the user (A):** keep `normalization` as the only place that says "per source particle" (the unit stays `cm`, `reaction`, `eV`), or write it in the unit as well. The recommendation is the first: one place, and the unit then names only what is measured; heating becomes `eV` with `per-source-particle`.

**Dimension tag.** Optional `dimension` on each index quantity: one of `length`, `time`, `temperature`, `pressure`, `energy`, `power`, `power-per-length`, `power-per-volume`, `heat-flux`, `mass-flow`, `probability`, `count`, `rate`, `dimensionless`, `other`. It exists because plan 08 requires "W, W/m and W/m3 are distinct": a transfer refuses a source whose `dimension` differs from the recipe's, and refuses a `unit` that is not valid for the dimension (a table in `src/core/units.ts`: allowed units per dimension, conversion factor to the SI unit of that dimension, tested for each pair). Absent `dimension` means the quantity is not offered to transfers (still fine for runs and oracles).

The host converts only through that table; an unknown unit for a known dimension is a refusal (`E_UNIT_UNKNOWN`), never a pass-through.

## 4. What changes, in order, if approved

1. `schema/quantity-data.schema.json`, `dimension` in `results-index.schema.json`, unit grammar in `common.schema.json` (pattern), `schemaVersion` bump to `seed.results-index/0.2` with the v0.1 reader kept (migration: none needed for data, v0.1 indexes read as before with no `dimension`).
2. `src/core/quantityData.ts` and `src/core/units.ts` with tests: each kind valid and every invalid field refused; the five adapters' stored v0.1 files convert; a mutation set on the checks.
3. Oracle observers in the five `tests/*-oracles.test.ts` files switch to the reader (this is the evidence the shape works: the same entries must pass).
4. Adapters write the new shape one at a time (RAFT first as the simplest), each with its own review and merge, as for the shared module.
5. `oracle.schema.json` and `validate` changes (candidates 1, 2, 7) are separate steps in the same version.

## 5. Questions for the user

- **A.** Per-source-particle: only in `normalization` (recommended), or also in the unit?
- **B.** `dimension` optional now (recommended: nothing breaks, and only quantities meant for transfer need it) or required in v0.2?
- **C.** Adapters keep writing v0.1 shapes until each is moved (recommended: the reader converts), or all five move in one change?
- **D.** A mesh or grid-field kind now (OpenMC mesh heating will need one for a spatial transfer), or only when the first mesh transfer is built (recommended: later; the first transfer uses the table kind with a bin-per-region heating tally).

## 6. Not decided here

Coordinate conventions shared across apps (plan 08 declares them per recipe), the recipe and approval format (next E4 step), propagation of Monte Carlo uncertainty into the downstream case.
