// Dev SSR sidecar. Spawned by the Rust dev server; handles page rendering and API routes.
// Signals readiness to Rust with "NOWAKI_SIDECAR_READY <port>" on stdout.

import "./exit-with-parent.mjs";
import { createServer } from "node:http";
import { createRequire, register } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSite } from "./seo.mjs";
import { loadEnv } from "./env.mjs";
import { requestOrigin } from "./origin.mjs";

// load .env before routes so routes/loaders can read process.env
loadEnv();

// from here on, dynamically imported .tsx/.ts go through Rust's transform endpoint
register(new URL("./loader-hooks.mjs", import.meta.url), { data: { root: process.cwd() } });
register(new URL("./react-alias-hooks.mjs", import.meta.url));

const { scanRoutes } = await import("./router.mjs");
const { loadIslandRegistry, renderDocument, renderShell, errorPage } = await import("./render.mjs");
const { handleRequest, sendResult } = await import("./handler.mjs");
const { liveRender, liveContext, liveShareable, liveSigStatus, LiveForbiddenError } = await import("./live.mjs");
const { runWithContext, contextReads } = await import("./functions.mjs");
const { pathToFileURL } = await import("node:url");

const appRoot = process.cwd();

// Content collections in dev: `nowaki dev` writes .nowaki/content/index.json at startup and on
// every change under content/ (bumping the SSR version), and content/config.ts is imported fresh
// for each version. Errors don't stop the dev server; getCollection reports them (error overlay).
const { setContent, validateContent } = await import("./content-store.mjs");
let contentVersion = null;
async function ensureContent(version) {
  if (contentVersion === version) return;
  contentVersion = version;
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(appRoot, ".nowaki/content/index.json"), "utf8"));
  } catch {
    setContent(null);
    return;
  }
  const configFile = ["config.ts", "config.mts", "config.js", "config.mjs"]
    .map((f) => path.join(appRoot, "content", f))
    .find((f) => existsSync(f));
  try {
    const config = configFile ? await env.importModule(configFile, version) : {};
    // MDX entries render from their source in dev (the Rust transform turns .mdx into a module).
    setContent(await validateContent(raw, config, (e) => env.importModule(path.join(appRoot, e.file), version)));
  } catch (err) {
    setContent({ collections: {}, errors: [`content/config: ${err?.message ?? err}`] });
  }
}
// env.ts in dev: `nowaki dev` validated it before starting; the renderer imports it (through the
// Rust transform, so on the first request, once that server is up) and fills env/server.
const { initServerEnv } = await import("./env-schema.mjs");
const { setServerEnv } = await import("./env-server.mjs");
const envFile = ["env.ts", "env.mts", "env.js", "env.mjs"].map((f) => path.join(appRoot, f)).find((f) => existsSync(f));
let envReady = envFile ? null : true;
if (!envFile) setServerEnv(null);
function ensureEnv(version) {
  if (envReady === true) return;
  envReady ??= env
    .importModule(envFile, version)
    .then((mod) => initServerEnv(mod, process.env))
    .then(
      () => {
        envReady = true;
      },
      (err) => {
        envReady = null;
        throw err;
      },
    );
  return envReady;
}

// Sessions in dev: without NOWAKI_SESSION_SECRET a secret is generated once into
// .nowaki/session-secret (on the first ctx.session, so apps without sessions get no file).
// session.ts is imported fresh for each SSR version.
const { configureSessions, sessionConfigOf } = await import("./session.mjs");
let devSecret;
function devSessionSecret() {
  if (process.env.NOWAKI_SESSION_SECRET) return process.env.NOWAKI_SESSION_SECRET;
  if (devSecret) return devSecret;
  const file = path.join(appRoot, ".nowaki/session-secret");
  try {
    devSecret = readFileSync(file, "utf8").trim();
  } catch {}
  if (!devSecret || devSecret.length < 32) {
    devSecret = randomBytes(32).toString("hex");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${devSecret}\n`, { mode: 0o600 });
  }
  console.warn("[nowaki] session: NOWAKI_SESSION_SECRET is not set; dev uses a generated secret (.nowaki/session-secret). Production needs NOWAKI_SESSION_SECRET.");
  return devSecret;
}
configureSessions({ secret: devSessionSecret });
const sessionFile = ["session.ts", "session.mts", "session.js", "session.mjs"].map((f) => path.join(appRoot, f)).find((f) => existsSync(f));
let sessionVersion = null;
async function ensureSession(version) {
  if (!sessionFile || sessionVersion === version) return;
  const mod = await env.importModule(sessionFile, version);
  configureSessions({ config: sessionConfigOf(mod), secret: devSessionSecret });
  sessionVersion = version;
}

// nowaki.config basePath: `nowaki dev` writes .nowaki/routing.json before it serves, after this
// process starts, so it's read on the first request.
const { setBasePath } = await import("./base-path.mjs");
let baseRead = false;
function ensureBasePath() {
  baseRead = true;
  try {
    setBasePath(JSON.parse(readFileSync(path.join(appRoot, ".nowaki/routing.json"), "utf8")).basePath);
  } catch {
    setBasePath("");
  }
}

const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;

// dev doesn't build, so Rust discovers the server function allowlist. Cached per HMR generation.
const fnCache = new Map();
// A page script's URL in dev: under the app root as its own path, elsewhere (node_modules in a pnpm
// store, say) through /@fs/.
function devScriptUrl(fromFile, spec) {
  let abs;
  if (spec.startsWith(".") || spec.startsWith("/")) abs = path.resolve(path.dirname(fromFile), spec);
  else {
    try {
      abs = createRequire(fromFile).resolve(spec);
    } catch {
      return `/${spec}`; // shows up as a 404 in the browser console, naming the specifier
    }
  }
  const rel = path.relative(appRoot, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return "/" + rel.split(path.sep).join("/");
  return "/@fs/" + abs.split(path.sep).join("/").replace(/^\/+/, "");
}

const routeCssCache = new Map();
async function routeCssDev(file, version) {
  const key = `${version}\u0000${file}`;
  if (!routeCssCache.has(key)) {
    if (routeCssCache.size > 500) routeCssCache.clear();
    routeCssCache.set(
      key,
      fetch(`${RUST}/__nowaki/route-css?file=${encodeURIComponent(file)}&v=${encodeURIComponent(version)}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    );
  }
  return routeCssCache.get(key);
}

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

// Errors go to the dev server's MCP log (`recent_errors`) as a stdout line carrying the same
// per-process token as publish(), so app log output can't add entries.
function reportError(source, err, urlPath) {
  const token = process.env.NOWAKI_PUBLISH_TOKEN;
  if (!token) return;
  const entry = {
    source,
    message: String(err?.message ?? err),
    stack: err?.stack ? String(err.stack) : undefined,
    path: urlPath,
  };
  process.stdout.write(`NOWAKI_DEV_ERROR ${token} ${JSON.stringify(entry)}\n`);
}

const rel = (file) => path.relative(appRoot, file).split(path.sep).join("/");

function routePattern(segments) {
  if (segments.length === 0) return "/";
  return "/" + segments.map((s) => s.lit ?? (s.rest ? `[...${s.param}]` : `[${s.param}]${s.suffix ?? ""}`)).join("/");
}

// For the dev MCP `routes` / `module_graph` tools: the route table and island registry the
// renderer uses, plus each route module's exports (imported the same way a request would).
async function devInfo(version) {
  const table = await scanRoutes(appRoot);
  const routes = [];
  for (const r of table.routes) {
    const route = { pattern: routePattern(r.segments), file: rel(r.file), kind: r.fileExt ? "file" : r.isApi ? "api" : "page" };
    try {
      const mod = await env.importModule(r.file, version);
      route.exports = Object.keys(mod).sort();
      if (mod.revalidate !== undefined) route.revalidate = mod.revalidate;
      if (mod.csrf !== undefined) route.csrf = mod.csrf;
    } catch (err) {
      route.loadError = String(err?.message ?? err);
    }
    routes.push(route);
  }
  const scoped = (kind, list) => list.map((e) => ({ kind, prefix: e.prefix || "/", file: rel(e.file) }));
  const conventions = [
    ...scoped("layout", table.layouts),
    ...scoped("middleware", table.middleware),
    ...scoped("loading", table.loadingBoundaries),
    ...scoped("error-boundary", table.errorBoundaries),
  ];
  if (table.notFound) conventions.push({ kind: "not-found", file: rel(table.notFound) });
  if (table.errorRoute) conventions.push({ kind: "error-page", file: rel(table.errorRoute) });
  let islands;
  try {
    const reg = await loadIslandRegistry(appRoot, version);
    islands = [...reg.values()].map((e) => ({ name: e.name, file: e.src.slice(1), live: Boolean(e.live) }));
  } catch (err) {
    islands = { loadError: String(err?.message ?? err) };
  }
  return { routes, conventions, islands };
}

// NOWAKI_SITE, else `site` in nowaki.config, and its `trailingSlash` (read once; restart dev
// after changing them).
const devConfig = await (async () => {
  for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
    const p = path.join(appRoot, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      return mod.default ?? mod.config ?? {};
    } catch (err) {
      console.error(`[nowaki] ${name}: ${err?.message ?? err}`);
    }
  }
  return {};
})();

// Self-hosted fonts in dev: `nowaki dev` builds them into .nowaki/fonts in the background at
// startup, so the file is read again whenever it changes.
const fontsFile = path.join(appRoot, ".nowaki/fonts.json");
let fontsCache = { mtime: -1, value: null };
function devFonts() {
  let mtime = 0;
  try {
    mtime = statSync(fontsFile).mtimeMs;
  } catch {
    return null;
  }
  if (mtime !== fontsCache.mtime) {
    try {
      fontsCache = { mtime, value: JSON.parse(readFileSync(fontsFile, "utf8")) };
    } catch {
      fontsCache = { mtime, value: null };
    }
  }
  return fontsCache.value;
}

const env = {
  dev: true,
  site: resolveSite(devConfig.site),
  trailingSlash: devConfig.trailingSlash,
  get fonts() {
    return devFonts();
  },
  // dev rescans on every request (picks up file changes)
  routeTable: () => scanRoutes(appRoot),
  importModule: (file, version) => import(`${pathToFileURL(file).href}?v=${version}`),
  ensureIslands: (version) => loadIslandRegistry(appRoot, version),
  // Route / layout CSS in dev: the Rust dev server follows the route's imports and serves each
  // stylesheet (cached per SSR version, so an edit shows up on the next reload).
  routeCss: (file, version) => routeCssDev(file, version),
  // Page scripts in dev: the listed modules' own URLs, served (and transformed) by the dev server.
  routeScripts: (file, mod) => (Array.isArray(mod?.scripts) ? mod.scripts : []).map((spec) => ({ src: devScriptUrl(file, String(spec)) })),
  serverFunctions: {
    async lookup(id, version) {
      const entries = await serverFnEntries(String(version ?? "0"));
      return entries[id] ?? null;
    },
    // dev has no dist, so import sources directly (loader-hooks bridges to the Rust transform).
    importModule: (m, version) =>
      import(`${pathToFileURL(path.join(appRoot, m)).href}?v=${version}`),
  },
  live: {
    async lookup(name, version) {
      const reg = await loadIslandRegistry(appRoot, String(version ?? "0"));
      return [...reg.values()].find((e) => e.name === name && e.live)?.mod ?? null;
    },
    render: liveRender,
  },
  renderDocument,
  renderShell,
  onError: (err, ctx) => reportError("ssr", err, ctx?.url?.pathname),
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
  if (req.method === "GET" && req.url.split("?")[0] === "/__nowaki/dev-info") {
    try {
      const version = new URL(req.url, "http://localhost").searchParams.get("v") ?? "0";
      const info = await devInfo(version);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(info));
    } catch (err) {
      // The stack goes to the terminal, not into the response (Rust only needs the failure).
      console.error("[nowaki dev-info]", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }
  if (req.method === "POST" && req.url.split("?")[0] === "/__nowaki/live-render") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { name, state, handler, payload, version, sig, request, load, verifyOnly } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (verifyOnly) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ verified: liveSigStatus(name, state, sig) }));
        return;
      }
      if (envReady !== true) await ensureEnv(String(version ?? "0"));
      await ensureSession(String(version ?? "0"));
      const reg = await loadIslandRegistry(appRoot, String(version ?? "0"));
      const entry = [...reg.values()].find((e) => e.name === name);
      if (!entry?.live) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "live island not found" }));
        return;
      }
      const ctx = liveContext(request);
      const result = await runWithContext(ctx, () =>
        liveRender(entry.mod, state, handler, payload, name, sig, { load }),
      );
      result.shareable = liveShareable(entry.mod, { handler, load, contextRead: !!ctx && contextReads.has(ctx) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err?.code === "NOWAKI_LIVE_STALE") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stale" }));
        return;
      }
      if (err instanceof LiveForbiddenError) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      console.error("[nowaki live]", err);
      reportError("live", err);
      // Logged above with its stack; the response carries only the message.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }
  try {
    const version = String(req.headers["x-nowaki-ssr-version"] ?? "0");
    if (!baseRead) ensureBasePath();
    if (envReady !== true) await ensureEnv(version);
    await ensureContent(version);
    await ensureSession(version);
    const url = new URL(req.url, requestOrigin((name) => req.headers[name]));
    const result = await handleRequest(env, {
      method: req.method,
      url,
      version,
      req,
      // Set by the Rust front for a rewrite or basePath (a client's own value never gets here).
      routePath: req.headers["x-nowaki-route-path"],
    });
    await sendResult(res, result);
  } catch (err) {
    console.error("[nowaki ssr]", err);
    reportError("ssr", err, req.url.split("?")[0]);
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(errorPage(String(err?.stack ?? err)));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_SIDECAR_READY ${server.address().port}`);
});
