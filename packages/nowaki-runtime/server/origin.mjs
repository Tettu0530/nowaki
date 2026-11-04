// Same-origin checks for state-changing requests (CSRF). No node: imports (used on Edge too).

export function sameOrigin(origin, host) {
  if (!host) return false;
  const i = origin.indexOf("://");
  const originHost = i >= 0 ? origin.slice(i + 3).replace(/\/$/, "") : origin;
  return originHost === host;
}

/// Whether a non-GET request came from another site. Browsers send Origin on POST; when
/// Origin is absent, Sec-Fetch-Site may still mark cross-site requests. When neither
/// header is present (curl, server-to-server), the request is not treated as cross-site
/// here—authenticate those callers separately. `get(name)` reads a request header. On the
/// `nowaki start` path the Rust front sets `x-forwarded-host` from the browser Host.
export function isCrossSite(get) {
  const origin = get("origin");
  if (origin) {
    if (origin === "null") return true; // sandboxed iframes, opaque redirects
    return !sameOrigin(origin, get("x-forwarded-host") ?? get("host"));
  }
  return get("sec-fetch-site") === "cross-site";
}
