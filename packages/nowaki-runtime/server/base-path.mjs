// nowaki.config `basePath` at runtime. One string per process, set once at startup (app.mjs and
// web.mjs from the routing config, the dev sidecar from .nowaki/routing.json; islands.js in the
// browser) and kept on globalThis, so every copy of the runtime (and an island bundle) sees the
// same value. Runtime-neutral: no node: imports.

export function setBasePath(base) {
  globalThis.__nowakiBase = base || "";
}

/// The basePath ("/app"), or "" at the root.
export function basePath() {
  return globalThis.__nowakiBase ?? "";
}

/// `path` under basePath when it is a root-relative path ("/about" → "/app/about", "/" → "/app")
/// that doesn't already start with the base. URLs with a scheme or host ("https://…", "//…"),
/// relative paths and anything that isn't a string come back unchanged.
export function withBase(path) {
  const base = globalThis.__nowakiBase;
  if (!base || typeof path !== "string" || path[0] !== "/" || path[1] === "/" || path[1] === "\\") return path;
  if (path.startsWith(base) && (path.length === base.length || "/?#".includes(path[base.length]))) return path;
  if (path === "/" || path[1] === "?" || path[1] === "#") return base + path.slice(1);
  return base + path;
}
