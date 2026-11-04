// The URLs of ISR pages (`export const revalidate` > 0): `nowaki start` renders each one once at
// startup, so the first visitor already gets a cached page from the Rust front. Static routes give
// one URL; dynamic routes give one per `staticPaths` entry (routes without it are skipped).

export async function isrUrls(env, { max = 1024 } = {}) {
  const { routes } = env.routeTable();
  const urls = new Set();
  for (const route of routes) {
    if (route.isApi || urls.size >= max) continue;
    let mod;
    try {
      mod = await env.importModule(route.file);
    } catch {
      continue; // the first real request reports it
    }
    const r = Number(mod?.revalidate);
    if (!Number.isFinite(r) || r <= 0) continue;
    if (!route.segments.some((s) => s.param)) {
      urls.add(urlOf(route, {}));
      continue;
    }
    let list = mod.staticPaths;
    try {
      if (typeof list === "function") list = await list();
    } catch (err) {
      console.warn(`[nowaki] ISR warm-up: staticPaths of ${route.file} failed: ${err?.message ?? err}`);
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const params of list) {
      const url = urlOf(route, params ?? {});
      if (url) urls.add(url);
      if (urls.size >= max) break;
    }
  }
  return [...urls];
}

function urlOf(route, params) {
  const out = [];
  for (const seg of route.segments) {
    if (seg.lit !== undefined) {
      out.push(seg.lit);
      continue;
    }
    const value = params[seg.param];
    const parts = seg.rest ? (Array.isArray(value) ? value : [value]) : [value];
    for (const part of parts) {
      const s = part === undefined || part === null ? "" : String(part);
      if (s === "" || s === "." || s === ".." || s.includes("/")) return null;
      out.push(encodeURIComponent(s));
    }
  }
  return "/" + out.join("/");
}
