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

import { readdir } from "node:fs/promises";
import path from "node:path";

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
      .map((seg) => {
        const rest = seg.match(/^\[\.\.\.(.+)\]$/); // [...slug] = catch-all
        if (rest) return { param: rest[1], rest: true };
        // [card].png: a param with a fixed extension after it (file routes)
        const suffixed = seg.match(/^\[([^\].]+)\](\.[^/]+)$/);
        if (suffixed) return { param: suffixed[1], suffix: suffixed[2] };
        const m = seg.match(/^\[(.+)\]$/);
        return m ? { param: m[1] } : { lit: seg };
      });
    // A file route's file name has an extension (feed.xml.ts, [card].png.ts): like an API route,
    // it returns a body instead of rendering a page, with the Content-Type of that extension.
    // Decided by the file name, so v1.2/index.tsx stays a page (as nowaki-core decides it too).
    const last = segments[segments.length - 1];
    const nameExt = base.replace(/^.*\]/, "").match(/\.[A-Za-z0-9]+$/)?.[0];
    const fileExt = base === "index" ? undefined : (last?.suffix ?? nameExt);
    const isApi = rel === "api" || rel.startsWith("api/") || fileExt !== undefined;
    routes.push({
      file: abs,
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
  layouts.sort((a, b) => a.prefix.length - b.prefix.length);
  middleware.sort((a, b) => a.prefix.length - b.prefix.length);

  return { routes, layouts, middleware, loadingBoundaries, errorBoundaries, notFound, errorRoute };
}

export function matchRoute(routesOrTable, pathname) {
  const routes = Array.isArray(routesOrTable) ? routesOrTable : routesOrTable.routes;
  const parts = pathname.split("/").filter(Boolean);
  outer: for (const route of routes) {
    const segs = route.segments;
    const rest = segs.length > 0 && segs[segs.length - 1].rest;
    if (rest) {
      // A trailing catch-all collects the rest (≥1). Fixed part = segs.length - 1.
      if (parts.length < segs.length) continue;
    } else if (segs.length !== parts.length) {
      continue;
    }
    const params = {};
    const fixed = rest ? segs.length - 1 : segs.length;
    for (let i = 0; i < fixed; i++) {
      const seg = segs[i];
      const part = decodeURIComponent(parts[i]);
      if (seg.lit !== undefined) {
        if (seg.lit !== part) continue outer;
      } else if (seg.suffix !== undefined) {
        if (part.length <= seg.suffix.length || !part.endsWith(seg.suffix)) continue outer;
        params[seg.param] = part.slice(0, -seg.suffix.length);
      } else {
        params[seg.param] = part;
      }
    }
    if (rest) {
      // A catch-all param is an array of the remaining segments.
      params[segs[segs.length - 1].param] = parts.slice(fixed).map((p) => decodeURIComponent(p));
    }
    return { file: route.file, params, isApi: route.isApi, fileExt: route.fileExt };
  }
  return null;
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
