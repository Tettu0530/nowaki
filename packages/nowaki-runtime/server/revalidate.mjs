// On-demand cache invalidation: revalidatePath(path) / revalidateTag(tag). Runtime-neutral (no
// node: imports).
//
// A call made while a request runs (page action, API route, server function, live event) is
// collected on the request's context (`ctx.__purge`, a Set of entries) and handed over when its
// response is built (handler.mjs `finalize`): `nowaki start` reads the `x-nowaki-purge` response
// header and deletes the entries from its ISR store before the response leaves, so the next
// request renders fresh. Outside a request the entries go to the Rust front through a stdout line
// carrying the per-process NOWAKI_PUBLISH_TOKEN (as publish() does), so log output can't purge.
//
// An entry is `t:<tag>` or `p:<browser path>`. Paths are expanded from the app path (as written in
// `<Link href>`) to every URL a browser can cache it under: each locale, the basePath, both forms
// under trailingSlash "ignore". The header encoding (`encodeEntries`) is shared with start.rs
// through crates/nowaki/tests/fixtures/purge-cases.json.

import { basePath } from "./base-path.mjs";
import { localePathFor } from "./i18n.mjs";

export const REVALIDATE_PATH = "/__nowaki/revalidate";
export const PURGE_HEADER = "x-nowaki-purge";
export const TAGS_HEADER = "x-nowaki-tags";

const TAG_MAX = 256;
const PATH_MAX = 2048;
const TAGS_PER_PAGE = 64;
// start.rs reads one header; what doesn't fit goes through the stdout channel.
const HEADER_MAX = 8 * 1024;
const BODY_LIMIT = 64 * 1024;
const ENDPOINT_MAX_ENTRIES = 256;
const RECENT_MAX = 50;

// One state per process, on globalThis so a second copy of the runtime (an app bundle that inlined
// it) sees the same env.
const S = (globalThis[Symbol.for("nowaki.revalidate")] ??= { env: null, warned: new Set(), recent: [], pending: null });

/// Tells revalidate*() which server it runs in: `env.isrStore` (`nowaki start`: the Rust front
/// holds the ISR cache), `env.purge(entries)` (an adapter's CDN purge), `env.dev`, `env.staticOutput`,
/// plus `env.i18n` / `env.trailingSlash` for the path expansion. Set once at startup.
export function setRevalidateEnv(env) {
  S.env = env ?? null;
}

const ctxOf = () => globalThis[Symbol.for("nowaki.context")]?.() ?? null;

/// Whether `tag` may be used: 1 to 256 characters, no whitespace, comma or control character.
export function validTag(tag) {
  return typeof tag === "string" && tag.length > 0 && tag.length <= TAG_MAX && !/[\s,\p{Cc}]/u.test(tag) && wellFormed(tag);
}

/// Whether `path` is a root-relative app path (`/blog`, not `//host` or `blog`).
export function validPath(path) {
  return typeof path === "string" && path.length <= PATH_MAX && path[0] === "/" && path[1] !== "/" && path[1] !== "\\" && !/\p{Cc}/u.test(path) && wellFormed(path);
}

function wellFormed(s) {
  if (typeof s.isWellFormed === "function") return s.isWellFormed();
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

/// Every browser path an app path can be cached under. `cfg`: `{ base, trailingSlash, i18n }`
/// (i18n compiled by i18n.mjs `compileI18n`). The query and fragment are dropped (every query
/// variant is purged), the path is normalized the way a browser sends it (percent-encoded, dot
/// segments resolved).
export function expandPath(path, { base = "", trailingSlash = "ignore", i18n = null } = {}) {
  const pathname = new URL(path, "http://n").pathname;
  const routes = i18n ? new Set(i18n.locales.map((l) => localePathFor(i18n, pathname, l))) : [pathname];
  const out = new Set();
  for (const r of routes) {
    let p = r === "/" && base ? base : base + r;
    if (trailingSlash === "always") {
      if (!p.endsWith("/") && !p.slice(p.lastIndexOf("/") + 1).includes(".")) p += "/";
      out.add(p);
    } else if (trailingSlash === "never") {
      out.add(p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
    } else {
      out.add(p);
      if (p !== "/") out.add(p.endsWith("/") ? p.slice(0, -1) || "/" : p + "/");
    }
  }
  return [...out];
}

// `%`, `,` and anything outside visible ASCII are percent-encoded (UTF-8), so a list is a valid
// header value that splits on `,`.
const encodeOne = (s) => s.replace(/[^\x21-\x24\x26-\x2b\x2d-\x7e]/gu, encodeURIComponent);

/// `["t:posts", "p:/blog"]` → `t:posts,p:/blog` (the `x-nowaki-purge` / `x-nowaki-tags` encoding).
export function encodeEntries(entries) {
  return entries.map(encodeOne).join(",");
}

/// The other side of `encodeEntries`; items that don't decode are dropped.
export function decodeEntries(value) {
  const out = [];
  for (const item of String(value ?? "").split(",")) {
    if (!item) continue;
    try {
      out.push(decodeURIComponent(item));
    } catch {}
  }
  return out;
}

/// Purges every page tagged `tag` (`export const tags`) from the ISR cache. See index.d.ts.
export function revalidateTag(tag) {
  if (!validTag(tag)) {
    throw new TypeError("revalidateTag(tag): tag must be a string of 1 to 256 characters, without whitespace, commas or control characters");
  }
  add([`t:${tag}`], `revalidateTag(${JSON.stringify(tag)})`);
}

/// Purges every cached variant of the page at the app path `path`. See index.d.ts.
export function revalidatePath(path) {
  if (!validPath(path)) {
    throw new TypeError('revalidatePath(path): path must be a root-relative app path such as "/blog" (at most 2048 characters)');
  }
  const env = S.env;
  const paths = expandPath(path, { base: basePath(), trailingSlash: env?.trailingSlash, i18n: env?.i18n });
  add(
    paths.map((p) => `p:${p}`),
    `revalidatePath(${JSON.stringify(path)})`,
  );
}

function add(entries, label) {
  const env = S.env;
  if (env?.dev) {
    S.recent.push({ at: Date.now(), call: label, entries });
    if (S.recent.length > RECENT_MAX) S.recent.shift();
    warnOnce("dev", `[nowaki] ${label}: \`nowaki dev\` has no ISR cache, so revalidate calls only get recorded here.`);
    return;
  }
  if (env?.staticOutput) {
    warnOnce("static", `[nowaki] ${label} has no effect in static output (pages are files).`);
    return;
  }
  if (!env || (!env.isrStore && typeof env.purge !== "function")) {
    warnOnce("none", `[nowaki] ${label} has no effect here: this server keeps no ISR cache (\`nowaki start\` does, and the Vercel adapter purges Vercel's CDN). Purge a CDN in front of it through that CDN's API.`);
    return;
  }
  const ctx = ctxOf();
  // A context whose response is already built (`__purgeClosed`) falls through to the detached path.
  if (ctx && !ctx.__purgeClosed) {
    const set = (ctx.__purge ??= new Set());
    for (const e of entries) set.add(e);
    return;
  }
  // Outside a request: batched per tick, so a loop of calls makes one line.
  if (!S.pending) {
    S.pending = new Set();
    queueMicrotask(() => {
      const list = [...S.pending];
      S.pending = null;
      sendDetached(list);
    });
  }
  for (const e of entries) S.pending.add(e);
}

function warnOnce(key, message) {
  if (S.warned.has(key)) return;
  S.warned.add(key);
  console.warn(message);
}

/// The last revalidate calls under `nowaki dev` (oldest first), for the dev tools.
export function recentRevalidations() {
  return S.recent.slice();
}

// Entries that can't ride on a response: the stdout line on `nowaki start`, env.purge elsewhere.
function sendDetached(entries) {
  const env = S.env;
  if (env?.isrStore) writeLines(chunks(entries, HEADER_MAX));
  if (typeof env?.purge === "function") {
    Promise.resolve()
      .then(() => env.purge(entries))
      .catch((err) => console.error("[nowaki] cache purge failed:", err));
  }
}

// `lines`: encoded lists from `chunks`.
function writeLines(lines) {
  const token = globalThis.process?.env?.NOWAKI_PUBLISH_TOKEN;
  const out = globalThis.process?.stdout;
  if (!token || !out?.write) return;
  for (const line of lines) out.write(`NOWAKI_PURGE ${token} ${line}\n`);
}

// Encoded lists of at most `max` bytes each (an entry is at most ~6 KB encoded, so each fits).
function chunks(entries, max) {
  const out = [];
  let cur = "";
  for (const e of entries) {
    const enc = encodeOne(e);
    if (cur && cur.length + 1 + enc.length > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur},${enc}` : enc;
  }
  if (cur) out.push(cur);
  return out;
}

/// Hands the request's collected entries over with its response (handler.mjs `finalize`):
/// `x-nowaki-purge` on `nowaki start` (overflow past 8 KB through stdout), then `env.purge` awaited.
/// `headers` is the response's own (fresh) headers object.
export function flushPurge(ctx, headers) {
  const entries = [...ctx.__purge];
  ctx.__purge = undefined;
  ctx.__purgeClosed = true;
  const env = S.env;
  if (env?.isrStore) {
    const [first, ...rest] = chunks(entries, HEADER_MAX);
    if (first) headers[PURGE_HEADER] = first;
    if (rest.length) writeLines(rest);
  }
  if (typeof env?.purge === "function") {
    // The context goes along: the Cloudflare cache deletes the paths under the request's origin.
    return Promise.resolve()
      .then(() => env.purge(entries, ctx))
      .catch((err) => console.error("[nowaki] cache purge failed:", err));
  }
  return undefined;
}

/// For contexts that have no response of their own (a WebSocket live render): sends what was
/// collected through the detached channel.
export function flushDetached(ctx) {
  if (!ctx) return;
  ctx.__purgeClosed = true;
  if (!ctx.__purge) return;
  const entries = [...ctx.__purge];
  ctx.__purge = undefined;
  sendDetached(entries);
}

/// The route's tags as a header value, or null: `export const tags` is an array, or a function of
/// `{ params, data }` returning one. Invalid tags are dropped (warned once per module).
export function encodeTags(list, file) {
  if (!Array.isArray(list)) {
    warnOnce(`tags:${file}`, `[nowaki] ${file}: \`tags\` must be an array of strings (or a function returning one).`);
    return null;
  }
  const ok = [];
  for (const t of list) {
    if (validTag(t)) {
      if (!ok.includes(t)) ok.push(t);
    } else {
      warnOnce(`tags:${file}`, `[nowaki] ${file}: ignoring invalid cache tag ${JSON.stringify(t)} (1 to 256 characters, no whitespace, commas or control characters).`);
    }
  }
  if (ok.length > TAGS_PER_PAGE) {
    warnOnce(`tags:${file}`, `[nowaki] ${file}: at most ${TAGS_PER_PAGE} cache tags per page; the rest are ignored.`);
    ok.length = TAGS_PER_PAGE;
  }
  return ok.length ? ok : null;
}

// Read on each request to the endpoint's path only (.env is loaded after this module).
function revalidateSecret() {
  return globalThis.process?.env?.NOWAKI_REVALIDATE_SECRET || null;
}

/// Whether `POST /__nowaki/revalidate` is on (NOWAKI_REVALIDATE_SECRET set).
export function revalidateEndpointEnabled() {
  return revalidateSecret() !== null;
}

const JSON_CT = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (status, body, extra) => ({ status, headers: extra ? { ...JSON_CT, ...extra } : JSON_CT, body: JSON.stringify(body) });

/// `POST /__nowaki/revalidate` with `Authorization: Bearer <NOWAKI_REVALIDATE_SECRET>` and a JSON
/// body `{ "paths": ["/blog"], "tags": ["posts"] }`: the same purge as revalidatePath / revalidateTag,
/// for an operator fanning a purge out to every `nowaki start` instance. Runs inside the request's
/// context (handler.mjs), so the purge rides on this response.
export async function revalidateEndpoint(ctx) {
  if (ctx.method !== "POST") return reply(405, { error: "Method Not Allowed" }, { allow: "POST" });
  const auth = String(ctx.get("authorization") ?? "");
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!given || !(await sameSecret(given, revalidateSecret()))) return reply(401, { error: "Unauthorized" });
  const ct = String(ctx.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return reply(415, { error: "Unsupported Media Type" });
  if (Number(ctx.get("content-length")) > BODY_LIMIT) return reply(413, { error: "Payload Too Large" });
  let body;
  try {
    const text = await ctx.bodyText();
    if (text.length > BODY_LIMIT) return reply(413, { error: "Payload Too Large" });
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: "Bad Request: invalid JSON" });
  }
  const paths = body?.paths ?? [];
  const tags = body?.tags ?? [];
  if (!Array.isArray(paths) || !Array.isArray(tags) || paths.length + tags.length === 0 || paths.length + tags.length > ENDPOINT_MAX_ENTRIES) {
    return reply(400, { error: `Bad Request: expected { paths?: string[], tags?: string[] } with 1 to ${ENDPOINT_MAX_ENTRIES} entries` });
  }
  const badPath = paths.find((p) => !validPath(p));
  if (badPath !== undefined) return reply(400, { error: `Bad Request: invalid path ${JSON.stringify(badPath)}` });
  const badTag = tags.find((t) => !validTag(t));
  if (badTag !== undefined) return reply(400, { error: `Bad Request: invalid tag ${JSON.stringify(badTag)}` });
  for (const p of paths) revalidatePath(p);
  for (const t of tags) revalidateTag(t);
  return reply(200, { revalidated: { paths, tags } });
}

// Compares SHA-256 digests in constant time, so neither the length nor a matching prefix of the
// secret shows in the response time.
async function sameSecret(given, expected) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
