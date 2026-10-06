import { defineConfig } from "vitest/config";

// The suites that start real runtimes (WSL, SCRAM, OpenMC, the NODAL and RAFT runners, FEED's solver) run one file at a time: started together
// with the other ~30 files they compete for WSL and memory and fail on timing, not on behavior (observed 2026-10-05: a different one of these
// failed in each of several full runs and passed alone, twice). Everything else runs in parallel as before.
const runtime = [
  "tests/feed-adapter.test.ts",
  "tests/feed-oracles.test.ts",
  "tests/nodal-adapter.test.ts",
  "tests/nodal-adapter-review.test.ts",
  "tests/nodal-oracles.test.ts",
  "tests/openmc-adapter.test.ts",
  "tests/openmc-oracles.test.ts",
  "tests/pra-adapter.test.ts",
  "tests/pra-oracles.test.ts",
  "tests/raft-adapter.test.ts",
  "tests/raft-adapter-review.test.ts",
  "tests/raft-direct-agreement.test.ts",
  "tests/raft-oracles.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/*.test.ts"], exclude: runtime } },
      { extends: true, test: { name: "runtime", include: runtime, fileParallelism: false } },
    ],
  },
});
