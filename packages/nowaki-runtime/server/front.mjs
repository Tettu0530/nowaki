// nowaki.config routing (basePath, trailingSlash, redirects, rewrites, headers, i18n.detect) at
// the JS fronts: app.mjs `handle` (node / bun / deno / vercel) and the Cloudflare worker from
// edge-build.mjs. The rules come from rules.mjs, compiled once from dist/server/routing.json;
// with no routing config they are null and a front skips all of this with one check.
// Runtime-neutral (no node: imports). The Rust fronts do the same in crates/nowaki/src/front.rs.

import { applyRules, negotiateLocale, ruleHeaders } from "./rules.mjs";

/// The config headers for a response to `pathname`: [[name, value]]. None for the framework's
/// /__nowaki/* endpoints, at the root or under basePath (a catch-all `cache-control` must not reach
/// RPC or live responses).
export function frontHeaders(rules, pathname) {
  if (pathname.startsWith("/__nowaki/")) return [];
  if (rules.base && pathname.startsWith(rules.base + "/__nowaki/")) return [];
  return ruleHeaders(rules, pathname);
}

const isFramework = (p) => p.startsWith("/_nowaki/") || p.startsWith("/__nowaki/") || p === "/__nowaki";

/// One request through the rules. Returns null to go on with the browser's path; { routePath } to
/// route by another path (basePath removed, a rewrite); { routePath, internal: true } for a
/// framework URL under basePath (`<base>/_nowaki/*`, `<base>/__nowaki/*`), to serve as the root
/// path `routePath`; { redirect: { status, location } } (the request's query carried over); or
/// { notFound: true } (outside basePath).
export function frontStep(rules, method, url) {
  const p = url.pathname;
  const base = rules.base;
  // Ahead of the rules: a catch-all rewrite or the trailing-slash policy must never move them.
  if (base && p.startsWith(base) && isFramework(p.slice(base.length))) return { routePath: p.slice(base.length), internal: true };
  // At the root, /__nowaki/* endpoints answer too; /_nowaki/* assets only without a basePath.
  if (p.startsWith("/__nowaki/") || p === "/__nowaki" || (!base && p.startsWith("/_nowaki/"))) return null;
  const out = applyRules(rules, method, p);
  if (out.redirect) return { redirect: { status: out.redirect.status, location: withQuery(out.redirect.location, url.search) } };
  if (out.notFound) return out;
  const routePath = out.rewrite ?? out.pass;
  return routePath === p ? null : { routePath };
}

/// `location` with the request's query (`search`, "?a=1" or "") after any query the destination
/// wrote, before a fragment.
export function withQuery(location, search) {
  if (!search || search === "?") return location;
  const hash = location.indexOf("#");
  const head = hash < 0 ? location : location.slice(0, hash);
  const fragment = hash < 0 ? "" : location.slice(hash);
  return head + (head.includes("?") ? "&" : "?") + search.slice(1) + fragment;
}

/// A copy of a Web Response with the config headers it doesn't set itself. Called before the
/// default security headers are added, so a rule's value wins over those.
export function withHeaderDefaults(response, pairs) {
  if (!pairs || !pairs.length) return response;
  const missing = pairs.filter(([k]) => !response.headers.has(k));
  if (!missing.length) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of missing) out.headers.set(k, v);
  return out;
}

/// The Vary of every response to the site's root under `i18n.detect`.
export const LOCALE_VARY = "Accept-Language, Cookie";

/// Accept-Language detection (`i18n.detect`) for a request frontStep went on with. Call it only
/// when `rules.detect` is set. Returns null when it doesn't apply (not a GET / HEAD of the root);
/// otherwise the response varies on LOCALE_VARY, and `{ redirect: { status, location }, headers }`
/// (the request's query carried over; never stored by a shared cache) means answer with that
/// redirect instead. Runs before any cache lookup, so a cached root only ever answers visitors
/// who stay on it.
export function frontLocale(rules, method, url, acceptLanguage, cookie) {
  const out = negotiateLocale(rules, method, url.pathname, acceptLanguage, cookie);
  if (!out) return null;
  if (!out.redirect) return {};
  return {
    redirect: { status: out.redirect.status, location: withQuery(out.redirect.location, url.search) },
    headers: { vary: LOCALE_VARY, "cache-control": "private, no-cache" },
  };
}

/// A Vary value with LOCALE_VARY's names added to `existing` (a string, an array of them, or
/// undefined) unless it already names them or is `*`.
export function mergeVary(existing) {
  const list = Array.isArray(existing) ? existing.join(", ") : existing ? String(existing) : "";
  const have = new Set(list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (have.has("*")) return list;
  const add = LOCALE_VARY.split(", ").filter((n) => !have.has(n.toLowerCase()));
  if (!add.length) return list;
  return list ? `${list}, ${add.join(", ")}` : add.join(", ");
}

/// A plain headers object with LOCALE_VARY merged into its Vary (whatever the key's case).
export function withVaryHeaders(headers) {
  const out = { ...(headers ?? {}) };
  const key = Object.keys(out).find((k) => k.toLowerCase() === "vary");
  const value = mergeVary(key === undefined ? undefined : out[key]);
  if (key !== undefined) delete out[key];
  out.vary = value;
  return out;
}

/// A copy of a Web Response with LOCALE_VARY merged into its Vary.
export function withVary(response) {
  const value = mergeVary(response.headers.get("vary") ?? undefined);
  if (value === response.headers.get("vary")) return response;
  const out = new Response(response.body, response);
  out.headers.set("vary", value);
  return out;
}
