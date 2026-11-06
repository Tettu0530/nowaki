// Same-origin checks for state-changing requests (CSRF). No node: imports (used on Edge too).

export function sameOrigin(origin, host) {
  if (!host) return false;
  const i = origin.indexOf("://");
  const originHost = i >= 0 ? origin.slice(i + 3).replace(/\/$/, "") : origin;
  return originHost === host;
}

/// Matches `crates/nowaki/src/forward.rs` `trust_proxy()`.
export function trustProxy() {
  const v = String(globalThis.process?.env?.NOWAKI_TRUST_PROXY ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function vercelHosted() {
  const v = String(globalThis.process?.env?.VERCEL ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true";
}

function firstCommaSeparated(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const first = String(value).split(",")[0].trim();
  return first || undefined;
}

function isLoopbackHost(host) {
  if (!host) return false;
  const name = host.split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/// Host the browser used for same-origin checks. Does not read `Origin` (that would let the
/// value under test pick its own comparison host). Order: trusted proxy `x-forwarded-host`;
/// loopback connection `Host` → canonical `x-forwarded-host` (Rust sidecar hop); on Vercel,
/// edge-set `x-forwarded-host` (public/custom domain); otherwise `Host`.
export function browserHost(get) {
  if (trustProxy()) {
    const forwarded = firstCommaSeparated(get("x-forwarded-host"));
    if (forwarded) return forwarded;
  }
  const host = get("host");
  const forwarded = firstCommaSeparated(get("x-forwarded-host"));
  if (isLoopbackHost(host)) {
    return forwarded ?? host;
  }
  if (vercelHosted() && forwarded) {
    return forwarded;
  }
  return host ?? forwarded;
}

/// The origin the browser addressed (`proto://host`), for `ctx.url`. Host as in `browserHost`.
/// The scheme comes from `x-forwarded-proto` only where that header is trusted: a trusted proxy,
/// the Rust front's loopback sidecar hop (it sets the header canonically), or Vercel's edge.
export function requestOrigin(get) {
  const host = browserHost(get) ?? "localhost";
  const trusted = trustProxy() || isLoopbackHost(get("host")) || !get("host") || vercelHosted();
  const proto = trusted && firstCommaSeparated(get("x-forwarded-proto")) === "https" ? "https" : "http";
  return `${proto}://${host}`;
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
    return !sameOrigin(origin, browserHost(get));
  }
  return get("sec-fetch-site") === "cross-site";
}
