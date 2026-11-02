// dev / prod / edge が共有するリクエストハンドラ。環境差分は env で注入する。

import { Readable } from "node:stream";
import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";

import { matchRoute } from "./router.mjs";
import { makeContext } from "./context.mjs";
import { dispatchServerFn, SERVER_FN_PATH } from "./functions.mjs";

// クライアントルーターが loading/error の境界 HTML を一度だけ取りに来る内部パス。
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

/// env が提供するもの:
///   routeTable(version) -> { routes, layouts, middleware, notFound, errorRoute }
///   importModule(file, version) -> モジュール
///   ensureIslands(version) -> 島レジストリを用意（描画前に呼ぶ）
///   renderDocument({ mod, body }) -> 完成 HTML 文字列
///   renderError(err) -> { status, headers, body }（dev/prod で表示が違う 500）
export async function handleRequest(env, info) {
  const { method, url, version } = info;
  const table = await env.routeTable(version);
  const match = matchRoute(table.routes, url.pathname);
  const ctx = makeContext({ ...info, params: match?.params ?? {} });

  // サーバー関数 RPC はルーティングより前に処理する。
  if (env.serverFunctions && url.pathname === SERVER_FN_PATH) {
    return finalize(ctx, await dispatchServerFn(ctx, info, env.serverFunctions));
  }

  if (method === "GET" && url.pathname === BOUNDARIES_PATH) {
    return finalize(ctx, await renderBoundaries(env, table, version));
  }

  try {
    // ミドルウェアは 404 判定より前に走り、Response を返したら短絡する。
    const short = await runMiddleware(env, table, ctx, version);
    if (short) return finalize(ctx, short);

    if (!match) return finalize(ctx, await render404(env, table, ctx, version));

    const mod = await env.importModule(match.file, version);

    if (match.isApi) return finalize(ctx, await handleApi(mod, ctx));

    if (method !== "GET" && method !== "HEAD" && typeof mod.action === "function") {
      const out = await mod.action(ctx);
      const res = toResult(out);
      if (res) return finalize(ctx, res);
      ctx.actionData = out; // データならページ再描画へ
    }

    return finalize(ctx, await renderRoute(env, table, match, mod, ctx, version));
  } catch (err) {
    if (ctx._redirect) return finalize(ctx, ctx._redirect); // ctx.redirect() の throw 経路
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

// table.middleware は root→leaf 順。
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
  // 旧式 { status, headers, body } もサポート
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
    throw new Error(`ルートがコンポーネントを default export していません: ${ctx.url.pathname}`);
  }
  const data = mod.loader ? await mod.loader(ctx) : undefined;
  const meta = await resolveMeta(mod, { data, params: ctx.params, url: ctx.url });
  let node = h(Page, { data, actionData: ctx.actionData, params: ctx.params, url: ctx.url });

  // leaf→root の順で外側に包む
  const layouts = layoutChain(table, match.file);
  for (let i = layouts.length - 1; i >= 0; i--) {
    const lmod = await env.importModule(layouts[i], version);
    const Layout = lmod.default;
    if (typeof Layout !== "function") continue;
    const ldata = lmod.loader ? await lmod.loader(ctx) : undefined;
    node = h(Layout, { data: ldata, params: ctx.params, url: ctx.url, children: node });
  }

  // 共有 Cache-Control で CDN はそのまま ISR になる。`nowaki start` の Rust フロントは
  // x-nowaki-revalidate を見てメモリキャッシュする。
  const revalidate = isrSeconds(mod);

  // ストリーミング SSR はシェルを即送出して TTFB を縮める（env.renderShell を持つ環境のみ）。
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
    // start.rs が Vary をキャッシュキーに織り込み、クロスユーザー漏れ・クエリ氾濫を防ぐ。
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

// クライアントルーターが起動時に一度だけ取得する。error 境界は data-nowaki-error /
// data-nowaki-reset スロットでメッセージと reset を受ける。
async function renderBoundaries(env, table, version) {
  await env.ensureIslands(version);
  const renderOne = async (entry, props) => {
    try {
      const mod = await env.importModule(entry.file, version);
      if (typeof mod.default !== "function") return null;
      const html = await renderToStringAsync(h(mod.default, props));
      return { prefix: entry.prefix, html };
    } catch {
      return null; // 境界自身が落ちても全体は壊さない
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
      dyn = null; // meta が落ちてもページ描画は続ける
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
      // ユーザー 500 自体が落ちたら下の組み込み表示にフォールバック
    }
  }
  return env.renderError(err);
}

// root→leaf 順で返す。
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

// prefix="" は全体にマッチする。
function underPrefix(pathname, prefix) {
  if (!prefix) return true;
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

// null を返したら戻り値はデータとして扱う。
function toResult(out) {
  if (out == null) return null;
  if (typeof Response !== "undefined" && out instanceof Response) {
    return responseToResult(out);
  }
  if (out && out.__nowakiResult) return out; // ctx.redirect()/ctx.json() の戻り
  return null;
}

function responseToResult(res) {
  const headers = {};
  for (const [k, v] of res.headers) headers[k] = v;
  return { status: res.status, headers, stream: res.body, body: undefined, _response: res };
}
