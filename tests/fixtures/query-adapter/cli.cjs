"use strict";
// A tiny adapter for the query_model host tests: describe and query only. The mode comes from QUERY_STUB_MODE.
//   ok (default)  answers {echo: <the query>, bytes: <size of the model file>}
//   no-capability describe does not advertise query-model
//   wrong-hash    answers about another model
//   mutate        changes the model file while it "runs"
//   big           answers with more than a megabyte
//   refuse        refuses with a typed code
//   silent        refuses with no reason
//   describe-refuse  describe itself refuses
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const verb = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const root = process.env.SEED_PROJECT_ROOT || process.cwd();
  const mode = process.env.QUERY_STUB_MODE || "ok";
  const out = (doc) => process.stdout.write(JSON.stringify({ schema: "seed.adapter-reply/0.1", verb, requestId: req.requestId, errors: [], warnings: [], ...doc }) + "\n");
  if (verb === "describe" && mode === "describe-garbage") return process.stdout.write("this is not a reply" + String.fromCharCode(10));
  if (verb === "describe" && mode === "describe-refuse") return out({ ok: false, errors: [{ code: "E_SETUP_REQUIRED", field: "", message: "the app is not set up", source: "seed" }] });
  if (verb === "describe") {
    return out({
      ok: true,
      result: {
        app: { id: "stub", name: "Query stub", version: "0.1.0" },
        engine: { name: "stub", version: "0.1.0" },
        formats: [{ id: "stub.model", version: "1" }],
        capabilities: mode === "no-capability" ? ["validate"] : ["validate", "query-model"],
        parameters: [],
        quantities: [],
        oracleCoverage: [],
      },
    });
  }
  if (verb !== "query") return out({ ok: false, errors: [{ code: "E_VERB_UNKNOWN", field: "", message: "unknown verb", source: "seed" }] });
  const file = path.join(root, req.artifact.path);
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (mode === "mutate") fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(" ")]));
  if (mode === "refuse") return out({ ok: false, errors: [{ code: "E_QUERY_INVALID", field: "/query/op", message: "E_QUERY_UNKNOWN_OP: no such op", source: "app-content" }] });
  if (mode === "silent") return out({ ok: false, errors: [] });
  if (mode === "big") return out({ ok: true, result: { answer: { filler: "x".repeat(1020000) }, modelSha256: sha } });
  return out({ ok: true, result: { answer: { echo: req.query, bytes: bytes.length }, modelSha256: mode === "wrong-hash" ? "0".repeat(64) : sha } });
});
