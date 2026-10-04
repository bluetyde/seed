# SEED: System for Engineering and Experimental Design

Planning skeleton created 2026-09-30. As of 2026-10-01 there is a runnable **host shell** (Electron) that opens the suite apps as tabs: see [docs/shell.md](docs/shell.md). Project storage, adapters and guarded headless runs now exist in the core; the shell does not yet expose a complete experiment workflow. See [guarded CLI setup](docs/host-cli.md).

Start with [PLAN.md](PLAN.md), then [TODO.md](TODO.md). Suite decisions and cross-app contracts live in [the integration draft](../plans/nuclear-suite-integration.md).

Folders: `docs/` for design notes; `examples/` for future teaching cases; `tests/` for acceptance cases. The Electron shell and dependency manifests are implemented; broader project coordination remains planned.

Development coordination: [project log](../messages/experiment-studio.md) and [workspace rules](../messages/INSTRUCTIONS.md). Do not interpret an unchecked task or proposed contract as implemented support.

On Windows, double-click `Start SEED.cmd` with Node 24+ (including npm) on PATH. If dependencies are missing, it asks before running `npm ci --include=dev`; first setup may need Internet access. Later launches reuse installed dependencies. Errors stay visible until a key is pressed. After dependency changes in an update, run `npm ci --include=dev` again. On other platforms, run that setup command, then `npm start`. Defaults select native launch commands on macOS/Linux and WSL for OpenMC on Windows. Adopt existing app clones from the Welcome page; see [shell setup](docs/shell.md).
