// A second process for tests/concurrency.test.ts: adds N entries to a request log through the run manager's own writer.
// usage: node requests-writer.cjs <dist/core/runManager.js> <requests.json> <prefix> <count>
"use strict";
const [, , lib, file, prefix, count] = process.argv;
const { updateRequestsFile } = require(lib);
const hash = "a".repeat(64);
for (let i = 0; i < Number(count); i++) updateRequestsFile(file, prefix + "-" + i, { payloadHash: hash, runId: "r-" + prefix + "-" + i });
