# SEED: TODO

Planning only. Milestones refer to [PLAN.md](PLAN.md). Close tasks with evidence, not a plan edit.

- [ ] E0: inventory app entry points and native model/run contracts; settle transport with one fake adapter.
- [ ] E0: write versioned project/material envelope and adapter schemas with migration policy and fixtures.
- [x] E1 (partial): configurable launcher shell: app registry, start/stop/attach, tabs, error pages (docs/shell.md). Still open: project attach/open/reopen, Windows/WSL path mapping beyond the OpenMC default, macOS.
- [ ] E1: import existing results and display their actual native status and provenance.
- [ ] E2: connect one real engine using immutable snapshots and owned job lifecycle.
- [ ] E2: verify cancellation, crash, edit conflict, relocation and stale-result handling.
- [ ] E3: implement typed sweeps, budgets, comparison plots and reproducible reports.
- [ ] E4: implement one reviewed offline transfer with physical mapping checks.
- [ ] E5: add uncertainty and feedback only after their assumptions and acceptance gates are specified.
- [ ] Installer/updater (the quick way to get the whole suite): from SEED, install and update the other repos in one step. Per app: clone from GitHub to a chosen folder if missing, fast-forward pull when clean (never touch a dirty tree or a branch with local commits), install dependencies (npm ci, Python/conda env for OpenMC), show current vs latest commit, and write the resulting paths into the app list so no path is hardcoded. Needs: a catalog of repos (OpenMC Studio, NODAL Studio, Virtual Reactor, later PRA/Fuel), per-app prerequisites check (Node, WSL, conda env, nuclear data) with plain-language fixes, progress and cancel, and offline behavior. Private repos need the user's own GitHub sign-in; SEED must not store credentials.
- [ ] Windows and macOS start commands for every default app entry (the defaults assume this computer's Windows layout).
