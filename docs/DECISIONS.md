# Decisions

Design decisions with their reasons, newest last. A decision changes only by a new entry that names the one it replaces. Decided by the user unless noted. Documentation records them; none is implemented yet.

## D1 (2026-10-03): Interface is both MCP and a plain CLI

- **Decision:** the core exposes one command set. A CLI and an MCP server are thin front-ends over it. GUI, CLI and MCP all go through the same authorization, validation, scheduler and store.
- **Why:** agents need MCP; CI, scripts and manual use need a CLI; one core path means a rule enforced for one front-end is enforced for all.
- **Consequences:** build the CLI first (easiest to test), then MCP over the same commands. No front-end may bypass the core. Local services, if any, need authentication; CLI process identity has its own boundary (see the harness plan, rule 4).
- **Rejected:** MCP only (no scripting or CI path); separate implementations per front-end (rules drift).

## D2 (2026-10-03): Studies and runs are project files, not an embedded database

- **Decision:** the study record, run records and results indexes are structured files in the project folder: append-only JSONL for the study record, atomic writes (temp file and rename), JSON for run records, native files for large arrays. An optional hash chain over the study record makes edits detectable.
- **Why:** transparency and reproducibility: files can be tracked in git, zipped, shared and read by hand. A database is opaque and harder to version.
- **Consequences:** a SQLite or DuckDB index may be added later as a **rebuildable cache**, never the source of truth. Scale limits (thousands of cases) are handled by that index, not by changing the record.
- **Rejected:** an embedded database as primary store.

## D3 (2026-10-03): Each app owns its oracles; SEED indexes and pins them

- **Decision:** oracle entries live in each app's own repo (PRA and Fuel already plan this). SEED owns the oracle-entry **schema**, the oracle **runner** and an **index**. SEED also keeps a small oracle set for its own fake adapter.
- **Why:** an app that is not installed adds no oracle bloat; the people who know an app's physics maintain its checks.
- **Consequences:**
  - Every oracle run records the oracle file hash and the app commit, so an expected value or tolerance changed in an app repo is visible, not silent. Changing an expected value or tolerance is a human action that makes a new entry version.
  - A study that uses an adapter whose oracle pin changed is flagged until a human accepts the new pin.
  - The project folder keeps verdicts and pinned oracle references, not the entries.
- **Rejected:** a central registry in this repo (bloat, and ownership separate from the app's physics).

## D4 (2026-10-03): Tier enforcement lives in the core library, run in-process by the host

- **Decision:** policy, tier and budget enforcement are part of the headless **core library** (no Electron imports). The host embeds it when the GUI is open; a headless process runs the same code when it is not. Approvals are pluggable: a GUI dialog when a window exists, otherwise the request queues for a human to approve through the CLI.
- **Why:** headless mode is required in E1, so enforcement cannot depend on Electron. Running it inside the host process is simpler than a separate daemon and gives direct access to the approval dialog.
- **What makes it safe:** the MCP and CLI surfaces expose **no approve action** to an agent; the approval channel accepts input only from the trusted GUI views (as the shell already restricts IPC to its own views) or from a human-run CLI command; grants are scoped to study, actor, operation, input revisions and expiry; model output cannot change policy. A separate process is not what stops a rogue client from approving.
- **Threat model (stated, not hidden):** this protects against an agent that makes mistakes while working through MCP or the CLI. It does **not** protect against an agent with shell access to the user's account, which can edit project files directly. The hash chain on the study record detects such edits; it cannot prevent them. SEED is a local educational tool, not a zero-trust service.
- **Rejected:** a separate policy daemon for now (complex approval routing, no real gain at this threat model). Revisit if SEED ever serves other people's studies.

## D5 (2026-10-03): First real adapter is Virtual Reactor; PRA follows

- **Decision:** the first real adapter (E2) is **Virtual Reactor (RAFT)**, chosen by availability. PRA is next, when its P2 gate passes. E0 uses the fake adapter. OpenMC is not first (heavy, statistical, slow); it fits E4.
- **Why:** PRA has no code yet, so E2 would wait on PRA's P0 to P2. Virtual Reactor has a headless Python engine with deterministic replay and analytic checks (from its TODO; **verify in the E0 inventory**). The harness plan already allowed a verified RAFT scripted adapter "if PRA is delayed, with the decision recorded"; this is that record.
- **Consequences:** E2's oracle set starts with RAFT's analytic cases (point-kinetics checks such as inhour and prompt jump, and replay), owned by the RAFT repo (D3). Harness acceptance test 9 becomes "the first real adapter through the CLI/MCP and directly agree on every oracle"; PRA repeats it when built. If the E0 inventory shows RAFT has no usable headless entry point, fall back to PRA or NODAL and record that as a new decision.
- **Rejected:** PRA first (waits on code that does not exist); NODAL first (no verified runner yet; decide after the inventory).

## D6 (2026-10-03): UI framework deferred to E3

- **Decision:** no framework change now. The shell stays plain TypeScript and HTML. Decide when the Study and Report views are designed (E3).
- **Why:** E0 to E2 add only a project and run list. The load worry (many jobs updating) is solved by a virtualized table and batched updates, not by the framework choice.
- **Constraints already fixed:** the report is deterministic HTML generated from the study record and run graph, works offline, and includes data tables as text alternatives to charts; views and reports share one small SVG chart approach. If a framework is adopted, React or Preact with Vite is the leading candidate.

## D7 (2026-10-08): A read-only `query_model` verb, as an additive adapter verb

- **Decision (user, 2026-10-08):** a read-only SEED verb `query_model` answers exact questions about an app's model (first NODAL: which pipes are 3 inch, is A connected to B, counts by kind). It is **tier A0** (the gate operation `query_model`), takes only a registered case id and a structured query, and records every query that reaches the app in a host-side chained log before it answers.
- **How, within the signed-off contract:** a new adapter verb `query`, offered only by adapters that list the capability `query-model`; v0.1 stays as it is (an adapter that does not know the verb never receives it), recorded here because it is the first verb added after the E0 sign-off. Adapter-style error codes need no registration (the core code list stays 25).
- **Why not a mode of `validate`:** `validate` answers valid or invalid; a query answers with data, which needs its own reply shape and its own size limit.
- **Not decided:** a query as a step of the study record; other apps' query vocabularies. Details: [query-model.md](query-model.md).

