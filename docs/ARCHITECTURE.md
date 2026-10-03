# Architecture

How SEED's parts fit together. Everything except the host shell is **proposed**: names, fields and transports change in E0. An unchecked item in [TODO.md](../TODO.md) is not implemented support.
Plans per area are in [plans/](plans/); the goal and principles are in [PLAN.md](../PLAN.md).

## The big picture

```
 GUI client (Electron host, implemented)        MCP client (an agent, E2)
        |                                              |
        v                                              v
 +----------------------------------------------------------------+
 | SEED core (headless-capable, E1)                               |
 |                                                                |
 |  project store ---- manifest, native artifact refs, revisions  |
 |  material envelope - IDs, revisions, namespaced property sets  |
 |  policy ----------- tiers A0-A4, budgets, bounds, gates        |
 |  scheduler -------- queue, one active case per engine          |
 |  run store -------- snapshots, run records, results index      |
 |  oracle runner ---- registry, tolerances, verdicts             |
 |  study record ----- append-only steps, agent identity          |
 |  report builder --- from record + run graph only               |
 +-------------------------+--------------------------------------+
                           | adapter verbs (typed messages)
      +----------+---------+---------+-----------+-----------+
   OpenMC      NODAL     Virtual     PRA &      Fuel Perf.   fake
   adapter    adapter    Reactor    Reliability  adapter     adapter
      |          |       adapter     adapter        |          |
   native     native     native      native      native     scripted
   app/CLI    app/CLI    app/CLI     app/CLI     app/CLI    behaviours
```

Two principles drive the shape:
1. **The core owns coordination; apps own physics.** No physics, no native-format parsing beyond the references the manifest needs.
2. **GUI and agents use the same core.** The Electron host and the MCP server are clients. A rule enforced for an agent (budget, tier, refusal) is enforced in the core, so the GUI cannot bypass it by accident either.

## Components

| Component | Responsibility | Status |
|---|---|---|
| Host shell (`src/main`, `src/renderer`) | Window, menu and tab bar, one sandboxed web view per app, Welcome page | implemented ([shell.md](shell.md)) |
| App registry (`src/main/apps.ts`, `apps.default.json`) | Where each app is and how it starts; per-OS defaults | implemented |
| Process manager (`src/main/processes.ts`) | Free port, per-launch token, health wait, stop only what it started, attach to a running server | implemented |
| Installer (`catalog.ts`, `git.ts`, `installer.ts`, `store.ts`) | Clone, adopt, check, fast-forward update, dependency steps, prerequisite checks | implemented |
| Core (`src/core`, planned) | Everything in the diagram's box, with no Electron imports | planned (E1) |
| Adapters (beside each app, or in `adapters/`) | Translate the verbs to one app's entry points | planned; fake adapter in E0 |
| MCP server (planned) | Expose the verbs as agent tools, through the core only | planned (E2) |
| Oracle registry (`oracles/`) | Cases with known answers | planned (E0 schema, E2 v1) |

## Interfaces

Five contracts. Each is a JSON document with a `schema` identifier and a version, a good and bad fixture set, and a migration policy. Unknown schema versions can be transported but not interpreted.

### 1. Project manifest (project folder, human and agent)

- Project ID, name, created/updated, SEED version that wrote it.
- References to native artifacts: relative path (portable), app ID, native format and version, **revision** (content hash under the app's own hashing rules, plus a monotonic counter), and where the app stores its own manifest.
- Material records: stable material ID, immutable revision, display name, namespaced property sets ([plan 02](plans/02-project-and-materials.md)).
- Reserved folders: `models/`, `runs/`, `studies/`, `oracles/` (empty is fine).
- Paths are relative and portable; installed app locations live in user configuration (`installs.json`, implemented), never in the project. Windows and WSL paths are distinguished by an explicit kind, not guessed.

### 2. Adapter messages (core to app and back)

Verbs: `describe`, `open`, `validate`, `run`, `status`, `cancel`, `collect` ([plan 03](plans/03-adapters-and-transport.md)).

- Every reply has `ok`, a typed `lifecycle` where relevant, and on refusal a list of `errors`: `{code, field, message, unit?, range?, source}`. `source` says whether the text came from SEED or from app content, and app content is escaped.
- `run` takes a snapshot reference and settings, and returns an owned job ID and run location. It never takes a path to a live, editable model.
- `status` returns the coordinator state and the native status side by side.
- `collect` returns a results index, below. It is the only way output enters SEED's records.

### 3. Results index (adapter to run store)

- Quantity name, units (SI inside, display units separate), normalization (per source particle, W, W/m, W/m3, per demand, per hour, ...), coordinates and domain, time grid, uncertainty (value, kind), provenance (run ID, input revisions, mapping recipe), and a content hash.
- Large arrays stay in native files and are referenced by hash. SEED never rewrites them.
- A result without a complete index is not a result.

### 4. Study record (core, append-only)

- Header: study ID, question, hypothesis, assumptions, allowed parameters with bounds, budget, autonomy tier, set by a human.
- Steps: sequence number, time, actor (human or agent name, model, tool version), action, reason, inputs changed (revisions before and after), runs produced, oracle set and verdict, gate stops.
- Conclusion block, written last, with links to runs. A report is generated from this record and the run graph ([plan 07](plans/07-studies-and-reports.md)).

### 5. Oracle entry (registry to oracle runner)

- ID, adapter and version coverage, tag (`good`, `bad-input`, `known-limit`), inputs, expected quantity or expected refusal code, tolerance (absolute and relative) **fixed and hashed before the case runs**, source of the answer (hand derivation, analytic formula, published value, direct engine run), and the quantities and domain it covers.
- Verdict: pass, fail or not-run, with the observed value. A tolerance change is a new entry version made by a human.

## Run lifecycle

States: `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`, `terminated-by-trip`. The native status is recorded beside it, never replaced.

```
 queued --start--> running --success + complete outputs--> completed
    |                  |--error--> failed
    |                  |--cancel (own process tree only)--> cancelled
    |                  |--host or app lost--> interrupted
    |                  `--native trip/abort--> terminated-by-trip
    `--budget or gate refusal--> refused (not a run; recorded as a gate stop)
```

- `completed` requires every declared output present and hashed. Partial output with a success exit code is `failed`, with the partial files kept for inspection and never indexed as results.
- A retry creates a new attempt record. Resume never trusts a partial output because it exists.
- Default: one active case per engine until measured limits exist. Process trees are owned by the run that started them.

## Run directories and snapshots

```
<project>/runs/<run-id>/
  inputs/        exact copies, hashed
  settings.json  seeds, data-library identity, adapter and engine versions, budget used
  native/        the app's own output, untouched
  results.json   results index (after collect)
  log/           stdout, stderr, status transitions
```

The cache key is: input hashes, material revisions, mapping recipe, adapter and engine versions, settings and seeds. GUI-only layout changes are excluded only where the native format's hashing rules say so.

## Policy and gates

The core holds the study's tier ([plans/05](plans/05-agent-harness.md)). Every verb call carries an actor and passes through the gate: tier allows the verb, the budget has room, parameters are within bounds, the revision is current. A stop is recorded in the study record and returned as a typed refusal. Nothing in an adapter reply or in app content can change tier, budget, bounds or tolerance.

## Conventions

- **Units inside SEED:** SI; display units converted in one place. The results index states normalization explicitly; W, W/m, W/m3 and per-source-particle are distinct quantities.
- **Time:** UTC timestamps in records; run time and simulation time are separate fields.
- **IDs, not names:** materials and components are matched by stable ID. Equal names are never merged.
- **Determinism:** a run records its seeds. With the same snapshot, settings, seeds, data library, adapter and engine versions, a replay gives the same result **within the tolerance the adapter declares**; Monte Carlo codes declare statistical, not bitwise, agreement.
- **No app-specific constants in the core.** App knowledge lives in adapters and in each adapter's `describe`.
- **Security:** a local service, if used, binds to loopback with a per-launch token (as the shell does for apps) and may read and write only the configured project and run roots. No command is taken from a project file, a result or an adapter reply.
- **Line endings:** LF everywhere (see `AGENTS.md`).

## Repository layout (planned)

```
experiment-studio/                (repo bluetyde/seed)
  README.md  PLAN.md  TODO.md  catalog.json  apps.default.json  apps.windows.json
  docs/            ARCHITECTURE.md, WORKFLOWS.md, TOOLING.md, AGENT-TASKS.md, shell.md, plans/
  schema/          project, material-envelope, adapter, results-index, study, oracle schemas; vectors/ (good and bad fixtures)
  src/main/        host shell, installer (implemented)
  src/renderer/    shell UI (implemented)
  src/core/        project store, policy, scheduler, run store, oracle runner, study record, report builder (planned)
  src/mcp/         MCP server (planned)
  adapters/        fake/ (E0); one folder per app only where the app repo cannot hold it
  oracles/         registry: entries and results, per adapter
  examples/        teaching cases and demonstration studies
  tests/           unit, e2e (implemented), harness acceptance tests (planned)
```

## How the milestones depend on each other

```
 Schemas + fixtures (E0) --------+
                                 |
 Fake adapter (E0) ---------+    +--> E1 project + headless core --> E2 PRA adapter + MCP + oracles v1
                            |                                              |
 Tier policy (E0) ----------+                                              +--> E3 sweeps, study record, reports, replay
                                                                           |
 App result adapters (OpenMC, Fuel F3) -------------------------------------+--> E4 reviewed transfer --> E5 advanced
```

- **Schemas and the fake adapter come first**, because every later piece reads or writes them and the harness tests need no physics.
- E1 (project, headless core) and the E0 harness tests can proceed in parallel once the schemas settle.
- E2 depends on PRA's own P2 gate. If PRA is late, a NODAL or Virtual Reactor adapter can take its place.
- E4 depends on Fuel Performance Studio F3 and an OpenMC result adapter, which are owned by those apps' plans.
