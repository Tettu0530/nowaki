// ISR cache and CDN purge for the Cloudflare Workers adapter: the `env.purge` /
// `env.cacheTagHeader` seams of handler.mjs, plus a page cache on the Workers Cache API
// (`caches.default`), which web.mjs consults in front of the handler. Runtime-neutral, no imports
// beyond the tag encoding (cdn-tag.mjs) and the CSP marker header name (csp.mjs).
//
// Cloudflare does not cache what a Worker returns, so without this nothing is cached. What the
// Cache API gives (developers.cloudflare.com/workers/runtime-apis/cache/):
// - It is per data center: `cache.delete` purges the local colo only. A global purge goes through
//   the zone purge API, and Cache API entries carry `Cache-Tag` for that.
// - It works on custom domains, not in the dashboard editor or previews; a workers.dev Worker has no
//   zone, so there is no zone purge there.
// - `put` throws for a non-GET key, a 206 or `Vary: *`, never stores a response with Set-Cookie,
//   and follows Cache-Control (no stale-while-revalidate). The cache ignores Vary (apart from
//   Accept-Encoding), so the varied request headers go into the key here.
//
// What is stored: a response the handler marked shareable, by the same signals `nowaki start` reads
// (`x-nowaki-revalidate`, `x-nowaki-vary`), status 200, no Set-Cookie, and a `public, s-maxage`
// Cache-Control (handler.mjs `sharedCacheHeaders` makes a page that read cookies, authorization or
// the raw request `private`). Streamed pages are not stored, as under `nowaki start`.
//
// Keys. A page that varies on nothing is stored at `<origin><path>` (the query is dropped, as
// `nowaki start` does). A page that read request headers or the query is stored under a variant
// key, and `<origin><path>` holds a stub naming what it varies on and a generation id that is part
// of every variant key. Deleting that one URL (revalidatePath) therefore drops every variant in
// the colo, whichever isolate stored them.

import { cdnTag } from "./cdn-tag.mjs";
import { CSP_MARKER_HEADER } from "./csp.mjs";

export const CF_TAG_HEADER = "cache-tag";
// Cloudflare: printable ASCII, no spaces, comma-separated, case-insensitive, up to 1024 characters
// per tag and 16 KB for the header. 240 keeps 65 tags (64 route tags + the path) under 16 KB.
const TAG_MAX = 240;
const TIMEOUT_MS = 2000;
// Purge API: up to 100 tags per request on every plan below Enterprise.
const BATCH = 100;
const API = "https://api.cloudflare.com/client/v4";
// How long the Cache API keeps an entry; staleness is decided here from x-nowaki-stored.
const KEEP = "public, max-age=31536000";
const KEY_MAX = 4096;
const NEGATIVE_MAX = 10000;
const ORIGINS_MAX = 16;
const PER_USER = new Set(["*", "cookie", "authorization"]);
// Headers the handler sets for `nowaki start` and the cache; never sent to a browser.
const INTERNAL = ["x-nowaki-revalidate", "x-nowaki-vary", "x-nowaki-vary-query", "x-nowaki-tags", CF_TAG_HEADER];

/// The Cloudflare cache tag for a revalidate entry (`t:posts`, `p:/blog`): `cdnTag` with
/// Cloudflare's per-header budget. Cloudflare compares tags case-insensitively, so `t:Posts` and
/// `t:posts` purge together (more than asked, never less).
export function cfTag(entry) {
  return cdnTag(entry, TAG_MAX);
}

/// Removes the handler's internal cache headers from a result's headers object (in place).
export function stripInternal(headers) {
  for (const k of Object.keys(headers)) if (INTERNAL.includes(k.toLowerCase())) delete headers[k];
  return headers;
}

const headerOf = (headers, name) => {
  for (const k of Object.keys(headers ?? {})) if (k.toLowerCase() === name) return headers[k];
  return undefined;
};

/// Whether a handler result may go into the shared cache: an ISR render (`x-nowaki-revalidate`),
/// 200, with a body string (not a stream), no Set-Cookie, a shared Cache-Control and no per-user
/// Vary input. Returns the render's vary spec `{ names, query, revalidate }`, or null.
export function shareable(result) {
  if (!result || result.stream || typeof result.body !== "string") return null;
  if ((result.status ?? 200) !== 200) return null;
  const h = result.headers ?? {};
  const secs = Number(headerOf(h, "x-nowaki-revalidate"));
  if (!Number.isFinite(secs) || secs <= 0) return null;
  if (headerOf(h, "set-cookie") !== undefined) return null;
  const cc = String(headerOf(h, "cache-control") ?? "");
  if (!/\bpublic\b/i.test(cc) || !/\bs-maxage=\d+/i.test(cc) || /\b(private|no-store|no-cache)\b/i.test(cc)) return null;
  const names = String(headerOf(h, "x-nowaki-vary") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.some((n) => PER_USER.has(n))) return null;
  const vary = headerOf(h, "vary");
  if (vary !== undefined && /(^|,)\s*\*\s*(,|$)/.test(String(vary))) return null;
  return { names: [...new Set(names)].sort(), query: headerOf(h, "x-nowaki-vary-query") === "1", revalidate: secs };
}

/// `{ purge, cacheTagHeader, cache }` for web.mjs. Options (tests replace them):
///   caches      () => the Cache API store (`caches.default`), or undefined where there is none
///   fetch       the fetch used for the zone purge API
///   credentials () => { zone, token } or null (CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN)
///   timeoutMs   how long a purge holds the action's response (2 s)
///   now         () => ms
export function cloudflareCdn({
  caches = () => globalThis.caches?.default,
  fetch = (...a) => globalThis.fetch(...a),
  credentials = () => null,
  timeoutMs = TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const warned = new Set();
  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(msg);
  };
  // Paths whose render was not an ISR page in this isolate: they skip the cache lookup.
  const negative = new Set();
  // Origins this isolate stored pages for: a purge without a request (a timer) deletes there.
  const origins = new Set();
  // Bumped by every purge: a render that started before one doesn't store its (older) result.
  let epoch = 0;
  // Revalidations in flight in this isolate (single-flight per key).
  const inflight = new Set();
  // Purge calls still running when the 2 s cap let the response go: handed to ctx.waitUntil.
  let pending = null;

  const store = () => {
    try {
      return caches() ?? null;
    } catch {
      return null;
    }
  };

  // The variant key for a request under a stub's spec, or null when the request can't be keyed
  // (too long). Header values are what the handler saw (a Web Headers object joins repeats).
  function variantKey(url, headers, spec, gen) {
    let k = `${url.origin}${url.pathname}?__nowaki=${gen}`;
    if (spec.query && url.search) k += `&q=${encodeURIComponent(url.search.slice(1))}`;
    for (const n of spec.names) {
      const v = headers[n];
      k += v === undefined ? `&h.${n}` : `&h.${n}=${encodeURIComponent(v)}`;
    }
    return k.length <= KEY_MAX ? k : null;
  }

  function cachedResult(res, status) {
    const headers = {};
    for (const [k, v] of res.headers) {
      // Cache-Tag: production strips it from a match, local workerd (wrangler dev) does not.
      // The render's CSP marker stays: applyCsp gives each hit its own nonce.
      if ((k.startsWith("x-nowaki-") && k !== CSP_MARKER_HEADER) || k === "cache-control" || k === "vary" || k === "age" || k === "content-length" || k === CF_TAG_HEADER) continue;
      headers[k] = v;
    }
    const cc = res.headers.get("x-nowaki-cc");
    if (cc) headers["cache-control"] = cc;
    const vary = res.headers.get("x-nowaki-vary-out");
    if (vary) headers.vary = vary;
    headers["x-nowaki-cache"] = status;
    return headers;
  }

  const cache = {
    /// Whether a request may use the cache (GET/HEAD, not an intercept fragment, not a path known
    /// to render no ISR page here). Synchronous and allocation-free.
    eligible(method, pathname, headers) {
      return (method === "GET" || method === "HEAD") && !headers["x-nowaki-intercept"] && !negative.has(pathname);
    },
    /// Looks the request up. Returns `{ hit: { status, headers, body }, stale, key }` or
    /// `{ miss: { stub, key } }` (`stub`: the spec at the base key, if any), or null when the cache
    /// is unavailable or the request can't be keyed.
    async lookup(url, headers) {
      const c = store();
      if (!c) return null;
      const base = `${url.origin}${url.pathname}`;
      let res;
      try {
        res = await c.match(base);
      } catch {
        return null;
      }
      let key = base;
      let stub = null;
      if (res && res.headers.has("x-nowaki-stub")) {
        stub = {
          gen: res.headers.get("x-nowaki-stub"),
          names: (res.headers.get("x-nowaki-vary") ?? "").split(",").filter(Boolean),
          query: res.headers.get("x-nowaki-vary-query") === "1",
        };
        key = variantKey(url, headers, stub, stub.gen);
        if (!key) return null;
        try {
          res = await c.match(key);
        } catch {
          return null;
        }
      }
      if (!res) return { miss: { stub, key } };
      const stored = Number(res.headers.get("x-nowaki-stored"));
      const secs = Number(res.headers.get("x-nowaki-revalidate"));
      const stale = !(now() - stored < secs * 1000);
      const out = { status: res.status, headers: cachedResult(res, stale ? "STALE" : "HIT"), body: await res.text() };
      return { hit: out, stale, key, stub };
    },
    /// Stores a render (when `shareable`) and returns the result to send, with its internal
    /// headers removed and `x-nowaki-cache: MISS` when it was stored. `miss` is what `lookup`
    /// returned (or null), `startEpoch` the value of `cache.epoch()` before the render. The writes
    /// go into `waitUntil`.
    settle(url, headers, result, miss, startEpoch, waitUntil) {
      const spec = shareable(result);
      if (!spec) {
        if (!headerOf(result?.headers, "x-nowaki-revalidate")) remember(url.pathname);
        if (result?.headers) stripInternal(result.headers);
        return result;
      }
      const tags = headerOf(result.headers, CF_TAG_HEADER);
      const out = { ...result, headers: stripInternal({ ...result.headers }) };
      const c = store();
      if (!c || startEpoch !== epoch || !miss) return out;
      const write = put(c, url, headers, out, spec, tags, miss.stub);
      if (!write) return out;
      out.headers["x-nowaki-cache"] = "MISS";
      if (typeof waitUntil === "function") waitUntil(write);
      return out;
    },
    /// Re-renders a stale entry once per key in this isolate, in the background.
    revalidate(key, render) {
      if (inflight.has(key)) return null;
      inflight.add(key);
      return Promise.resolve()
        .then(render)
        .catch((err) => console.error("[nowaki] ISR revalidation failed:", err))
        .finally(() => inflight.delete(key));
    },
    epoch: () => epoch,
  };

  function remember(pathname) {
    if (negative.size >= NEGATIVE_MAX) negative.clear();
    negative.add(pathname);
  }

  // The writes for one render, or null when it can't be keyed. The page goes to the base key when
  // nothing varies (and no stub is there); otherwise a stub (new generation when the spec grew)
  // and the variant.
  function put(c, url, headers, result, spec, tags, stub) {
    const base = `${url.origin}${url.pathname}`;
    let names = spec.names;
    let query = spec.query;
    let gen = stub?.gen;
    let writeStub = false;
    if (stub) {
      const union = [...new Set([...stub.names, ...names])].sort();
      const q = stub.query || query;
      if (union.length !== stub.names.length || q !== stub.query) {
        gen = newGen();
        writeStub = true;
      }
      names = union;
      query = q;
    } else if (names.length || query) {
      gen = newGen();
      writeStub = true;
    }
    const key = gen ? variantKey(url, headers, { names, query }, gen) : base;
    if (!key) return null;
    if (origins.size < ORIGINS_MAX) origins.add(url.origin);
    const meta = { "x-nowaki-revalidate": String(spec.revalidate), "cache-control": KEEP };
    if (tags) meta[CF_TAG_HEADER] = String(tags);
    const page = new Headers();
    for (const [k, v] of Object.entries(result.headers)) {
      const n = k.toLowerCase();
      if (n === "cache-control" || n === "vary" || n === "x-nowaki-cache" || n === "server-timing" || n === "content-length") continue;
      if (Array.isArray(v)) for (const item of v) page.append(k, String(item));
      else if (v !== undefined && v !== null) page.set(k, String(v));
    }
    for (const [k, v] of Object.entries(meta)) page.set(k, v);
    page.set("x-nowaki-stored", String(now()));
    const cc = headerOf(result.headers, "cache-control");
    if (cc) page.set("x-nowaki-cc", String(cc));
    const vary = headerOf(result.headers, "vary");
    if (vary) page.set("x-nowaki-vary-out", String(vary));
    const writes = [c.put(key, new Response(result.body, { status: 200, headers: page }))];
    if (writeStub) {
      const s = new Headers(meta);
      s.set("x-nowaki-stub", gen);
      s.set("x-nowaki-vary", names.join(","));
      s.set("x-nowaki-vary-query", query ? "1" : "0");
      writes.push(c.put(base, new Response("", { status: 200, headers: s })));
    }
    return Promise.all(writes).catch((err) => console.error("[nowaki] ISR cache write failed:", err));
  }

  async function zonePurge(creds, tags) {
    const calls = [];
    for (let i = 0; i < tags.length; i += BATCH) {
      calls.push(
        Promise.resolve()
          .then(() =>
            fetch(`${API}/zones/${encodeURIComponent(creds.zone)}/purge_cache`, {
              method: "POST",
              headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
              body: JSON.stringify({ tags: tags.slice(i, i + BATCH) }),
            }),
          )
          .then(async (res) => {
            const body = await res.json().catch(() => null);
            if (res.ok && body?.success !== false) return;
            const err = body?.errors?.[0];
            const code = err?.code ?? res.status;
            warnOnce(`zone:${code}`, `[nowaki] Cloudflare zone purge failed (${code}${err?.message ? `: ${err.message}` : ""}); cached pages in other data centers stay until they expire. Check CLOUDFLARE_API_TOKEN (Cache Purge permission) and the plan's purge rate limit.`);
          })
          .catch((err) => warnOnce("zone:fetch", `[nowaki] Cloudflare zone purge failed: ${err?.message ?? err}`)),
      );
    }
    await Promise.all(calls);
  }

  return {
    cache,
    cacheTagHeader(entries) {
      let value = "";
      for (const e of entries) value = value ? `${value},${cfTag(e)}` : cfTag(e);
      return value ? { [CF_TAG_HEADER]: value } : null;
    },
    /// Deletes the path entries from this colo's cache, and purges every entry by tag through the
    /// zone purge API when credentials are set; awaited up to `timeoutMs`. `ctx` is the request's
    /// context when there is one (its origin is where the pages were cached).
    async purge(entries, ctx) {
      epoch++;
      const origin = ctx?.url?.origin;
      const hosts = new Set(origins);
      if (origin) hosts.add(origin);
      const work = [];
      const c = store();
      if (c) {
        for (const e of entries) {
          if (!e.startsWith("p:")) continue;
          for (const o of hosts) work.push(Promise.resolve().then(() => c.delete(`${o}${e.slice(2)}`)).catch(() => {}));
        }
      }
      const creds = credentials();
      if (creds?.zone && creds?.token) {
        const seen = new Set();
        const tags = [];
        for (const e of entries) {
          const t = cfTag(e);
          if (seen.has(t.toLowerCase())) continue;
          seen.add(t.toLowerCase());
          tags.push(t);
        }
        work.push(zonePurge(creds, tags));
      } else if (origin && new URL(origin).hostname.endsWith(".workers.dev")) {
        warnOnce("workers.dev", "[nowaki] revalidatePath / revalidateTag on workers.dev: there is no zone to purge, so only this data center's cache is cleared (and revalidateTag clears nothing). Serve the Worker on a custom domain and set CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN for a global purge.");
      } else {
        warnOnce("nozone", "[nowaki] revalidatePath / revalidateTag on Cloudflare: CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are not set, so only this data center's cache is cleared (and revalidateTag clears nothing). Set both (the token needs the Cache Purge permission) for a global purge by tag.");
      }
      if (!work.length) return;
      const all = Promise.all(work);
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs, "timeout");
      });
      try {
        const r = await Promise.race([all, timeout]);
        if (r === "timeout") {
          console.warn(`[nowaki] Cloudflare cache purge did not finish within ${timeoutMs} ms; the response goes out without waiting for it.`);
          pending = pending ? Promise.all([pending, all]) : all;
        }
      } finally {
        clearTimeout(timer);
      }
    },
    /// The purge work the timeout let go of (for ctx.waitUntil), or null. Clears it.
    takePending() {
      const p = pending;
      pending = null;
      return p;
    },
  };
}

function newGen() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/// CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN from the Worker's bindings, else process.env.
export function zoneCredentials(bindings) {
  const pick = (k) => (typeof bindings?.[k] === "string" && bindings[k]) || globalThis.process?.env?.[k] || "";
  const zone = pick("CLOUDFLARE_ZONE_ID").trim();
  const token = pick("CLOUDFLARE_API_TOKEN").trim();
  return zone && token ? { zone, token } : null;
}
