// Same-origin checks for state-changing requests (CSRF). No node: imports (used on Edge too).

export function sameOrigin(origin, host) {
  if (!host) return false;
  const i = origin.indexOf("://");
  const originHost = i >= 0 ? origin.slice(i + 3).replace(/\/$/, "") : origin;
  return originHost === host;
}

/// Whether a non-GET request came from another site. Browsers send Origin on POST; without it,
/// Sec-Fetch-Site still identifies a cross-site request. Neither header (curl, server-to-server)
/// is allowed. `get(name)` reads a request header. The Rust front sets x-forwarded-host itself.
export function isCrossSite(get) {
  const origin = get("origin");
  if (origin) {
    if (origin === "null") return true; // sandboxed iframes, opaque redirects
    return !sameOrigin(origin, get("x-forwarded-host") ?? get("host"));
  }
  return get("sec-fetch-site") === "cross-site";
}
