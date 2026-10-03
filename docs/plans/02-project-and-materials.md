# Plan 02: Project and materials

The project folder, how native models are attached, and how materials travel between apps. Milestones E0 (schemas) and E1 (project launcher). Suite-level rules are in the workspace `plans/nuclear-suite-integration.md`; this plan turns them into SEED work.

## Project

A project is a folder with a manifest ([ARCHITECTURE interface 1](../ARCHITECTURE.md)). It references native artifacts; it does not copy or convert them.

- **Portable:** references are relative paths. Installed app locations live in user configuration. Moving the folder must not break a reference; the test is to copy it to another path and reopen.
- **Path kinds:** `windows`, `wsl` and `posix` are explicit. SEED converts between them only through one function that is tested with spaces, drive letters, UNC paths and `\\wsl$` paths. It never guesses from the shape of a string.
- **Traversal:** a reference that resolves outside the project or a configured root is refused.
- **One owner per document:** each app's editor owns its native file. SEED saves nothing into it. If an app saves, SEED notices the changed revision and marks dependents stale.
- **Revision:** the native format's own hash where it has one, plus SEED's counter. Saves from an editor carry the expected revision; a mismatch is a conflict, not an overwrite.

## Materials

Materials are project data, not a separate app. Envelope fields:

| Field | Meaning |
|---|---|
| `id` | Stable, never reused; matching is by ID only |
| `revision` | Immutable; a change makes a new revision and invalidates dependent results |
| `name` | Display only |
| `sets` | Namespaced property sets, one per consumer (for example `openmc.composition`, `thermal.conductivity`) |

Each set records: schema or model identifier and version, units, source, reference conditions, applicable ranges, and data or artifact references.

Rules (from the suite draft, restated as testable behaviour):

1. Capability is judged per operation: a thermal run needing conductivity refuses with the missing property named; an OpenMC run does not care.
2. Unknown sets survive open and save in a receiving app unchanged. If a native format cannot hold them, they are stored as opaque data beside the envelope.
3. SEED never evaluates an expression found in a set it does not understand.
4. Equal names are not merged. Custom data is not replaced by a catalog entry. Missing values are not invented. Another app's set is not overwritten.
5. Different density representations may coexist, each with its conditions and source; any override is explicit and recorded.
6. Derived properties name their input revisions and the derivation.
7. Conflicting edits use expected-revision checks and explicit resolution.

## Acceptance (the cross-app material case)

A custom OpenMC-only material survives open and save in a receiving app with its unknown fields intact. A thermal run names the missing properties. Adding a sourced thermal set creates a new revision without changing the composition. Reopening in OpenMC keeps both sets. Old results stay tied to the old revision. This is harness-adjacent: it runs first against the fake adapter, then with two real apps.

## Tests

- Schema good and bad fixtures: unknown set, unknown schema version, duplicate ID, duplicate name with different IDs, range gaps, unit mismatch, expression in a set.
- Relocation: copy the project, reopen, every reference resolves.
- Path conversion table test (Windows, WSL, spaces, UNC, traversal).
- Conflict: two writers, the second save with a stale revision is rejected and recorded.
- Crash mid-write: a half-written manifest is detected (write to a temp file and rename; keep the previous manifest).

## Open

- Canonical envelope format (JSON only, or JSON plus sidecar files for large data).
- Whether the manifest hash covers GUI-only layout (answer comes from each app's native hashing rules, per [plan 04](04-runs-and-scheduling.md)).
- How an app that cannot hold unknown sets stores the opaque data without a native format change.
