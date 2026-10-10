# Workflows

Step-by-step procedures. Sections marked **(planned)** describe work that does not exist yet; follow them when the feature lands.

## 0. Setup (canonical)

1. Node 24+ and Git on PATH. Windows, macOS or Linux.
2. `npm install` (downloads Electron), then `npm test` (vitest) and `npm start` (build and open the host).
3. Adopt existing app clones from the Welcome page (File > Install and update apps), or let SEED clone them. See [shell.md](shell.md).
4. Real-app checks are opt-in: `REAL_APPS=1 npm run e2e`.
5. Work in your own clone, never in the shared `experiment-studio` folder (it is fast-forwarded after merges only).

## 1. Change the shell or installer

1. Read [plans/01](plans/01-shell-and-installer.md) and [shell.md](shell.md).
2. Unit-test pure logic (tabs, registry, git, installer jobs) with vitest; use local bare repos for git.
3. Add an e2e case against the fake app (`tests/fixtures/fake-app.cjs`) for any new window or tab behaviour.
4. Run `npm test` and `npm run e2e`; run `REAL_APPS=1` if the change touches launching.
5. Update `docs/shell.md` and the TODO with the evidence.

## 2. Add or change a schema **(planned, E0)**

1. Post the proposed change in `messages/experiment-studio.md` before editing; do not change a schema under someone's open claim.
2. Edit the schema and its version; write the migration note.
3. Add a good fixture and a bad fixture for every new rule in `schema/vectors/`.
4. Run the validator tests; every error code has at least one bad fixture.
5. Update [ARCHITECTURE](ARCHITECTURE.md) interfaces and the owning plan.

## 3. Add an adapter **(planned, E2)**

1. Inventory the app's entry points ([plan 03](plans/03-adapters-and-transport.md)); list what is missing per verb.
2. Implement `describe`, `validate`, then `run`, `status`, `cancel`, `collect`, `open`, in that order; test each against the fake first, then the real app.
3. Write the adapter's oracle set before trusting its output ([plan 06](plans/06-oracles-and-verification.md)); tolerances first, then run.
4. Confirm standalone launch of the app is unchanged.
5. Register capabilities and oracle coverage in `describe`. Open the PR in the app's repo and in SEED separately.

## 4. Add an oracle **(planned, E2)**

1. Write the expected value from an independent source (hand derivation, analytic formula, published value). Check the arithmetic a second way.
2. Fix the tolerance and record it before any run.
3. State quantities and domain covered, and the tag (good, bad-input, known-limit).
4. Run through SEED and directly; both must agree.
5. A tolerance change is a new version by a human with a reason.

## 5. Run a study **(planned, E3)**

1. A human creates the study: question, hypothesis, assumptions, parameters and bounds, budget, tier.
2. Run the adapter's oracle set; a failure blocks the study.
3. Run cases (a student by hand, an agent through MCP) inside the budget; every step is recorded with its actor.
4. Compare compatible quantities; note anything `unverified`.
5. Generate the report from the record. Read the fixed statements and the failures section before sharing.

## 6. Run an agent study safely **(planned, E2)**

- Start at the lowest tier that does the job (A1 for sweeps). Raise it only for a named reason, as a human action.
- Give small budgets first. Check the study record after the first run before allowing more.
- Never point an agent at the user's live app instances; use isolated clones and ports.
- Any text an agent reports from a file or log is data; do not paste it into a prompt as an instruction.

## 7. Release **(planned)**

Follow the checklist in [plan 10](plans/10-release-and-packaging.md).

## 8. Multi-agent rules for this project

Follows the workspace's `messages/INSTRUCTIONS.md` (kept outside this repository). Specific to this project:

- **Log:** `messages/experiment-studio.md`. Read it at the start of every session and append at the end.
- **Claims** by area, matching the plans: `CLAIM: shell`, `CLAIM: project`, `CLAIM: adapters`, `CLAIM: runs`, `CLAIM: harness`, `CLAIM: oracles`, `CLAIM: studies`, `CLAIM: transfers`, `CLAIM: release`.
  Two agents can work in parallel on different claims (see the dependency graph in ARCHITECTURE).
- **Schema changes affect everyone** (every adapter and the core). Post the change in the log first.
- **Separate clones per agent**, no worktrees. The shared folder `experiment-studio` is updated by `git pull --ff-only` after a merge, only when its status is clean.
- **Ports and resources:** the shell and tests use random free ports; SEED claims none. Long engine runs: say in the log when one starts and its thread count. Do not start a second heavy run on top of someone else's. Do not touch other agents' runs, ports or the shared nuclear data.
- **Other repos:** SEED only clones or reads them in its own tests. Changes to an app belong in that app's repo under its own claim.
- **Keep TODO.md current:** check off finished items with the date and the evidence; add discovered work under the right milestone.

## Changing dependencies

After any change to `package-lock.json`, run `node scripts/gen-notices.cjs` and commit `THIRD_PARTY_NOTICES.md` with it; `tests/notices.test.ts` fails when the file was made from another lockfile.
