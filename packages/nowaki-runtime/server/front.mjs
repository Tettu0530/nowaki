// nowaki.config routing (basePath, trailingSlash, redirects, rewrites, headers) at the JS fronts:
// app.mjs `handle` (node / bun / deno / vercel) and the Cloudflare worker from edge-build.mjs. The
// rules come from rules.mjs, compiled once from dist/server/routing.json; with no routing config
// they are null and a front skips all of this with one check. Runtime-neutral (no node: imports).
// The Rust fronts do the same in crates/nowaki/src/front.rs.

import { applyRules, ruleHeaders } from "./rules.mjs";

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
