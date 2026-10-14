# Merging another app's materials into a project (decision: option (a), 2026-10-14)

A project's materials (`seed.project.json`, contract section 5) are shared: a material is `{id, revision, name, sets}`, and each **set** belongs to one app (`openmc.composition` to OpenMC Studio, `thermal.*` to FEED). Only SEED's project store writes the manifest, with its lock, its stale-revision check and the revision rule (contract section 11). An app that produces material entries does **not** write the file (the user's decision, 2026-10-14, option (a); option (b), a second implementation of the lock in the app, was refused). It hands SEED entries, and a human has SEED merge them.

## The verb

```
node dist/cli/admin.js import-materials      # SEED_ADMIN_HOST_CONFIG names a host configuration whose actor is a human
```

Request on stdin, exactly: `{ "ownedSets": ["openmc.composition"], "entries": [ {id, revision, name, sets}, ... ], "dryRun": true | false }` (`dryRun` is optional). **It is a human-only admin verb**: it is not in the CLI an agent is given (`src/cli/seed.ts`), and the host identity must be a human. A material is a physical input; an agent that may run cases does not thereby get to change one. (An agent verb would be an additive change and is the user's call.)

Answer: `{ ok, dryRun, written, changes: [{id, action: "added" | "changed" | "unchanged", from?, to?, nameChanged?, sets, ignoredSets}], revisionBefore, revisionAfter }`. A dry run, or entries that change nothing, write nothing. Every outcome is one line in `materials.jsonl` in the host's state folder (the actor, the owned sets, the SHA-256 of the entries, the changes, the project revision before and after, or the refusal).

## What the merge takes (`src/core/materialMerge.ts`, pure)

- **Only the sets named in `ownedSets`, and the material's name.** Every other set an entry carries is ignored and listed in `ignoredSets`: it is a copy made when the producer exported, and the project may have changed since. Every set of the project that is not named stays exactly as stored, including unknown sets and keys named `__proto__` or `constructor`, which are data and never interpreted.
- **It never deletes** a material, a set or a key. A set missing from an entry is not a removal.
- **The revision is the project's.** A material that changes becomes `stored revision + 1`, and the entry must say exactly that: it was made from the revision the project holds now. Anything else is `E_STALE_REVISION` (field `/entries/<i>/revision`, the message names the revision the project holds) and the producer exports again. A new material is revision 1. An entry that would change nothing leaves the material and its revision alone whatever revision it says, so merging the same export twice is harmless.
- **All or nothing.** One refusal refuses the whole list; the errors name every bad entry.
- Shape: at most 500 entries and 256 KiB per entry; an entry has exactly `id`, `revision`, `name`, `sets`; ids are unique; `ownedSets` are 1 to 8 set names such as `openmc.composition` (a name that could name a prototype is refused); an entry must carry at least one of the owned sets.
- **SEED does not judge the content of the producer's set.** The project schema asks only that a set is an object with a `schema` string; the producer's own validator (Studio's `seed_materials.py`) owns the rest.

The write is `saveProject(dir, manifest, expectedRevision)` with the revision read together with the manifest, waiting up to 5 s for the lock, so a project that changed in between is refused by the store as it always is (`E_STALE_REVISION`, `E_PROJECT_LOCKED`, passed on unchanged).

## How OpenMC Studio uses it

```
python -m openmc_studio.seed_materials import PROJECT/seed.project.json     # what Studio can read, and what it skipped and why
# ... edit in Studio ...
python -m openmc_studio.seed_materials export STUDIO.json --project PROJECT/seed.project.json     # entries on stdout, revisions numbered from the project
# wrap them: { "ownedSets": ["openmc.composition"], "entries": <the entries> }  and give that to import-materials
```

Studio's export prints the entries; the wrapper with `ownedSets` is added by the person (or a small script), because the owned set is a decision of the merge, not something an entry may claim for itself.

## What was checked, and what was not

- `tests/material-merge.test.ts` (36): the planner, every refusal. `tests/material-merge-host.test.ts` (15): the admin verb with a real project store, lock and files. `tests/material-merge-save-refusals.test.ts` (2): the store's own refusals passed on. `tests/material-merge-studio.test.ts` (3): **Studio's own command line against Studio's own fixture project**: import, a density changed and a steel added, export, SEED's merge, import again; FEED's thermal set and the unknown vendor set exactly as before, the skipped materials untouched, the same export twice a no-op, a stale export refused. It needs the Studio checkout (`SEED_OPENMC_REPO`) and a Python, and is skipped without them.
- **FEED's importer on the result (checked by FEED's session, 2026-10-14, and rerun here):** FEED's script `scripts/check-merged-project.cjs` and its 10 tests (`tests/projectImportMerged.test.ts`, FEED branch `claude/merged-project-check`, tip `6511f96`, not merged into FEED's main when this was written) run Studio's fixture through Studio's `import`, a person's edit, Studio's `export`, **SEED's own `planMaterialMerge` and `saveProject`**, and then FEED's importer. Result: all 6 materials are read and none is lost; the fuel is revision 4; FEED's `thermal.conductivity` is byte for byte what it was before the merge; Studio's set and the vendor's set pass through unread and unchanged, with their `__proto__` and `constructor` keys as plain data; FEED's export of the imported fuel reproduces the project's three sets exactly; the old revision 3 is refused; the materials without a FEED thermal set import with both sets named as missing. The SEED session reran the 10 tests and the 13 pipeline checks against SEED `d8737a0` and Studio `82265ae` (not the commits FEED used): all passed. FEED's own record is in its `docs/seed-material-import.md`.
- **Not checked:** a real OpenMC run on a material that came back from a project (Studio's side). The acceptance case "reopening in OpenMC keeps both sets" is shown through Studio's own import and FEED's importer, not through a run.
- There is no button in the SEED shell for it yet.
