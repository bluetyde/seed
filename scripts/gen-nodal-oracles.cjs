"use strict";
// Turns NODAL's oracle cases (<nodal repo>/oracles/seed/cases.json, written by tools/gen_seed_oracles.py there) into SEED oracle entries
// (seed.oracle/0.1) in <nodal repo>/oracles/seed/entries. The expected values come from NODAL's analytic references and committed golden
// vectors, never from running the adapter. This script owns the hashing: the input hashes and the tolerance pin must match SEED's canonical JSON.
// Usage: node scripts/gen-nodal-oracles.cjs <path to the NODAL repo>

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/gen-nodal-oracles.cjs <path to the NODAL repo>");
  process.exit(2);
}
const base = path.join(path.resolve(repo), "oracles", "seed");
const NL = String.fromCharCode(10);
const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

const spec = JSON.parse(fs.readFileSync(path.join(base, "cases.json"), "utf8"));
if (spec.format !== "nodal-oracle-cases" || spec.version !== 1 || !Array.isArray(spec.cases)) {
  console.error("cases.json is not nodal-oracle-cases version 1");
  process.exit(2);
}
const entriesDir = path.join(base, "entries");
fs.rmSync(entriesDir, { recursive: true, force: true });
fs.mkdirSync(entriesDir, { recursive: true });

let good = 0;
let bad = 0;
for (const c of spec.cases) {
  const files = [c.model, ...(c.commands ? [c.commands] : [])];
  const inputs = files.map((p) => ({ path: p, sha256: sha(fs.readFileSync(path.join(base, p))) }));
  const e = {
    schema: "seed.oracle/0.1",
    oracleId: c.id,
    entryVersion: 1,
    adapter: "nodal",
    adapterVersions: ["*"],
    tag: c.tag,
    inputs,
    expected: c.expected,
    ...(c.tolerance ? { tolerance: c.tolerance } : {}),
    source: c.source,
    coverage: c.coverage,
  };
  e.toleranceHash = sha(canonical({ expected: e.expected, tolerance: e.tolerance === undefined ? null : e.tolerance }));
  fs.writeFileSync(path.join(entriesDir, c.id + ".json"), JSON.stringify(e, null, 2) + NL);
  if (c.tag === "good") good++;
  else bad++;
}
fs.writeFileSync(
  path.join(base, "README.md"),
  [
    "# SEED oracle entries for NODAL",
    "",
    "`cases.json` and `models/` are written by `tools/gen_seed_oracles.py` in this repo; `entries/` by `scripts/gen-nodal-oracles.cjs` in bluetyde/seed (it owns the hashing).",
    "A model and its commands file are pinned by hash in each entry; a tolerance is part of the entry's hash, so changing one needs a new `entryVersion` made by a human.",
    "",
    good + " good entries and " + bad + " bad-input entries:",
    "- ANALYTIC (4 good): hydrostatic column, turbulent and laminar pipe flow, vertical drain; the expected value is computed by a formula or integral that does not use the solver (iapws properties only), with the tolerances NUMERICS section 9 fixed before any solver result.",
    "- REGRESSION (golden vectors): the last sample of the committed vector; two implementations (Python, TypeScript) agree within docs/GOLDEN.md's bound, a shared defect would pass.",
    "- BAD INPUT: four faults of the steady-pipe model that must be refused.",
    "Not covered: two-phase accuracy against anything outside NODAL, heat-structure physics beyond the golden cases, kinetics (M7 not built), real decks.",
    "",
  ].join(NL)
);
console.log("wrote " + good + " good and " + bad + " bad-input entries to " + entriesDir);
