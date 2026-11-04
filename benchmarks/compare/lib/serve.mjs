// A plain static file server for the static builds, so every framework's output is served the
// same way (no compression; sizes are gzipped by the measuring side). Clean URLs resolve to
// `path`, `path/index.html` or `path.html`, which covers every framework's output layout.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolve(root, urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const base = path.join(root, clean);
  if (!base.startsWith(root)) return null;
  for (const p of [base, path.join(base, "index.html"), `${base}.html`]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

export function serve(root, port) {
  const dir = path.resolve(root);
  const server = createServer((req, res) => {
    const file = resolve(dir, new URL(req.url, "http://x").pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
