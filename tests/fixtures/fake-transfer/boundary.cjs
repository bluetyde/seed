// A fake target app's coolant-boundary `transfer` command: a bulk temperature (the primary quantity, one selected sample) and a heat transfer
// coefficient (the additional quantity with the role heat-transfer-coefficient) become a boundary in the target case.
const fs = require("fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const s = request.source;
const h = (s.additional || []).find((a) => a.role === "heat-transfer-coefficient");
if (!s.selected || !h || !h.selected) { reply({ ok: false, errors: [{ code: "E_BOUNDARY_INCOMPLETE", field: "/source", message: "a bulk temperature alone is not a convective boundary" }] }); process.exit(0); }
const content = JSON.stringify({ pin: "pin-1", boundary: { bulkTemperatureK: s.selected.value, heatTransferCoefficient: h.selected.value, at: s.selected.x, interpolated: s.selected.interpolated || h.selected.interpolated, region: request.recipe.mapping.spatial.region } }) + "\n";
reply({ ok: true, output: { content }, checks: { sawRoles: (s.additional || []).map((a) => a.role), units: { T: s.quantity.unit, h: h.quantity.unit } } });
