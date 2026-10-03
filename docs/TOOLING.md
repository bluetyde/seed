# Tooling and ecosystem survey

What SEED uses, what it may use, and what to look at before claiming a gap. Written 2026-10-03. **Sections 1 and 2 are read from the repo. Sections 3 and 4 are an unchecked candidate list: nothing about an external tool's features, license or activity has been verified, and none of it may be quoted outside the repo until section 5 is run.**

## 1. Our own repos

| Repo | Role | Notes |
|---|---|---|
| `bluetyde/seed` (private) | This project | Folder `experiment-studio` |
| `bluetyde/openmc-studio` (public) | Neutronics app | Runs from source in WSL on Windows; turnkey Windows package exists (draft PR) |
| `bluetyde/nodal-studio` (private) | Thermal-hydraulics app | Folder `pipe-studio`; has run, results and runtime-protocol docs |
| `bluetyde/raft` (private) | Virtual Reactor | Library format, scenario/session, runtime authority |
| PRA & Reliability Studio, Fuel Performance Studio | Skeleton plans only | No code, no repos yet |
| `bluetyde/virtual-reactor` plan and validation docs | Pattern for this plan's structure | Contracts, oracles, validation levels |

## 2. Installed toolchain (from `package.json` and the shell docs)

| Tool | Version in the repo | Use |
|---|---|---|
| Node | 24+ required | Host and tests |
| Electron | ^44.5.1 | Host shell |
| TypeScript | ^7.0.2 | All source |
| vitest | ^5.0.3 | Unit tests |
| Playwright | ^1.63.0 | Electron e2e |
| Git | on PATH | Installer, update checks |

Refresh with `npm outdated` and `npm ls --depth=0`; record the date here when checked.

## 3. Facts to establish before the E0 transport decision

- The real entry point of each app that an adapter would call (CLI, server endpoint, file drop) and whether it works headless.
- Which apps already emit a run manifest and results index, and what hashing rules they use (NODAL has documents for these; read them, do not assume).
- What an MCP server needs from the host (transport, auth, tool schema limits) in the current MCP version.
- Whether JSON Schema validation in TypeScript has an acceptable dependency or the stdlib-style validator pattern from Virtual Reactor is cheaper.

## 4. External tools to survey (unchecked candidates)

| Area | Candidates | Question to answer |
|---|---|---|
| Workflow and provenance | AiiDA, Snakemake, Nextflow, signac | What would SEED reuse (record formats, provenance model) rather than rebuild? |
| Parameter studies | DAKOTA, SALib, OpenTURNS | License, how an input-file based driver would call our adapters |
| MCP | The MCP SDK for TypeScript | Version, transport options, auth model |
| Schema validation | Ajv and alternatives | Draft supported, size, error codes |
| Packaging | electron-builder and alternatives | Signing, auto-update, per-OS support |
| Reports | HTML and PDF generation libraries | Licensing, offline use, accessibility |
| Plotting | A small chart library for the host views | Offline, license, size |
| Fault tree engine | SCRAM (pinned in the PRA plan, unverified until PRA P0) | Version, license, redistribution |
| Fuel code | OFFBEAT with OpenFOAM (pinned in the Fuel plan, unverified until F0) | Version pair, license, install footprint |
| Agent evals | Existing benchmark and evaluation harnesses for agents | What to borrow for the oracle-run and replay design |

## 5. How to refresh this survey

For each candidate: record the date; check the project's license file, last release date and open-issue health with `gh` (authenticated) or its release page; read the part of its documentation that bears on the question; write a two-line verdict (reuse, learn from, ignore) with the evidence.
When a candidate changes a plan, edit the plan and point back here. Do not copy a claim into PLAN.md until it has a date and a source in this file.

## 6. Upgrade, reuse and build candidates

Filled in after section 5. Until then the only decision made is the one already in the repo: build the contracts, the oracle runner and the study record here; reuse nothing external beyond the Electron, TypeScript and test toolchain above.
