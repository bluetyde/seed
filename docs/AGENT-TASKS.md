# Agent task board

How work is split under the delegation workflow:
**Claude plans and verifies; Antigravity (agy, via the `antigravity-task` skill) implements delegated tasks in the isolated `agent-sandbox`; Codex (`codex-review` skill) gives a read-only second opinion on non-trivial diffs.**
Nothing merges to `main` until Claude has re-run the checks itself and the user agrees.

## Whether to delegate

Decide with **step 0 ("Is it worth delegating?") of the antigravity-task skill**, `~/.claude/skills/antigravity-task/SKILL.md`. It is the single source for the rule; this board only applies it to this project's tasks. Run step 0 again before dispatching. How to brief, preflight, run and verify is in the same file.

Reminders from the sibling project (Virtual Reactor, [its board](../../virtual-reactor/docs/AGENT-TASKS.md)): the clear wins are large, mechanical tasks whose contract is already fixed and whose oracle is strong (schemas with fixtures, golden vectors, screening scripts). Tasks that need judgment, nuclear or safety reasoning, or a feasibility prototype are net losses to delegate.

Note: SEED is Node/TypeScript, so the sandbox's Python version caveat (py_compile with the `--env` Python) does not apply to most of it; run `npx tsc --noEmit` and `npm test` with Node 24 instead, and check the sandbox has Node 24.

## Board

Status: `ready` (brief can be written now) | `blocked` (needs something first) | `pending` | `done` | `ongoing`. Triage written 2026-10-03; recheck with step 0 before any dispatch.

### agy candidates (large, mechanical, strong oracle)

| # | Task | Status | Oracle | Notes |
|---|---|---|---|---|
| A1 | JSON Schemas for adapter messages, results index, project manifest, material envelope, study record, oracle entry, with a good and a bad fixture per rule and a validator | blocked | Every error code has a failing bad fixture; targeted schema breaks are caught | Needs the contract decisions from E0 task 3 written down first; then it is a textbook step-0 win. Brief must state units, the escaping rule and the "unknown version is refused" rule (rules 9 and 10 of the brief template) |
| A2 | Fake adapter with scripted behaviours (success, each validation error, crash, hang, partial output, trip, stale revision, instruction-like text) | blocked | Harness acceptance tests 1, 2, 4 run against it | Needs A1 and the transport decision |
| A3 | Harness acceptance tests 1, 3, 4, 5, 6 as vitest cases | blocked | Each test fails against a deliberately broken gate | Needs the core's gate API |
| A4 | Path conversion function (Windows, WSL, posix, spaces, UNC, traversal) with a table test | ready | Table of cases agreed in the brief; breaking the function breaks the tests | Small; may be cheaper for Claude to write directly. Run step 0 |
| A5 | Report builder templates (HTML and Markdown) from a study record fixture | blocked | Golden output; a record with an injected string is escaped | Needs the study record schema |

### Claude-only (judgment, safety, contracts, small changes)

| # | Task | Why |
|---|---|---|
| C1 | App inventory and transport decision | Needs reading each app's entry points and judging trade-offs |
| C2 | Tier policy and gate semantics | Safety reasoning; the part an agent must not be able to bypass |
| C3 | Study record and oracle entry design | Defines the contracts every other task depends on |
| C4 | Material envelope rules and the cross-app acceptance case | Cross-app semantics and unit/normalization decisions |
| C5 | PRA oracle arithmetic and tolerances | Hand derivations; a mistake here propagates to every check |
| C6 | Transfer recipe and conservation checks (E4) | Physics normalization; precision-critical |
| C7 | Brief writing, preflight, verification of every delegated diff | By the skill's rules |

### Codex review points

Every milestone ends with a `codex-review` of its diff (focus: silent failures, security boundaries, spec gaps, consistency). Special attention: the gate and tier code, path handling, anything that spawns a process, anything that reads app content.

| Review | When |
|---|---|
| R1 | After the E0 schemas, validator and fake adapter |
| R2 | After the core gate and policy (E1 and E2) |
| R3 | After the MCP server |
| R4 | After the first real adapter and its oracle set |
| R5 | After the transfer recipe and conservation checks (E4) |

### Done

- Shell skeleton, same-origin windows, installer/updater, platform-aware defaults (Claude, 2026-10-01 to 2026-10-03; see the project log).

## Current request: Codex-ready work (2026-10-03)

The user's current request authorizes Codex planning and identifying implementation work; historical role labels above are not an exclusive ownership restriction. No delegation or implementation is dispatched here.

- Ready: W1 read-only SEED/OpenMC runtime inventory and W2 contract drafting in [plan 11](plans/11-runtime-and-shared-acceptance.md).
- After contracts: W3 fake-process lifecycle and W4 fake-artifact transaction tests/implementation; existing tests stay intact.
- Parallel design: W5 E0 typed contracts and harness fixtures, then implementation once contract decisions are resolved.
- Later: W6 isolated real OpenMC acceptance; W7 remains an OpenMC-repo task.
