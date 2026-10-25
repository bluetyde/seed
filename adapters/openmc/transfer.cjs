"use strict";
// The OpenMC Studio side of a SEED transfer as the host calls a target's `transfer` command: a seed.transfer-request/0.2 on stdin, one reply line on stdout,
// exit 0 for every answer. It hands the request to Studio's own `headless transfer` (inside WSL on Windows) and passes Studio's reply on unchanged; the
// configuration is the adapter's (adapters/openmc/lib.cjs, the SEED_OPENMC_* variables). Usage: node transfer.cjs
const fs = require("node:fs");
const { config, studioTransfer } = require("./lib.cjs");

(async () => {
  let reply;
  try {
    const cfg = config();
    if (cfg.setup) {
      reply = { ok: false, errors: [{ code: "E_SETUP_REQUIRED", message: "the OpenMC runner is not configured: " + cfg.setup }] };
    } else {
      reply = await studioTransfer(cfg, JSON.parse(fs.readFileSync(0, "utf8")));
    }
  } catch (err) {
    reply = { ok: false, errors: [{ code: "E_APP_FAILED", message: "the OpenMC transfer wrapper failed: " + String(err && err.message).slice(0, 300) }] };
  }
  process.stdout.write(JSON.stringify(reply) + String.fromCharCode(10));
})();
