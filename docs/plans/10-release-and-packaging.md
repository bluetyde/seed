# Plan 10: Release and packaging

How SEED becomes something a student or another developer can install. Not before E2 is verified.

## Distribution model (to decide)

| Option | For | Against |
|---|---|---|
| Source clone plus `npm start` (today) | Zero packaging work; matches the installer's clone model | Needs Node 24 and Git; not student-friendly |
| Unsigned installer per OS | Easy for students | OS warnings; signing costs; update story |
| Signed installers with auto-update | Best experience | Cost, certificates, release engineering |
| Bundled with the turnkey OpenMC Studio package | One download for the neutronics side | Size (the Windows package is about 20 GiB); coupling of release cycles |

SEED itself is small. Apps publish versioned runtime recipes, compatibility metadata and native checks; SEED owns installation, activation, cache, upgrade and lifecycle. Engine/data artifacts may ship separately and be reused offline. See [plan 11](11-runtime-and-shared-acceptance.md); the turnkey OpenMC package is a candidate artifact, not a second mandatory installer.

## Licensing and provenance

- MIT for SEED. Do not bundle an external engine (SCRAM, OFFBEAT/OpenFOAM, OpenMC data) before its license and redistribution terms are checked and recorded; public binary redistribution needs corresponding-source obligations reviewed.
- `THIRD_PARTY_NOTICES.md` lists every bundled dependency with license, version and source.
- Fonts and assets: bundled with their licenses; no remote font or script loading from the apps' views.
- Nuclear data stays read-only and shared; never copied into a project.

## Pre-release checklist

1. Fresh-machine install on Windows, macOS and Linux with the documented prerequisites only.
2. Every default app entry launched for real on each OS.
3. Oracle sets pass for every shipped adapter on the shipped engine versions.
4. Harness acceptance tests 1 to 9 pass; 10 if the transfer ships.
5. Security pass: loopback-only binding, token per launch, path roots enforced, no command taken from data, IPC accepted from the two trusted views only.
6. Docs: install guide, student workflow, agent guide (tiers, MCP tools, limits), adapter authoring guide.
7. Educational-use statement present in the app, the report template and the docs.
8. Changelog; tag; release assets (installers, checksums).
9. Make the repo public only when the user says so.

## Adapter authoring guide (for other app authors)

Describe the verbs, the schemas, the oracle entry format, the fake adapter as a template, and the rules (thin, no change to standalone launch, typed errors, snapshots). A new app joins by shipping an adapter and an oracle set, not by changing SEED's core.

## Open

- Installer technology (electron-builder or similar; survey in TOOLING).
- Code signing and notarization cost and ownership.
- Update channel for SEED itself (the installer today updates the apps, not SEED).
- Telemetry: none by default; any addition needs an explicit decision.

## Incremental acceptance

Managed runtime development and fake-artifact testing can begin before E2; the release gate remains separate. Test the supported platform/app matrix rather than requiring unsupported combinations. Include plan 11 R1-R10, final-version owned-process cleanup, offline run/save/reopen, corrupted/interrupted installation and rollback in the shipped subset's acceptance evidence.
