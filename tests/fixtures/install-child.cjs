// A separate process that installs from a prepared manifest into an install root (tests/component-installer-processes.test.ts).
// usage: node install-child.cjs <root> <job.json> <artifacts dir> [hang <ready file>]
// The job file holds {manifest, sha, select}. With "hang" the artifact source announces itself in the ready file and never delivers.
const fs = require("node:fs");
const path = require("node:path");
const { installSelection } = require("../../dist/core/componentInstaller.js");

const [root, jobFile, artifacts, mode, readyFile] = process.argv.slice(2);
const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
const source = async (a, dest) => {
  if (mode === "hang") {
    fs.writeFileSync(readyFile, String(process.pid));
    setInterval(() => {}, 1000); // an unresolved promise alone would let the process end
    await new Promise(() => {});
  }
  fs.copyFileSync(path.join(artifacts, a.id), dest);
};
const env = { root, platform: { os: "linux", arch: "x64" }, appVersion: "1.5.0", source };

(async () => {
  // another installer on the same root makes this one wait its turn: it asks again until it has had one
  for (let i = 0; i < 600; i++) {
    const r = await installSelection(env, job.manifest, job.sha, job.select);
    if (r.ok || !r.errors.some((e) => e.code === "E_INSTALL_BUSY")) {
      process.stdout.write(JSON.stringify({ ok: r.ok, errors: r.errors, steps: r.steps, tries: i + 1 }));
      return;
    }
    await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 30)));
  }
  process.stdout.write(JSON.stringify({ ok: false, errors: [{ code: "GAVE_UP" }] }));
})();
