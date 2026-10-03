# SEED runtime interface inventory

2026-10-03, SEED-only implementation slice. Source inspected locally; no other application or package claimed or modified.

| Interface | Existing owner/file | Current behavior / next boundary |
|---|---|---|
| Repository install/update | src/main/installer.ts, git.ts | Catalog commands, per-app cancellable jobs, guarded fast-forward; not a versioned runtime transaction |
| Installation settings | src/main/store.ts | Atomic JSON rename storing repo paths/root; no runtime manifests or rollback registry |
| Trusted catalog | src/main/catalog.ts, catalog.json | Shipped repo/prerequisite/step declarations; no artifact digest/platform/compatibility contract yet |
| Editor launch/attach/stop | src/main/processes.ts | Per-app start coalescing; owned versus attached servers; asynchronous HTTP readiness |
| UI entry points | src/main/main.ts | openApp uses ensure; closeTab calls stop; host closure calls stopAll |
| Job cancellation | installer.ts defaultRunCmd, processes.ts killTree | Live child-tree termination helper; abrupt host death and WSL-side ownership remain unverified |
| Runtime provisioning | not implemented | Next: manifest and staged activation store, using small local fixtures before engine artifacts |
| Study/adapter verbs | planned only | Do not expose editor launch as a completed calculation/run adapter |

## Implemented in this slice

Startup has an AbortController registered before asynchronous attach/port work. stop and stopAll invalidate pending starts; checkpoints after asynchronous operations prevent a cancelled launch from publishing readiness or creating a late child. A reopen waits for the cancelled generation's cleanup. Health requires HTTP 2xx, rather than accepting 4xx. This is protocol readiness only, not authenticated application identity.

The change preserves public ProcessManager methods and existing installer behavior. It adds no Electron dependency and no new GUI control. Tests cover cancellation before spawn, attach cancellation/reopen, warming-child cleanup, sibling survival and HTTP errors.

## Remaining lifecycle limitations

killTree still uses the existing platform helper and cannot prove cleanup after abrupt host termination. This slice is graceful in-process cancellation, not an implementation of job objects, runtime leases, PID-reuse recovery or WSL descendant cleanup. Cancellation latency is bounded by current probe timeout/sleep behavior, not an instantaneous abort of every dependency. Configured attach endpoints remain trusted; identity-bearing health responses require an app protocol extension.

## Next contract for implementation

Runtime manifests must be versioned and validated before file writes: artifact identity/digest, platform/architecture, app/adapter compatibility, declared sizes, source trust, data references and notices. Managed roots are distinct from adopted locations. Installation states: queued -> preflight -> staging -> verifying -> activating -> ready, with cancelled/failed/interrupted outcomes preserving the previously active version. Activation uses an atomic reference switch; rollback is a new operation, not mutation of an old attempt.

One ownership record identifies a launch/job generation, process start identity, managed runtime and supervising owner. Installation and study authorization remain separate. Do not accept commands from project files or add a runtime install button until transaction recovery is implemented.

Next SEED tasks: implement this runtime manifest and fake-artifact transaction store; harden cancellation failure reporting; design host-death cleanup with runtime-side evidence. Real engine integration remains a separate later task. See [plan 11](plans/11-runtime-and-shared-acceptance.md).
