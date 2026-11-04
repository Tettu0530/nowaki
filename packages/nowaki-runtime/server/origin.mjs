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

/// Host the browser used for same-origin checks (matches `forward.rs` `public_host`).
/// On `nowaki start`, the Rust front sets `x-forwarded-host` on the sidecar hop; adapter-only
/// deploys must not trust a client-supplied `x-forwarded-host` unless `NOWAKI_TRUST_PROXY` is set.
export function browserHost(get) {
  if (trustProxy()) {
    const forwarded = firstCommaSeparated(get("x-forwarded-host"));
    if (forwarded) return forwarded;
  }
  return get("host") ?? undefined;
}

/// Whether a non-GET request came from another site. Browsers send Origin on POST; without it,
/// Sec-Fetch-Site still identifies a cross-site request. Neither header (curl, server-to-server)
/// is allowed. `get(name)` reads a request header.
export function isCrossSite(get) {
  const origin = get("origin");
  if (origin) {
    if (origin === "null") return true; // sandboxed iframes, opaque redirects
    return !sameOrigin(origin, browserHost(get));
  }
  return get("sec-fetch-site") === "cross-site";
}
