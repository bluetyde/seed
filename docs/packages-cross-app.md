# Packages across apps (design)

2026-10-07. The SEED agent's answer to the research session's note (`plans/suite/packages-plan.md`, `packages-review.md`), at the user's request. It extends [runtime-contract.md](runtime-contract.md) (the component contract, W2) and records which of the research session's proposals are accepted. **Built:** the schema, the registry, the resolver and their tests. **Not built:** the installer (W3, W4, W6); nothing here can install anything yet.

Code: `schema/component-manifest.schema.json` (v0.1 and v0.2), `schema/record-kinds.schema.json`, `record-kinds.json`, `src/core/components.ts` (v0.2 checks, registry validator), `src/core/packages.ts` (suite validation, `resolveChain`, `componentsSatisfying`). Tests: `tests/packages.test.ts` (52), `tests/components.test.ts` (89).

## Ground rules (the user's, 2026-10-07)

1. No app requires SEED; apps run standalone. 2. A layperson with an app will have SEED, so SEED can explain and install what an app needs, including things that come from another app. 3. A package is optional and non-necessary: the base app launches and does its basic job without it; removing it never touches projects, models, results or custom materials. 4. A dependency is written down in machine-readable form and the refusal names it.

## The three kinds of dependency (accepted as proposed)

| Kind | Example | How it is written |
|---|---|---|
| **A. Within an app** | Nodal Core needs Studio core; Reactor Physics needs the chain file | `dependsOn` (unchanged, v0.1) |
| **B. Environment prerequisite** | the `openmc-mcnp` conda environment, nuclear data, the `feed-solver` distro | the catalog's `prerequisites` stay as **checks** with their `fix` text; a `library` component may add `satisfies: ["conda-env"]` (v0.2), and then SEED offers to install it instead of only telling the user how. System-level items (Git, WSL itself, Node) stay checks: installing them is an explicit human setup action ([plan 11](plans/11-runtime-and-shared-acceptance.md)). An environment already there is **adopted**, never replaced |
| **C. Across apps** | RAFT burnup needs a depletion record that Studio's depletion package writes | the consumer lists `consumes: [{record, minVersion, maxVersion?}]`, the producer `produces: [{record, version}]`; the kinds are registered in `record-kinds.json` |

**C is a file contract, not an install-time call and not a runtime link.** It says "this feature needs a record of this kind to exist, so a package that makes one must be installed". How the data later gets from one app to the other stays what it is: the user opens the file, or a transfer recipe moves it ([transfer-recipe.md](transfer-recipe.md)). The two do not mix: transfers are a runtime mechanism with approvals; `consumes` only decides what gets installed.

## The research session's six questions

1. **Does `seed.component-manifest/0.1` have room?** No, and it does not need to change: **0.2 is an additive version.** A 0.1 manifest keeps its exact meaning (the schema refuses `produces`, `consumes` and `satisfies` in it). A 0.2 manifest adds those three optional fields; everything else is as in 0.1. The validator reads both.
2. **Where are record kinds registered so two apps agree on one schema?** In `record-kinds.json` at the root of SEED's repository, shipped with the catalog and trusted the same way (the catalog is the only trust source). An entry: the record id, a **version** (a whole number, bumped when the format breaks), the **owner** app, a **status** (`planned` until the owner has a schema, `defined` once it names its wire schema and pins the schema file's hash), a summary and a `manual` text (how a person with no SEED makes the record by hand). The owner defines the format in its own repository; the SEED agent adds or updates the entry. Today there is **one** entry: `depletion-record/1`, owner `openmc-studio`, wire schema `studio.depletion/0.1`, `planned`. Other kinds (a thermal-hydraulic result from NODAL or RAFT for SNEED; a coolant result for FEED) are registered when their producer has a format; I did not invent them.
3. **Cycle refusal across apps.** Two checks. At suite validation, a cycle that cannot be avoided (each record has exactly one possible producer, and those producers need each other) is refused with the loop named, for example `a/a-add -> b/b-add -> a/a-add`. At plan time, the chain actually chosen is checked as a whole, so a choice among several producers that closes a loop is refused naming it, while another choice is fine.
4. **How a user with no SEED gets the same message.** The app's own feature refuses, in its own words, with text built from the registry entry: the record kind, the app and package that make it, and the `manual` steps. The app never calls SEED. With SEED, the same message can link to "Add" with the chain already selected.
5. **The package-ready checklist.** Kept, as eight items, as an informational checklist for builders (listed in the draft notes to the apps, `plans/suite/packages-notes-to-apps-DRAFT.md` in the shared non-git plans folder). SEED's W6 acceptance will test items 3 and 8 (the app without the package, and the refusal) on fakes.
6. **The order.** Kept as the research session wrote it: Studio's core and CAD manifest first on fake artifacts (needs W4/W6), then CAD end to end, then the cross-app chain test with fakes. The resolver for kind C does not wait for that: it is already built and tested on five fake apps.

## How a chain is planned (`resolveChain`)

Input: every app's manifest, the registry, what is installed, the add-ons the user chose (in any app), the platform and each app's version. For the chosen add-ons, in each app, the existing within-app plan ([runtime-contract.md](runtime-contract.md)) gives the add-on, its dependencies and the app's core. Then for each component in the plan that `consumes` a record:

- a producer **already installed** (any app): satisfied, cost nothing (`installed`);
- a producer the user **also chose**: satisfied (`chosen`);
- a producer **already in the plan** because the chain brought it in for another consumer: satisfied (`added`);
- exactly one possible producer (usable on this platform and app version): **added**, with its own app's core and dependencies (`added`);
- several possible producers: **never guessed**: the refusal names them and the user passes `producerChoice` (`E_RECORD_AMBIGUOUS`); a choice that is not a usable producer is refused the same way;
- none: `E_RECORD_NO_PRODUCER`, naming the record and giving the registry's `manual` text.

This repeats until nothing more is added. The result: the steps in a safe order (every component after what it depends on and after the producer it consumes), the chain (each consumer, the record, the producer and how it was settled), the **total** download and disk cost over all apps (disk space and an offline cache are checked for the whole chain), and the **grant scope**: the list of every component that would be installed or updated, with its app. **One human grant names that whole list**, with a byte ceiling that covers the whole chain ([runtime-contract.md](runtime-contract.md), decision 2); the `install_component` gate operation lands with W4. Only what the user chose has `selectedByUser`; producers, libraries and cores brought in by the chain do not, so removing the consumer later removes them if nothing else needs them.

Rules the manifest checks enforce: **only an add-on may consume a record** (a core or library that needed another app's record would make the base app depend on it); a library makes no records; `satisfies` is for libraries only; a record is consumed or produced once per component; a maximum version is not below the minimum; a record named must be in the registry and its version must exist there.

## The chains named by the research session

| Chain | Kind | State |
|---|---|---|
| Nodal Core, Radiation Protection, TRISO, Fusion, MCNP translation, CAD (all Studio packages) need Studio's core | A | expressible now |
| P&ID, deck writer need NODAL's core | A | expressible now |
| RAFT AI operator needs `jev-server` and the model folder | A (+ B for the Python environment, a library) | expressible now |
| RAFT library builder, Studio needing the `openmc-mcnp` environment and nuclear data | B | `satisfies` exists; the real library components wait for W6 |
| **RAFT burnup**, **FEED burnup** need a depletion record | C | built and tested on fakes; registry entry `depletion-record/1` is `planned` |
| SNEED T-H success criterion needs a NODAL or RAFT result | C, two possible producers | resolver asks the user to choose; the record kind is not registered yet |
| FEED heating (from OpenMC) and coolant (from NODAL) | runtime transfers | not installs; unchanged |

## What is not decided, and whose it is

- **Which items become packages** in each app: the apps' sessions and the user (positions recorded by the research session: RAFT's AI operator yes; SNEED's SCRAM to investigate; FEED's solver to investigate; NODAL's deck writer a definite candidate; Studio's MCNP translation a candidate). The notes to the apps say "candidate, your call".
- **Granularity** of Studio's "Reactor Physics" package (one, or sweeps and checks apart from depletion with its chain file): Studio's proposal.
- **Where the Reactor Physics code lives** (the unmerged agy modules): the user's.
- **Licences and platforms** per package: read before each manifest is written; not recorded here.
- **The order of W4 and W6**: unchanged.

## Limits

- A pure resolver on fake manifests. No app has a `seed.components.json`; the installer, the grant operation and the Add-ons view do not exist.
- The registry has one `planned` entry. A `planned` kind means the owner has not frozen the format; a consumer can declare it, but nothing should rely on the bytes until it is `defined` with a pinned schema hash.
- Candidate producers come only from the manifests SEED is given (the catalog pins them); an unlisted app cannot offer a record.
- The version of a record is a whole number the registry assigns; how it maps to the wire schema's own version (`studio.depletion/0.1`) is the registry entry's `wireSchema` field and the owner's job to keep true.

Mutations of the new code: 36 (`scripts/mutate-packages.cjs`), all caught; two first survived and got tests (a consumer's maximum version against the registry; a kept component in a plan staying out of the grant).

## Rules added by the 2026-10-08 review (batch 3)

- **Installed means pinned.** A component at the catalog's version is "kept" only if its recorded artifact hashes (`artifactSha256`) are the ones the catalog pins now; otherwise it is planned as an update of the same version. A managed component with no recorded pins counts as not matching.
- **An installed producer must be new enough.** A producer installed at a version below the manifest's does not stand for the record being asked for: its update is planned and goes into the grant.
- **Conflicts count from both sides**, for what is selected and what stays installed.
- **A platform that does not say how it runs (native or WSL) does not satisfy a component that names a mode.**
- **Removal** touches only what the target brought in (what it depends on and what makes the records it consumes, transitively), never an unrelated component. It is refused while a component of any app (when `manifests` is given) consumes a record the target makes and no other installed component makes it.

**Decided 2026-10-10 (D9):** NODAL's `pid/` P&ID generator is an optional add-on of NODAL; `elkjs` stays inside it and becomes a shared library component only if a second app needs it.
