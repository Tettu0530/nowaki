// Opt-in Content Security Policy with a per-response nonce for the adapters
// (NOWAKI_CSP=report-only|enforce). Mirrors crates/nowaki/src/csp.rs: every <script> / <style>
// in an HTML response gets nonce="…", streams stay streams, and a response that already sets a
// CSP is left alone. No node: imports, so the Edge worker uses it too.

const env = globalThis.process?.env ?? {};

export function cspMode() {
  const v = String(env.NOWAKI_CSP ?? "").trim().toLowerCase();
  if (v === "report-only" || v === "report") return "report-only";
  if (v === "enforce" || v === "on" || v === "1" || v === "true") return "enforce";
  return "off";
}

export function newNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Style attributes need style-src-attr 'unsafe-inline' (CSP3 ignores 'unsafe-inline' next to a nonce).
export function cspPolicy(nonce, reportUri = env.NOWAKI_CSP_REPORT_URI) {
  let p =
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src-elem 'self' 'nonce-${nonce}'; ` +
    "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
  if (reportUri && String(reportUri).trim()) p += `; report-uri ${String(reportUri).trim()}`;
  return p;
}

const TAG = /<(script|style)(?=[\s>/])/gi;
// A tail that could still become `<script` / `<style` once the next chunk arrives.
const PARTIAL = /<(s(c(r(i(pt?)?)?)?)?|st(y(le?)?)?)?$/i;

export function injectNonce(html, nonce) {
  return html.replace(TAG, `$& nonce="${nonce}"`);
}

/// A TransformStream of strings that injects the nonce across chunk boundaries.
export function nonceTransform(nonce) {
  let carry = "";
  return new TransformStream({
    transform(chunk, controller) {
      let s = carry + chunk;
      const m = PARTIAL.exec(s);
      carry = m ? m[0] : "";
      if (m) s = s.slice(0, m.index);
      // A carried `<script` / `<style` followed by a delimiter is complete; inject it now.
      controller.enqueue(injectNonce(s, nonce));
    },
    flush(controller) {
      if (carry) controller.enqueue(carry);
    },
  });
}

function headerOf(headers, name) {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

/// Applies the CSP to a handler result ({ status, headers, body | stream }); non-HTML results and
/// results with their own CSP pass through unchanged.
export function applyCsp(result) {
  const mode = cspMode();
  if (mode === "off" || !result) return result;
  const ct = String(headerOf(result.headers, "content-type") ?? "");
  if (!ct.startsWith("text/html")) return result;
  if (headerOf(result.headers, "content-security-policy") || headerOf(result.headers, "content-security-policy-report-only")) {
    return result;
  }
  const nonce = newNonce();
  const headers = { ...(result.headers ?? {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length") delete headers[k];
  headers[mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only"] = cspPolicy(nonce);
  if (result.stream) {
    const stream = result.stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(nonceTransform(nonce))
      .pipeThrough(new TextEncoderStream());
    return { ...result, headers, stream };
  }
  const body = typeof result.body === "string" ? injectNonce(result.body, nonce) : result.body;
  return { ...result, headers, body };
}
