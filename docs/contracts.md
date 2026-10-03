# Contracts v0.1

Normative text for the E0 contracts: the documents SEED, adapters and agents exchange, and the path rules. Written 2026-10-03 (Claude) from [ARCHITECTURE](ARCHITECTURE.md), [DECISIONS](DECISIONS.md) and plans 02 to 07. Status: **proposed**, not yet reviewed by Codex or the user; everything is v0.1 and may change by migration. Implemented 2026-10-03 in `schema/*.schema.json` and `src/core/` (validator, semantic checks, canonical JSON, paths, adapter client, run manager, report builder) with fixtures and generated tests; see TODO E0.

## 0. Conventions (apply to every document)

1. JSON, UTF-8, LF. Property names are camelCase. Numbers are finite.
2. Every document has `"schema": "seed.<family>/<major>.<minor>"`. Only the exact versions in this file are supported. Any other value that matches `^seed\.[a-z-]+/[0-9]+\.[0-9]+$` is refused with `E_SCHEMA_VERSION` (no coercion); a missing or non-string `schema` is `E_SCHEMA_INVALID`. A document whose family does not match the validator being used is `E_SCHEMA_VERSION`.
3. SEED-owned objects reject unknown properties (`additionalProperties: false`). The only places that accept arbitrary content are named in each section (`extensions`, material property sets). Content in those places is data: it is stored and returned unchanged and never evaluated.
4. Patterns used below:
   - `id`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
   - `sha256`: `^[0-9a-f]{64}$`
   - `time`: UTC ISO-8601, `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`
   - `relPath`: a portable relative path (section 9): 1 to 512 characters, `/` separators only, no leading `/`, no backslash, no `:`, no NUL, no empty, `.` or `..` segment.
   - `unit`: non-empty string, at most 40 characters. Dimensionless is `"1"`.
   - `normalization`: one of `none`, `per-source-particle`, `per-fission`, `per-demand`, `per-hour`, `per-second`, `per-watt`. W, W/m and W/m3 are units, not normalizations.
   - `budget`: object with required integers `maxWallSeconds` (>= 1), `maxCores` (>= 1), `maxMemoryMB` (>= 1), `maxDiskMB` (>= 1); no other properties.
   - `revision`: object `{hash: sha256, counter: integer >= 0}`.
   - `actor`: `{kind: "human" | "agent" | "system", name: string 1..80, model?: string 1..80, toolVersion?: string 1..40}`; `model` is required when `kind` is `agent`.
   - `lifecycle`: one of `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`, `terminated-by-trip`.
   - `nativeStatus`: `{status: string 1..80, detail?: string 0..2000}`; the app's own status, kept beside `lifecycle`, never replaced by it.
5. **Typed error** (`seed.error`, a `$defs` entry, not a document): `{code, field, message, unit?, range?, source}`.
   - `code`: `^[EW]_[A-Z0-9_]{2,40}$` (E = error, W = warning).
   - `field`: a JSON Pointer into the offending document, `""` when it concerns the whole document.
   - `message`: string 1..1000. `unit?`: `unit`. `range?`: `{min?: number, max?: number}` with at least one present.
   - `source`: `"seed"` or `"app-content"`. `app-content` means the message text includes text taken from an app's model, log or result; consumers treat it as untrusted data.
6. **Core error codes** live in `schema/error-codes.json` as `{ "<code>": {"severity": "error"|"warning", "meaning": "<one line>"} }`. Adapters may add their own codes that match the pattern; SEED core codes are:

   | Code | Meaning |
   |---|---|
   | `E_SCHEMA_INVALID` | document does not satisfy its schema |
   | `E_SCHEMA_VERSION` | unsupported schema family or version |
   | `E_VERB_UNKNOWN` | request names a verb the adapter does not support |
   | `E_NOT_PERMITTED` | the actor's tier does not allow the operation |
   | `E_BUDGET_EXCEEDED` | request would exceed the study budget |
   | `E_BOUNDS_EXCEEDED` | parameter outside the study's declared bounds |
   | `E_STALE_REVISION` | an input or expected revision is not current |
   | `E_REQUEST_CONFLICT` | same `requestId` with a different payload |
   | `E_PROP_MISSING` | a property the operation needs is absent |
   | `E_UNITS` | missing, unknown or mismatched units |
   | `E_OUT_OF_DOMAIN` | value or result outside the declared domain |
   | `E_UNSUPPORTED` | construct or feature not supported |
   | `E_PATH_INVALID` | path is malformed for its kind |
   | `E_PATH_TRAVERSAL` | path escapes its root |
   | `E_PATH_UNMAPPABLE` | path has no equivalent in the target kind |
   | `E_OUTPUT_INCOMPLETE` | declared outputs missing, partial or not finite |
   | `E_APP_FAILED` | the app or engine failed |
   | `E_TIMEOUT` | the operation exceeded its time limit |
   | `E_CANCELLED` | the operation was cancelled |
   | `E_NOT_OWNED` | the job or process is not owned by this SEED run |
   | `E_SETUP_REQUIRED` | a missing dependency or runtime must be set up first |
   | `E_INTERNAL` | unexpected failure inside SEED |

## 1. Adapter request: `seed.adapter-request/0.1`

Common properties (all required unless marked): `schema`, `verb`, `requestId` (`id`; the idempotency key), `actor`, plus `extensions?` (object, arbitrary, opaque to SEED).
`verb` is one of the seven below; the schema selects the verb-specific shape by `verb` (use Ajv `discriminator`; if it misbehaves, use an `if/then` chain and note it).

| `verb` | Extra required properties | Extra optional |
|---|---|---|
| `describe` | none | none |
| `open` | `artifact` | none |
| `validate` | `artifact` | `operation` (`"run"` default, or `"open"`) |
| `run` | `snapshot`, `runDir`, `budget` | `settings` (object, default `{}`), `seed` (integer >= 0), `cacheReuse` (boolean, default false) |
| `status` | `jobId` (`id`) | none |
| `cancel` | `jobId` (`id`) | none |
| `collect` | `jobId` (`id`), `runDir` | none |

- `artifact`: `{path: relPath, revision}`.
- `snapshot`: `{inputs: [{path: relPath, sha256}, ...]}` with at least one input.
- `runDir`: `relPath`.

## 2. Adapter reply: `seed.adapter-reply/0.1`

Required: `schema`, `verb`, `requestId`, `ok` (boolean), `errors` (array of typed errors with `code` starting `E_`), `warnings` (array of typed errors with `code` starting `W_`). `result` is required when `ok` is true and forbidden when `ok` is false. When `ok` is true `errors` is empty; when false `errors` has at least one item.
`ok: false` means the adapter could not carry out the verb (protocol or setup failure). A completed judgement about the user's input, including a failed validation, is `ok: true`.

`result` by verb:

| `verb` | `result` (all listed properties required unless marked) |
|---|---|
| `describe` | `app` `{id, name, version}`; `engine?` `{name, version}`; `formats` `[{id, version}]`; `capabilities` `[string]`; `parameters` `[{id, type: "number"\|"integer"\|"string"\|"boolean", unit?, min?, max?, enum?}]`; `quantities` `[{name, unit, normalization}]`; `oracleCoverage` `[{quantity, domain}]`; `oraclePin?` `{sha256, commit}` |
| `open` | `editor` (`"opened"` or `"focused"`) |
| `validate` | `valid` (boolean), `problems` (array of typed errors). `valid` is true exactly when no problem has an `E_` code (warnings allowed) |
| `run` | `jobId` (`id`), `runDir` (`relPath`), `lifecycle` (`queued` or `running`) |
| `status` | `jobId`, `lifecycle`, `native` (`nativeStatus`), `startedAt?`, `finishedAt?` (`time`) |
| `cancel` | `jobId`, `lifecycle`, `cancelled` (boolean) |
| `collect` | `jobId`, `lifecycle` (must be `completed`), `resultsIndex` (`relPath`), `resultsSha256` |

## 3. Results index: `seed.results-index/0.1`

Required: `schema`, `runId` (`id`), `status` (`"completed"`), `adapter` `{id, version}`, `engine` `{name, version}`, `inputHashes` (array of `{path, sha256}`, at least 1), `nativeStatus`, `quantities` (array, at least 1). Optional: `seed` (integer >= 0), `oracle` `{entries: [id], verdict: "pass"|"fail"|"not-run"}`, `extensions`.
Each quantity: required `name`, `unit`, `normalization`, `provenance` `{runId, inputRevisions: [sha256], mappingRecipe?: id}`, `data` `{path: relPath, sha256}`, `verification` (`"verified"` or `"unverified"`); optional `coordinates` `{system: string, axes: [{name, unit}]}`, `timeGrid` `{unit, start, stop, count: integer >= 1}`, `uncertainty` `{kind: "statistical"|"input"|"model", value: number >= 0, unit?}`.
A result without a complete index is not a result: nothing is optional that this paragraph lists as required.

## 4. Run record: `seed.run-record/0.1`

Required: `schema`, `runId`, `attempt` (integer >= 1), `adapter` `{id, version}`, `state` (`lifecycle`), `inputs` (array of `{path, sha256}`, at least 1), `settings` (object), `budget`, `createdAt` (`time`). Optional: `engine` `{name, version}`, `dataLibrary` `{id, hash?}`, `jobId`, `native` (`nativeStatus`), `seed`, `budgetUsed` `{wallSeconds, cores, memoryMB, diskMB}` (numbers >= 0), `startedAt`, `finishedAt`, `cacheKey` (`sha256`), `outputs` (array of `{path, sha256}`), `extensions`.
Conditionals: `state: "completed"` requires `finishedAt` and a non-empty `outputs`; `state` in `failed`, `cancelled`, `interrupted`, `terminated-by-trip` requires `finishedAt`; `state: "running"` forbids `finishedAt`.

## 5. Project manifest: `seed.project/0.1`

Required: `schema`, `projectId` (`id`), `name` (1..120), `created`, `updated` (`time`), `seedVersion` (string 1..40), `folders` `{models, runs, studies, oracles}` (each a `relPath`), `artifacts` (array), `materials` (array). Optional `extensions`.
- Artifact: `{id, app (id), path (relPath), format (string 1..40), formatVersion (string 1..40), revision}`.
- Material: `{id, revision (integer >= 1), name (1..120), sets}`. `sets` is an object whose keys match `^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$` (for example `openmc.composition`, `thermal.conductivity`). Each value is an object with a required `schema` (string 1..80) and **any other properties** (opaque, preserved, never evaluated). Allowed optional well-known properties: `units`, `source` `{kind: "synthetic"|"sourced"|"assumed", text}`, `conditions`, `ranges`, `ref` `{path: relPath, sha256}`.

## 6. Study record: `seed.study/0.1` (JSON Lines)

One JSON object per line; each line validates by its `type`. All lines also carry `schema` and optional `prev`/`hash` (both present or both absent).

- `header` (line 1, `seq` 0): `{type, schema, seq: 0, studyId (id), created, projectId (id), question (1..2000), hypothesis? , assumptions [string], parameters [{id, artifact? (id), min, max, unit?}], budget, tier ("A0"|"A1"|"A2"|"A3"), startRevisions [{artifact (id), revision (sha256)}], setBy (actor with kind "human")}`. `A4` is not assignable.
- `step`: `{type, schema, seq (integer >= 1), time, actor, action ("validate"|"run"|"oracle"|"edit"|"compare"|"collect"|"cancel"|"note"|"gate-stop"), reason (1..2000), inputsChanged [{artifact (id), before (sha256), after (sha256)}], runs [id], oracle? {set: string 1..80, verdict: "pass"|"fail"|"not-run"}, gateStop? {request: string 1..200, rule: string 1..200}}`. `action: "gate-stop"` requires `gateStop`; `gateStop` is forbidden otherwise.
- `conclusion` (last line, at most one): `{type, schema, seq, time, actor, claims [{text (1..2000), runs [id], oracles [id]}]}` with every claim citing at least one run or oracle. A conclusion cannot be written by an actor of kind `system`.

**Canonical JSON** (used for every hash here): the value serialized with object keys sorted in ascending UTF-16 code-unit order at every depth, no whitespace, strings and numbers as `JSON.stringify` writes them, arrays in order, UTF-8 bytes. `hash` of a line is `sha256(canonical JSON of the line object without its own `hash` property)` in lowercase hex; `prev` is the previous line's `hash`, `null` on the first line.
**Chain verification** (`verifyStudyLog(lines)`): the first line is a header with `seq` 0; `seq` increases by exactly 1 per line; a conclusion, if present, is last; if any line has `hash`, every line has `prev` and `hash`, each `hash` recomputes, and each `prev` equals the previous line's `hash`. Violations report the 1-based line number.

## 7. Oracle entry: `seed.oracle/0.1`

Required: `schema`, `oracleId` (`id`), `entryVersion` (integer >= 1), `adapter` (`id`), `adapterVersions` (array of strings, at least 1; `"*"` means any), `tag` (`"good"`, `"bad-input"`, `"known-limit"`), `inputs` (array of `{path: relPath, sha256}`, at least 1), `expected`, `source` `{kind: "hand"|"analytic"|"published"|"direct-engine", text (1..2000), check? (string 1..2000; the second method used)}`, `coverage` `{quantities: [string] (at least 1), domain: string 1..500}`, `toleranceHash` (`sha256`). `tolerance` `{abs: number >= 0, rel: number >= 0}` is required exactly when `expected` has a `value`.
`expected` is one of: `{quantity: string, value: number, unit}`; `{refusalCode: code}`; `{verdict: "out-of-domain"|"truncated"|"unsupported"}`.
Tag rules: `good` requires the `value` form; `bad-input` requires `refusalCode`; `known-limit` requires `verdict` or `refusalCode`.
**Tolerance pin:** `toleranceHash` must equal `sha256(canonical JSON of {"expected": <expected>, "tolerance": <tolerance or null>})`. Changing either makes a new `entryVersion` by a human action.

## 8. Semantic checks (beyond the schemas)

Exported from `src/core/`, each returning a list of typed errors (empty = ok); none throws on bad input:
- `checkProject(manifest)`: artifact `id`s unique; material `id`s unique; `app` references are plain ids (no resolution).
- `checkResultsIndex(index)`: every quantity `provenance.runId` equals `runId`; quantity names unique.
- `checkOracleHash(entry)`: the tolerance pin above.
- `verifyStudyLog(lines: string[])`: section 6; also validates each line against the schema first.

## 9. Paths

Path kinds: `windows` (drive or UNC path), `wsl` (POSIX path inside a WSL distro), `posix` (any other absolute POSIX path), `relative` (portable relative path). SEED stores only `relative` paths in projects; the other kinds are for locating apps and files at run time. All functions return a result `{ok: true, value} | {ok: false, error: {code, field?, message}}` and never throw on bad input. Lexical only: no filesystem access, no symlink resolution (callers needing that check real paths themselves).

Rules:
1. **Classification** of an input string: `^[A-Za-z]:[\\/]` is a Windows drive path; `\\?\X:\...` (extended-length) is a Windows drive path with the prefix removed; `\\?\UNC\server\share\...` and `\\server\share\...` are Windows UNC; `\\wsl$\<distro>\...` and `\\wsl.localhost\<distro>\...` are Windows UNC paths into a WSL distro; a string starting with `/` is posix (or wsl when the caller says so); anything else without a drive prefix is relative. A bare `C:` or `C:foo` (drive-relative) is `E_PATH_INVALID`. NUL characters anywhere are `E_PATH_INVALID`. Empty string is `E_PATH_INVALID`.
2. **Drive to WSL:** `C:\Users\a b\f.txt` and `C:/Users/a b/f.txt` map to `/mnt/c/Users/a b/f.txt` (drive letter lowercased, separators `/`, spaces unchanged, no quoting). Convention: the default WSL automount root `/mnt/<letter>`; the root is a parameter defaulting to `/mnt`.
3. **WSL to drive:** `/mnt/c/Users/a b` maps to `C:\Users\a b` (drive letter uppercased, backslashes). `/mnt/c` alone maps to `C:\`. Only `/mnt/<single letter>` followed by `/` or end counts as a drive mount; `/mnt/cc/x` and `/mnt/data` are ordinary posix paths.
4. **WSL internal path to Windows:** a WSL path that is not under a drive mount (for example `/home/u/p`) maps to `\\wsl.localhost\<distro>\home\u\p` (the distro root `/` maps to `\\wsl.localhost\<distro>` with no trailing backslash, like any UNC share root); the distro name is a required parameter, otherwise `E_PATH_UNMAPPABLE`. Convention chosen for this project: the `\\wsl.localhost\` form is produced; both `\\wsl$\` and `\\wsl.localhost\` are accepted as input.
5. **Windows WSL-UNC to WSL:** `\\wsl$\Ubuntu\home\u\p` or `\\wsl.localhost\Ubuntu\home\u\p` maps to `/home/u/p` only when the distro in the path equals the target distro parameter (case-insensitive); otherwise `E_PATH_UNMAPPABLE`. A WSL-UNC path with no path after the distro maps to `/`.
6. **Other UNC** (`\\server\share\...`) has no WSL equivalent: `E_PATH_UNMAPPABLE`. A UNC path missing the share is `E_PATH_INVALID`.
7. **Normalization** (applies to output of every mapping): collapse repeated separators, drop `.` segments, resolve `..` lexically, remove a trailing separator except for a root (`C:\`, `/`). A `..` that climbs above the root of an absolute path is `E_PATH_TRAVERSAL`.
8. **Portable relative path** (`isPortableRelative`): rules in section 0, pattern `relPath`. A Windows-style relative path with backslashes converts to forward slashes with `toPortableRelative`, but a string that already contains `:` or begins with `/` is not relative. `..` is never allowed in a portable relative path: `E_PATH_TRAVERSAL`; other violations `E_PATH_INVALID`.
9. **Inside-root check** `resolveInside(root, rel, caseInsensitive)`: `root` must be absolute (any absolute kind), else `E_PATH_INVALID`. `rel` is any relative-looking string that may use `/` or `\` separators and may contain `.` and `..` segments. Join onto the root, normalize lexically (rule 7), and require the result to have the normalized root as a prefix at a segment boundary (`/a/b` is not a prefix of `/a/bc/x`). A result outside the root, an absolute `rel` (leading `/` or `\`), or a `rel` with a drive prefix is `E_PATH_TRAVERSAL`; a NUL character is `E_PATH_INVALID`. `caseInsensitive` defaults to true for Windows roots and false otherwise; the prefix comparison uses it, and the returned path keeps the casing of the joined text.
10. **Round trip:** for every Windows drive path P without `..` or `.` segments or repeated separators, `toWindows(toWsl(P))` equals P normalized to backslashes with an uppercase drive letter; for every WSL path under a mount, the reverse holds.
