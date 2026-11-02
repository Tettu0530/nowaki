// Production SSR sidecar. Spawned by `nowaki start` (Rust axum front); Node only renders
// components (Rust handles static serving and HTML assembly). Signals readiness to Rust
// with "NOWAKI_START_READY <port>" on stdout.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { createApp } from "./app.mjs";
import { handleRequest } from "./handler.mjs";
import { liveRender } from "./live.mjs";
import { pageMeta } from "./document.mjs";

const appRoot = process.cwd();
const { env, liveRegistry } = await createApp({
  clientDir: path.join(appRoot, "dist/client"),
  serverDir: path.join(appRoot, "dist/server"),
});

// Pages return body+meta markers instead of final HTML. Streaming bypasses the markers.
env.renderDocument = ({ mod, body, meta }) => {
  const m = pageMeta(meta, mod);
  return { __nowakiPage: true, body, title: m.title, head: m.head, lang: m.lang };
};

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url.startsWith("/__nowaki/live-render")) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { name, state, handler, payload, sig } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      const entry = [...liveRegistry.values()].find((e) => e.name === name);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "live island not found" }));
        return;
      }
      const result = await liveRender(entry.mod, state, handler, payload, name, sig);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("[nowaki live]", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.stack ?? err) }));
    }
    return;
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const result = await handleRequest(env, { method: req.method, url, version: "prod", req });
    const b = result.body;
    if (b && typeof b === "object" && b.__nowakiPage) {
      // Keep response headers (cookies etc.) and tell Rust to assemble the HTML via x-nowaki-page.
      res.writeHead(result.status ?? 200, {
        ...(result.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
        "x-nowaki-page": "1",
      });
      res.end(JSON.stringify({ body: b.body, title: b.title, head: b.head, lang: b.lang }));
    } else {
      res.writeHead(result.status ?? 200, result.headers ?? {});
      if (result.stream) {
        Readable.fromWeb(result.stream).pipe(res);
      } else {
        res.end(result.body ?? "");
      }
    }
  } catch (err) {
    console.error("[nowaki prod-sidecar]", err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(err?.stack ?? err));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_START_READY ${server.address().port}`);
});
