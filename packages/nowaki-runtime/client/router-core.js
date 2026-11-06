// Pure client router logic (DOM-free, unit-testable).
// Used by router.js. Never reference window/document here.

// Returns the boundary that best matches pathname (deepest directory). prefix "" matches everything.
// loading/error boundaries nest; boundaries in deeper directories win. A prefix is the boundary's
// directory as written: a [param] directory matches any one segment, [...rest] one or more,
// [id].v2 one ending in .v2 (the same rule as underPrefix in server/router.mjs).
export function matchBoundary(list, pathname) {
  const parts = String(pathname).split("/").filter(Boolean);
  let best = null;
  let bestDepth = -1;
  for (const b of list || []) {
    const want = (b.prefix || "").split("/").filter(Boolean);
    if (!prefixHit(want, parts)) continue;
    if (want.length > bestDepth) {
      best = b;
      bestDepth = want.length;
    }
  }
  return best;
}

function prefixHit(want, parts) {
  for (let i = 0; i < want.length; i++) {
    if (i >= parts.length) return false;
    if (/^\[\.\.\..+\]$/.test(want[i])) return true;
    let part;
    try {
      part = decodeURIComponent(parts[i]);
    } catch {
      return false;
    }
    if (/^\[.+\]$/.test(want[i])) continue;
    if (part !== want[i]) return false;
  }
  return true;
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
