# SNEED (PRA) adapter

Status 2026-10-05: built on branch `claude/pra-adapter`, **not merged**. The SNEED side (headless runner and 14 oracle entries) is in the SNEED repository (`docs/HEADLESS.md`, `docs/plans/11-seed-adapter.md`); this adapter only reads it.

## Shape

`adapters/pra/cli.cjs` (one process per verb), on the shared job wrapper and flows ([adapters-shared.md](adapters-shared.md)). The runner is `node dist/node/cli/headless.js` from a SNEED checkout built with `npm run build:cli`; it starts SCRAM inside WSL itself.

Host environment, never a project file or request: `SEED_PRA_REPO` (absolute path of the built checkout), optional `SEED_PRA_NODE`, optional `SEED_PRA_ORACLES` (absolute path of `oracles/seed/entries`, for `describe` coverage). A missing or unbuilt checkout is `E_SETUP_REQUIRED` naming the variable or `npm run build:cli`; a missing SCRAM runtime is warning `W_SOLVER_MISSING` on `describe` and refuses `run`.

## Verbs

| Verb | Behavior |
|---|---|
| `describe` | App `pra` / SNEED, the engine the runner uses by default and its version (the built-in `sneed-bdd` since the runner changed its default on 2026-10-06, or SCRAM; read from the runner's `describe.engines`, never assumed), format `sneed.fault-tree` 1, methods, parameters (`method`, `limitOrder`, `engine`, `event.probability`), the three quantities (unit `1`, normalization **`none`**: plan 11's recommendation, the user may change it), oracle coverage. |
| `open` | `E_VERB_UNKNOWN`: the editor is SNEED's web page. |
| `validate` | The runner's validator on the model file. App codes pass through (`E_CYCLE`, `E_PROB_RANGE`, `E_MISSING_REF`, ...; `E_SCHEMA` becomes `E_SCHEMA_INVALID`), always `source: "app-content"`: messages quote ids from the model, so they are data. |
| `run` | Snapshot of one model file; settings `model`, `method` (`exact`, `rare-event`, `mcub`), `limitOrder` (1..1000), `engine` (`builtin` or `scram`; omitted = the runner's default, which `SNEED_ENGINE` in the host environment can change; an unknown name is refused before anything is reserved, SCRAM without its runtime is the runner's own refusal). A request `seed` is refused (the analysis is deterministic). Only `budget.maxWallSeconds` is enforced (runner timeout, 10..86400 s); cores and memory are not (SCRAM is single-threaded). The runner validates the model first, so an invalid model is refused with the app's own code before anything is reserved. |
| `status` | From the wrapper's `status.json`, heartbeat and token. |
| `cancel` | The runner's own `cancel` first (it writes its cancel request and kills the processes carrying this run's owner tag in WSL), confirmed only when its answer has `nativeStopped: true`; then the wrapper and Node runner, only after their command lines prove they belong to this run. `E_NOT_OWNED` when a process cannot be shown to be this job's. |
| `collect` | Only for a completed job. Every manifest file re-hashed; the run's `model.json` and the manifest's model hash equal the snapshot's; the result is `completed` and `complete` (truncated, failed, cancelled and incomplete runs are never indexed); the result's document hash and settings equal the request's; probability in [0, 1]; cut sets well formed; an approximation value present exactly when the method is not `exact`. |

## Results

`top_event_probability`, `minimal_cut_sets` (a data file of sets with probabilities; coordinates `cut-set-index`), and `approximation_value` for the approximation methods. All unit `1`, normalization `none`, `verification: unverified` until an oracle gate passes. `extensions.pra` carries the method, limit order, the semantic model hash and the document hash (so a formatting-only change is a new revision in SEED but the same model in SNEED), the assumptions and caveats (also passed on as `W_PRA_CAVEAT` warnings), the engine and runtime identity, parser and exporter versions, and the statement that the result is a probability under stated assumptions, not a frequency and not a plant risk figure.

## Evidence (2026-10-05, Windows 11 + WSL Ubuntu, SCRAM 0.16.2, SNEED commit 9394664 built)

- `tests/pra-adapter.test.ts`: 20 pass. Real runs through the run manager; parity with the runner's own run and the hand-derived 0.028 of the 2-of-3 oracle; approximation method; a product-order limit that truncates is not a result; request refusals; invalid models refused with `E_CYCLE`; hostile model text stays app content and starts nothing; cancel of a ~25 s analysis (`slowTree(14)`: 14 AND-ed pairs) through the manager; seven kinds of tampering at collect; request-id conflict; forged cancel target. Project folders contain a space.
- `tests/pra-oracles.test.ts`: 10 pass. All 14 SNEED oracle entries (11 good within `abs 1e-12`, 3 bad-input) pass through the adapter; wrong values, a swapped unit, a dropped refusal, a changed model and an edited tolerance each fail the set and block the gate.
- Mutation checks, 11 of 11 caught after strengthening two tests (native cancel, the run verb's own validation); the method-enum check in `run` is a redundant second line behind the runner's own refusal.

## Known limits and findings

- The adapter cannot see SCRAM by name in WSL's process list; cancel confirmation relies on the runner's own `nativeStopped`, and the test asserts the runner's cancel request exists.
- Found while building (reported in `messages/pra-studio.md`): the runner did not stop a 17-pair analysis at `--timeout-seconds 120` (killed from outside at 940 s); a nonexistent `--out` folder is reported as `E_EXISTS`; `cancel --out` compares its recorded work dir as a string, so forward slashes fail. The adapter passes native paths and a pre-created folder, so none affect it.
- A cancel that arrives while the job is exiting can be refused `E_NOT_OWNED` (the process ended between the state check and the command-line check): safe, retry shows the final state.
- Windows with WSL only, like the runner. Normalization `none` pending the user's decision. The approximation rows and the product-order limit cannot be oracle entries until `seed.oracle` has a settings field.
- Shared adapter module still not done: this is the fourth copy of the infrastructure.

## Engine label (fixed 2026-10-06)

The adapter used to write `engine: { name: "SCRAM" }` in `describe` and in every results index. The runner now defaults to the built-in engine, so that label was false provenance (found by the SNEED agent; the tests asserted the same constant and passed). Now: `describe` reports the runner's default engine from `describe.engines`; `collect` takes the engine from `results.json`, requires `manifest.json` to name the same engine and version, and, when the request named an engine, requires the result to come from it (SCRAM is named "SCRAM"; the built-in engine is anything else the runner calls itself); anything else is `E_OUTPUT_INCOMPLETE`. Tests assert what the runner itself reports, run each available engine, and pin `engine: "scram"` for the two slow-model tests (cancel, bound request id), which use a 17-pair tree because the built-in engine and the faster SCRAM checks finish smaller trees before a cancel can arrive.
