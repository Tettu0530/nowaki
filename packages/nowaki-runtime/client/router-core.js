// Pure client router logic (DOM-free, unit-testable).
// Used by router.js. Never reference window/document here.

// Returns the boundary that best matches pathname (longest prefix). prefix "" matches everything.
// loading/error boundaries nest; boundaries in deeper directories win.
export function matchBoundary(list, pathname) {
  let best = null;
  for (const b of list || []) {
    const p = b.prefix || "";
    const hit = p === "" || pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/");
    if (!hit) continue;
    if (best === null || p.length > (best.prefix || "").length) best = b;
  }
  return best;
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
