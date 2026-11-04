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

/// Host the browser used for same-origin checks (aligned with `forward.rs` on the Rust hop).
/// When `Host` and `x-forwarded-host` disagree, the Rust sidecar sets canonical
/// `x-forwarded-host` from the browser while the HTTP client keeps the loopback connection
/// `Host`; adapters set `Host` from the request URL. Origin is used to pick the right one,
/// and a cross-site Origin never wins via a forged `x-forwarded-host` alone.
export function browserHost(get) {
  if (trustProxy()) {
    const forwarded = firstCommaSeparated(get("x-forwarded-host"));
    if (forwarded) return forwarded;
  }
  const host = get("host");
  const forwarded = firstCommaSeparated(get("x-forwarded-host"));
  if (host && forwarded && host !== forwarded) {
    const origin = get("origin");
    if (origin && origin !== "null") {
      if (sameOrigin(origin, host)) return host;
      if (
        sameOrigin(origin, forwarded) &&
        !sameOrigin(origin, host) &&
        isLoopbackHost(host)
      ) {
        return forwarded;
      }
      return host;
    }
    return host;
  }
  return host ?? forwarded;
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
