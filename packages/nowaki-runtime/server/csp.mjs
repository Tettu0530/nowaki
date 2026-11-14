// Opt-in Content Security Policy with a per-response nonce for the adapters
// (NOWAKI_CSP=report-only|enforce). Mirrors crates/nowaki/src/csp.rs: the nonce goes only on the
// tags Nowaki rendered, which carry `nonce="<marker>"` with the render's marker (server/nonce.mjs),
// never on a <script> / <style> that came in as raw HTML. Streams stay streams, and a response
// that already sets a CSP is left alone (its marker attributes are removed). No node: imports, so
// the Edge worker uses it too.

const env = globalThis.process?.env ?? {};

/// The response header a render names its marker in. Internal: applyCsp and csp.rs remove it.
export const CSP_MARKER_HEADER = "x-nowaki-csp-marker";

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

/// `html` with every `nonce="<marker>"` replaced by `to` (the response's `nonce="…"`, or "").
export function stampMarker(html, marker, to) {
  return html.replaceAll(`nonce="${marker}"`, to);
}

/// A TransformStream of strings that replaces the marker attribute across chunk boundaries.
export function markerTransform(marker, to) {
  const needle = `nonce="${marker}"`;
  let carry = "";
  return new TransformStream({
    transform(chunk, controller) {
      const s = stampMarker(carry + chunk, marker, to);
      // A tail that could still become the marker with the next chunk waits for it.
      let keep = Math.min(needle.length - 1, s.length);
      while (keep > 0 && !needle.startsWith(s.slice(s.length - keep))) keep--;
      carry = s.slice(s.length - keep);
      controller.enqueue(s.slice(0, s.length - keep));
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

/// Applies the CSP to a handler result ({ status, headers, body | stream }); non-HTML results pass
/// through unchanged. The marker the render named (CSP_MARKER_HEADER) becomes this response's
/// nonce. A result without one keeps its body as it is: nothing in it gets the nonce.
export function applyCsp(result) {
  const mode = cspMode();
  if (mode === "off" || !result) return result;
  const ct = String(headerOf(result.headers, "content-type") ?? "");
  if (!ct.startsWith("text/html")) return result;
  const headers = { ...(result.headers ?? {}) };
  let marker;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== CSP_MARKER_HEADER) continue;
    marker ??= String(headers[k]);
    delete headers[k];
  }
  // Only a marker as nonce.mjs makes them: an empty or short value must never match app attributes.
  if (marker !== undefined && !/^[0-9a-f]{32}$/.test(marker)) marker = undefined;
  // With the app's own CSP there is no nonce of ours: the marked tags just lose the marker.
  const own = headerOf(headers, "content-security-policy") || headerOf(headers, "content-security-policy-report-only");
  if (own && !marker) return result;
  let to = "";
  if (!own) {
    const nonce = newNonce();
    headers[mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only"] = cspPolicy(nonce);
    to = `nonce="${nonce}"`;
  }
  if (!marker) return { ...result, headers };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length") delete headers[k];
  if (result.stream) {
    const stream = result.stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(markerTransform(marker, to))
      .pipeThrough(new TextEncoderStream());
    return { ...result, headers, stream };
  }
  const body = typeof result.body === "string" ? stampMarker(result.body, marker, to) : result.body;
  return { ...result, headers, body };
}
