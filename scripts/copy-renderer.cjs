// Copies the static renderer files (html, css) next to the compiled scripts.
const fs = require("fs");
const path = require("path");
const from = path.join(__dirname, "..", "src", "renderer");
const to = path.join(__dirname, "..", "dist", "renderer");
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) if (/\.(html|css)$/.test(f)) fs.copyFileSync(path.join(from, f), path.join(to, f));
