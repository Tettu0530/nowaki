// nowaki.config `cors`: browser cross-origin reads (and credentialed fetches when allowed). This is
// separate from origin checks on state-changing requests (CSRF); CORS does not disable them.
// Framework paths (`/__nowaki/*`, `/_nowaki/*`, including under basePath) never get CORS headers.

import { basePath } from "./base-path.mjs";

function isFrameworkSuffix(pathname) {
  return (
    pathname.startsWith("/__nowaki/") ||
    pathname === "/__nowaki" ||
    pathname.startsWith("/_nowaki/")
  );
}

export function isFrameworkCorsPath(pathname) {
  if (!pathname) return true;
  const base = basePath();
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
    const suffix = pathname.slice(base.length) || "/";
    if (isFrameworkSuffix(suffix)) return true;
  }
  if (pathname.startsWith("/__nowaki/") || pathname === "/__nowaki") return true;
  if (!base && pathname.startsWith("/_nowaki/")) return true;
  return false;
}

function normalizeOrigin(origin) {
  return String(origin ?? "").replace(/\/$/, "");
}

export function originAllowed(cors, origin) {
  if (!cors || !origin || origin === "null") return false;
  if (cors.origins.includes("*")) return true;
  const o = normalizeOrigin(origin);
  return cors.origins.some((allowed) => normalizeOrigin(allowed) === o);
}

function hasHeader(headers, name) {
  const n = name.toLowerCase();
  return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === n);
}

function requestedHeadersAllowed(cors, requestHeaders) {
  if (!requestHeaders) return true;
  const allowed = new Set(cors.headers.map((h) => h.toLowerCase()));
  for (const part of String(requestHeaders).split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!allowed.has(name)) return false;
  }
  return true;
}

/// OPTIONS preflight, or null when this request should continue through the handler.
export function corsPreflight(cors, { method, origin, pathname, requestMethod, requestHeaders }) {
  if (!cors || method !== "OPTIONS" || isFrameworkCorsPath(pathname)) return null;
  // Non-preflight OPTIONS (no Access-Control-Request-Method) still reach API routes.
  if (!origin || !requestMethod) return null;
  if (!originAllowed(cors, origin)) {
    return { status: 204, headers: {}, body: "" };
  }
  const methods = cors.methods.map((m) => m.toUpperCase());
  if (requestMethod && !methods.includes(requestMethod.toUpperCase())) {
    return { status: 204, headers: {}, body: "" };
  }
  if (!requestedHeadersAllowed(cors, requestHeaders)) {
    return { status: 204, headers: {}, body: "" };
  }
  const headers = corsResponseHeaders(cors, origin, {}, { preflight: true });
  return { status: 204, headers, body: "" };
}

/// Add Access-Control-* to a response when the Origin is allowlisted.
export function corsResponseHeaders(cors, origin, headers, opts = {}) {
  if (!cors || !originAllowed(cors, origin)) return headers;
  const out = { ...(headers ?? {}) };
  if (hasHeader(out, "access-control-allow-origin")) return out;
  out["access-control-allow-origin"] = cors.origins.includes("*") ? "*" : origin;
  if (cors.credentials && !cors.origins.includes("*")) {
    out["access-control-allow-credentials"] = "true";
  }
  if (opts.preflight) {
    out["access-control-allow-methods"] = cors.methods.join(", ");
    out["access-control-allow-headers"] = cors.headers.join(", ");
    out["access-control-max-age"] = String(cors.maxAge);
  }
  appendVary(out, "Origin");
  return out;
}

function appendVary(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "vary");
  const parts = new Set(
    (key ? String(headers[key]) : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add(name);
  if (key !== undefined) delete headers[key];
  headers.vary = [...parts].join(", ");
}

export function withCorsOnResult(env, ctx, result) {
  if (!env?.cors || !result) return result;
  const pathname = ctx.url?.pathname ?? "/";
  if (isFrameworkCorsPath(pathname)) return result;
  // ctx.get records only `origin` for ISR Vary; ctx.headers would mark every header as a dependency.
  const origin = typeof ctx.get === "function" ? ctx.get("origin") : undefined;
  const headers = corsResponseHeaders(env.cors, origin, result.headers);
  return headers === result.headers ? result : { ...result, headers };
}
