// Dev SSR sidecar. Spawned by the Rust dev server; handles page rendering and API routes.
// Signals readiness to Rust with "NOWAKI_SIDECAR_READY <port>" on stdout.

import { createServer } from "node:http";
import { register } from "node:module";
import path from "node:path";
import { loadEnv } from "./env.mjs";

// load .env before routes so routes/loaders can read process.env
loadEnv();

// from here on, dynamically imported .tsx/.ts go through Rust's transform endpoint
register(new URL("./loader-hooks.mjs", import.meta.url));
register(new URL("./react-alias-hooks.mjs", import.meta.url));

const { scanRoutes } = await import("./router.mjs");
const { loadIslandRegistry, renderDocument, renderShell, errorPage } = await import("./render.mjs");
const { handleRequest, sendResult } = await import("./handler.mjs");
const { liveRender, liveContext, LiveForbiddenError } = await import("./live.mjs");
const { runWithContext } = await import("./functions.mjs");
const { pathToFileURL } = await import("node:url");

const appRoot = process.cwd();
const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;

// dev doesn't build, so Rust discovers the server function allowlist. Cached per HMR generation.
const fnCache = new Map();
async function serverFnEntries(version) {
  if (fnCache.has(version)) return fnCache.get(version);
  let entries = {};
  try {
    const r = await fetch(`${RUST}/__nowaki/server-functions?v=${encodeURIComponent(version)}`);
    if (r.ok) entries = (await r.json()).entries ?? {};
  } catch {}
  fnCache.set(version, entries);
  return entries;
}

const env = {
  dev: true,
  // dev rescans on every request (picks up file changes)
  routeTable: () => scanRoutes(appRoot),
  importModule: (file, version) => import(`${pathToFileURL(file).href}?v=${version}`),
  ensureIslands: (version) => loadIslandRegistry(appRoot, version),
  serverFunctions: {
    async lookup(id, version) {
      const entries = await serverFnEntries(String(version ?? "0"));
      return entries[id] ?? null;
    },
    // dev has no dist, so import sources directly (loader-hooks bridges to the Rust transform).
    importModule: (m, version) =>
      import(`${pathToFileURL(path.join(appRoot, m)).href}?v=${version}`),
  },
  renderDocument,
  renderShell,
  renderError: (err) => {
    console.error("[nowaki ssr]", err);
    return {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: errorPage(String(err?.stack ?? err)),
    };
  },
};

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/__nowaki/live-render") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { name, state, handler, payload, version, sig, request } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      const reg = await loadIslandRegistry(appRoot, String(version ?? "0"));
      const entry = [...reg.values()].find((e) => e.name === name);
      if (!entry?.live) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "live island not found" }));
        return;
      }
      const result = await runWithContext(liveContext(request), () =>
        liveRender(entry.mod, state, handler, payload, name, sig),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof LiveForbiddenError) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      console.error("[nowaki live]", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.stack ?? err) }));
    }
    return;
  }
  try {
    const version = String(req.headers["x-nowaki-ssr-version"] ?? "0");
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const result = await handleRequest(env, {
      method: req.method,
      url,
      version,
      req,
    });
    await sendResult(res, result);
  } catch (err) {
    console.error("[nowaki ssr]", err);
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(errorPage(String(err?.stack ?? err)));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_SIDECAR_READY ${server.address().port}`);
});
