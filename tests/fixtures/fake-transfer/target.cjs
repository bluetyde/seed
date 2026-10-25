// A fake target app's `transfer` command: heating bins (a table: bin label, mean in eV per source particle, std) onto axial slices.
// The recipe's mapping.spatial.slices name the bins of each slice. FAKE_TRANSFER_MODE: good | lossy | exit | garbage | nochange | refuse | dishonest | dishonest-flag.
const fs = require("fs");
const mode = process.env.FAKE_TRANSFER_MODE || "good";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
if (process.env.FAKE_TRANSFER_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_TRANSFER_DELAY_MS));
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (mode === "exit") process.exit(3);
if (mode === "reply-then-exit") { reply({ ok: true, output: { content: "{}" } }); process.exit(1); }
if (mode === "garbage") { process.stdout.write("not json\n"); process.exit(0); }
if (mode === "refuse") { reply({ ok: false, errors: [{ code: "E_BOUNDARY_INCOMPLETE", field: "/mapping", message: "no boundary form" }, { code: "bad code", message: "x" }] }); process.exit(0); }
const EV_J = 1.602176634e-19;
const r = request.recipe, d = request.source.data;
const rate = r.normalization.value.value;
const mean = new Map(d.rows.map((row) => [row[0].join(","), row[1]]));
const slices = r.mapping.spatial.slices;
const power = {};
for (const s of slices) {
  let p = 0;
  for (const b of s.bins) {
    if (!mean.has(b)) { reply({ ok: false, errors: [{ code: "E_COVERAGE", field: "/mapping/spatial/slices/" + s.id, message: "bin " + b + " is not in the source" }] }); process.exit(0); }
    p += mean.get(b) * rate * EV_J;
  }
  power[s.id] = p;
}
if (mode === "lossy") power[slices[0].id] *= 0.9;
const total = [...mean.values()].reduce((a, b) => a + b, 0) * rate * EV_J;
const mapped = Object.values(power).reduce((a, b) => a + b, 0);
const rel = Math.abs(mapped - total) / total;
if (rel > r.tolerance.conservation) { reply({ ok: false, errors: [{ code: "E_CONSERVATION", field: "/tolerance/conservation", message: "mapped " + mapped + " W, source " + total + " W" }] }); process.exit(0); }
if (mode === "dishonest" || mode === "dishonest-flag") { reply({ ok: true, output: { content: JSON.stringify({ pin: "pin-1", powerW: 0 }) + String.fromCharCode(10) }, checks: { conservation: mode === "dishonest" ? { relativeDifference: 0.5, tolerance: r.tolerance.conservation } : { ok: false } } }); process.exit(0); }
const content = mode === "nochange" ? request.target.content : JSON.stringify({ pin: "pin-1", powerW: power, from: request.recipeDigest }) + "\n";
reply({ ok: true, output: { content }, checks: { conservation: { relativeDifference: rel, tolerance: r.tolerance.conservation } } });
