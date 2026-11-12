// Production SSR sidecar. Spawned by `nowaki start` (Rust axum front); Node only renders
// components (Rust handles static serving and HTML assembly). Signals readiness to Rust
// with "NOWAKI_START_READY <port>" on stdout.

import "./exit-with-parent.mjs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { createApp } from "./app.mjs";
import { handleRequest } from "./handler.mjs";
import { liveContext, liveRender, liveShareable, liveSigStatus, LiveForbiddenError } from "./live.mjs";
import { contextReads, runWithContext } from "./functions.mjs";
import { pageMeta } from "./document.mjs";
import { persistRooms } from "./live-rooms-file.mjs";
import { isrUrls } from "./isr-urls.mjs";
import { requestOrigin } from "./origin.mjs";
import { flushDetached, setRevalidateEnv } from "./revalidate.mjs";
import { logError } from "./log.mjs";
import { HEALTH_BODY, HEALTH_HEADERS, HEALTH_PATH } from "./health.mjs";

const appRoot = process.cwd();
persistRooms(appRoot);
const { env, liveRegistry } = await createApp({
  clientDir: path.join(appRoot, "dist/client"),
  serverDir: path.join(appRoot, "dist/server"),
});

// Pages return body+meta markers instead of final HTML. Streaming bypasses the markers.
env.renderDocument = ({ mod, body, meta }) => {
  const m = pageMeta(meta, mod);
  return { __nowakiPage: true, body, title: m.title, head: m.head, lang: m.lang, htmlAttrs: m.htmlAttrs, bodyAttrs: m.bodyAttrs, router: meta?.router === true };
};
// The Rust front keeps the ISR cache: pages send their tags, revalidate*() purges it.
env.isrStore = true;
setRevalidateEnv(env);
// The Rust front names its SERVER span after the route the sidecar matched (x-nowaki-route, internal).
if (env.trace) env.trace.routeHeader = true;

const server = createServer(async (req, res) => {
  // start.rs `health` pings this (and answers the public /__nowaki/health itself).
  if (req.url === HEALTH_PATH) {
    res.writeHead(200, HEALTH_HEADERS).end(HEALTH_BODY);
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/__nowaki/isr-urls") {
    const max = Number(new URL(req.url, "http://x").searchParams.get("max")) || 1024;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await isrUrls(env, { max })));
    return;
  }
  if (req.method === "POST" && req.url.split("?")[0] === "/__nowaki/live-render") {
    // A WebSocket event or publish refresh: its span is a child of live.rs's (traceparent).
    const tr = env.trace ? env.trace.start("POST", (n) => req.headers[n]) : null;
    let status = 200;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { name, state, handler, payload, sig, request, load, verifyOnly } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (verifyOnly) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ verified: liveSigStatus(name, state, sig) }));
        return;
      }
      const entry = [...liveRegistry.values()].find((e) => e.name === name);
      if (!entry) {
        status = 404;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "live island not found" }));
        return;
      }
      tr?.rename(`live ${name}`);
      const ctx = liveContext(request);
      if (tr && ctx) ctx.__trace = tr;
      const result = await runWithContext(ctx, () =>
        liveRender(entry.mod, state, handler, payload, name, sig, { load }),
      );
      // A WebSocket event has no response for x-nowaki-purge to ride on.
      flushDetached(ctx);
      // Rust reuses a shareable render for every connection in the room (one render per publish).
      result.shareable = liveShareable(entry.mod, { handler, load, contextRead: !!ctx && contextReads.has(ctx) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err?.code === "NOWAKI_LIVE_STALE") {
        status = 409;
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stale" }));
        return;
      }
      if (err instanceof LiveForbiddenError) {
        status = 403;
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      status = 500;
      logError("", err, { scope: "live", trace: tr ?? undefined });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "live render failed" }));
    } finally {
      tr?.finish({}, status);
    }
    return;
  }
  try {
    const url = new URL(req.url, requestOrigin((name) => req.headers[name]));
    // The Rust front sets x-nowaki-route-path for a rewrite or basePath (and drops a client's own).
    const routePath = req.headers["x-nowaki-route-path"];
    const result = await handleRequest(env, { method: req.method, url, version: "prod", req, routePath });
    const b = result.body;
    if (b && typeof b === "object" && b.__nowakiPage) {
      // Keep response headers (cookies etc.) and tell Rust to assemble the HTML via x-nowaki-page.
      res.writeHead(result.status ?? 200, {
        ...(result.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
        "x-nowaki-page": "1",
      });
      res.end(JSON.stringify({ body: b.body, title: b.title, head: b.head, lang: b.lang, htmlAttrs: b.htmlAttrs, bodyAttrs: b.bodyAttrs, router: b.router || undefined }));
    } else {
      res.writeHead(result.status ?? 200, result.headers ?? {});
      if (result.stream) {
        Readable.fromWeb(result.stream).pipe(res);
      } else {
        res.end(result.body ?? "");
      }
    }
  } catch (err) {
    logError("", err, { scope: "prod-sidecar" });
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_START_READY ${server.address().port}`);
});
