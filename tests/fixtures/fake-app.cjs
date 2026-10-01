// A stand-in for a suite app: a tiny HTTP server for the tests.
//   node fake-app.cjs --port N [--delay ms] [--exit code] [--crash-after ms] [--title text] [--beforeunload]
const http = require("http");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf("--" + name); return i < 0 ? dflt : args[i + 1]; };
const port = Number(opt("port", "0"));
const title = opt("title", "Fake app");
const delay = Number(opt("delay", "0"));
if (opt("exit") !== undefined) {
  console.log("fake app failing on purpose: missing dependency foo");
  console.error("Traceback: ModuleNotFoundError: foo");
  process.exit(Number(opt("exit")));
}
const page = `<!doctype html><title>${title}</title><body style="background:#223;color:#eee;font:16px sans-serif"><h1 id="t">${title}</h1><input id="x">` +
  (args.includes("--beforeunload") ? `<script>window.addEventListener("beforeunload",(e)=>{e.preventDefault();e.returnValue="";});document.getElementById("x").addEventListener("input",()=>{});</script>` : "") + `</body>`;
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url.startsWith("/health")) { res.writeHead(200); return res.end("ok"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  }).listen(port, "127.0.0.1", () => console.log("fake app listening on " + port));
}, delay);
if (opt("crash-after") !== undefined) setTimeout(() => process.exit(3), Number(opt("crash-after")));
