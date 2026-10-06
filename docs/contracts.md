# Contracts v0.1

Normative text for the E0 contracts: the documents SEED, adapters and agents exchange, and the path rules. Written 2026-10-03 (Claude) from [ARCHITECTURE](ARCHITECTURE.md), [DECISIONS](DECISIONS.md) and plans 02 to 07. Status: **signed off as final by the user on 2026-10-05** (see below); the implementation was reviewed by Codex (2026-10-03 and later); a change is a new schema version with a migration. Implemented 2026-10-03 in `schema/*.schema.json` and `src/core/` (validator, semantic checks, canonical JSON, paths, adapter client, run manager, report builder) with fixtures and generated tests; see TODO E0.

**Final sign-off (2026-10-05).** The user signed off v0.1 as final, together with the v0.1.1 clarifications of section 12. Earlier the same day it had been accepted provisionally, because only RAFT and the fake adapter had exercised it; the condition for the final decision was that other apps had tried it. Five real adapters now implement it (RAFT, FEED, NODAL, OpenMC Studio, SNEED/PRA, on the shared adapter module, [adapters-shared.md](adapters-shared.md)), each with a real runner and its own oracle set, and the full suite passes (2117 tests, 2026-10-05). Any change from here goes through a new schema version and a migration, recorded here. The candidates for v0.2 (validate with the run's inputs and settings, oracle settings, standard result data shapes with units, snapshot input roles) and v0.3 (`describe.oraclePin`) are in [contracts-v0.2-candidates.md](contracts-v0.2-candidates.md). Not covered by this sign-off: the policy file format and grant persistence, MCP tool naming beyond what exists, the host configuration schema (`schema/host.schema.json`, added later), and an independent design review of the contract against the other apps' plans (still optional and not done).

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
   | `E_PROJECT_LOCKED` | another writer holds the project lock |
   | `E_NOT_FOUND` | project, file or artifact does not exist |
   | `E_EXISTS` | target already exists |

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
| `describe` | `app` `{id, name, version}`; `engine?` `{name, version}`; `formats` `[{id, version}]`; `capabilities` `[string]`; `parameters` `[{id, type: "number"\|"integer"\|"string"\|"boolean", unit?, min?, max?, enum?}]`; `quantities` `[{name, unit, normalization}]`; `oracleCoverage` `[{quantity, domain}]`; `resources?` `{wallSeconds? {typical, max}, cores?, memoryMB? {peak}, diskMB? {peak}, measured {platform, date, basis}, notes?}` (what a run costs, measured; section 12.3); `oraclePin?` `{sha256, commit}` |
| `open` | `editor` (`"opened"` or `"focused"`) |
| `validate` | `valid` (boolean), `problems` (array of typed errors). `valid` is true exactly when no problem has an `E_` code (warnings allowed) |
| `run` | `jobId` (`id`), `runDir` (`relPath`), `lifecycle` (`queued` or `running`), optional `nativeProcesses` (1..16 distinct integer PIDs >= 2, obtained from trusted launch) |
| `status` | `jobId`, `lifecycle`, `native` (`nativeStatus`), `startedAt?`, `finishedAt?` (`time`) |
| `cancel` | `jobId`, `lifecycle`, `cancelled` (boolean), optional `nativeStopped` (boolean; confirms all owned native processes stopped) |
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
- `checkResultsAgainstRecord(index, record)`: the index belongs to the run snapshot it is attached to: its `inputHashes` equal the record's `inputs` (as a set of path and sha256) and every quantity's `provenance.inputRevisions` names only hashes of those inputs.

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

## 10. Run manager rules (from the Codex review, 2026-10-03)

These bind `RunManager` (`src/core/runManager.ts`) and are covered by tests/review-fixes.test.ts.

1. **Replies answer their request.** The adapter client refuses a reply whose `verb` or `requestId` differs from the request, whose `result.jobId` differs from the request's `jobId` (status, cancel, collect), or whose `result.runDir` differs from the request's (run): `E_APP_FAILED`.
2. **Outputs belong to the run.** The results index and every quantity `data` file named by a collect must lie inside the run's own directory (`<runsFolder>/<runId>/`), lexically and after resolving symlinks and junctions; the results must satisfy `checkResultsAgainstRecord`. Otherwise the run ends `failed` with `E_OUTPUT_INCOMPLETE` and no outputs.
3. **Physical containment.** An input source reached through a link that leaves the project is refused (`E_PATH_TRAVERSAL`, field `/inputs/<i>/path`); so is a runs folder that resolves outside the project (field `/runsFolder`). Containment is checked before use, not race-free: a path changed between the check and the read is not detected.
4. **Run ids are plain ids.** `cancel(runId)` and `transition(runId, ...)` accept only the `id` pattern (no separators, no `..`); the record read must carry the same `runId`.
5. **Cancellation is confirmed.** A run is recorded `cancelled` only when the adapter affirms the stop (`cancelled: true`) or reports a terminal lifecycle. An unconfirmed cancel leaves the run `running` and tracked, and `cancel()` returns `E_APP_FAILED`. A timeout or three failed status calls still end the run `failed`, but an unconfirmed stop is recorded in `log/errors.json` and the native detail says the job may still be running.
6. **The request log is trusted only when valid.** `requests.json` must be an object whose entries have a sha256 `payloadHash` and an id `runId`; anything else, a replayed run record that fails `seed.run-record` or names another run, or an entry whose run record is missing, refuses the start (`E_INTERNAL`) and leaves the files untouched. Lookups use own properties only (a requestId such as `constructor` is an ordinary id).
7. **One manager per request.** Before any asynchronous work a start reserves its requestId by creating `<runsFolder>/.reserve-<hash>`; a second manager (or an interrupted earlier start) is refused with `E_REQUEST_CONFLICT`. `recover()` removes reservations that no live start of this manager holds.
8. **Process-tree kills are honest.** `killTree` returns true only when the root process (and on POSIX its whole process group) is gone and, on Windows, `taskkill` reported the tree killed (exit 0 or 128). Descendants that outlive their parent on Windows are not individually tracked; this is a known limit.

## 11. Project store rules (2026-10-03)

These bind `src/core/projectStore.ts`. The project manifest is the file `seed.project.json` at the project root; all other paths in it are portable relative paths (section 9). Every function returns `{ok: true, value} | {ok: false, errors: TypedError[]}` and never throws on bad input or a busy lock.

1. **Revision.** The revision of a project is `sha256Hex(canonicalJson(manifest))` of the manifest object (the `updated` field is part of it). Callers pass the revision they read as `expectedRevision` when saving.
2. **create.** `createProject(dir, {name, seedVersion, now?, newId?})` makes `dir` (and parents) if it is absent or empty, creates the four folders `models`, `runs`, `studies`, `oracles`, and writes a valid manifest (`projectId` = `p-` plus 12 random hex characters unless `newId` is given, `created` = `updated` = now, folders set to those names, empty `artifacts` and `materials`). A non-empty `dir` is refused (`E_EXISTS`); a `name` outside 1..120 is `E_SCHEMA_INVALID`.
3. **open.** `openProject(dir)` reads and validates the manifest (`seed.project/0.1`, then `checkProject`) and returns `{manifest, revision}`. It never writes. A missing folder or manifest is `E_NOT_FOUND`; invalid JSON or a schema failure is `E_SCHEMA_INVALID` with the validator's errors; an unsupported schema version is `E_SCHEMA_VERSION`. Leftover `*.tmp-*` files and a stale lock are ignored.
4. **save.** `saveProject(dir, manifest, expectedRevision)` takes the writer lock (rule 6), re-reads the stored manifest, and refuses with `E_STALE_REVISION` (field `/revision`) when the stored revision is not `expectedRevision`. Then it checks the new manifest: schema and `checkProject`; `projectId` and `created` unchanged; and for every material id present in both versions, unchanged `name` and `sets` require an equal `revision`, while any change requires a strictly greater `revision` (otherwise `E_SCHEMA_INVALID`, field `/materials/<i>/revision`). On success it sets `updated` to the later of now and the stored `updated`, writes `seed.project.json` with `writeFileAtomic` (two-space indented JSON plus a final line feed, key order as given), releases the lock and returns the stored manifest and its new revision. A refused save leaves the file byte for byte unchanged.
5. **Preservation.** Material `sets`, `extensions` and any other nested content round-trip unchanged through open and save, including unknown set names and keys such as `__proto__` and `constructor`. The store never evaluates, interprets or reorders content; no expression is evaluated and no names are matched.
6. **Writer lock.** The lock is the directory `<dir>/.seed/lock`, created with a non-recursive `mkdirSync` (exactly one creator wins). The owner writes `owner.json` inside it: `{ownerId, pid, host, acquiredAt, token}`. `withProjectLock(dir, fn, opts?)` acquires, runs `fn`, and releases in `finally`, removing the lock only if `owner.json` still carries its own token. A held lock refuses with `E_PROJECT_LOCKED` after `opts.waitMs` (default 0) of retrying every 25 ms. A lock is **stale** when (same `host` and the owner pid is not alive) or (different `host` and `acquiredAt` older than `staleMs`, default 600000) or (no readable `owner.json` and the directory is older than `graceMs`, default 5000). A stale lock is taken over by renaming the lock directory to `<dir>/.seed/lock.stale-<random>` (one rename wins), deleting that directory, and retrying; a rename that fails because another process won is treated as a held lock. Liveness is `isAlive` from `procTree.ts`, injectable in `opts` for tests.
7. **recover.** `recoverProject(dir)` takes the lock (no waiting), deletes `seed.project.json.tmp-*` leftovers and stale `lock.stale-*` directories, releases, and returns the list of removed names.
8. **Artifacts and relocation.** `resolveArtifact(dir, artifactId)` returns the absolute path of the artifact's `path`: unknown id `E_NOT_FOUND`, a path that leaves the project lexically or after resolving links `E_PATH_TRAVERSAL`, a path that does not exist `E_NOT_FOUND`. Because every stored path is relative, moving or copying the project folder and opening it at the new location resolves every artifact; `listMissingArtifacts(dir)` returns the ids whose files are absent.
9. **Limits.** Locking and path checks are best effort against a cooperating process on one machine: not safe over network drives, and the containment check is check-then-use (section 10, rule 3).

### Additions from the Codex review (2026-10-03)

10. **Takeover is serialized.** A stale lock is taken over only by the holder of the guard folder `<dir>/.seed/takeover` (created with a non-recursive `mkdirSync`): the contender judges the lock again under the guard, and only then renames it aside and deletes it. A guard older than `graceMs` was abandoned by a crashed contender and is removed. A contender that cannot get the guard treats the lock as held.
11. **`.seed` must be a real folder inside the project.** A link (symlink or junction) or a folder that resolves outside the project is refused with `E_PATH_TRAVERSAL` (field `/.seed`) before any lock file is written or any recovery delete.
12. **Synchronous and asynchronous work.** `withProjectLock` refuses a callback that returns a promise (`E_INTERNAL`, the lock is released; the work is not covered); `withProjectLockAsync` holds the lock until the promise settles.
13. **A failed release is reported.** Removing the lock folder is retried on `EBUSY`, `EPERM`, `ENOTEMPTY` and `EACCES`; if it still fails, the call returns `E_INTERNAL` ("could not be released"); a save that was committed says "the project was saved, but ...". `recoverProject` clears the leftover once its cause is fixed.

## 12. Clarifications (v0.1.1, 2026-10-05)

Text only: no schema changed. Collected while building the five adapters (RAFT, FEED, NODAL, OpenMC Studio, SNEED); the evidence is in [contracts-v0.2-candidates.md](contracts-v0.2-candidates.md). The user accepted these on 2026-10-05.

1. **`run.seed`.** If a request carries `seed`, it must equal the seed of the model or case; any other value is `E_REQUEST_CONFLICT` (a different seed is a different model revision, not a different run of this one). An app that has no seed (deterministic) refuses any `seed` with `E_UNSUPPORTED`. The host includes `seed` in the cache key.
2. **`open` is optional.** An adapter whose editor is not reachable headlessly answers `open` with `E_VERB_UNKNOWN`; it may advertise `open` in `capabilities` when it supports it.
3. **Budget.** `budget` is checked at admission by the policy gate (each over-limit field is `E_BUDGET_EXCEEDED`). While running: `maxWallSeconds` is enforced by the host (the run manager cancels through the adapter and records `E_TIMEOUT`), and an adapter whose runner has its own timeout also receives it. `maxCores` is enforced only by an adapter that has a thread setting (OpenMC). `maxMemoryMB` and `maxDiskMB` are **advisory**: no component enforces them yet (host-side disk enforcement is on the TODO list).

   **Measured costs (`describe.resources`, added 2026-10-06, additive, optional).** Every real adapter reports what its app's oracle-sized cases cost when run through the adapter: wall seconds (typical = median, max), cores, peak memory, peak run-folder size, with the platform, date and what was run. The figures live in `adapters/shared/resources.json` and are made by `scripts/measure-resources.cjs <app>` (run the app's good oracle cases one at a time through the run manager; memory is the peak of the summed working sets of the process tree sampled every 0.4 s, plus, for the apps that run in WSL, the peak rise of the WSL machine's used memory, so it is a lower bound of the true peak). They are information for choosing a budget, not a guarantee: a larger study costs more, and the host does not compare them with a budget. Re-measure when an app's runner changes a lot. First figures (Windows 11 with WSL2, 2026-10-06): RAFT 1.3 s typical, 215 MB; NODAL 4.7 s, 307 MB; SNEED 1.6 s, 280 MB; FEED 3.9 s (max 11.2 s), 564 MB with the WSL solver; OpenMC Studio 19.1 s, 1015 MB with WSL.
4. **Settings.** `describe.parameters` declares the settings an adapter accepts (type, bounds, enum). The host is to check requests against it; until it does, each adapter refuses unknown settings and out-of-range values itself, as every adapter does today.
5. **Idempotency.** `requestId` is the idempotency key. The same `requestId` with the same payload gives the same run or job, however often it is sent; with a different payload it is `E_REQUEST_CONFLICT`. The host compares its whole start request. An adapter also guards what determines a run: a request id belongs to one run folder, and it stores a hash of the snapshot inputs, settings and seed with the job, so the same id with other inputs, settings or seed is `E_REQUEST_CONFLICT` even when it reaches the adapter directly. A second `run` for a request whose first launch has not committed yet waits for it and returns the same job; if that launch failed and was rolled back, the second call says so and the request can be started again.
6. **Cancel before the launch commits.** The job's process id is recorded after the start; a `cancel` that arrives before that is refused `E_NOT_OWNED` (never a kill of an unproven process). A retry sees the job or its final state.
7. **Paths into a runtime.** Where an app runs in a different environment (WSL), the adapter maps the host's absolute paths into it with the rules of `src/core/paths.ts`; a path that cannot be mapped (for example a UNC path) is `E_PATH_UNMAPPABLE`.
8. **`describe.oraclePin`.** Stays in the contract unchanged and unused; to be revisited for v0.3.

