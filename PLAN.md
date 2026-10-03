# SEED: Plan

SEED = System for Engineering and Experimental Design. Folder and log keep the running name `experiment-studio` (like `virtual-reactor` for RAFT); the repo is `bluetyde/seed` (private).

Detailed documents:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit together (components, interfaces, run lifecycle, conventions, repo layout, dependency graph)
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md): step-by-step procedures (setup, adding an adapter, adding an oracle, running a study, releases, multi-agent rules)
- [docs/TOOLING.md](docs/TOOLING.md): tools in use or considered, versions, prior art to survey
- [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md): who does what under the delegation workflow, and the task board
- [docs/shell.md](docs/shell.md): the implemented host shell and installer
- [docs/plans/](docs/plans/): one plan per area: [01 shell and installer](docs/plans/01-shell-and-installer.md), [02 project and materials](docs/plans/02-project-and-materials.md),
  [03 adapters and transport](docs/plans/03-adapters-and-transport.md), [04 runs and scheduling](docs/plans/04-runs-and-scheduling.md), [05 agent harness](docs/plans/05-agent-harness.md),
  [06 oracles and verification](docs/plans/06-oracles-and-verification.md), [07 studies and reports](docs/plans/07-studies-and-reports.md), [08 transfers and pipelines](docs/plans/08-transfers-and-pipelines.md),
  [09 advanced studies](docs/plans/09-advanced-studies.md), [10 release and packaging](docs/plans/10-release-and-packaging.md)
- Suite context (workspace, outside this repo): `plans/nuclear-suite-integration.md` (six apps, material envelope, adapter semantics) and `plans/agentic-harness.md` (the harness this plan builds).

## Goal

One project workspace for the nuclear teaching suite. A student opens the five engineering apps (OpenMC Studio, NODAL Studio, Virtual Reactor/RAFT, PRA & Reliability Studio, Fuel Performance Studio) from one window, attaches native models to a project, runs bounded experiments, compares reproducible results and exports a report.
The stretch goal is that the same layer is a **harness for agentic engineering**: an AI agent can run an engineering study through the same verbs a student uses, under limits it cannot loosen, and a human can review and replay every step.

SEED coordinates. It does not simulate and it does not own any app's model. The apps stay independently usable.

## Design principles

- **Apps stay standalone.** Every app runs without SEED. An adapter is a thin wrapper, not a change to a physics core.
- **Native documents are authoritative.** No universal model replaces them. SEED references versioned native artifacts and wraps their manifests without changing their hashing rules.
- **Open is not run.** Opening an editor and executing a calculation are different operations with different permissions.
- **Refuse, don't guess.** Missing properties, unit mismatches, unsupported constructs and stale revisions produce a typed refusal with the field and reason. No silent defaults, no name matching, no invented values.
- **Calculations consume snapshots.** A run copies exact inputs into its own directory. No two writers share a mutable directory or revision.
- **Native status survives.** The coordinator's status sits next to the app's own status. A trip, a partial output or a crash is never promoted to a result.
- **Every result traces to its cause.** Inputs, material revisions, mapping recipe, versions, settings, seeds and output hashes are recorded. A changed input invalidates what depends on it.
- **Limits are enforced by SEED, not requested of the agent.** Budgets, bounds and autonomy tiers live in the host; an agent cannot raise its own.
- **Data is not instructions.** Text in models, logs, results and imported files is displayed and stored, never executed or obeyed.
- **Honest scope.** Educational use. Outputs are not licensing-grade analyses, and reports say so.
- **Open source, MIT** (as set at repo creation). Bundling an external engine needs a license check first.

## Why it's worth building

Written 2026-10-03 from the repo's own plans, not from a fresh survey. **The claims about other tools below are unverified until [docs/TOOLING.md](docs/TOOLING.md) section 4 is done; do not repeat them outside the repo before then.**

| Existing kind of tool | Good at | Missing for this suite |
|---|---|---|
| Single-app GUIs (each suite app on its own, ParaView and similar) | Deep work inside one code | No shared project, no cross-app run record, no comparison across apps |
| Scientific workflow and provenance managers (to survey: AiiDA, Snakemake, Nextflow, signac) | Reproducible pipelines, provenance graphs | Built for scripts, not for opening teaching apps as tabs; no educational guardrails |
| Uncertainty and parameter-study drivers (to survey: DAKOTA) | Sweeps, sampling, sensitivity | Input-file workflow per code; no GUI project, no oracle gate for agents |
| Notebooks | Flexible, familiar | Reproducibility depends on the author; no enforced refusals or tiers |
| General agent frameworks and MCP servers | Tool access for agents | No domain contract: no units, revisions, normalization or physics refusals |

The gap: a thin, local, open layer that turns a set of independent teaching apps into one reviewable experiment workspace, with the contracts (units, revisions, refusals, oracles) that make an agent's work checkable.
The new parts are the contracts and the oracle gate, not the launcher.

## Core technique: contract, snapshot, oracle

1. **Contract:** each app declares what it can do (`describe`) and what an input needs (`validate`) in typed form.
2. **Snapshot:** a run consumes an immutable copy of the inputs and records everything needed to repeat it.
3. **Oracle:** before a result is trusted, the adapter passes a set of cases with known answers and tolerances fixed in advance. A failing oracle blocks the study.

This is close to how a careful engineer works by hand. It fails if the oracle set does not cover the case being run; each adapter therefore declares which quantities and domains its oracles cover, and SEED marks everything outside that as `unverified`.

## Architecture

```
          students (GUI)                         agents (MCP tools)
                |                                       |
        +-------v----------------------------------------v-------+
        | SEED core (headless)                                    |
        |  project store, study record, policy (tiers, budgets)   |
        |  scheduler, run store, oracle runner, report builder    |
        +-------+-------------------------------------------------+
                | adapter verbs: describe open validate run status cancel collect
   +------------+-----------+---------------+--------------+------------+
 OpenMC      NODAL      Virtual         PRA &          Fuel Perf.    fake adapter
 Studio      Studio     Reactor        Reliability     Studio        (tests)
```

- The **host shell** (implemented) is a GUI client of the core: tabs, installer, Welcome page.
- The **core** is headless-capable from E1. The GUI and the MCP server are both clients of it.
- **Adapters** are thin and live beside each app's entry points. Transport is decided in E0 ([plan 03](docs/plans/03-adapters-and-transport.md)).
- Details, interfaces and the run lifecycle are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Views

- **Welcome / apps** (implemented): install, update and open the suite apps as tabs.
- **Project:** attached models and runs, revisions, materials, missing-app and stale-result notices.
- **Runs and compare:** run list with native and coordinator status; compare compatible quantities with normalization and uncertainty.
- **Study:** question, assumptions, parameters and bounds, budget, steps (human and agent), oracle status, conclusion.
- **Report:** generated from the study record and run graph; every figure links to a run.
- **Policy:** the study's autonomy tier and budgets; gate stops and approvals.

## Tech choices (tentative)

- Electron host, TypeScript, vitest, Playwright (implemented; see [TOOLING](docs/TOOLING.md)).
- Core in TypeScript so the host and an MCP server share it; adapters may be any language behind the transport.
- JSON Schema for contracts, with good and bad fixtures and a small validator (the pattern used in Virtual Reactor's `schema/`).
- Study record and run store as plain files in the project folder first; an embedded store only if files prove too slow (decision in E0).
- No fixed ports reserved until the implementation plan checks existing allocations (shared rule: user 8765, Claude 8766, Antigravity 8767, Codex 8768).

## First test cases

- **Fake adapter:** succeeds, fails validation, crashes, hangs, leaves partial output, trips, reports a stale revision. Drives the harness tests with no physics.
- **PRA two-pump lesson:** first real adapter. Hand oracles: A=0.1, B=0.2, AND 0.02, OR 0.28; A AND A and A OR A both 0.1; (A AND B) OR (A AND C).
- **OpenMC heating to Fuel Performance Studio:** first reviewed transfer and first end-to-end agent demonstration.

## Milestones

Detail and exit evidence per milestone are in [TODO.md](TODO.md) and the area plans.

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| E0: contracts | App inventory, transport decision, schemas with fixtures, study and oracle record formats, tier policy, fake adapter | Open vs run, revisions, material preservation and status semantics documented; harness acceptance tests 1, 3, 4, 5, 6 pass against the fake adapter |
| E1: project launcher | Project create/open/reopen, attach native models, open editors, import completed runs, headless core | Reopen and relocate a project; missing app is actionable; Windows/WSL path mapping explicit; no physics required |
| E2: single-app runs | One real adapter (PRA) through all verbs, MCP server, oracle registry v1, tier enforcement | Direct, workspace and MCP results agree on every oracle; cancellation, crash, partial output, edit conflict and stale result handled |
| E3: experiments | Typed parameters, bounded sweeps, comparison, study record, generated report, replay | Failed cases visible; same inputs and seed replay or list differences; each figure traces to a run |
| E4: reviewed transfer | One-way, offline OpenMC heating to Fuel Performance Studio with human-approved mapping | Unit, normalization and coverage refusals hold; conserved power within a tolerance fixed beforehand; downstream invalidation |
| E5: advanced studies | Sensitivity and uncertainty an agent can drive; optional feedback coupling | Monte Carlo noise, input uncertainty and deterministic sensitivity reported separately; feedback only after its gates are written |

## Open questions

- MCP only, or MCP plus a plain CLI for scripts and CI.
- Study record as project files or an embedded store with files as the export.
- Oracle registry in this repo, or in each app's repo with SEED indexing it.
- Where tier enforcement runs (host main process or a small separate service).
- UI framework for project, study and report views (the shell uses plain TypeScript and HTML).
- First real adapter if PRA is late: NODAL or Virtual Reactor have existing run contracts.
- One log convention for dev agents and engineering agents, without mixing them.
- License of bundled engines and of any redistributed packages; distribution model.
