// LoaderContext: shared context passed to loaders, actions, middleware, and API handlers.

import { createSession } from "./session.mjs";
import { withBase } from "./base-path.mjs";

export function makeContext(info) {
  const { url, params = {}, method = "GET", req } = info;
  // Callers may inject headers / readBody (Node: from req; Edge: from the Web Request).
  const reqHeaders = info.headers ?? req?.headers ?? {};
  const readBodyFn = info.readBody ?? (() => readBodyNode(req));
  const resHeaders = new Map();
  const setCookies = [];

  // ISR Vary tracking: records the request headers / query this render depended on. start.rs folds
  // them into the cache key, preventing cross-user leaks on header-dependent pages and eviction from query floods.
  const accessedHeaders = new Set();
  let queryAccessed = false;
  let reqAccessed = false; // touching raw req has unknown granularity, so treat as uncacheable ("*")
  const noteHeader = (name) => accessedHeaders.add(String(name).toLowerCase());

  // Allowlisting accessors that expose the query misses inherited methods like toLocaleString,
  // causing cross-user leaks. So anything outside QUERY_FREE counts as query-dependent (fail safe).
  // Framework internals only use the raw info.url / .pathname, so only user-code accesses are recorded.
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
      // Call getters / methods with the target as receiver (so URL's private fields keep working).
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  let cookiesCache;
  let session;

  const ctx = {
    url: urlProxy,
    params,
    method,
    // The request's locale with i18n configured (handler.mjs `localizedRequest`), else undefined.
    locale: info.locale,
    // Header/query access through raw req (Node IncomingMessage) can't be tracked, so
    // touching it counts as "depends on everything" and disables the ISR cache (prevents per-user leaks).
    get req() {
      reqAccessed = true;
      return req;
    },
    // Direct raw header access has no granularity, so treat it as "depends on all headers" (conservatively uncacheable).
    get headers() {
      noteHeader("*");
      return reqHeaders;
    },
    // Record cookie access as a dependency on the cookie header (prevents serving per-user content to the wrong user).
    get cookies() {
      if (!cookiesCache) cookiesCache = parseCookies(reqHeaders["cookie"] ?? "");
      noteHeader("cookie");
      return cookiesCache;
    },
    // Created on first access, so a request that never touches it pays nothing. Reading it reads
    // the cookie header (above), which makes an ISR page per-user. `__sessionMode` ("crossSite",
    // set by handler.mjs before middleware; "live" for live renders) makes it read-only. The
    // session sets `__commit` when it has a cookie to write (handler.mjs `finalize` awaits it).
    // These internal fields are only added when used, keeping the common path's object unchanged.
    get session() {
      return (session ??= createSession(ctx, ctx.__sessionMode));
    },
    resHeaders,
    resStatus: undefined,
    actionData: undefined,
    state: {}, // arbitrary data middleware passes to loaders/pages

    // handler.mjs puts this in the ISR response header. "*" means no_cache on the Rust side.
    __vary() {
      const headers = reqAccessed ? ["*"] : [...accessedHeaders];
      return { query: queryAccessed, headers };
    },

    get(name) {
      noteHeader(name);
      return reqHeaders[String(name).toLowerCase()];
    },
    async formData() {
      reqAccessed = true; // depends on body/Content-Type → no shared ISR cache (prevents per-user mixups)
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

    // A root-relative `to` gets basePath in front (unless it already starts with it);
    // `{ basePath: false }` sends it as written.
    redirect(to, status = 302, opts) {
      if (typeof status === "object" && status !== null) [status, opts] = [302, status];
      const location = opts?.basePath === false ? to : withBase(to);
      const res = { __nowakiResult: true, status, headers: { location }, body: "" };
      ctx._redirect = res; // keep it so the throw path can pick it up
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
  if (info.sessionMode) ctx.__sessionMode = info.sessionMode;
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
    const raw = part.slice(i + 1).trim();
    // One malformed cookie (a third party's `x=50%`) must not break every page that reads cookies.
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
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

// Edge has no Buffer, so decode with TextDecoder.
function decodeBody(buf) {
  if (typeof buf === "string") return buf;
  return new TextDecoder().decode(buf);
}

function parseFormBody(buf, contentType) {
  const text = decodeBody(buf);
  if (contentType.includes("multipart/form-data")) {
    throw new Error("multipart/form-data is not supported yet (use urlencoded)");
  }
  return new URLSearchParams(text);
}
