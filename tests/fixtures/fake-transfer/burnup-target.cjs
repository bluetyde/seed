// A fake target app's `transfer` command for a burnup (the shape of FEED's, which sets the case's burnup value, basis and source and keeps its own
// physical refusals). Request: seed.transfer-request/0.3 (a record source SEED has already resolved). FAKE_BURNUP_MODE: good | nochange | garbage.
const fs = require("fs");
const mode = process.env.FAKE_BURNUP_MODE || "good";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (request.schema !== "seed.transfer-request/0.3" || request.source.kind !== "record") {
  reply({ ok: false, errors: [{ code: "E_RECIPE_INVALID", field: "/schema", message: "this target takes a record request" }] });
  process.exit(0);
}
if (mode === "garbage") { process.stdout.write("not json\n"); process.exit(0); }
const target = JSON.parse(request.target.content);
const q = request.source.quantity;
if (target.fuel !== "uo2-nfi") { reply({ ok: false, errors: [{ code: "E_UNSUPPORTED", field: "/fuel", message: "the fuel's conductivity must be uo2-nfi" }] }); process.exit(0); }
if (!(q.value >= 0 && q.value <= 62)) { reply({ ok: false, errors: [{ code: "E_OUT_OF_RANGE", field: "/burnup/value", message: "burnup " + q.value + " is outside 0 to 62 MWd/kgHM" }] }); process.exit(0); }
const out = { ...target, burnup: { value: { value: q.value, unit: q.unit }, basis: q.basis, source: request.source.record + " " + request.source.recordId } };
const content = mode === "nochange" ? request.target.content : JSON.stringify(out, null, 2) + "\n";
reply({ ok: true, output: { content }, checks: { appliedBurnup: q.value, interpolated: request.source.interpolated } });
