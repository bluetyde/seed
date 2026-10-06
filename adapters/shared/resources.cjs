"use strict";
// What a run of each app costs, as measured (scripts/measure-resources.cjs); the adapters put it into describe.resources.
// An app without an entry reports no resources (the field is optional).
const fs = require("node:fs");
const path = require("node:path");

function resourcesFor(appId) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, "resources.json"), "utf8"));
    return all[appId];
  } catch {
    return undefined;
  }
}

module.exports = { resourcesFor };
