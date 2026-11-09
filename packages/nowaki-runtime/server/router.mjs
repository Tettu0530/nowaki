// File-based routing: scans routes/ into a route table.
//   routes/index.tsx        → /
//   routes/about.tsx        → /about
//   routes/blog/[slug].tsx  → /blog/:slug
//   routes/api/hello.ts     → /api/hello (handler)
// Convention files (not regular routes):
//   _layout.tsx     wraps pages under its directory (nestable)
//   _middleware.ts  pre-processes requests under its directory (nestable)
//   _404.tsx        page for unmatched paths
//   _500.tsx /_error.tsx  page for render failures
//   loading.tsx     loading UI shown during client navigation (nestable)
//   error.tsx       fallback UI when client navigation fails (nestable)
// A convention file's prefix is its directory as written ("/org/[org]").
//   _middleware: runs for every request whose URL is under the directory (underPrefix; a [param]
//     directory matches any one segment), matched route or not: pages, API routes and 404s.
//   _layout / error: apply to route files inside the directory (routeUnderPrefix), as
//     nowaki-core's budget::layouts_for and route_css find layouts.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { decodeSegment, matchSegments, parseSegment } from "./segments.mjs";

const ROUTE_EXT = /\.(tsx|ts|jsx|js|mdx)$/;

export async function scanRoutes(appRoot) {
  const routesDir = path.join(appRoot, "routes");
  const files = (await walk(routesDir, "")).filter((rel) => ROUTE_EXT.test(rel));

  const routes = [];
  const layouts = [];
  const middleware = [];
  const loadingBoundaries = [];
  const errorBoundaries = [];
  let notFound = null;
  let errorRoute = null;

  for (const rel of files) {
    const abs = path.join(routesDir, rel);
    const base = path.basename(rel).replace(ROUTE_EXT, "");
    const dirPrefix = dirToPrefix(path.dirname(rel));

    if (base === "_layout") {
      layouts.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "_middleware") {
      middleware.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "loading") {
      loadingBoundaries.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "error") {
      errorBoundaries.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "_404") {
      notFound = abs;
      continue;
    }
    if (base === "_500" || base === "_error") {
      errorRoute = abs;
      continue;
    }
    if (base.startsWith("_")) continue; // reserved

    let urlPath = "/" + rel.replace(ROUTE_EXT, "");
    if (urlPath.endsWith("/index")) {
      urlPath = urlPath.slice(0, -"/index".length) || "/";
    }
    const segments = urlPath
      .split("/")
      .filter(Boolean)
      .map(parseSegment);
    // A file route's file name has an extension (feed.xml.ts, [card].png.ts): like an API route,
    // it returns a body instead of rendering a page, with the Content-Type of that extension.
    // Decided by the file name, so v1.2/index.tsx stays a page (as nowaki-core decides it too).
    const last = segments[segments.length - 1];
    const nameExt = base.replace(/^.*\]/, "").match(/\.[A-Za-z0-9]+$/)?.[0];
    const fileExt = base === "index" ? undefined : (last?.suffix ?? nameExt);
    const isApi = rel === "api" || rel.startsWith("api/") || fileExt !== undefined;
    routes.push({
      file: abs,
      // The file's directory as written ("/org/[org]"), for layout / error-boundary containment.
      dir: dirPrefix,
      segments,
      isApi,
      fileExt,
      // A suffixed param ([card].png) is more specific than a bare one, less than a literal.
      specificity: segments.filter((s) => s.lit).length + segments.filter((s) => s.suffix).length / 2,
      rest: segments.some((s) => s.rest),
    });
  }

  // static > dynamic > catch-all. Descending specificity (literal count); on ties, catch-all goes last.
  routes.sort((a, b) => b.specificity - a.specificity || (a.rest ? 1 : 0) - (b.rest ? 1 : 0));
  // root→leaf order (shorter prefixes first)
  // (by segment count: "/[o]/x" is deeper than "/abcdefgh" though shorter as a string).
  layouts.sort((a, b) => prefixDepth(a.prefix) - prefixDepth(b.prefix));
  middleware.sort((a, b) => prefixDepth(a.prefix) - prefixDepth(b.prefix));

  return { routes, layouts, middleware, loadingBoundaries, errorBoundaries, notFound, errorRoute };
}

export function matchRoute(routesOrTable, pathname) {
  const routes = Array.isArray(routesOrTable) ? routesOrTable : routesOrTable.routes;
  // Decoded up front: a match reads every part, so a malformed percent-escape anywhere means no
  // route (404), never a throw.
  const parts = pathname.split("/").filter(Boolean).map(decodeSegment);
  if (parts.includes(null)) return null;
  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params) return { file: route.file, params, isApi: route.isApi, fileExt: route.fileExt };
  }
  return null;
}

/// Number of directories in a convention-file prefix ("" → 0, "/org/[org]" → 2).
export function prefixDepth(prefix) {
  return (prefix || "").split("/").filter(Boolean).length;
}

/// Does a request path fall under a convention file's directory prefix? `prefix` is the directory
/// as written ("/org/[org]"), and each directory name is read the way a route segment is
/// (parseSegment): a literal must equal the (percent-decoded) segment, [param] matches any one
/// segment, [param].ext one that ends in .ext, and [...rest] the rest (one or more).
/// prefix "" matches everything. Middleware uses this for every request, matched route or not.
export function underPrefix(pathname, prefix) {
  const want = (prefix || "").split("/").filter(Boolean);
  if (want.length === 0) return true;
  const parts = String(pathname).split("/").filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    const seg = parseSegment(want[i]);
    if (i >= parts.length) return false;
    if (seg.rest) return true;
    // Compare decoded, as matchRoute does: /%61dmin must not slip past routes/admin/_middleware.ts.
    const part = decodeSegment(parts[i]);
    if (part === null) return false;
    if (seg.lit !== undefined) {
      if (part !== seg.lit) return false;
    } else if (seg.suffix !== undefined) {
      if (part.length <= seg.suffix.length || !part.endsWith(seg.suffix)) return false;
    }
  }
  return true;
}

/// Is a route file inside a convention file's directory? Plain directory containment on the file
/// path, as nowaki-core's budget::layouts_for walks a file's parent directories:
/// routes/org/[org]/_layout wraps routes/org/[org]/settings.tsx and routes/org/[org]/index.tsx,
/// but not the sibling routes/org/[org].tsx nor routes/org/acme/settings.tsx.
/// Used for layouts and error boundaries of a matched route.
export function routeUnderPrefix(route, prefix) {
  if (!prefix) return true;
  const dir = route?.dir ?? "";
  return dir === prefix || dir.startsWith(prefix + "/");
}

// "." → "" (root)
function dirToPrefix(dir) {
  if (!dir || dir === ".") return "";
  return "/" + dir.split(path.sep).join("/");
}

async function walk(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}
