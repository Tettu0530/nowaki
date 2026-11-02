// Request handler shared by dev / prod / edge. Environment differences are injected via env.

import { Readable } from "node:stream";
import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";

import { matchRoute } from "./router.mjs";
import { makeContext } from "./context.mjs";
import { dispatchServerFn, SERVER_FN_PATH } from "./functions.mjs";

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
export async function handleRequest(env, info) {
  const { method, url, version } = info;
  const table = await env.routeTable(version);
  const match = matchRoute(table.routes, url.pathname);
  const ctx = makeContext({ ...info, params: match?.params ?? {} });

  // Handle server function RPC before routing.
  if (env.serverFunctions && url.pathname === SERVER_FN_PATH) {
    return finalize(ctx, await dispatchServerFn(ctx, info, env.serverFunctions));
  }

  if (method === "GET" && url.pathname === BOUNDARIES_PATH) {
    return finalize(ctx, await renderBoundaries(env, table, version));
  }

  try {
    // Middleware runs before the 404 check and short-circuits if it returns a Response.
    const short = await runMiddleware(env, table, ctx, version);
    if (short) return finalize(ctx, short);

    if (!match) return finalize(ctx, await render404(env, table, ctx, version));

    const mod = await env.importModule(match.file, version);

    if (match.isApi) return finalize(ctx, await handleApi(mod, ctx));

    if (method !== "GET" && method !== "HEAD" && typeof mod.action === "function") {
      const out = await mod.action(ctx);
      const res = toResult(out);
      if (res) return finalize(ctx, res);
      ctx.actionData = out; // data → re-render the page
    }

    return finalize(ctx, await renderRoute(env, table, match, mod, ctx, version));
  } catch (err) {
    if (ctx._redirect) return finalize(ctx, ctx._redirect); // throw path of ctx.redirect()
    return finalize(ctx, await render500(env, table, ctx, version, err));
  }
}

function finalize(ctx, result) {
  if (!result) return { status: 500, headers: HTML, body: "Internal Error" };
  const headers = { ...(result.headers ?? {}) };
  for (const [k, v] of ctx.resHeaders) {
    if (k.toLowerCase() === "set-cookie") continue;
    if (headers[k] === undefined) headers[k] = v;
  }
  const cookies = ctx.collectSetCookies();
  if (cookies.length) headers["set-cookie"] = cookies.length === 1 ? cookies[0] : cookies;
  let status = result.status ?? ctx.resStatus ?? 200;
  if (ctx.resStatus && (result.status === undefined || result.status === 200)) {
    status = ctx.resStatus;
  }
  return { status, headers, body: result.body, stream: result.stream };
}

// table.middleware is in root→leaf order.
async function runMiddleware(env, table, ctx, version) {
  for (const entry of table.middleware ?? []) {
    if (!underPrefix(ctx.url.pathname, entry.prefix)) continue;
    const mod = await env.importModule(entry.file, version);
    const fn = mod.default ?? mod.middleware;
    if (typeof fn !== "function") continue;
    const out = await fn(ctx);
    const res = toResult(out);
    if (res) return res;
  }
  return null;
}

async function handleApi(mod, ctx) {
  const fn = pickMethodHandler(mod, ctx.method);
  if (!fn) {
    return { status: 405, headers: JSON_CT, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }
  const out = await fn(ctx);
  const res = toResult(out);
  if (res) return res;
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

function pickMethodHandler(mod, method) {
  const named = mod[method] ?? mod[method?.toLowerCase?.()];
  if (typeof named === "function") return named;
  if (typeof mod.default === "function") return mod.default;
  return null;
}

async function renderRoute(env, table, match, mod, ctx, version) {
  await env.ensureIslands(version);
  const Page = mod.default;
  if (typeof Page !== "function") {
    throw new Error(`Route does not default-export a component: ${ctx.url.pathname}`);
  }
  const data = mod.loader ? await mod.loader(ctx) : undefined;
  const meta = await resolveMeta(mod, { data, params: ctx.params, url: ctx.url });
  let node = h(Page, { data, actionData: ctx.actionData, params: ctx.params, url: ctx.url });

  // wrap outward in leaf→root order
  const layouts = layoutChain(table, match.file);
  for (let i = layouts.length - 1; i >= 0; i--) {
    const lmod = await env.importModule(layouts[i], version);
    const Layout = lmod.default;
    if (typeof Layout !== "function") continue;
    const ldata = lmod.loader ? await lmod.loader(ctx) : undefined;
    node = h(Layout, { data: ldata, params: ctx.params, url: ctx.url, children: node });
  }

  // With a shared Cache-Control, CDNs do ISR as-is. The `nowaki start` Rust front
  // reads x-nowaki-revalidate and caches in memory.
  const revalidate = isrSeconds(mod);

  // Streaming SSR sends the shell immediately to cut TTFB (only in envs with env.renderShell).
  if (mod.streaming === true && typeof env.renderShell === "function") {
    const { head, tail } = env.renderShell({ mod, meta });
    const bodyStream = await renderToReadableStream(node);
    const headers = revalidate ? { ...HTML, "cache-control": swr(revalidate) } : HTML;
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
      "cache-control": swr(revalidate),
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

// The client router fetches this once at startup. Error boundaries receive the message and reset
// through the data-nowaki-error / data-nowaki-reset slots.
async function renderBoundaries(env, table, version) {
  await env.ensureIslands(version);
  const renderOne = async (entry, props) => {
    try {
      const mod = await env.importModule(entry.file, version);
      if (typeof mod.default !== "function") return null;
      const html = await renderToStringAsync(h(mod.default, props));
      return { prefix: entry.prefix, html };
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
  if (typeof mod.meta === "function") {
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
  };
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
      return { status: 404, headers: HTML, body: env.renderDocument({ mod, body }) };
    }
  }
  return { status: 404, headers: HTML, body: "<h1>404 Not Found</h1>" };
}

async function render500(env, table, ctx, version, err) {
  if (table.errorRoute && !ctx._inErrorPage) {
    try {
      ctx._inErrorPage = true;
      const mod = await env.importModule(table.errorRoute, version);
      if (typeof mod.default === "function") {
        await env.ensureIslands(version);
        const message = env.dev ? String(err?.stack ?? err) : String(err?.message ?? err);
        const body = await renderToStringAsync(h(mod.default, { error: { message }, url: ctx.url }));
        return { status: 500, headers: HTML, body: env.renderDocument({ mod, body }) };
      }
    } catch {
      // if the user's 500 page itself throws, fall back to the built-in one below
    }
  }
  return env.renderError(err);
}

// Returns in root→leaf order.
function layoutChain(table, file) {
  const chain = [];
  for (const entry of table.layouts ?? []) {
    if (underPrefix(routeUrlOf(table, file), entry.prefix)) chain.push(entry.file);
  }
  return chain;
}

function routeUrlOf(table, file) {
  const r = (table.routes ?? []).find((x) => x.file === file);
  if (!r) return "/";
  return "/" + r.segments.map((s) => (s.lit ?? `:${s.param}`)).join("/");
}

// prefix="" matches everything.
function underPrefix(pathname, prefix) {
  if (!prefix) return true;
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
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
