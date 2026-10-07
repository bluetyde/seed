# Comparison of quantities and the cache key (E3, step 2)

Two pure functions of the core, from [plan 07](plans/07-studies-and-reports.md) ("Comparison") and [plan 04](plans/04-runs-and-scheduling.md) ("Cache key"). Neither reads a file, starts a run or changes a record. Neither has a CLI verb, an MCP tool or a place in the report builder yet; see "Not done".

## Comparison: `src/core/compare.ts`

`compareQuantity({ quantity, runs, reference?, gridTolerance? })` compares one named quantity across runs. The caller passes, for each run, its lifecycle state, native status, stale flag, the quantities of its results index and the data of the compared quantity, **already read and checked against the data hash in the index** (the function trusts what it is given and says so: it does no I/O).

**Who is compared.** The reference is the run named by `reference`, or the first run in the list that is completed, current, has the quantity and has its data. A run is compared only if it is compatible with the reference; every other run stays in the table with a mark and a reason. Nothing is dropped.

| Mark | Run | In the comparison |
|---|---|---|
| `ok` | completed, current, compatible | yes |
| `refused` | completed, current, **incompatible**: the reason and a code are on the row | no |
| `stale` | completed, but a later input revision made it stale: its value is shown, labelled | no |
| `failed`, `cancelled`, `interrupted`, `queued`, `running` | not a result | no |
| `trip` | ended by a trip (lifecycle `terminated-by-trip`): not a completed run of the intended experiment | no |
| `no-quantity` | completed, but the quantity or its data is missing | no |

**Compatibility, checked in this order, first failure wins:** a table is never compared here (`table-unsupported`); the same kind of data, scalar or series (`kind-mismatch`); the same normalization (`normalization-mismatch`); the same declared dimension if both declare one (`dimension-mismatch`); the data in the unit the index says (`data-mismatch`); units of the same kind (`unit-mismatch`: the unit vectors from `src/core/units.ts` are equal, so K against Pa is refused and kW against W is converted); the same coordinate system if either declares one (`domain-mismatch`); for a series, the same axis name and axis unit kind (`axis-mismatch`), the same number of points and the same grid within a relative tolerance, default 1e-9 (`grid-mismatch`, naming the first point that differs). Values are converted into the **reference's unit**; degC and K convert with the offset for values and without it for differences and uncertainties.

**Uncertainty is shown where a run declares it and never invented.** A scalar's `std` or a series' largest `std` is `statistical` (Monte Carlo sampling noise); the index entry's `uncertainty` carries its own kind (`statistical`, `input` or `model`). The three kinds are kept apart on every row and in the summary (`variation.uncertainty`), and are never added. Two scalars with statistical uncertainties also get their difference in sigmas, `|d| / sqrt(s1² + s2²)`. When none is declared, a note says none is assumed; when sampling noise is present, a note says the spread between runs includes it.

**Result.** `rows` in the order of the request (each with state, native status, mark, `used`, reason, verification, unit, normalization, uncertainty, value or series, difference from the reference), `reference`, `variation` (how many runs were compared, the spread of their values, the largest uncertainty of each kind) and `notes`. A request that cannot start (no comparable run, a named reference that cannot be used, a table as reference, a run listed twice) is a typed error, not an empty table.

`comparisonMarkdown(result)` writes the table (run, state, mark, value, unit, normalization, uncertainty, verification, difference, note). Text that comes from runs is escaped, so a run id or a reason cannot break a cell or start a heading; the numbers are formatted by the function and left alone.

## Cache key: `src/core/cacheKey.ts`

`cacheKey(parts)` is the sha256 of the canonical JSON of what a run's result depends on: the adapter (id, version), the inputs (path and sha256; **order does not matter**), the seed (an unset seed is not the same as seed 0), the settings, and, when known, the engine (name, version), the data library (id, hash), the material revisions (order does not matter) and the digest of the mapping recipe. A component that is not known is **left out, not guessed**, so a key made without the engine version never equals one made with it: a miss, never a false hit.

`RunManager` records `cacheKey` in the run record through this one function. It knows the adapter, the inputs, the seed and the settings at the start of a run; the other components are added when a host can supply them (see "Not done"). The value changed for a run with several inputs listed out of path order (they are sorted now); no code reads old keys.

`findCacheHit(candidates, key, { reuse })` looks through the run records for one that may stand in for a new request. Reuse is **opt-in** (`reuse` is the `cacheReuse` flag of the `run` verb, false by default); only a **completed, current** run with the same key counts; when several qualify the most recently finished wins (ties by run id), whatever the order of the list. The answer **names the run**: a cache hit is never a silent substitution.

## Tests

`tests/compare.test.ts` (50) and `tests/cache-key.test.ts` (44): one test per component of the key, order and absence rules, the lookup rules, the run manager's record, and for the comparison every refusal and every mark, uncertainty and unit handling, series grids, input validation, no mutation of the input, and the Markdown with hostile text. Mutations: 25 of 25 of the comparison and 12 of 12 of the cache key caught (one first survived, a seed of 0 against no seed, and its test was fixed).

## Not done

- **A cache hit is not used by the dispatcher.** Whether and when a request may be answered from an earlier run is a decision for the user (stochastic apps with no seed; a stale material revision; who may ask for reuse; how the study record shows it). The function and the `cacheReuse` flag exist; nothing calls `findCacheHit` yet. The engine version, data library, material revisions and mapping recipe are not yet passed into the key by the host.
- **The comparison has no verb and is not in the report builder.** A host function that reads the runs of a study, checks the data hashes, calls `compareQuantity` and feeds the report belongs with the live study record (next E3 items).
- **Tables are not compared.** A table quantity (a mesh tally, for example) would need a rule for which columns match; compare its scalar or series quantities instead.
- Uncertainty is carried, not propagated: the function compares what the runs declare and does not combine kinds.
