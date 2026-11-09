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
// Route groups: a directory named "(name)" groups files without adding a URL segment
//   (routes/(marketing)/about.tsx → /about). Its _layout / loading / error apply to the files
//   inside it, and so does its _middleware (containment, not URL prefix: it doesn't run for
//   404s). Names starting with "." ("(.)", "(..)") are reserved and stay literal.
//   Two files that serve the same URL because of groups are an error.
// Parallel routes: a directory named "@slot" renders in the matching layout's `@slot` prop
//   without adding a URL segment (routes/gallery/@panel/[id].tsx → /gallery/:id in `panel`).
//   `default.tsx` in a slot is the fallback when that slot has no route for the URL. The primary
//   page stays in the implicit `children` slot (files outside any `@` directory).

import { readdir } from "node:fs/promises";
import path from "node:path";
import { decodeSegment, matchSegments, parseSegment } from "./segments.mjs";

const ROUTE_EXT = /\.(tsx|ts|jsx|js|mdx)$/;
// Kept in step with nowaki-core routes::is_route_group.
const GROUP_DIR = /^\((?!\.)[^)/]+\)$/;
// Kept in step with nowaki-core routes::is_parallel_slot.
const SLOT_DIR = /^@[A-Za-z]\w*$/;

/// Is a directory name a route group ("(marketing)")?
export function isRouteGroup(name) {
  return GROUP_DIR.test(name);
}

/// A directory prefix ("/(marketing)/docs") without its route groups ("/docs").
export function stripRouteGroups(prefix) {
  if (!prefix || !prefix.includes("(")) return prefix;
  const kept = prefix.split("/").filter((p) => p && !GROUP_DIR.test(p));
  return kept.length ? "/" + kept.join("/") : "";
}

/// Is a directory name a parallel slot ("@panel")?
export function isParallelSlot(name) {
  return SLOT_DIR.test(name);
}

/// Strip `@slot` directories from a convention prefix (they are not URL segments).
export function stripParallelSlots(prefix) {
  if (!prefix || !prefix.includes("@")) return prefix;
  const kept = prefix.split("/").filter((p) => p && !isParallelSlot(p));
  return kept.length ? "/" + kept.join("/") : "";
}

/// Route groups and parallel slots left out of the URL.
export function stripRouteUrlPrefix(prefix) {
  return stripParallelSlots(stripRouteGroups(prefix));
}

function slotFromRel(rel) {
  const parts = rel.split(/[/\\]/);
  parts.pop();
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isParallelSlot(parts[i])) {
      const name = parts[i].slice(1);
      if (name === "children") {
        throw new Error(`routes/${rel}: @children is reserved (use files outside @ directories for the main slot).`);
      }
      return name;
    }
  }
  return "children";
}

/// The layout directory that owns a slot (`routes/g/@panel/x` → `/g`). Kept in step with activeSlotsForRoute.
export function slotLayoutDir(route) {
  const dir = route?.dir ?? "";
  const i = dir.lastIndexOf("/@");
  return i >= 0 ? dir.slice(0, i) : dir;
}

/// @slot names that are direct children of the matched page's layout directory (not every slot in the app).
export function activeSlotsForRoute(table, primaryFile) {
  const route = table.routes.find((r) => r.file === primaryFile);
  if (!route) return [];
  const layoutDir = slotLayoutDir(route);
  const slots = new Set();
  const owns = (slot, dir) => {
    const root = layoutDir ? `${layoutDir}/@${slot}` : `/@${slot}`;
    return dir === root || dir.startsWith(`${root}/`);
  };
  for (const r of table.routes) {
    if (r.slot === "children") continue;
    if (owns(r.slot, r.dir)) slots.add(r.slot);
  }
  for (const d of table.slotDefaults ?? []) {
    if (owns(d.slot, d.prefix)) slots.add(d.slot);
  }
  return [...slots];
}

export async function scanRoutes(appRoot) {
  const routesDir = path.join(appRoot, "routes");
  const files = (await walk(routesDir, "")).filter((rel) => ROUTE_EXT.test(rel));

  const routes = [];
  const layouts = [];
  const middleware = [];
  const loadingBoundaries = [];
  const errorBoundaries = [];
  const slotDefaults = [];
  let notFound = null;
  let errorRoute = null;
  // `${slot}:${urlShape}` → { rel, special } (special = route group or any @slot on the path).
  const urls = new Map();

  for (const rel of files) {
    const abs = path.join(routesDir, rel);
    const base = path.basename(rel).replace(ROUTE_EXT, "");
    const dirPrefix = dirToPrefix(path.dirname(rel));
    // The directory as the URL sees it: route groups and @slots left out.
    const urlPrefix = stripRouteUrlPrefix(dirPrefix);
    const slot = slotFromRel(rel);
    const slotParts = rel.split(/[/\\]/).slice(0, -1).filter(isParallelSlot);
    if (slotParts.length > 1) {
      throw new Error(`routes/${rel}: nested @slot directories are not supported (use one @name per branch).`);
    }
    const special = urlPrefix !== dirPrefix;

    if (base === "_layout") {
      layouts.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "_middleware") {
      // In a group, middleware goes by containment (routeUnderPrefix), since the group has no URL.
      middleware.push(special ? { prefix: dirPrefix, file: abs, group: true } : { prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "default" && slot !== "children") {
      slotDefaults.push({ slot, prefix: dirPrefix, urlPrefix, file: abs });
      continue;
    }
    if (base === "loading") {
      loadingBoundaries.push({ prefix: dirPrefix, urlPrefix, file: abs });
      continue;
    }
    if (base === "error") {
      errorBoundaries.push({ prefix: dirPrefix, urlPrefix, file: abs });
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

    const urlRel = special ? (urlPrefix ? urlPrefix.slice(1) + "/" : "") + path.posix.basename(rel) : rel;
    let urlPath = "/" + urlRel.replace(ROUTE_EXT, "");
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
    const isApi = urlRel === "api" || urlRel.startsWith("api/") || fileExt !== undefined;
    if (slot !== "children" && isApi) {
      throw new Error(`routes/${rel}: parallel @${slot} routes can't be API or file routes.`);
    }
    const prev = claimUrl(urls, segments, rel, special, slot);
    if (prev) {
      throw new Error(
        slot === "children"
          ? `routes/${prev} and routes/${rel} both serve ${urlPath}: route groups "(name)" add no URL segment. Rename or move one of them.`
          : `routes/${prev} and routes/${rel} both serve ${urlPath} in the @${slot} slot. Rename or move one of them.`,
      );
    }
    routes.push({
      file: abs,
      // The file's directory as written ("/org/[org]"), for layout / error-boundary containment.
      dir: dirPrefix,
      slot,
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
  // The client takes the first boundary of the deepest URL prefix, so at the same prefix one
  // outside a group ("loading.tsx") goes before a group's ("(app)/loading.tsx").
  const ungroupedFirst = (a, b) => (a.urlPrefix !== a.prefix) - (b.urlPrefix !== b.prefix);
  loadingBoundaries.sort(ungroupedFirst);
  errorBoundaries.sort(ungroupedFirst);

  const slots = [...new Set(routes.map((r) => r.slot).filter((s) => s !== "children"))];
  for (const d of slotDefaults) {
    if (!slots.includes(d.slot)) slots.push(d.slot);
  }
  return { routes, layouts, middleware, loadingBoundaries, errorBoundaries, slotDefaults, slots, notFound, errorRoute };
}

// Two route files serving the same URL is an error when a group causes it ((a)/about vs
// (b)/about, or about.tsx vs (b)/about.tsx). Param names don't matter: [slug] and [id] collide.
// Other duplicates (about.tsx vs about/index.tsx) are left as they were. Returns the earlier
// file's rel on a collision.
function segmentShape(s) {
  if (s.lit !== undefined) return `=${s.lit}`;
  if (s.rest) return "*";
  if (s.suffix !== undefined) return `:${s.suffix}`;
  return ":";
}

function claimUrl(seen, segments, rel, special, slot) {
  const shape = segments.map(segmentShape).join("/");
  const key = `${slot}:${shape}`;
  const prev = seen.get(key);
  if (slot !== "children") {
    if (prev) return prev.rel;
    seen.set(key, { rel, special: true });
    return null;
  }
  if (prev && (prev.special || special)) return prev.rel;
  if (!prev) seen.set(key, { rel, special });
  return null;
}

export function matchRoute(routesOrTable, pathname) {
  const routes = Array.isArray(routesOrTable)
    ? routesOrTable
    : routesOrTable.routes.filter((r) => (r.slot ?? "children") === "children");
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
