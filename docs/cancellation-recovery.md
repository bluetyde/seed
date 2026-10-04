# Calculation cancellation and conservative recovery

CLI and MCP now distinguish cancelling a client request from stopping a calculation. The run's original `requestId` identifies the calculation; clients never submit native job IDs, PIDs, executable paths or actors.

## Cancel a live calculation

Call MCP `seed_cancel_calculation` with `{"requestId":"original-request"}`, or run `node dist/cli/seed.js cancel` with that JSON on stdin and the existing trusted SEED_HOST_CONFIG.

A `cancellation-requested` reply acknowledges a queued request, not a confirmed stop. The live owner reloads host policy/grants, verifies the active study/recipe, records a cancellation decision and calls its existing RunManager cancellation path. The adapter must confirm the stop. The original run call supplies the terminal result; a confirmed cancellation records `cancelled`, not success or completed output. If the calculation already finished, it may complete before cancellation is processed.

Cancellation is an A1 operation; at A0 an agent needs a separate scoped `cancel` grant. A `run_case` grant does not authorize cancellation. Revocation is checked both when the request is queued and when the owner processes it. An unconfirmed stop, including an adapter-call timeout, returns the attempt result and permits a fresh cancellation request. Oracle failure does not prevent an authorized stop. Requests for another project, recipe or original request ID are refused. No process is killed based only on a client-supplied PID.

## Recover an abandoned calculation

Recovery is currently a trusted human CLI action, not an MCP tool. Select an externally provisioned host configuration with a human actor, the original project/study and exactly the same adapter/runtime recipe. Run `node dist/cli/seed.js recover` with `{"requestId":"original-request"}` on stdin.

The host requires an existing matching lease/active record and a dead supervisor. A live PID, including an ambiguous reused PID, blocks recovery. A recovery guard serializes attempts. Under the project writer lock it matches the saved nonterminal run, original request ID, study, adapter and job identity against the authoritative launch binding in external host state, records the recovery request, and asks the configured adapter to cancel the externally bound job directly. A project record is never reread to choose the native stop target. A record change during the stop keeps the lease for inspection even when the bound job was stopped. Only a confirmed cancelled result permits removal of that exact engine lease. The run remains saved as cancelled and recovery records are appended to the admission journal.

The process identity test never authorizes killing the supervisor PID; it only prevents takeover while a process might still own the run. The adapter remains responsible for native process ownership verification. Changed runtime bytes, an incompatible recipe, missing/invalid job identity, terminal or corrupt run records, missing active metadata and unconfirmed stops require manual inspection. Recovery does not restart, resume or relabel partial results as successful. Legacy runs without the new request binding also require manual inspection.

Failed or interrupted host outcomes retain their engine lease conservatively because the run state alone cannot prove all native processes stopped. Do not delete a lease merely because the owner died. There is no general automatic stale-lease cleanup, arbitrary process-kill tool or recovery of every crash window in this slice.

## Evidence

Process tests cover owner-mediated cancellation, rejection of client authority and unrelated requests, refusal to recover a live owner, and a supervisor killed during a native fake-adapter job followed by human recovery through the actual CLI. Real RAFT acceptance also kills the SEED supervisor during a running synthetic case, verifies that the abandoned lease blocks another admission, recovers through the human CLI, confirms both the wrapper and runner are dead, checks the cancelled record and recovery journal, and completes a subsequent registered calculation. The extended synthetic case tests lifecycle control; it does not establish additional physics oracle coverage. Existing RAFT cancellation/ownership tests and real CLI/MCP calculation agreement remain part of regression. This is Windows evidence; Linux recovery needs its own verification.
