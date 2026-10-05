"use strict";
// Records which dependency list node_modules was installed from, so the launcher can notice an update that changed it.
//   node scripts/deps-stamp.cjs write   after a successful install: store the hash of package.json + package-lock.json
//   node scripts/deps-stamp.cjs check   exit 0 when the stored hash matches the current files, 1 otherwise (including no stamp)
// The stamp lives inside node_modules, so deleting node_modules also forgets it.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const stampFile = path.join(root, "node_modules", ".seed-deps-stamp");

function current() {
  const hash = crypto.createHash("sha256");
  for (const name of ["package.json", "package-lock.json"]) {
    hash.update(name + "\n");
    hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}

const verb = process.argv[2];
try {
  if (verb === "write") {
    fs.writeFileSync(stampFile, current() + "\n");
    process.exit(0);
  }
  if (verb === "check") {
    process.exit(fs.readFileSync(stampFile, "utf8").trim() === current() ? 0 : 1);
  }
  process.stderr.write("usage: node scripts/deps-stamp.cjs write|check\n");
  process.exit(2);
} catch (err) {
  // No stamp, no lockfile or an unreadable folder: a check says "changed or unknown" and a write fails loudly.
  if (verb === "check") process.exit(1);
  process.stderr.write("deps-stamp " + verb + " failed: " + (err && err.code ? err.code : err) + "\n");
  process.exit(1);
}
