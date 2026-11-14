// Dev SSR sidecar. Spawned by the Rust dev server; renders pages and runs API routes, live island
// renders (/__nowaki/live-render) and the dev tools' route info (/__nowaki/dev-info).
// Signals readiness to Rust with "NOWAKI_SIDECAR_READY <port>" on stdout.

import "./exit-with-parent.mjs";
import { createServer } from "node:http";
import { createRequire, register } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSite } from "./seo.mjs";
import { compileI18n, splitLocale } from "./i18n.mjs";
import { loadEnv } from "./env.mjs";
import { requestOrigin, requestUrl, trustSidecarHop } from "./origin.mjs";
import { traceFromEnv } from "./trace.mjs";
import { HEALTH_BODY, HEALTH_HEADERS, HEALTH_PATH } from "./health.mjs";

// Spawned by `nowaki dev`: a loopback Host is the Rust hop (see origin.mjs).
trustSidecarHop();

// load .env before routes so routes/loaders can read process.env
loadEnv();

// from here on, dynamically imported .tsx/.ts go through Rust's transform endpoint
register(new URL("./loader-hooks.mjs", import.meta.url), { data: { root: process.cwd() } });
register(new URL("./react-alias-hooks.mjs", import.meta.url));

const { scanRoutes, matchRoute, routeUnderPrefix, underPrefix } = await import("./router.mjs");
const { loadIslandRegistry, renderDocument, renderShell, errorPage } = await import("./render.mjs");
const { handleRequest, sendResult } = await import("./handler.mjs");
const { liveRender, liveContext, liveShareable, liveSigStatus, LiveForbiddenError } = await import("./live.mjs");
const { runWithContext, contextReads } = await import("./functions.mjs");
const { cspOn, markResult, runWithMarker } = await import("./nonce.mjs");
const { newNonce } = await import("./csp.mjs");
const { recentRevalidations, setRevalidateEnv } = await import("./revalidate.mjs");
const { pathToFileURL } = await import("node:url");
const { configOf } = await import("./site-config.mjs");

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
const { setServerEnv } = await import("./env-store.mjs");
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
const { setBasePath, basePath } = await import("./base-path.mjs");
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

// Dev doesn't build, so the Rust dev server discovers the server function allowlist. Cached per
// SSR version.
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
  return { routes, conventions, islands, revalidations: recentRevalidations() };
}

// For the dev MCP `page` tool and the dev toolbar (`/__nowaki/dev-info?url=…`): what serves one
// browser path. The base and the locale come off first, as for a request (rewrites don't apply).
// Rust adds the islands (from the module graph) and the JS estimate.
async function devPage(browserPath, version) {
  if (!baseRead) ensureBasePath();
  const table = await scanRoutes(appRoot);
  let routePath = browserPath.split(/[?#]/)[0] || "/";
  const base = basePath();
  if (base && (routePath === base || routePath.startsWith(base + "/"))) routePath = routePath.slice(base.length) || "/";
  let locale = null;
  const i18n = env.i18n;
  if (i18n) ({ locale, path: routePath } = splitLocale(i18n, routePath));
  const match = matchRoute(table, routePath);
  const route = match && table.routes.find((r) => r.file === match.file);
  const layouts = (table.layouts ?? []).filter((e) => (route ? routeUnderPrefix(route, e.prefix) : !e.prefix)).map((e) => rel(e.file));
  const middleware = (table.middleware ?? [])
    .filter((e) => (e.group ? route && routeUnderPrefix(route, e.prefix) : underPrefix(routePath, e.prefix)))
    .map((e) => rel(e.file));
  const page = { path: browserPath, routePath, locale, layouts, middleware, route: null };
  if (!route) {
    page.notFound = table.notFound ? rel(table.notFound) : null;
    return page;
  }
  const info = { pattern: routePattern(route.segments), file: rel(route.file), kind: route.fileExt ? "file" : route.isApi ? "api" : "page", params: match.params };
  try {
    const mod = await env.importModule(route.file, version);
    if (mod.revalidate !== undefined) info.revalidate = mod.revalidate;
    // An array is listed; a function runs per request (with params and the loader's data).
    if (Array.isArray(mod.tags)) info.tags = mod.tags.map(String);
    else if (typeof mod.tags === "function") info.tags = "function";
    if (mod.streaming !== undefined) info.streaming = mod.streaming;
  } catch (err) {
    info.loadError = String(err?.message ?? err);
  }
  page.route = info;
  return page;
}

// NOWAKI_SITE, else `site` in nowaki.config, and its `trailingSlash` (read once; restart dev
// after changing them).
const devConfig = await (async () => {
  for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
    const p = path.join(appRoot, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      return configOf(mod);
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

// i18n from .nowaki/routing.json, which `nowaki dev` writes before serving (a change needs a
// restart, like the rest of the routing config): read on the first request.
let devI18n;
function readDevI18n() {
  try {
    return compileI18n(JSON.parse(readFileSync(path.join(appRoot, ".nowaki/routing.json"), "utf8")));
  } catch {
    return null;
  }
}

const env = {
  dev: true,
  site: resolveSite(devConfig.site),
  trailingSlash: devConfig.trailingSlash,
  get fonts() {
    return devFonts();
  },
  get i18n() {
    if (devI18n === undefined) devI18n = readDevI18n();
    return devI18n;
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
      return Object.hasOwn(entries, id) ? entries[id] : null;
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
// Dev has no ISR cache: revalidate*() calls are only recorded (dev-info `revalidations`).
setRevalidateEnv(env);
// Server-Timing is always on in dev (OTEL_* still decides about spans).
env.trace = traceFromEnv(process.env, { timing: true });

const server = createServer(async (req, res) => {
  if (req.url === HEALTH_PATH) {
    res.writeHead(200, HEALTH_HEADERS).end(HEALTH_BODY);
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/__nowaki/dev-info") {
    try {
      const query = new URL(req.url, "http://localhost").searchParams;
      const version = query.get("v") ?? "0";
      const pagePath = query.get("url");
      const info = pagePath
        ? { page: await devPage(pagePath, version), revalidations: recentRevalidations() }
        : query.get("only") === "revalidations"
          ? { revalidations: recentRevalidations() }
          : await devInfo(version);
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
    const url = requestUrl(req.url, requestOrigin((name) => req.headers[name]));
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
    // Outside handleRequest, so its hmr.js tag gets a marker here (NOWAKI_CSP).
    const message = String(err?.stack ?? err);
    const marker = cspOn() ? newNonce() : null;
    const page = { status: 500, headers: { "content-type": "text/html; charset=utf-8" } };
    const { headers } = marker ? markResult(page, marker) : page;
    res.writeHead(500, headers);
    res.end(marker ? runWithMarker(marker, () => errorPage(message)) : errorPage(message));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_SIDECAR_READY ${server.address().port}`);
});
