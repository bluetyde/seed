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
const worker = "let n = 0; onconnect = (e) => { n += 1; e.ports[0].postMessage(n); };";
const shared = '<p id="count">-</p><button id="open" onclick="window.open(\'/popup\')">open window</button><a id="ext" href="https://example.com/" target="_blank">external</a>' +
  '<script>const w = new SharedWorker("/sw.js"); w.port.onmessage = (e) => { document.getElementById("count").textContent = String(e.data); };</script>';
const page = `<!doctype html><title>${title}</title><body style="background:#223;color:#eee;font:16px sans-serif"><h1 id="t">${title}</h1><input id="x">` +
  (args.includes("--shared") ? shared : "") + (args.includes("--beforeunload") ? `<script>window.addEventListener("beforeunload",(e)=>{e.preventDefault();e.returnValue="";});document.getElementById("x").addEventListener("input",()=>{});</script>` : "") + `</body>`;
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url.startsWith("/health")) { res.writeHead(200); return res.end("ok"); }
    if (req.url === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(worker); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  }).listen(port, "127.0.0.1", () => console.log("fake app listening on " + port));
}, delay);
if (opt("crash-after") !== undefined) setTimeout(() => process.exit(3), Number(opt("crash-after")));
