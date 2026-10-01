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
- [x] Installer/updater (first version, docs/shell.md): clone, adopt, check, fast-forward update, dependency steps, prerequisite checks, per-app card with output and cancel. Still open: install the conda environment and nuclear data for OpenMC Studio; update SEED itself; sign-in help beyond the message; macOS/Linux install paths; offline use of a cached copy; a schedule or notice for available updates.
- [ ] Windows and macOS start commands for every default app entry (the defaults assume this computer's Windows layout).
