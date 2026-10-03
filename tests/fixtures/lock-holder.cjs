const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const projectDir = process.argv[2];
if (!projectDir) {
  process.stderr.write("Usage: node lock-holder.cjs <projectDir>\n");
  process.exit(1);
}

const seedDir = path.join(projectDir, ".seed");
fs.mkdirSync(seedDir, { recursive: true });
const lockDir = path.join(seedDir, "lock");
fs.mkdirSync(lockDir);

const owner = {
  ownerId: "holder",
  pid: process.pid,
  host: os.hostname(),
  acquiredAt: new Date().toISOString(),
  token: "holder-token",
};

fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner, null, 2) + "\n", "utf8");

process.stdout.write("locked\n");

setInterval(() => {}, 1000);
