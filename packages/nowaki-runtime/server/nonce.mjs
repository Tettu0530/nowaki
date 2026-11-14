// The render's CSP marker (NOWAKI_CSP). Under a CSP each request renders with a fresh random
// marker: Nowaki writes ` nonce="<marker>"` on the scripts and styles it emits, `nonce()` hands it
// to app code, and the response names it in CSP_MARKER_HEADER. The CSP layer (csp.rs on dev and
// start, csp.mjs on the adapters) then turns exactly those attributes into the response's nonce.
// Raw HTML in the page can't know the marker, so a <script> / <style> it carries gets no nonce.
// The marker never reaches the browser, and an ISR entry keeps its own (each hit gets a new nonce).
// With NOWAKI_CSP off a request pays one property read (cspOn) and nothing else.

import { AsyncLocalStorage } from "node:async_hooks";
import { CSP_MARKER_HEADER, cspMode, newNonce } from "./csp.mjs";

// One store per process even if the runtime is loaded twice (an app bundle with its own copy).
const KEY = Symbol.for("nowaki.cspMarker");
const store = () => (globalThis[KEY] ??= new AsyncLocalStorage());

const env = globalThis.process?.env ?? {};

/// Whether requests render with markers: NOWAKI_CSP is set (read per request, as applyCsp does,
/// since a Worker's vars can arrive after this module loads). Unset, that is one property read.
export function cspOn() {
  return !!env.NOWAKI_CSP && cspMode() !== "off";
}

/// Runs `fn` (a request) with a new marker, and names it on an HTML result.
export async function withCspMarker(fn) {
  const marker = newNonce();
  const result = await store().run(marker, fn);
  return markResult(result, marker);
}

/// `result` with `marker` named in its headers when it is HTML (any value the app set is dropped).
export function markResult(result, marker) {
  const headers = result?.headers;
  if (!headers) return result;
  let html = false;
  const next = {};
  for (const [k, v] of Object.entries(headers)) {
    const n = k.toLowerCase();
    if (n === CSP_MARKER_HEADER) continue;
    if (n === "content-type" && String(v).startsWith("text/html")) html = true;
    next[k] = v;
  }
  if (!html) return result;
  next[CSP_MARKER_HEADER] = marker;
  return { ...result, headers: next };
}

/// Runs `fn` with `marker` as the current one (an HTML response built outside handleRequest).
export function runWithMarker(marker, fn) {
  return store().run(marker, fn);
}

/// The nonce for an inline `<script>` / `<style>` the app renders on the server: the value of
/// its `nonce` attribute. "" with NOWAKI_CSP off or outside a request.
export function nonce() {
  return globalThis[KEY]?.getStore() || "";
}

/// ` nonce="<marker>"` for a tag Nowaki emits, or "".
export function nonceAttr() {
  const m = globalThis[KEY]?.getStore();
  return m ? ` nonce="${m}"` : "";
}
