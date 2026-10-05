"use strict";
// The fixture's "app cancel verb": node cancel.cjs <markerFile>. Writes the marker (the native run is stopped) and says so.
require("node:fs").writeFileSync(process.argv[2], "stopped\n");
console.log(JSON.stringify({ ok: true, cancelled: true }));
