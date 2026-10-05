"use strict";
// The fixture's runner: node runner.cjs <mode> <outDir>. Prints one JSON line like a real headless runner.
const mode = process.argv[2];
const done = (code, reply) => {
  console.log(JSON.stringify(reply));
  process.exit(code);
};
if (mode === "ok") done(0, { ok: true, status: "completed" });
else if (mode === "exit3") done(3, { ok: true, status: "completed" }); // says completed but the process failed: never a success
else if (mode === "cancelled") done(0, { ok: true, status: "cancelled" });
else if (mode === "refuse") done(2, { ok: false, errors: [{ code: "E_SCHEMA_INVALID", message: "refused for a reason" }] });
else if (mode === "failed") done(0, { ok: true, status: "failed", reason: "the engine said no" });
else setInterval(() => {}, 1000); // "hang"
