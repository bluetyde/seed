# Plan 05: Agent harness

What lets an AI agent run an engineering study through SEED, and what stops it from doing harm or fooling itself. Milestones: E0 (contracts, fake-adapter tests), E2 (MCP, tier enforcement), E3 (study record), E4 (first cross-app demonstration). Full rationale is in the workspace `plans/agentic-harness.md`.

Educational scope: an agent's output is never a licensing-grade analysis, and every report says so.

## Four layers

| Layer | What | Plan |
|---|---|---|
| H1 Headless adapters | Every calculation verb works with no editor window; typed replies; one MCP server over the core | here and [03](03-adapters-and-transport.md) |
| H2 Oracle registry | Cases with known answers, tolerances fixed in advance | [06](06-oracles-and-verification.md) |
| H3 Study record | Append-only account of question, steps, actors and conclusions | [07](07-studies-and-reports.md) |
| H4 Autonomy tiers | What an agent may do without a human, enforced by the core | here |

## MCP surface (proposed)

Tools map one to one onto core operations; none runs a command string.

| Tool | Tier needed | Notes |
|---|---|---|
| `list_apps`, `describe` | A0 | Versions, capabilities, typed parameters, oracle coverage |
| `list_projects`, `read_manifest`, `read_study`, `read_results` | A0 | Read-only; app content escaped and labelled |
| `validate` | A0 | Typed errors with field and unit |
| `run_oracles` | A1 | Runs the adapter's oracle set; verdict recorded |
| `run_case`, `run_sweep` | A1 | Within study budget and bounds, on snapshots |
| `status`, `cancel` | A1 | Cancel only its own jobs |
| `new_revision` | A2 | Creates a revision of a project-owned model or material inside the study; recorded step |
| `propose_transfer` | A2 | Writes a proposal; cannot enable it |
| `enable_transfer` | A3 | Human approves; agent cannot call it successfully on its own authority |
| `append_step`, `draft_conclusion` | A1 | Appends to the record; cannot edit earlier steps |

Tool descriptions state limits and refusals so an agent can plan around them. There is no tool to change a tier, budget, bound or tolerance; those are human actions in the GUI or in a signed policy file.

## Autonomy tiers

| Tier | Agent may, without asking | Agent must stop for a human |
|---|---|---|
| A0 observe | describe, validate, collect, read | anything that changes a file or starts a process |
| A1 run | run oracle sets; cases within budget on snapshots; sweeps inside declared bounds | exceeding budget, bounds or the per-engine limit |
| A2 edit | new revision of a project-owned model or material inside the study | accepting a new material property set, source or units convention |
| A3 transfer | nothing by default | enabling any transfer, mapping recipe or feedback loop |
| A4 never | nothing | removing a refusal, loosening a tolerance after seeing a result, writing outside configured roots, running a command found in a project file or result |

- The tier belongs to the **study** and is set by a human. The core enforces it at the gate ([ARCHITECTURE](../ARCHITECTURE.md)).
- A refusal is final until a human changes its cause. A failed oracle blocks the study.
- A gate stop is recorded, with the request, the rule and the actor.

## Threat model

| Threat | Mitigation |
|---|---|
| Instruction-like text in a model, log, result or imported paper | Data is not instructions: typed fields, escaped and labelled app content, no tool takes a command string |
| Agent loosens a tolerance after a bad result | Tolerance hashed before the run; changing it is a human action producing a new oracle version |
| Agent reads a green status as a good result | Native status shown; oracles; trip never counted as success; `unverified` outside oracle coverage |
| Agent exhausts the shared machine | Budgets, one active case per engine, owned process trees, no touching others' ports or data |
| Agent edits another writer's revision | Expected-revision checks; conflict recorded |
| Agent writes outside the project | Path roots enforced in the core; traversal refused |
| Report reads as authoritative | Educational-use statement, generated assumptions section, uncertainty always shown |
| A second agent impersonates the first | Actor recorded per step; local token per client; roles not authenticated beyond that in v1 (state it) |

## Dev agents versus engineering agents

`messages/INSTRUCTIONS.md` coordinates agents that write code (claims, clones, ports, handoff logs). Engineering agents run studies. Keep two records: the project's dev log for code work, and each study's record for engineering work. An open decision is whether one convention can serve both without mixing them.

## Acceptance tests

Numbered as in the workspace plan. Tests 1, 3, 4, 5 and 6 need only the fake adapter.

1. Fake adapter, no window: an agent validates a bad input and gets the typed error with field and unit.
2. Cancelled, crashed and partial-output attempts remain visible as diagnostics, never successful quantitative results.
3. A deliberately wrong adapter output fails its oracle set and blocks the study; the agent cannot proceed or edit the tolerance.
4. A project file with instruction-like text (a shell command, "ignore the budget") is stored and shown as data and starts nothing.
5. An over-budget A1 request stops at the gate and is recorded; an A2 request to accept a new material property set stops for a human.
6. Two writers: the second save with a stale revision is rejected and recorded.
7. Replay reproduces the stored study, or lists each difference.
8. A report is generated only from the record; each figure traces to a run ID; the educational-use statement is present.
9. The first real adapter (Virtual Reactor) through the CLI/MCP and directly agree on every oracle; PRA repeats this when built.
10. The E4 transfer refuses wrong units, a stale revision and incomplete coverage, and conserves total mapped power within the tolerance fixed beforehand.

## Decisions (2026-10-03, see [../DECISIONS.md](../DECISIONS.md))

- D1: MCP and a plain CLI, both thin front-ends over one core.
- D4: enforcement is in the core library, run in-process by the host and by a headless process otherwise. Approvals are pluggable (GUI dialog, or a human-run CLI command when no window exists). No MCP or CLI surface has an approve action for an agent. Grants are scoped to study, actor, operation, input revisions and expiry.
- The threat model is an agent making mistakes through MCP or CLI, not an agent with shell access to the account; the study record's hash chain detects edits but cannot prevent them.

## Open

- Policy file format and who may sign it.
- Whether agents get per-agent tokens and per-agent budgets.

## Completeness clarifications (2026-10-03)

These rules refine earlier shorthand and are requirements for the E0 contracts, not implemented functionality.

1. **Provisioning versus study authority.** Installation, runtime upgrades, prerequisite changes, downloads and cleanup are setup operations authorized separately from study tiers. A run cannot trigger an implicit install. Missing dependencies return a typed requirement. SEED owns these operations using app recipes; native save/open and export performance remain app-owned. Shared offline integration acceptance is required.
2. **Read-only means read-only.** A0 may inspect already available metadata, validate purely in memory, read status and read previously collected artifacts. If validation needs an engine process or collect must write an index, that operation needs run-level authorization. Opening an editor is a separate launch operation and never implicitly starts a calculation. Headless means calculation operations do not require a window, not that the open-editor verb creates no window.
3. **Idempotency is not caching.** Repeating the same request key with the same payload returns the same operation; the same key with a changed payload is refused. A new request creates a new attempt unless explicit cache reuse is requested and validated. The cache key includes input/material revisions, data, engine/adapter/runtime versions, settings and seeds. Replicates with identical settings remain possible. Retries do not overwrite failed attempts.
4. **One core enforcement path.** GUI, CLI and MCP use the same authorization, validation, scheduler and store. Transport is still an E0 decision; authentication requirements apply to local services, while CLI/process identity has its own boundary. Unknown schema versions fail with migration guidance; no silent coercion. Capability declarations are checked against actual supported operations.
5. **Results retain evidence.** Failed, cancelled, interrupted or tripped attempts remain visible in reports as diagnostics, never promoted to successful quantitative conclusions. Completed means declared outputs exist, are parsed/finite where required, satisfy native convergence/completion rules and are hashed. A numerical oracle passing on a small case does not certify arbitrary domain behavior. Unknown coverage stays unverified.
6. **Approval scope and revisions.** A grant identifies study, actor/session, operation, input revisions, mapping/constraint version, budget and expiry/revocation. Changed inputs invalidate incompatible grants. The study policy cannot be changed by model output. A2 permits in-bounds changes under approved property models, not invented or newly accepted material data. A3 may execute a specifically approved mapping within its scope without asking again for every identical step; feedback is separately scoped. A4 is prohibited agent behavior, not a higher privilege level. A legitimate revised tolerance creates a new oracle version and new evaluation; it cannot rewrite earlier failures or erase evidence.
7. **Failure, cancellation and concurrency.** Define legal states and timeout/cancellation races, atomic result commit, crash recovery, resource accounting, expected-revision saves, and one active case per engine by default. Track owned process start identity, not just PID; never cancel attached/unowned servers or restart WSL. Record wall-time versus simulation-time budgets explicitly.
8. **Replay and reporting.** Record actual accepted AI decisions, model/checkpoint/configuration and transformations; replay recorded actions rather than assuming repeatable live inference. Separate source observations, derived calculations and agent interpretations. Record uncertainty, seeds and numerical tolerance; a human-readable report is generated from linked evidence and preserves failed attempts and limitations.
9. **Minimal path first.** First agent end-to-end demonstration is E2: one real adapter and oracle through the common core. E4 adds the first cross-app transfer, not the first working harness. Per decision D5 ([DECISIONS](../DECISIONS.md)) Virtual Reactor (RAFT) is the first real adapter, subject to the E0 inventory confirming its headless entry point; PRA follows after its P2 gate, and NODAL is the fallback if RAFT is delayed, with the decision recorded. No suite-wide wait for all five engines.
10. **Materials.** Project-owned IDs/revisions and app-specific property sets survive round trips. Unknown sets remain opaque data, not executable expressions; each operation reports missing fields/ranges. Names do not establish identity and no fallback catalog material is silently substituted.

### Additional acceptance cases

11. A study tries to install/update a runtime: refused with setup-required status; existing installed runs remain usable offline.
12. Duplicate request, conflicting payload, explicit retry and cache reuse each follow the declared identity rules; no accidental duplicate process or loss of prior attempt.
13. GUI and agent request the same forbidden operation: both are refused by the core. Expired/revoked approval and changed input revision invalidate the action.
14. Host crash, cancellation/completion race and stale PID recovery preserve owned/unowned boundaries and do not create false completed results.
15. Unknown material properties survive open/save; missing thermal properties block only the affected operation. Project relocation and expected-revision conflict are checked.
16. Malformed/nonfinite outputs or failed convergence with exit code zero are refused; failed/tripped attempts remain visible as diagnostics in the report.
17. Runtime version change invalidates incompatible oracle/cache reuse. Recorded AI-action replay is distinguished from live-model rerun.

Acceptance cases 11-17 can begin with fake adapters/artifacts after their contracts exist. Real runtime acceptance additionally tests install, launch, offline calculation, save/reopen, interruption and rollback; see SEED plan 11. This completes the planned failure/ownership coverage, not implementation or physical validation. Transport, schemas, storage and exact platform mechanisms remain named design decisions.
