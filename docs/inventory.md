# App inventory (E0 task 1)

2026-10-03, read-only inspection of the local checkouts by grep and file reads; no app was run and no app file changed. Evidence is the named file; "not verified" means I did not execute it. Revisions: NODAL Studio `1f7dd54`, RAFT `702ae12`, OpenMC Studio (the installed copy, revision not recorded here). PRA and Fuel Performance Studio: `not built` (plans only).

## Per verb

| Verb | NODAL Studio (`pipe-studio`) | Virtual Reactor / RAFT | OpenMC Studio |
|---|---|---|---|
| describe | `nodal_studio/capabilities.py` (not verified what it declares); no CLI verb | none; `web/src/app/catalog.ts` lists scenarios and cores for the UI | none; `GET /api/health`, `/api/cad/capabilities` cover only part |
| open | editor is the web app (`run-viewer.cmd`); no open-by-reference entry | `run-viewer.cmd`, Vite app | local server with token, started by SEED today |
| validate | `nodal_studio/validate.py`, `RunRefused` issues as `code path: message`, exit 2 | `web/src/contracts/validate.ts` (TypeScript, no CLI) | partial: `/api/check-geometry`, `geometry_check.py` |
| run | **CLI exists**: `python -m nodal_studio.run MODEL.json --out DIR --run-id ID [--commands F] [--replay S]` | no CLI. Sim core is TypeScript (`web/src/sim/engine.ts`, `web/src/runtime/runtime.ts`) behind a `RuntimeHost` interface; headless today only through test helpers (`test-helpers.ts`, `agent-harness.ts`, vitest). The Python/OpenMC pipeline has a CLI (`pipeline/openmc/sweep.py --core ... --dry-run`) but it is the offline library build, not the simulator | `POST /api/run` (token, origin and host checks), subprocess `python model.py` in the project folder; no CLI |
| status | run folder `manifest.json` (`running` until the commit marker) | runtime clock/snapshot messages (in-process) | `GET /api/runs`, run progress endpoints |
| cancel | no verb; process exit only (not verified) | in-process stop only | `DELETE` endpoint (`do_DELETE`); child started with `start_new_session` |
| collect | `runs/<runId>/{manifest,results,model,log}`; manifest written last with sha256 per file (`docs/run-manifest.md`, `results-format.md`) | session/checkpoint files (docs/c6-runtime-design.md); no results index | results under the project; `results.py`, `provenance.py` (not verified against contract) |

## Update, 2026-10-03: RAFT now has a headless runner (merged into RAFT main, 570d2e1)

`claude/seed-headless` in the RAFT repo (570d2e1, [docs/headless.md](https://github.com/bluetyde/raft/blob/claude/seed-headless/docs/headless.md)) adds `node web/dist-headless/raft-headless.mjs describe | validate | run | replay`. A case is a golden-vector scenario plus a library path; the run folder has a hashed manifest written last, deterministic results and a session for replay. All six engine golden vectors agree through it; Windows and Linux give byte-identical output. Per verb: describe = `describe`, validate = `validate`, run = `run`, status = manifest (`running`), cancel = kill the process, collect = results.json plus manifest hashes. This settles the D5 inventory question: RAFT is usable as the first adapter now that the runner is in RAFT main. The table above shows the state before this update.

## What this says about the first adapter (decision D5)

D5 chose Virtual Reactor as the first real adapter, pending this inventory. The inventory does not support that as stated:

- **NODAL is the closest fit today.** It already has a headless CLI with exit codes (0 completed, 1 failed/interrupted, 2 refused), an atomic run folder with the manifest as commit marker, hashes, replay of a recorded session and a documented results format. The adapter would be a thin wrapper (request on stdin, existing CLI, collect from the manifest). Missing: describe, status while running (poll the folder), cancel, an explicit snapshot step.
- **RAFT has no headless entry point.** A Node 24 script that builds a `Runtime` on a scripted host would be needed (`agent-harness.ts` shows it is possible), plus its own run-folder and results contract. That is real work inside RAFT, coordinated with its owner. Its oracles (inhour, prompt jump, replay) are in TypeScript tests today.
- **OpenMC Studio** is a token-guarded local service (transport option B) with no CLI; fine for later, not for first.

Recommendation, for the user to decide (D5 stays as recorded until then): first adapter NODAL (exists today, closest to the contract), then RAFT once it grows a headless runner, then OpenMC Studio through its service. PRA stays second among the new apps per its plan.

## Open questions for the owners

1. NODAL: does `capabilities.py` declare anything usable for `describe`; can a run be cancelled safely mid-step and leave `running` manifest only (the contract's interrupted state)?
2. RAFT: who writes the headless runner, and what is its run-folder format (copy NODAL's `run-manifest.md` pattern, which says it follows RAFT's run cache)?
3. OpenMC Studio: which `/api/run` response fields map to job id and run location.

Existing manifest and hashing rules to reuse: NODAL `docs/run-manifest.md` (sha256 per file, manifest last), SEED `schema/results-index.schema.json`.
