// Request handler shared by dev / prod / edge. Environment differences are injected via env.

import { Readable } from "node:stream";
import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";

import { matchRoute, matchSlot, pathParts, prefixDepth, routeUnderPrefix, underPrefix } from "./router.mjs";
import { mergeAttrs } from "./document.mjs";
import { mergeMeta, robotsTxt, seoTags, sitemapXml } from "./seo.mjs";
import { sitemapUrls } from "./isr-urls.mjs";
import { makeContext } from "./context.mjs";
import { dispatchServerFn, runWithContext, SERVER_FN_PATH } from "./functions.mjs";
import { isCrossSite } from "./origin.mjs";
import { dispatchLiveEvent, LIVE_EVENT_PATH } from "./live-event.mjs";

// Internal path the client router fetches loading/error boundary HTML from, once.
export const BOUNDARIES_PATH = "/__nowaki/boundaries";

export async function sendResult(res, result) {
  res.writeHead(result.status ?? 200, result.headers ?? {});
  if (result.stream) {
    Readable.fromWeb(result.stream).pipe(res);
    return;
  }
  res.end(result.body ?? "");
}

const HTML = { "content-type": "text/html; charset=utf-8" };
const JSON_CT = { "content-type": "application/json; charset=utf-8" };

/// env provides:
///   routeTable(version) -> { routes, layouts, middleware, notFound, errorRoute }
///   importModule(file, version) -> module
///   ensureIslands(version) -> prepares the island registry (call before rendering)
///   renderDocument({ mod, body }) -> final HTML string
///   renderError(err) -> { status, headers, body } (500 page differs between dev/prod)
///   onError(err, ctx) (optional) -> called for every error that becomes a 500 page
///   live (optional) -> { lookup(name, version), render } for POST /__nowaki/live-event
export async function handleRequest(env, info) {
  const { method, url, version } = info;
  const table = await env.routeTable(version);
  // What routing, middleware and the 404 see; ctx.url stays the URL the browser asked for.
  const path = resolveRequestPath(env, info, url);
  const match = matchRoute(table.routes, path);
  const ctx = makeContext({ ...info, params: match?.params ?? {} });
  // The site's URL (NOWAKI_SITE / nowaki.config `site`), for absolute links in feeds and the like.
  // Parsed on first read: most requests never look at it.
  let site;
  Object.defineProperty(ctx, "site", {
    get: () => (env.site ? (site ??= new URL(env.site)) : undefined),
    configurable: true,
    enumerable: true,
  });

  // Handle server function RPC before routing.
  if (env.serverFunctions && url.pathname === SERVER_FN_PATH) {
    return finalize(ctx, await dispatchServerFn(ctx, info, env.serverFunctions, { dev: env.dev === true }));
  }
  if (env.live && url.pathname === LIVE_EVENT_PATH) {
    // The event runs with this request as getContext() (handlers and live.authorize see its cookies).
    return finalize(ctx, await runWithContext(ctx, () => dispatchLiveEvent(ctx, info, env.live)));
  }

  if (method === "GET" && url.pathname === BOUNDARIES_PATH) {
    return finalize(ctx, await renderBoundaries(env, table, version));
  }

  try {
    const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const crossOrigin = unsafe && isCrossSite(rawHeader(info));
    // A cross-site write sees an empty, read-only session from the first middleware on; the
    // route's `csrf = false` lifts that below (for a session nothing has read yet).
    if (crossOrigin) ctx.__sessionMode = "crossSite";

    // Middleware runs before the 404 check and short-circuits if it returns a Response.
    const short = await runMiddleware(env, table, ctx, version, path, match);
    if (short) return finalize(ctx, short, env, table, version);

    if (!match) {
      // With a site URL, sitemap.xml and robots.txt are generated unless a route or a public/
      // file (served before this) provides them.
      if (env.site && (method === "GET" || method === "HEAD")) {
        if (path === "/sitemap.xml") {
          const body = sitemapXml(env.site, await sitemapUrls(env, version), { staticOutput: env.staticOutput === true });
          return finalize(ctx, { status: 200, headers: { "content-type": "application/xml; charset=utf-8" }, body }, env, table, version);
        }
        if (path === "/robots.txt") {
          return finalize(ctx, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: robotsTxt(env.site) }, env, table, version);
        }
      }
      return finalize(ctx, await render404(env, table, ctx, version), env, table, version);
    }

    const mod = await env.importModule(match.file, version);

    const crossSite = crossOrigin && mod.csrf !== false;
    if (crossOrigin && !crossSite) ctx.__sessionMode = undefined;

    if (match.isApi) {
      if (crossSite) {
        // Phase 1 for API routes: warn; `export const csrf = true` enforces now.
        if (mod.csrf === true) return finalize(ctx, FORBIDDEN, env, table, version);
        warnCrossSiteApi(match.file, url.pathname);
      }
      return finalize(ctx, await handleApi(mod, ctx, match.fileExt), env, table, version);
    }

    if (crossSite && typeof mod.action === "function") return finalize(ctx, FORBIDDEN, env, table, version);

    if (method !== "GET" && method !== "HEAD" && typeof mod.action === "function") {
      const out = await mod.action(ctx);
      const res = toResult(out);
      if (res) return finalize(ctx, res, env, table, version);
      ctx.actionData = out; // data → re-render the page
    }

    return finalize(ctx, await renderRoute(env, table, match, mod, ctx, version, path), env, table, version);
  } catch (err) {
    if (ctx._redirect) return finalize(ctx, ctx._redirect, env, table, version); // throw path of ctx.redirect()
    return finalize(ctx, await render500(env, table, ctx, version, err), env, table, version);
  }
}

// The path the request is routed by. Identity for now; rewrites, basePath and i18n prefixes will
// map the browser's path to the route's here. `info.routePath` lets a front that already resolved
// it pass it in.
function resolveRequestPath(env, info, url) {
  return info.routePath ?? url.pathname;
}

const FORBIDDEN = { status: 403, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Forbidden" };

// Read request headers without going through ctx.get, which records Vary inputs for ISR.
function rawHeader(info) {
  const h = info.headers ?? info.req?.headers ?? {};
  return typeof h.get === "function" ? (n) => h.get(n) ?? undefined : (n) => h[n];
}

const warnedApi = new Set();
function warnCrossSiteApi(file, pathname) {
  if (warnedApi.has(file)) return;
  warnedApi.add(file);
  console.warn(
    `[nowaki] cross-site non-GET request to API route ${pathname} was allowed. A later release rejects these by default; add \`export const csrf = true\` to reject now, or \`export const csrf = false\` to keep allowing them.`,
  );
}

// `ctx.__commit(result)` (sessions) runs before the response headers are built, so a cookie it sets
// goes out. Without one the result is built synchronously: the common path adds no await. A commit
// that fails (a store error, a cookie over 4 KB) is handled here, since the promise returned from
// the handler's try block would escape its catch: the 500 page when the route table is given,
// else a plain 500.
function finalize(ctx, result, env, table, version) {
  if (!ctx.__commit) return finalizeResult(ctx, result);
  return commitAndFinalize(ctx, result, env, table, version);
}

async function commitAndFinalize(ctx, result, env, table, version) {
  const commit = ctx.__commit;
  ctx.__commit = undefined;
  try {
    await commit(result);
  } catch (err) {
    return finalizeResult(ctx, table ? await render500(env, table, ctx, version, err) : plainError(err));
  }
  return finalizeResult(ctx, result);
}

function plainError(err) {
  console.error("[nowaki]", err);
  return { status: 500, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Internal Server Error" };
}

function finalizeResult(ctx, result) {
  if (!result) return { status: 500, headers: HTML, body: "Internal Error" };
  // The headers are fixed now while code still runs (an early-streamed loader): a session write
  // from there throws instead of being lost.
  if (result.stream) ctx.__sent = true;
  const headers = { ...(result.headers ?? {}) };
  for (const [k, v] of ctx.resHeaders) {
    if (k.toLowerCase() === "set-cookie") continue;
    if (headers[k] === undefined) headers[k] = v;
  }
  const cookies = ctx.collectSetCookies();
  if (cookies.length) headers["set-cookie"] = cookies.length === 1 ? cookies[0] : cookies;
  privateIfSetsCookie(headers);
  let status = result.status ?? ctx.resStatus ?? 200;
  if (ctx.resStatus && (result.status === undefined || result.status === 200)) {
    status = ctx.resStatus;
  }
  return { status, headers, body: result.body, stream: result.stream };
}

// A response that sets a cookie is per-user: a shared cache (CDN, an adapter host's edge) must not
// store it and replay the cookie to other visitors, whatever Cache-Control the render asked for.
export function privateIfSetsCookie(headers) {
  const keys = Object.keys(headers);
  if (!keys.some((k) => k.toLowerCase() === "set-cookie")) return headers;
  const cc = keys.find((k) => k.toLowerCase() === "cache-control");
  if (cc !== undefined && /\b(public|s-maxage)\b/i.test(String(headers[cc]))) {
    delete headers[cc];
    headers["cache-control"] = "private, no-cache";
  }
  return headers;
}

// table.middleware is in root→leaf order. A middleware runs for every request whose URL is under
// its directory, whichever route (if any) serves it: routes/admin/_middleware.ts guards
// /admin/x even when routes/[...slug].tsx is the route that matched, and the 404 under /admin.
// A route group's middleware (`group`) has no URL to match, so it runs only for the routes whose
// files are inside the group's directory, and not for 404s.
async function runMiddleware(env, table, ctx, version, path, match) {
  for (const entry of table.middleware ?? []) {
    if (entry.group ? !(match && groupMiddleware(table, match.file).has(entry)) : !underPrefix(path, entry.prefix)) continue;
    const mod = await env.importModule(entry.file, version);
    const fn = mod.default ?? mod.middleware;
    if (typeof fn !== "function") continue;
    const out = await fn(ctx);
    const res = toResult(out);
    if (res) return res;
  }
  return null;
}

async function handleApi(mod, ctx, fileExt) {
  const fn = pickMethodHandler(mod, ctx.method);
  if (!fn) {
    return { status: 405, headers: JSON_CT, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }
  const out = await fn(ctx);
  const res = toResult(out);
  if (res) return res;
  // File routes (feed.xml.ts, og/[card].png.ts): a string or bytes is the file itself, typed by
  // the route's extension. Objects are still JSON.
  if (fileExt && (typeof out === "string" || out instanceof Uint8Array || out instanceof ArrayBuffer)) {
    return {
      status: 200,
      headers: { "content-type": contentTypeForExt(fileExt) },
      body: out instanceof ArrayBuffer ? new Uint8Array(out) : out,
    };
  }
  // also supports legacy { status, headers, body }
  if (out && typeof out === "object" && ("body" in out || "status" in out)) {
    return {
      status: out.status ?? 200,
      headers: { ...JSON_CT, ...(out.headers ?? {}) },
      body: typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? null),
    };
  }
  return { status: 200, headers: JSON_CT, body: JSON.stringify(out ?? null) };
}

// Kept in step with nowaki-core `public::content_type` (the same types a file in public/ gets).
const EXT_TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json",
  map: "application/json", webmanifest: "application/manifest+json", txt: "text/plain; charset=utf-8",
  xml: "application/xml", rss: "application/rss+xml", atom: "application/atom+xml", csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  pdf: "application/pdf", wasm: "application/wasm", ics: "text/calendar; charset=utf-8",
};
function contentTypeForExt(ext) {
  return EXT_TYPES[ext.slice(1).toLowerCase()] ?? "application/octet-stream";
}

function pickMethodHandler(mod, method) {
  const named = mod[method] ?? mod[method?.toLowerCase?.()];
  if (typeof named === "function") return named;
  if (typeof mod.default === "function") return mod.default;
  return null;
}

async function renderRoute(env, table, match, mod, ctx, version, path) {
  await env.ensureIslands(version);
  const Page = mod.default;
  if (typeof Page !== "function") {
    throw new Error(`Route does not default-export a component: ${ctx.url.pathname}`);
  }
  const slots = resolveSlots(table, match.file, path);
  const slotFiles = slots ? renderedSlotFiles(slots) : undefined;
  // `streaming = "early"`: the shell goes out before any loader runs (TTFB doesn't wait for data).
  // The trade-off: once it's sent, the status and headers are fixed, so `meta` only sees the static
  // exports, and a loader redirect or error is handled inside the stream (see earlyDocument).
  if (mod.streaming === "early" && typeof env.renderShell === "function") {
    const meta = await withDocAttrs(env, table, match.file, mod, version, withFonts(env, await withScripts(env, table, match.file, mod, version, await withSeo(env, table, match.file, mod, version, ctx, await withRouteCss(env, match.file, mod, version, await resolveMeta(mod, { data: undefined, params: ctx.params, url: ctx.url }), slotFiles)), slotFiles)));
    const { head, tail } = env.renderShell({ mod, meta });
    const revalidate = isrSeconds(mod);
    return {
      status: 200,
      // The loaders run after the headers are sent, so what the page reads from the request is
      // unknown here: never mark it shareable (a CDN could serve one visitor's page to another).
      headers: revalidate ? { ...HTML, "cache-control": "private, no-cache" } : HTML,
      stream: earlyDocument(head, tail, {
        node: async () => {
          const n = await routeNode(env, table, match, mod, ctx, version, slots);
          if (ctx._redirect) throw ctx._redirect; // `return ctx.redirect(…)` from a loader
          return n;
        },
        onError: (err) => earlyError(env, table, ctx, version, err, match.file),
      }),
    };
  }
  const data = mod.loader ? await mod.loader(ctx) : undefined;
  const meta = await withDocAttrs(env, table, match.file, mod, version, withFonts(env, await withScripts(env, table, match.file, mod, version, await withSeo(env, table, match.file, mod, version, ctx, await withRouteCss(env, match.file, mod, version, await resolveMeta(mod, { data, params: ctx.params, url: ctx.url }), slotFiles)), slotFiles)));
  const node = await wrapLayouts(env, table, match.file, h(Page, { data, actionData: ctx.actionData, params: ctx.params, url: ctx.url }), ctx, version, slots);

  // With a shared Cache-Control, CDNs do ISR as-is. The `nowaki start` Rust front
  // reads x-nowaki-revalidate and caches in memory.
  const revalidate = isrSeconds(mod);

  // Streaming SSR sends the shell immediately to cut TTFB (only in envs with env.renderShell).
  if (mod.streaming === true && typeof env.renderShell === "function") {
    const { head, tail } = env.renderShell({ mod, meta });
    const bodyStream = await renderToReadableStream(node);
    // The loaders have run (above), so the request inputs they read are known.
    const headers = revalidate ? { ...HTML, ...sharedCacheHeaders(revalidate, ctx.__vary()) } : HTML;
    return {
      status: 200,
      headers,
      stream: streamedDocument(head, bodyStream, tail),
    };
  }

  const body = await renderToStringAsync(node);
  let headers = HTML;
  if (revalidate) {
    // start.rs folds Vary into the cache key, preventing cross-user leaks and query floods.
    const vary = ctx.__vary();
    headers = {
      ...HTML,
      ...sharedCacheHeaders(revalidate, vary),
      "x-nowaki-revalidate": String(revalidate),
      "x-nowaki-vary": vary.headers.join(","),
      "x-nowaki-vary-query": vary.query ? "1" : "0",
    };
  }
  return { status: 200, headers, body: env.renderDocument({ mod, body, meta }) };
}

function isrSeconds(mod) {
  const r = Number(mod?.revalidate);
  return Number.isFinite(r) && r > 0 ? Math.floor(r) : null;
}

function swr(seconds) {
  return `public, s-maxage=${seconds}, stale-while-revalidate`;
}

// Cache headers an ISR page sends to browsers and CDNs. `vary` is what the render read from the
// request (ctx.__vary()). x-nowaki-vary only reaches the `nowaki start` cache, so a CDN in front
// (or the edge of an adapter's host) needs the standard headers:
// - cookie / authorization / the whole request ("*"): the page is per-user. `private`, never
//   shared; some CDNs ignore `Vary: Cookie`, so Vary alone isn't enough.
// - other headers (accept-language, …): shareable, with `Vary` naming them.
// - the query string needs nothing: it is part of the URL every cache keys by.
const PER_USER = new Set(["*", "cookie", "authorization"]);
export function sharedCacheHeaders(revalidate, vary) {
  const read = vary?.headers ?? [];
  if (read.some((h) => PER_USER.has(h))) return { "cache-control": "private, no-cache" };
  const out = { "cache-control": swr(revalidate) };
  if (read.length) out.vary = read.join(", ");
  return out;
}

// The client router fetches this once at startup. Error boundaries receive the message and reset
// through the data-nowaki-error / data-nowaki-reset slots.
async function renderBoundaries(env, table, version) {
  await env.ensureIslands(version);
  const renderOne = async (entry, props) => {
    try {
      const mod = await env.importModule(entry.file, version);
      if (typeof mod.default !== "function") return null;
      const html = await renderToStringAsync(h(mod.default, props));
      // The client matches boundaries by URL, so route groups are left out of the prefix.
      return { prefix: entry.urlPrefix ?? entry.prefix, html };
    } catch {
      return null; // a failing boundary must not break everything
    }
  };
  const loading = (
    await Promise.all((table.loadingBoundaries ?? []).map((e) => renderOne(e, {})))
  ).filter(Boolean);
  const error = (
    await Promise.all(
      (table.errorBoundaries ?? []).map((e) =>
        renderOne(e, { error: { message: "" }, reset: () => {} }),
      ),
    )
  ).filter(Boolean);
  return { status: 200, headers: JSON_CT, body: JSON.stringify({ loading, error }) };
}

async function resolveMeta(mod, info) {
  let dyn = null;
  if (mod.meta && typeof mod.meta === "object") {
    dyn = mod.meta; // `export const meta = { title, description, openGraph, … }`
  } else if (typeof mod.meta === "function") {
    try {
      dyn = await mod.meta(info);
    } catch {
      dyn = null; // keep rendering the page even if meta throws
    }
  }
  const str = (v) => (typeof v === "string" ? v : undefined);
  return {
    title: str(dyn?.title) ?? str(mod.title),
    head: str(dyn?.head) ?? str(mod.head),
    lang: str(dyn?.lang) ?? str(mod.lang),
    htmlAttrs: dyn?.htmlAttrs,
    bodyAttrs: dyn?.bodyAttrs,
    seo: dyn && typeof dyn === "object" ? dyn : undefined,
  };
}

// The typed meta's head tags (seo.mjs): layouts' `export const meta` objects first (site-wide
// defaults like openGraph.siteName), then the route's meta. They go after the route CSS and before
// the page's own `head`.
// Layouts' own `export const head` strings (root first) go here too, before the page's `head`.
async function withSeo(env, table, file, mod, version, ctx, meta) {
  const layouts = [];
  const layoutHeads = [];
  for (const f of file ? layoutChain(table, file) : []) {
    const l = await env.importModule(f, version);
    if (l?.meta && typeof l.meta === "object") layouts.push(l.meta);
    if (typeof l?.head === "string" && l.head) layoutHeads.push(l.head);
  }
  const own = meta?.seo ?? (mod?.meta && typeof mod.meta === "object" ? mod.meta : undefined);
  if (layouts.length === 0 && !own && layoutHeads.length === 0) return meta;
  const merged = mergeMeta(...layouts, own);
  const title = (typeof meta?.title === "string" ? meta.title : undefined) ?? merged.title ?? mod?.title;
  const tags = [seoTags(merged, { title, pathname: ctx.url.pathname, origin: ctx.url.origin, site: env.site, staticOutput: env.staticOutput === true }), ...layoutHeads]
    .filter(Boolean)
    .join("\n");
  const next = { ...(meta ?? {}) };
  if (next.title === undefined && typeof merged.title === "string") next.title = merged.title;
  if (!tags) return next;
  const head = typeof next.head === "string" ? next.head : typeof mod?.head === "string" ? mod.head : "";
  const lead = head.match(/^(?:<link rel="stylesheet"[^>]*>\n?)*/)?.[0] ?? "";
  const sep = lead && !lead.endsWith("\n") ? "\n" : "";
  next.head = `${lead}${sep}${tags}${head.length > lead.length ? `\n${head.slice(lead.length)}` : ""}`;
  return next;
}

// Page scripts (`export const scripts`) of the layouts (root first) and the route, as module
// <script> tags with preloads for their chunks, at the end of the page's head region so the
// stylesheets come first and the SPA router can load them on navigation. `env.routeScripts(file,
// mod, version)` returns [{ src, preload }] (the build's manifest, or the dev server's URLs).
// `slotFiles`: the parallel-route slot files the page renders, after the page.
async function withScripts(env, table, file, mod, version, meta, slotFiles) {
  if (typeof env.routeScripts !== "function" || !file) return meta;
  const esc = (h) => String(h).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const seen = new Set();
  const tags = [];
  const files = [...layoutChain(table, file), file];
  if (slotFiles) files.push(...slotFiles);
  for (const f of files) {
    const m = f === file ? mod : await env.importModule(f, version);
    for (const s of (await env.routeScripts(f, m, version)) ?? []) {
      if (!s?.src || seen.has(s.src)) continue;
      seen.add(s.src);
      for (const p of s.preload ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        tags.push(`<link rel="modulepreload" href="${esc(p)}" />`);
      }
      tags.push(`<script type="module" src="${esc(s.src)}" data-nowaki-script></script>`);
    }
  }
  if (tags.length === 0) return meta;
  const own = typeof meta?.head === "string" ? meta.head : typeof mod?.head === "string" ? mod.head : "";
  return { ...(meta ?? {}), head: own ? `${own}\n${tags.join("\n")}` : tags.join("\n") };
}

// Self-hosted fonts (`fonts` in nowaki.config, built by fonts.rs): preloads for the faces marked
// for it and the stylesheet, first in every page's head. `env.fonts` is `{ css, preload }`.
function withFonts(env, meta) {
  const f = env.fonts;
  if (!f?.css) return meta;
  const esc = (h) => String(h).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const links = [
    ...(f.preload ?? []).map((p) => `<link rel="preload" href="${esc(p.href)}" as="font" type="${esc(p.type)}" crossorigin />`),
    `<link rel="stylesheet" href="${esc(f.css)}" />`,
  ].join("\n");
  const head = typeof meta?.head === "string" ? meta.head : "";
  return { ...(meta ?? {}), head: head ? `${links}\n${head}` : links };
}

// `export const htmlAttrs` / `bodyAttrs` from the layouts (root first), then the route, then what
// the route's meta() returned, merged into one object each (document.mjs `mergeAttrs`).
async function withDocAttrs(env, table, file, mod, version, meta) {
  const layouts = [];
  for (const f of layoutChain(table, file)) layouts.push(await env.importModule(f, version));
  const merged = (key) => mergeAttrs(...layouts.map((l) => l?.[key]), mod?.[key], meta?.[key]);
  return { ...(meta ?? {}), htmlAttrs: merged("htmlAttrs"), bodyAttrs: merged("bodyAttrs") };
}

// The page wrapped in its layouts, with every loader run (route first, then layouts leaf → root).
async function routeNode(env, table, match, mod, ctx, version, slots) {
  const data = mod.loader ? await mod.loader(ctx) : undefined;
  return wrapLayouts(env, table, match.file, h(mod.default, { data, actionData: ctx.actionData, params: ctx.params, url: ctx.url }), ctx, version, slots);
}

const NO_SLOTS = Object.freeze({});

// Wraps the page node in the file's layouts, leaf → root, running each layout's loader in turn.
// `slots` (resolveSlots, aligned with the layout chain) holds what each layout's @slots render;
// a layout's slots render (their loaders run) just before its own loader.
async function wrapLayouts(env, table, file, node, ctx, version, slots) {
  const layouts = layoutChain(table, file);
  for (let i = layouts.length - 1; i >= 0; i--) {
    const lmod = await env.importModule(layouts[i], version);
    const Layout = lmod.default;
    if (typeof Layout !== "function") continue;
    const slotNodes = slots?.[i] ? await renderSlots(env, slots[i], ctx, version) : NO_SLOTS;
    const ldata = lmod.loader ? await lmod.loader(ctx) : undefined;
    node = h(Layout, { data: ldata, params: ctx.params, url: ctx.url, slots: slotNodes, children: node });
  }
  return node;
}

// One layout's slots: name → its node wrapped in <nowaki-slot name>, or null when the slot has
// nothing to render (no matching file and no default). Loaders of sibling slots run together.
async function renderSlots(env, resolved, ctx, version) {
  const out = {};
  await Promise.all(
    resolved.map(async ({ name, hit }) => {
      out[name] = null;
      if (!hit) return;
      const smod = await env.importModule(hit.file, version);
      const Slot = smod.default;
      if (typeof Slot !== "function") return;
      // A slot route has its own params (its URL pattern); a default sees the page's.
      const sctx = hit.params ? slotContext(ctx, hit.params) : ctx;
      const data = smod.loader ? await smod.loader(sctx) : undefined;
      out[name] = h("nowaki-slot", { name, style: "display:contents" }, h(Slot, { data, params: sctx.params, url: ctx.url }));
    }),
  );
  return out;
}

// The request's context with other params. Everything else (writes included) goes to ctx itself.
function slotContext(ctx, params) {
  return new Proxy(ctx, { get: (target, prop) => (prop === "params" ? params : target[prop]) });
}

// What every @slot owned by a layout in the file's chain renders for this request path, as an
// array aligned with layoutChain (null where a layout owns no slots): [{ name, hit }] with hit
// from matchSlot. null when no layout in the chain owns a slot. An app without slots pays the one
// length check.
function resolveSlots(table, file, path) {
  if (!table.slots?.length) return null;
  const owners = slotOwners(table, file);
  if (!owners) return null;
  const parts = pathParts(path);
  return owners.map((slots) => slots && slots.map((slot) => ({ name: slot.name, hit: matchSlot(slot, parts) })));
}

function renderedSlotFiles(slots) {
  const files = [];
  for (const layout of slots) for (const s of layout ?? []) if (s.hit) files.push(s.hit.file);
  return files.length ? files : undefined;
}

// The slots of each layout in a file's chain (aligned with layoutChain, null for a layout without
// any), or null when none has slots: once per route table and file, like layoutChain. A slot
// belongs to the _layout in the directory holding its @name directory.
const slotChains = new WeakMap();
function slotOwners(table, file) {
  let byFile = slotChains.get(table);
  if (!byFile) slotChains.set(table, (byFile = new Map()));
  let owners = byFile.get(file);
  if (owners === undefined) {
    const prefixOf = new Map((table.layouts ?? []).map((l) => [l.file, l.prefix]));
    const chain = layoutChain(table, file).map((lf) => {
      const own = table.slots.filter((s) => s.ownerDir === prefixOf.get(lf));
      return own.length ? own : null;
    });
    owners = chain.some(Boolean) ? chain : null;
    byFile.set(file, owners);
  }
  return owners;
}

// After an early shell, a redirect becomes a client-side `location.replace`, and an error renders
// the nearest error boundary (`error.tsx`) in place of the page. The message is shown only in dev.
async function earlyError(env, table, ctx, version, err, file) {
  const to = ctx._redirect?.headers?.location;
  if (to) {
    const url = JSON.stringify(String(to)).replace(/</g, "\\u003c");
    return `<script>location.replace(${url})</script>`;
  }
  console.error("[nowaki]", err);
  const route = routeOf(table, file);
  const boundary = (table.errorBoundaries ?? [])
    .filter((b) => (route ? routeUnderPrefix(route, b.prefix) : underPrefix(ctx.url.pathname, b.urlPrefix ?? b.prefix)))
    .sort((a, b) => prefixDepth(b.prefix) - prefixDepth(a.prefix))[0];
  if (boundary) {
    try {
      const bmod = await env.importModule(boundary.file, version);
      if (typeof bmod.default === "function") {
        const message = env.dev ? String(err?.message ?? err) : "";
        return await renderToStringAsync(h(bmod.default, { error: { message }, reset: () => {} }));
      }
    } catch {
      // fall through to the generic message
    }
  }
  return "<p>Something went wrong.</p>";
}

function earlyDocument(head, tail, { node, onError }) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(head));
      try {
        const reader = (await renderToReadableStream(await node())).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(typeof value === "string" ? enc.encode(value) : value);
        }
      } catch (err) {
        controller.enqueue(enc.encode(await onError(err)));
      }
      controller.enqueue(enc.encode(tail));
      controller.close();
    },
  });
}

function streamedDocument(head, bodyStream, tail) {
  const enc = new TextEncoder();
  const reader = bodyStream.getReader();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(head));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(typeof value === "string" ? enc.encode(value) : value);
      }
      controller.enqueue(enc.encode(tail));
      controller.close();
    },
  });
}

async function render404(env, table, ctx, version) {
  ctx.resStatus = 404;
  if (table.notFound) {
    const mod = await env.importModule(table.notFound, version);
    if (typeof mod.default === "function") {
      await env.ensureIslands(version);
      const body = await renderToStringAsync(h(mod.default, { url: ctx.url }));
      const meta = withFonts(env, await withScripts(env, table, table.notFound, mod, version, await withSeo(env, table, table.notFound, mod, version, ctx, await withRouteCss(env, table.notFound, mod, version))));
      return { status: 404, headers: HTML, body: env.renderDocument({ mod, body, meta }) };
    }
  }
  return { status: 404, headers: HTML, body: "<h1>404 Not Found</h1>" };
}

async function render500(env, table, ctx, version, err) {
  // Always on record: with a custom _500 page, the built-in renderError (which logs) never runs.
  if (typeof env.onError === "function") env.onError(err, ctx);
  else console.error(`[nowaki] ${ctx.method ?? "GET"} ${ctx.url?.pathname ?? ""}:`, err);
  if (table.errorRoute && !ctx._inErrorPage) {
    try {
      ctx._inErrorPage = true;
      const mod = await env.importModule(table.errorRoute, version);
      if (typeof mod.default === "function") {
        await env.ensureIslands(version);
        const message = env.dev ? String(err?.stack ?? err) : String(err?.message ?? err);
        const body = await renderToStringAsync(h(mod.default, { error: { message }, url: ctx.url }));
        const meta = withFonts(env, await withScripts(env, table, table.errorRoute, mod, version, await withSeo(env, table, table.errorRoute, mod, version, ctx, await withRouteCss(env, table.errorRoute, mod, version))));
        return { status: 500, headers: HTML, body: env.renderDocument({ mod, body, meta }) };
      }
    } catch {
      // if the user's 500 page itself throws, fall back to the built-in one below
    }
  }
  return env.renderError(err);
}

// Returns in root→leaf order. A page asks for it several times per request (layouts, SEO, page
// scripts, document attributes), so it is computed once per route table and file. A rescan in dev
// makes a new table, which starts a new cache.
const chains = new WeakMap();
function layoutChain(table, file) {
  let byFile = chains.get(table);
  if (!byFile) chains.set(table, (byFile = new Map()));
  let chain = byFile.get(file);
  if (!chain) {
    const route = routeOf(table, file);
    chain = [];
    for (const entry of table.layouts ?? []) {
      // A file that is not a route (the 404 page) gets only the root layouts.
      if (route ? routeUnderPrefix(route, entry.prefix) : !entry.prefix) chain.push(entry.file);
    }
    byFile.set(file, chain);
  }
  return chain;
}

// The group middleware entries whose directory contains a route file, once per route table and
// file like layoutChain. Only asked for when a group has middleware.
const groupMw = new WeakMap();
function groupMiddleware(table, file) {
  let byFile = groupMw.get(table);
  if (!byFile) groupMw.set(table, (byFile = new Map()));
  let set = byFile.get(file);
  if (!set) {
    const route = routeOf(table, file);
    set = new Set((table.middleware ?? []).filter((m) => m.group && route && routeUnderPrefix(route, m.prefix)));
    byFile.set(file, set);
  }
  return set;
}

function routeOf(table, file) {
  return file === undefined ? undefined : (table.routes ?? []).find((x) => x.file === file);
}

// Returning null means the value is treated as data.
function toResult(out) {
  if (out == null) return null;
  if (typeof Response !== "undefined" && out instanceof Response) {
    return responseToResult(out);
  }
  if (out && out.__nowakiResult) return out; // returned by ctx.redirect()/ctx.json()
  return null;
}

function responseToResult(res) {
  const headers = {};
  for (const [k, v] of res.headers) headers[k] = v;
  return { status: res.status, headers, stream: res.body, body: undefined, _response: res };
}

// Stylesheets for the CSS the route (and its layouts) imports: `env.routeCss(file, version)`
// returns their URLs (the build's `routeCss`, or the dev server's). They go first in the page's
// head, so `head` / `meta` styles still win, and the SPA router swaps them with the head.
// `slotFiles`: the parallel-route slot files the page renders; their stylesheets follow the page's.
async function withRouteCss(env, file, mod, version, meta, slotFiles) {
  let hrefs = typeof env.routeCss === "function" && file ? await env.routeCss(file, version) : null;
  if (slotFiles && typeof env.routeCss === "function") {
    const all = Array.isArray(hrefs) ? [...hrefs] : [];
    for (const f of slotFiles) {
      for (const href of (await env.routeCss(f, version)) ?? []) if (!all.includes(href)) all.push(href);
    }
    hrefs = all;
  }
  if (!Array.isArray(hrefs) || hrefs.length === 0) return meta;
  const links = hrefs.map((h) => `<link rel="stylesheet" href="${String(h).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}" />`).join("\n");
  const own = typeof meta?.head === "string" ? meta.head : typeof mod?.head === "string" ? mod.head : "";
  return { ...(meta ?? {}), head: own ? `${links}\n${own}` : links };
}
