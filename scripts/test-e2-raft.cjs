// Acceptance must fail, not silently skip, when the real runner is unavailable.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.join(__dirname, "..");
const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "tests/raft-direct-agreement.test.ts", "tests/raft-oracles.test.ts", "tests/file-run-host.test.ts"], {
  cwd: root, stdio: "inherit", env: { ...process.env, SEED_REQUIRE_RAFT: "1" },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
