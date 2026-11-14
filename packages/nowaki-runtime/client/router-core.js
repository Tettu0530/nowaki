// Pure client router logic (DOM-free, unit-testable).
// Used by router.js. Never reference window/document here.

// Returns the boundary that best matches pathname (deepest directory). prefix "" matches everything.
// loading/error boundaries nest; boundaries in deeper directories win. A prefix is the boundary's
// directory as written: a [param] directory matches any one segment, [...rest] one or more,
// [id].v2 one ending in .v2 (the same rule as underPrefix in server/router.mjs). A route group's
// boundary (its prefix leaves the group out) also lists `routes`, URL patterns in matching order,
// those of routes outside the group marked "!": it applies when the first one the path matches is
// the group's, and at the same prefix it wins over a boundary outside the group.
export function matchBoundary(list, pathname) {
  const parts = String(pathname).split("/").filter(Boolean);
  let best = null;
  let bestDepth = -1;
  for (const b of list || []) {
    const want = (b.prefix || "").split("/").filter(Boolean);
    if (!segmentsHit(want, parts)) continue;
    if (b.routes && b.routes.find((r) => matchPattern(r.replace(/^!/, ""), pathname))?.[0] !== "/") continue;
    // At the same depth a group's boundary (closer to the route on disk) wins.
    if (want.length > bestDepth || (want.length === bestDepth && b.routes)) {
      best = b;
      bestDepth = want.length;
    }
  }
  return best;
}

// Does a URL path match a route pattern ("/photo/[id]", "/docs/[...rest]", "/og/[card].png")?
// Trailing slashes don't count.
export function matchPattern(pattern, pathname) {
  return segmentsHit(String(pattern).split("/").filter(Boolean), String(pathname).split("/").filter(Boolean), true);
}

// `want` (segments as written) against `parts` (a path's, percent-encoded): as a prefix of the
// path, or the whole path when `exact`.
function segmentsHit(want, parts, exact) {
  for (let i = 0; i < want.length; i++) {
    if (i >= parts.length) return false;
    if (/^\[\.\.\..+\]$/.test(want[i])) return true;
    let part;
    try {
      part = decodeURIComponent(parts[i]);
    } catch {
      return false;
    }
    const suffixed = want[i].match(/^\[[^\].]+\](\.[^/]+)$/); // [id].v2
    if (suffixed) {
      if (part.length <= suffixed[1].length || !part.endsWith(suffixed[1])) return false;
      continue;
    }
    if (/^\[.+\]$/.test(want[i])) continue;
    if (part !== want[i]) return false;
  }
  return !exact || want.length === parts.length;
}

// Small TTL + LRU page cache (Router Cache). Values are opaque ({doc,finalUrl} in router.js).
export function createPageCache({ ttlMs = 30000, max = 32, now = () => Date.now() } = {}) {
  const map = new Map(); // key -> { value, at }
  const fresh = (e) => e && now() - e.at < ttlMs;
  return {
    get(key) {
      const e = map.get(key);
      if (!fresh(e)) {
        if (e) map.delete(key);
        return undefined;
      }
      map.delete(key); // LRU: move touched entry to the end
      map.set(key, e);
      return e.value;
    },
    has(key) {
      const e = map.get(key);
      if (fresh(e)) return true;
      if (e) map.delete(key);
      return false;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

// The nonce a fetched page's response was sent with (its CSP header), or undefined.
export function responseNonce(res) {
  const h = res.headers;
  return /'nonce-([^']+)'/.exec(h.get("content-security-policy") || h.get("content-security-policy-report-only") || "")?.[1];
}

// A fetched page's HTML for DOMParser, under NOWAKI_CSP (`nonce`: this document's). Its document
// shares this one's CSP, so a tag with another response's nonce is a violation the moment it
// parses. The tags the server nonced, which carry `from` (that response's nonce, responseNonce),
// get this document's nonce instead. Any other nonce attribute of a <script> / <style> is dropped:
// only Nowaki's own tags ever get one, so raw HTML in the page can't pass for them.
export function carryNonces(html, nonce, from) {
  if (!nonce) return html;
  return html.replace(/(<(?:script|style)(?=[\s>/])[^>]*?)\s+nonce="([^"]*)"/gi, (_, tag, n) =>
    from && n === from ? `${tag} nonce="${nonce}"` : tag,
  );
}

// Whether a parsed <script> / <style> is one carryNonces gave this document's nonce.
export function hasNonce(el, nonce) {
  return !!nonce && (el.nonce || el.getAttribute("nonce")) === nonce;
}

// Whether a client navigation runs as a View Transition: something opted in (the link, the page
// left or the page entered), the browser has document.startViewTransition, and the visitor doesn't
// prefer reduced motion. Otherwise the router swaps the page synchronously, as without them.
export function shouldTransition(optedIn, supported, reducedMotion) {
  return !!optedIn && !!supported && !reducedMotion;
}
