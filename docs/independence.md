# What is not independently verified

SEED is made with the assistance of AI coding agents and checked largely by the same kind of agents and by its own tests. This page says plainly where that leaves the evidence, so a reader can weigh it. For each point: what is not independent, the evidence, and what would close it. Counts are as of 2026-10-10 (SEED main).

## 1. The same process wrote the code, the tests and most of the reviews

- **Evidence:** 231 of 292 commits carry the co-author trailer of the Claude agent that did most of the work; the others come from delegated agents (agy, Codex) or are untagged. The review records of the milestones are written by the same agent, from the same understanding of the design.
- **What it means:** a mistaken idea about how something should work can be written into the code and into the test that checks it. A passing test shows the code does what its author expected.
- **What would close it:** a review by people who did not write it, and tests written from the requirement by someone who has not read the code.

## 2. A second-model review is not independent of the suite's assumptions

- **Evidence:** Codex reviewed the first concurrency work and its seven findings were fixed; it did not find a lost update in the request log, which a load stress run found the next day. In the later review of everything since (six batches, 2026-10-08 to 10), about thirty problems were confirmed and fixed, including several in code an earlier review had passed (the project lock, process ownership, the study record). A review finds what it looks for, in the code it is shown.
- **What it means:** a review catches some mistakes, in some places. A clean review is not a proof.
- **What would close it:** stress and fault-injection runs (these found what review missed), and an outside reviewer.

## 3. The oracles are mostly written by the people who wrote the apps

- **Evidence:** each app owns its oracle set (decision D3). Most expected values are hand-derived, closed-form, or computed with a library the suite also depends on. The first oracles that are independent of everything written here are FEED's four from General Atomic report GA-7882 (published numbers, source kind `published`). The other apps' sets were not re-audited for this page.
- **What it means:** an oracle derived by the author checks consistency, not correctness against the world.
- **What would close it:** published benchmark values pinned in every app's oracle set, and a catalogue per app of each oracle's kind and what it does not prove (FEED has one: `docs/oracles.md` in its repository).

## 4. One platform in practice, and no automatic checks

- **Evidence:** development and the full suite run on Windows 11 with WSL. Individual files have been run on Linux by hand. The macOS launcher and macOS process matching have been checked by hand only; a rerun on the Mac was still to come when this page was written. There is no continuous integration (no `.github` folder), so nothing runs on Linux or macOS on its own. Tests that need an app or the solver skip when it is absent.
- **What would close it:** continuous integration on Linux and macOS, with the real-app tests in a container that has the apps and the solver.

## 5. Manual sign-off is narrow

- **Evidence:** the person responsible signed the E0 and E2 milestones after the agent explained each item. The sign-off rests on the agent's own review record. The desktop acceptance tests answer the native confirmation dialog themselves and verify routing and refusal behaviour, not a real person's scientific acceptance of a conclusion (`docs/conclusion-review.md`).
- **What would close it:** a person other than the author reading the review record and trying the workflows.

## 6. Some tests fail under load

- **Evidence:** full-suite runs on a busy machine have shown 30-second timeouts and the failures that follow them (installer, git, study record, sweeps and others); the same files pass alone. On 2026-10-10 two full runs on a loaded machine ended with 11 and then 2 failing files that passed on rerun, and a race in a test fixture that made one Linux test fail now and then (between one run in eight and one in twenty) was found and fixed. A merge is sometimes justified by the union of runs (every file has passed on that commit) and not by one clean full run; the release notes say so when that happens.
- **What would close it:** an idle build machine or CI, and a retry-free green run as the merge rule.

## 7. Mutation testing covers new code, not all of it

- **Evidence:** mutation runs exist for the cache key, comparison, sweeps, components, the lock, transfers and `query_model`. The fixes from the 2026-10-08 review each have a test that fails without the fix, but were not put through mutation runs.
- **What would close it:** mutation runs over the modules that decide admission (policy, the gate, the journal, the study record).

## 8. No stated integrity level for SEED itself

- **Evidence:** the README says SEED is experimental and educational and not validated for safety, licensing or operation, and every generated report carries an educational-use statement. There is no software integrity level and no intended-use statement beyond that.
- **What it means:** SEED protects against an agent that makes mistakes through its command line and MCP server. It does not protect against an agent with shell access to the same account (decision D4).
- **What would close it:** an intended-use statement and a threat model reviewed by someone who did not write them.

## Reading this page

None of this says the results are wrong. It says what has been checked, by whom, and what has not. A report is only as strong as the oracle behind each quantity, and the report says which quantities are verified and which are not.
