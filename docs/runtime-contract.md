# Runtime and component contract (plan 11, W2)

Status: **design with a pure implementation and fake fixtures**, 2026-10-07; **the staged installer (W4) was built on 2026-10-18** against local fake artifacts, see [The staged install](#the-staged-install-w4-2026-10-18) below. The contract decides what is recorded, what is refused and which states a transaction passes through; process handling is W3. [Plan 11](plans/11-runtime-and-shared-acceptance.md) has the requirements; [runtime-inventory.md](runtime-inventory.md) has what exists today.

Code: `src/core/components.ts` (no file or process access of its own). Schemas: `schema/component-manifest.schema.json`, `install-state.schema.json`, `process-owner.schema.json`. Tests: `tests/components.test.ts`, fixture `tests/fixtures/runtime/fake-manifest.json`. These are separate from the contract v0.1 families signed off for E0; nothing there changed.

## What an app publishes: the component manifest

`seed.component-manifest/0.1`, written by the app's own session in its own repository (the app owns its recipe and its capability claims; SEED owns installation). One manifest per app and recipe revision, listing **components**:

| Field | Meaning |
|---|---|
| `kind` | `core` (always installed with the app), `addon` (the user adds or removes it), `library` (a dependency only; never offered as a choice) |
| `platforms` | os, arch and, optionally, how it runs (`native` or `wsl`); a component absent for a platform is simply unavailable there |
| `appVersions` | the app versions it works with (`min`, optional `max`) |
| `dependsOn`, `conflicts` | other components of the same app, with an optional minimum version |
| `capabilities` | what it enables (`cad-import`, `nodal-solve`, ...). The app's own code refuses an operation whose capability is absent, with a precise reason; SEED does not guess |
| `artifacts` | what to fetch: sha256, download size, expanded size, archive type, an `https://` url if it is fetched |
| `dataRefs` | data it needs, by id and digest (nuclear data stays outside projects and read-only) |
| `license` | SPDX id, notices hash, whether a source offer is owed |

**Trust.** A hash identifies content; it does not prove who published it. SEED's shipped `catalog.json` is the trust source: for each app it will pin the manifest's sha256 (and the repo and commit it comes from). A manifest that does not match the pin is refused. A study file, project file or agent request can never supply a manifest, a url or a command (this keeps D4: nothing in a study can install or run software).

Consistency rules checked by `validateManifest`: at least one core; no duplicate component or artifact ids; every dependency and conflict names a listed component; no cycle (the loop is named); a dependency's listed version satisfies the `min` asked of it; a core never depends on an add-on; app version range not inverted; an archive does not expand to less than it downloads.

## What SEED records: the install state

`seed.install-state/0.1`, one file in SEED's own store, outside every project. One record per installed or adopted component: app, component, version, `origin` (`managed` = SEED installed it and may remove it; `adopted` = it was already there and SEED never deletes it), location, the manifest hash it came from, artifact hashes, whether the **user chose it** (as opposed to being installed as a dependency), when, and the `previous` version kept for rollback. At most one **transaction** is recorded at a time (below).

Layout (confirmed by W4, one folder per artifact below the version): `<install root>/<app>/<component>/<version>/<artifact id>/` for installed versions; `<install root>/.seed/components.json` for this record; `.seed/active/<app>/<component>` a one-line pointer naming the active version, changed only by writing a temp file and renaming it (the one atomic step of an install); `.seed/staging/<transaction id>/` for work in progress; `.seed/cache/<sha256>` for verified artifacts (the offline cache).

## Choosing what to install: `resolveSelection`

Input: manifest, what is installed, the add-ons the user chose, platform, app version, optionally the offline cache and free disk. Output: an ordered list (dependencies first) of `install`, `update` or `keep`, and the cost. Rules:

- Core components are always included. An add-on appears only when chosen; its libraries come with it and are marked "not chosen by the user". A library cannot be chosen. A request never installs anything on its own.
- Every included component must fit the platform (and the way it runs) and the app version; the refusal names the component.
- A conflict with something selected or already installed is refused.
- Installed at the same or a newer version: `keep`, cost zero. Older and **managed**: `update`. **Adopted**: kept if good enough; if a newer one is needed, refused with `E_ADOPTED_PROTECTED` (SEED will not replace what it did not install).
- Cost: download bytes (artifacts already in the cache cost none) and expanded bytes. Offline, anything not cached is refused with the missing artifact named. Too little free space is refused before staging.

## Removing an add-on: `planRemoval`

Refused while another installed component needs it (`E_COMPONENT_REQUIRED_BY`, naming it) or while a running launch or job uses it or a library that would go with it (`E_COMPONENT_IN_USE`). The core is never removed on its own, a library never directly. Libraries SEED installed only as dependencies go with it unless something still needs them; the plan lists what is **kept and why**. An adopted component is **unregistered, never deleted**. Models, results, custom material sets and original input files are never in a component's folder, so removal cannot touch them (acceptance R-add-on).

## Transactions

An install or update: `queued -> preflight -> staging -> verifying -> activating -> ready`; a removal: `queued -> preflight -> removing -> removed`. Any step before `activating` may end `cancelled` or `failed`; `staging`, `verifying`, `activating` and `removing` may end `interrupted` (the host died). **`activating` cannot be cancelled**: it is the single atomic switch of the active pointer. Terminal states have no way out; a retry is a new transaction. `canTransition` is the table, tested over every pair of states.

At startup `recoverTransaction` decides, from the record **and what is on disk**:

| Found | Result |
|---|---|
| terminal state | nothing |
| owner still alive | wait |
| queued or preflight, owner gone | interrupted, nothing to clean |
| staging or verifying, owner gone | interrupted; discard the staging folder; the active version is untouched |
| activating, owner gone, **new version already the active one** | ready (the file system decides, not the record) |
| activating, owner gone, old version still active | interrupted; roll back (discard staging) |
| removing, owner gone, files gone | removed |
| removing, owner gone, files present | interrupted; keep installed |

Serialization: one transaction per managed runtime at a time (`E_INSTALL_BUSY` when another is in flight, enforced in W4 with the claim machinery of the request log, which is proven under load). An update or removal is deferred while any process-owner record names the component.

## The staged install (W4, 2026-10-18)

Code: `src/core/componentInstaller.ts` (`installSelection`, `rollbackComponent`, `removeComponent`, `recoverInstalls`, `listInstalled`), `src/core/installStore.ts` (layout, state file, pointer, cache), `src/core/archive.ts` (safe extraction). Tests: `tests/component-installer.test.ts`, `component-installer-recovery.test.ts`, `component-installer-processes.test.ts` (real processes, needs `npm run build`), `archive.test.ts`; fixtures in `tests/helpers/installFixture.ts` and `archives.ts`.

**One install is one transaction per component**, run under the writer lock of the install root (`<root>/.seed/lock`, the lock the project store uses and the load tests prove), so a second installer on the same root is told `E_INSTALL_BUSY` and a lock left by a dead process is taken over. `installSelection` asks `resolveSelection` for the plan and then runs the steps in order; the first failure stops the run and lists what was completed before it.

| Step | What happens | Failure leaves |
|---|---|---|
| preflight | platform and app version, a job using the component (updates), the app's prerequisite check (`E_PREREQUISITE`), free disk against the expanded size (`E_DISK_SPACE`) | nothing created |
| staging | each artifact goes to the cache `.seed/cache/<sha256>` (size and hash checked, `E_HASH_MISMATCH`; offline, only the cache: `E_OFFLINE_MISSING`; a cached copy whose hash no longer matches is deleted, never used), then is unpacked into `.seed/staging/<tx>/version/<artifact id>/` by the safe extractor with the manifest's `expandedBytes` as the limit | the cache keeps verified artifacts; staging is deleted |
| verifying | the pending record is written to the staging folder (`installed.json`), then the app's health check runs on the staged files (`E_HEALTH_CHECK`: the version is never switched on) | the old version stays active |
| activating | the staged folder is moved to `<root>/<app>/<component>/<version>`, the pointer file is written to a temporary file and renamed (**the one atomic step**), the install record and the transaction state are saved. A cancel that arrives from here on does not stop it | any failure puts everything back: old pointer, old record, no new folder |

The version being replaced is recorded as `previous` (with the manifest and artifact pins it was installed under, so a rollback restores a complete record); the version before it is deleted. `rollbackComponent` switches back (and a second rollback goes forward again). An update is deferred while a launch or job uses the component (`E_COMPONENT_IN_USE`); an adopted component is never replaced.

**Recovery** (`recoverInstalls`, and automatically at the start of every install, rollback and removal): the recorded owner of an unfinished transaction counts as running only if its pid **and start identity** are still those of a process (the process-owner rule); if it is running the new operation waits (`E_INSTALL_BUSY`). Otherwise `recoverTransaction` decides from the record and the pointer: before the pointer was flipped the transaction becomes `interrupted` and the old version stays; after it, the staged `installed.json` completes the record and the new version is the active one (the file system decides, not the record). Orphan version folders, staging and trash folders are deleted.

**Removal** moves the component folder to `.seed/trash/<tx>` in one rename, deletes the record and the pointer, then deletes the trash; a host that dies in between is settled by the recovery rows above. An adopted component is unregistered and its files stay. Models, results, custom materials and original files are never below a component's folder, so removal cannot touch them (the tests keep a project file in the install root and check it).

**Not built yet:** a source that really downloads (https only, size cap, time limit, no redirects to other schemes), the gate operations `install_component` (rule `grant`) and `remove_component` (rule `human`) with the grant file and the admin verb that issues it, a shell or CLI verb that calls the installer, the catalog's pin of the manifest hash, authenticated health after the switch, runs on real WSL and macOS. Safe extraction supports tar.gz (ustar, GNU long names, pax `path` and `size`) and zip (stored and deflate, no zip64 and no encryption: refused by name).

## Process ownership

`seed.process-owner/0.1`: one record per app launch or job, written when it starts (exclusive create, then rename) and removed or marked `stopped` when it ends: launch id, kind, the runtime component and version it uses, who supervises it (`seed` or `standalone`: exactly one), the host process, the worker process (native or in a named WSL distro), the endpoint (loopback only), a generation token and a state.

A process is named by **pid and start identity** (Windows creation time; Linux boot id and the start time from `/proc/<pid>/stat`). `mayActOn(recorded, current)` is true only when both match; a reused pid, a vanished process or a record with no identity authorizes **nothing**. This is what keeps a stale record from killing an unrelated process (acceptance R5). Health checks must identify the expected app and generation; an HTTP 200 alone does not establish ownership.

**What is built (W3, 2026-10-12).** The host writes one record per server it starts (`ProcessManager`, store folder `process-owners` in its user-data folder), marks it running when the server answers and removes it when the server stops. At startup `recoverOwners` (`src/core/ownerRecovery.ts`) settles every record a previous host left: a worker is stopped only when the process under the recorded pid has the recorded start identity (`stopped`: `terminated`); a pid now held by a different process makes the record stale (`stale-identity`: nothing stopped); a host that is still running keeps its records (`host-alive`); a server the host only attached to has no record at all; a worker that survives the stop keeps its record, marked `orphaned`. **Platform note:** on Windows Node ties every child that is not detached to its parent with a job object, so a plain worker dies with a force-killed host; the workers a dead host can leave behind are detached ones (the host spawns them detached on Linux and macOS) and the Linux process behind `wsl.exe`. **Not yet:** authenticated health, WSL-side leases, and a real-distro check of the `wsl.exe` path.

## Errors

Component errors are local to this contract (the E0 error-code list is untouched): `E_SCHEMA_INVALID`, `E_COMPONENT_UNKNOWN`, `E_COMPONENT_CYCLE`, `E_COMPONENT_DEPENDENCY`, `E_COMPONENT_NOT_SELECTABLE`, `E_COMPONENT_PLATFORM`, `E_COMPONENT_APP_VERSION`, `E_COMPONENT_CONFLICT`, `E_COMPONENT_REQUIRED_BY`, `E_COMPONENT_IN_USE`, `E_COMPONENT_CORE`, `E_ADOPTED_PROTECTED`, `E_OFFLINE_MISSING`, `E_DISK_SPACE`. Each carries the component it concerns and a message that says what to do. W4 added the I/O errors: `E_ARCHIVE_UNSAFE`, `E_ARCHIVE_CORRUPT`, `E_ARCHIVE_UNSUPPORTED`, `E_ARCHIVE_TOO_LARGE`, `E_HASH_MISMATCH`, `E_ARTIFACT_MISSING`, `E_PREREQUISITE`, `E_INSTALL_BUSY`, `E_INSTALL_FAILED`, `E_INSTALL_CANCELLED`, `E_HEALTH_CHECK`.

## Decisions recorded (transport and ownership)

1. **Manifest is a JSON file in the app's repo** (`seed.components.json`), pinned by hash in SEED's catalog. Not fetched from a URL a project names.
2. **SEED owns the store; the app owns the recipe.** An app may keep a standalone setup that follows the same manifest; two installers must not manage the same folder.
3. **State is one JSON file with one transaction slot**, replaced atomically; no database.
4. **Cache by content hash**; offline install uses only cache entries whose hash matches the manifest.
5. **Adopted is permanent protection**, not a flag the app can clear.

## What this gives the first add-ons

- **CAD import** (OpenMC Studio): a `core` (editor, OpenMC run), an `addon` `cad` with the GEOUNED/FreeCAD stack and the capability `cad-import`, a `library` for anything shared. Studio's CAD operations refuse with a named missing component when the capability is absent. The OpenMC session writes its manifest; the bundled-artifact split is its work (W6), and the current bundle does not yet show core-only works.
- **Nodal package** (OpenMC session's idea): the same shape, capabilities `group-constants` and `nodal-solve`, openndm as an artifact pinned by commit and hash. It needs nothing from SEED beyond this contract.

## Acceptance coverage

| Check (plan 11) | Covered here | Left for |
|---|---|---|
| R1 prerequisites, spaces in path | the cost and platform/app-version refusals | proven by W4 on fakes (prerequisite hook, a root with spaces); a real prerequisite check is the app's |
| R2 corrupt or unsafe archive, interrupted install | recovery table, no cancel while activating | proven by W4 (hashing, safe extraction, a crash at every step, a killed process) |
| R3 upgrade with an active job; failed health check | `E_COMPONENT_IN_USE`, rollback rows | proven by W4 on fakes |
| R4 forced host termination | ownership record and identity rule | W3 (job object, WSL cleanup) |
| R5 attach, sibling survives, stale pid | `mayActOn` | W3 |
| R6 offline | `E_OFFLINE_MISSING`, cache cost | proven by W4 (offline from a cache, a missing artifact named, a damaged cache entry refused) |
| Add-ons: core-only, later add, remove, shared library kept, incompatible versions | `resolveSelection`, `planRemoval` on a fake manifest | W6 on the real OpenMC recipe |

## Cross-app packages (manifest v0.2)

A package of one app can need a record that a package of another app makes, and a library component can fulfil a catalog prerequisite. Both are additive fields of **manifest v0.2** (`produces`, `consumes`, `satisfies`); a v0.1 manifest keeps its exact meaning. The design, the record-kinds registry and the cross-app resolver are in [packages-cross-app.md](packages-cross-app.md).

## Decisions of the user (2026-10-07)

1. **Install root.** Add-ons go in the same install root as the apps (today the `apps` folder inside the SEED folder, git-ignored; before 2026-10-11 it was `~/SEED/apps`, which is still searched for existing clones), as `<root>/<app>/<component>/<version>/`. One folder to back up or delete; removing an app removes its managed add-ons.
2. **Agents may request an install; they never install on their own.** A first-time setup, including one run by an agent in a cloud session, has to be able to ask for an add-on, so "human only" is dropped. What stays:
   - **What can be installed is fixed by the catalog**, not by the agent: only components in a manifest whose hash SEED's shipped catalog pins. An agent supplies a component id, never a url, a command or a manifest.
   - **A human grant is still needed**, as for `accept_material_set` and `enable_transfer`: a new gate operation `install_component` with rule `grant`. The grant names the app and the components, an expiry and a ceiling (download and disk bytes). A person can issue one standing grant ahead of an unattended or cloud setup ("fakeapp core and cad, 8 GB, 24 hours"). Without a grant the request is refused and says what to grant.
   - The grant lives in the host's state folder, written by the admin CLI. Neither a project, a study nor an agent-facing tool can write it (the same rule as the other grants).
   - **Removal stays human**: `remove_component` with rule `human` (my default; it can be relaxed by the same reasoning).
   - **The attack surface that remains** (the user asked what it is): (a) cost, a large download or disk use, bounded by the ceiling in the grant; (b) an injected instruction steering an agent to request a legitimate but unwanted or conflicting component, bounded by the grant naming exact components; (c) the install recipe runs code from the app's own repository, so the six repos and the catalog are the trust base; a compromised catalog or app repo would be dangerous with or without this rule.
   - The two operations are added to `OPERATION_RULES` when W4 wires them; adding them now would be a rule with no code behind it.
3. **Catalog pin.** SEED's shipped catalog is the only trust source for now; a signing scheme comes only if outside publishers appear.
4. **Removing an app.** Removes the components SEED installed, unregisters (never deletes) what it adopted, and never touches project folders, models, results or custom materials.
