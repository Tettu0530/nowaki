// Response headers every Nowaki server adds unless the response already sets them. Mirrors
// crates/nowaki/src/security_headers.rs. NOWAKI_SECURITY_HEADERS=off turns them off.
// No node: imports, so the Edge worker can use it.

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
};
// Only when the app sends no CSP of its own; it restricts framing and nothing else.
export const FRAME_CSP = "frame-ancestors 'self'";

export function securityHeadersEnabled() {
  const v = globalThis.process?.env?.NOWAKI_SECURITY_HEADERS;
  return !(v && /^(0|off|false|no)$/i.test(String(v).trim()));
}

/// [name, value] pairs to add, skipping names `has(name)` reports as already set.
export function missingSecurityHeaders(has) {
  if (!securityHeadersEnabled()) return [];
  const out = Object.entries(SECURITY_HEADERS).filter(([k]) => !has(k));
  if (!has("content-security-policy")) out.push(["content-security-policy", FRAME_CSP]);
  return out;
}

/// A copy of `response` with the missing security headers added (Web Response / Headers).
export function withSecurityHeaders(response) {
  const add = missingSecurityHeaders((k) => response.headers.has(k));
  if (add.length === 0) return response;
  const out = new Response(response.body, response);
  for (const [k, v] of add) out.headers.set(k, v);
  return out;
}
