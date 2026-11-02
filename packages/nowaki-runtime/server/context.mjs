// LoaderContext: loader / action / middleware / API ハンドラに渡る共通コンテキスト。

export function makeContext(info) {
  const { url, params = {}, method = "GET", req } = info;
  // headers / readBody は呼び出し側が注入できる（Node: req から、Edge: Web Request から）。
  const reqHeaders = info.headers ?? req?.headers ?? {};
  const readBodyFn = info.readBody ?? (() => readBodyNode(req));
  const resHeaders = new Map();
  const setCookies = [];

  // ISR の Vary 追跡: この描画が依存したリクエストヘッダ / クエリを記録する。start.rs が
  // キャッシュキーへ織り込み、ヘッダ依存ページのクロスユーザー漏れと、クエリ氾濫による追い出しを防ぐ。
  const accessedHeaders = new Set();
  let queryAccessed = false;
  let reqAccessed = false; // 生 req に触れたら粒度不明なのでキャッシュ無効化（"*"）扱い
  const noteHeader = (name) => accessedHeaders.add(String(name).toLowerCase());

  // クエリを露出する参照の許可リスト方式は toLocaleString 等の継承メソッドを取りこぼし、
  // クロスユーザー漏れになる。そこで QUERY_FREE 以外は全てクエリ依存とみなす（安全側）。
  // フレームワーク内部は生の info.url / .pathname しか使わないので、記録されるのはユーザーコード分のみ。
  const QUERY_FREE = new Set([
    "pathname",
    "hostname",
    "host",
    "origin",
    "protocol",
    "port",
    "hash",
    "username",
    "password",
  ]);
  const urlProxy = new Proxy(url, {
    get(target, prop) {
      if (prop === "search" || prop === "searchParams") {
        queryAccessed = true;
      } else if (target.search && !(typeof prop === "string" && QUERY_FREE.has(prop))) {
        queryAccessed = true;
      }
      // getter / メソッドは実体(target)を receiver にして呼ぶ（URL の private field が使えなくならないよう）。
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  let cookiesCache;

  const ctx = {
    url: urlProxy,
    params,
    method,
    // 生 req（Node IncomingMessage）に触れるとヘッダ/クエリ参照を追跡できないので、
    // 触れた時点で「全依存」とみなし ISR キャッシュを無効化する（per-user 内容の漏れ防止）。
    get req() {
      reqAccessed = true;
      return req;
    },
    // 生ヘッダの直接参照は粒度が取れないので「全ヘッダ依存」とみなす（保守的にキャッシュ無効化）。
    get headers() {
      noteHeader("*");
      return reqHeaders;
    },
    // Cookie 参照は「cookie ヘッダ依存」として記録（per-user 内容の取り違えを防ぐ）。
    get cookies() {
      if (!cookiesCache) cookiesCache = parseCookies(reqHeaders["cookie"] ?? "");
      noteHeader("cookie");
      return cookiesCache;
    },
    resHeaders,
    resStatus: undefined,
    actionData: undefined,
    state: {}, // ミドルウェアが loader/ページへ渡す任意データ

    // handler.mjs が ISR 応答ヘッダへ載せる。"*" なら Rust 側で no_cache になる。
    __vary() {
      const headers = reqAccessed ? ["*"] : [...accessedHeaders];
      return { query: queryAccessed, headers };
    },

    get(name) {
      noteHeader(name);
      return reqHeaders[String(name).toLowerCase()];
    },
    async formData() {
      reqAccessed = true; // 本文/Content-Type 依存 → ISR 共有キャッシュ不可（per-user 取り違え防止）
      const buf = await readBodyFn();
      return parseFormBody(buf, reqHeaders["content-type"] ?? "");
    },
    async bodyText() {
      reqAccessed = true;
      return decodeBody(await readBodyFn());
    },
    async bodyJson() {
      reqAccessed = true;
      const s = decodeBody(await readBodyFn());
      return s ? JSON.parse(s) : null;
    },

    status(code) {
      ctx.resStatus = code;
      return ctx;
    },
    setHeader(name, value) {
      resHeaders.set(name, value);
      return ctx;
    },
    setCookie(name, value, opts = {}) {
      setCookies.push(serializeCookie(name, value, opts));
      return ctx;
    },
    deleteCookie(name, opts = {}) {
      setCookies.push(serializeCookie(name, "", { ...opts, maxAge: 0 }));
      return ctx;
    },
    collectSetCookies() {
      return setCookies;
    },

    redirect(to, status = 302) {
      const res = { __nowakiResult: true, status, headers: { location: to }, body: "" };
      ctx._redirect = res; // throw 経路でも拾えるよう保持
      return res;
    },
    json(data, init = {}) {
      return result(init.status ?? 200, "application/json; charset=utf-8", JSON.stringify(data), init.headers);
    },
    html(markup, init = {}) {
      return result(init.status ?? 200, "text/html; charset=utf-8", String(markup), init.headers);
    },
    text(s, init = {}) {
      return result(init.status ?? 200, "text/plain; charset=utf-8", String(s), init.headers);
    },
  };
  return ctx;
}

function result(status, contentType, body, extra) {
  return { __nowakiResult: true, status, headers: { "content-type": contentType, ...(extra ?? {}) }, body };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, opts) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.expires) s += `; Expires=${opts.expires instanceof Date ? opts.expires.toUTCString() : opts.expires}`;
  s += `; Path=${opts.path ?? "/"}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  if (opts.httpOnly !== false) s += "; HttpOnly";
  if (opts.secure) s += "; Secure";
  s += `; SameSite=${opts.sameSite ?? "Lax"}`;
  return s;
}

function readBodyNode(req) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== "function") return resolve(new Uint8Array(0));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Edge には Buffer が無いので TextDecoder で復号する。
function decodeBody(buf) {
  if (typeof buf === "string") return buf;
  return new TextDecoder().decode(buf);
}

function parseFormBody(buf, contentType) {
  const text = decodeBody(buf);
  if (contentType.includes("multipart/form-data")) {
    throw new Error("multipart/form-data はまだ未対応です（urlencoded を使ってください）");
  }
  return new URLSearchParams(text);
}
