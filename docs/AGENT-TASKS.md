# Agent task board

How work is split under the delegation workflow:
**Claude plans and verifies; Antigravity (agy, via the `antigravity-task` skill) implements delegated tasks in the isolated `agent-sandbox`; Codex (`codex-review` skill) gives a read-only second opinion on non-trivial diffs.**
Nothing merges to `main` until Claude has re-run the checks itself and the user agrees.

## Whether to delegate

Decide with **step 0 ("Is it worth delegating?") of the antigravity-task skill**, `~/.claude/skills/antigravity-task/SKILL.md`. It is the single source for the rule; this board only applies it to this project's tasks. Run step 0 again before dispatching. How to brief, preflight, run and verify is in the same file.

Reminders from the sibling project (Virtual Reactor, its own task board, in that project's repository): the clear wins are large, mechanical tasks whose contract is already fixed and whose oracle is strong (schemas with fixtures, golden vectors, screening scripts). Tasks that need judgment, nuclear or safety reasoning, or a feasibility prototype are net losses to delegate.

Note: SEED is Node/TypeScript, so the sandbox's Python version caveat (py_compile with the `--env` Python) does not apply to most of it; run `npx tsc --noEmit` and `npm test` with Node 24 instead, and check the sandbox has Node 24.

## Board

Status: `ready` (brief can be written now) | `blocked` (needs something first) | `pending` | `done` | `ongoing`. Triage written 2026-10-03; recheck with step 0 before any dispatch.

### agy candidates (large, mechanical, strong oracle)

| # | Task | Status | Oracle | Notes |
|---|---|---|---|---|
| A1 | JSON Schemas for adapter messages, results index, run record, project manifest, study record, oracle entry, plus validator, canonical hashing and semantic checks | done 2026-10-03 | 177 fixtures, 1344 generated per-property cases, mutation sweep | Two agy runs (schemas, then a contract-table test generator after a mutation sweep showed the first fixture set caught only 120 of 517 loosenings). Contract text: `docs/contracts.md` |
| A2 | Fake adapter with scripted behaviours and the adapter client | done 2026-10-03 | 31 tests on Windows and Linux; targeted breaks (ownership check, finite check, timeout kill) each caught | agy run stalled after writing the files; the code was usable. Dispatcher fixed a Linux-only stdout truncation, a silent kill failure, unbounded stderr and a racy test |
| A3 | Run lifecycle (RunManager) tests with the fake: crash, validation failure, hang, partial output, trip, cancel, idempotency, recovery | done 2026-10-03 (second dispatch) | 10 agy tests plus 8 dispatcher tests; targeted breaks caught after adding forged-collect cases | First dispatch produced nothing (agy waited on a background test run). Dispatcher fixed a silent reset of a corrupt request log. Harness acceptance tests needing the oracle runner, tiers or the project store are still open |
| A4 | Path conversion function (Windows, WSL, posix, spaces, UNC, traversal) with a table test | done 2026-10-03 | 61 tests: every row of the case table, seeded round trip | Dispatcher added the code-point length rule and distro-name validation |
| A5 | Report builder (HTML and Markdown) from a study record | done 2026-10-03 | 14 tests; every free-text field fuzzed with markup payloads | Dispatcher fixed an unescaped Markdown sentence and locale-dependent ordering |

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

### Evidence from the E0 implementation round (2026-10-03)

Five dispatches (schemas, paths, fake adapter, report builder, run lifecycle) plus one follow-up (schema contract tests) and one re-dispatch. What the dispatcher's own review found that the runner's checks and agy's tests did not:

- **Example-based fixtures are not enough.** A mutation sweep over the schemas caught 23% of single-constraint loosenings; agy then transcribed the contract into a table and generated per-property tests (78%, the rest mostly redundant or unspecified bounds). For schema work, ask for the generated table up front.
- **Silent failures the scanner did not flag:** a kill that reported success when it failed, a corrupt request log reset to empty, unbounded stderr buffering.
- **A Linux-only bug in a test fixture** (stdout cut at the pipe buffer when the process exits right after writing) that passed on Windows. Run process-heavy tests on both OSes.
- **Untrusted text left unescaped** in one Markdown sentence of the report; found only by fuzzing every free-text field.
- **agy stalls on process-heavy tasks:** two runs ended with no or partial work after launching a test run as a background task. Briefs now say: write the files before running anything, wrap tests in `timeout 300`, and a reply that ends before the files exist counts as BLOCKED.
- Cost: briefs were long (the contract text carried most of the design); the dispatcher fixes were small (about 10 edits). Net: worth it for the schemas, fixtures and report builder; marginal for the run manager.

### Done

- Shell skeleton, same-origin windows, installer/updater, platform-aware defaults (Claude, 2026-10-01 to 2026-10-03; see the project log).

## Current request: Codex-ready work (2026-10-03)

The user's current request authorizes Codex planning and identifying implementation work; historical role labels above are not an exclusive ownership restriction. No delegation or implementation is dispatched here.

- Ready: W1 read-only SEED/OpenMC runtime inventory and W2 contract drafting in [plan 11](plans/11-runtime-and-shared-acceptance.md).
- After contracts: W3 fake-process lifecycle and W4 fake-artifact transaction tests/implementation; existing tests stay intact.
- Parallel design: W5 E0 typed contracts and harness fixtures, then implementation once contract decisions are resolved.
- Later: W6 isolated real OpenMC acceptance; W7 remains an OpenMC-repo task.
