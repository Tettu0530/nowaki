// File-based routing: scans routes/ into a route table.
//   routes/index.tsx        → /
//   routes/about.tsx        → /about
//   routes/blog/[slug].tsx  → /blog/:slug
//   routes/api/hello.ts     → /api/hello (handler)
// Convention files (not regular routes):
//   _layout.tsx     wraps pages under its directory (nestable)
//   _middleware.ts  pre-processes requests under its directory (nestable)
//   _404.tsx        page for unmatched paths
//   _500.tsx        page for render failures (`_error.tsx`, its old alias, is refused)
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
// Parallel routes: a directory named "@name" is a slot of the _layout in its parent directory
//   (routes/@modal/ → `slots.modal` of routes/_layout). Its files are never routes of their own:
//   a slot file matches the URL below its owner's directory (routes/@modal/photo/[id].tsx matches
//   /photo/42), and @name/default.tsx renders when none matches. Files starting with "_" and
//   nested slots inside a slot are ignored.
// Intercepting routes: inside a slot, a path segment starting with "(.)", "(..)" or "(...)" marks
//   a file that takes over another URL on client navigation (routes/@modal/(.)photo/[id].tsx
//   intercepts /photo/[id]): `slot.intercepts`, each with the `pattern` it intercepts. The marker
//   counts URL segments (groups and slots don't count) from the directory holding it: "(.)" the
//   same level, "(..)" one up (repeatable: "(..)(..)"), "(...)" the root. Served only as a
//   fragment for the client router (handler.mjs); outside a slot they are recorded
//   (`intercepts`), not served.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { decodeSegment, matchSegments, parseSegment } from "./segments.mjs";

const ROUTE_EXT = /\.(tsx|ts|jsx|js|mdx)$/;
// Kept in step with nowaki-core routes::is_route_group.
const GROUP_DIR = /^\((?!\.)[^)/]+\)$/;
// File conventions removed before 1.0, refused rather than ignored so the page doesn't silently
// disappear (nowaki-core routes::removed_convention fails the build the same way).
const REMOVED_CONVENTIONS = {
  _error:
    "`_error` is no longer a file convention (removed in 0.20.0). Rename it to `_500` (the server's error page); `error.tsx` is the client navigation error boundary.",
};
// Kept in step with nowaki-core routes::is_intercept_segment.
const INTERCEPT = /^\(\.{1,3}\)/;

/// Does a path segment mark an intercepting route ("(.)photo", "(..)x", "(...)x")?
export function isInterceptSegment(name) {
  return INTERCEPT.test(name);
}

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
  // "ownerDir\0name" → slot, and intercepting route files outside any slot.
  const slots = new Map();
  const intercepts = [];
  // URL shape → { rel, inGroup } of the route files seen so far.
  const urls = new Map();

  for (const rel of files) {
    const abs = path.join(routesDir, rel);
    const parts = rel.split("/");
    const slotAt = parts.findIndex((p) => p.startsWith("@"));
    if (slotAt !== -1) {
      addSlotFile(slots, parts, slotAt, abs);
      continue;
    }
    const base = path.basename(rel).replace(ROUTE_EXT, "");
    const dirPrefix = dirToPrefix(path.dirname(rel));
    if (parts.some(isInterceptSegment)) {
      intercepts.push({ file: abs, dir: dirPrefix });
      continue;
    }
    // The directory as the URL sees it: route groups left out.
    const urlPrefix = stripRouteGroups(dirPrefix);
    const inGroup = urlPrefix !== dirPrefix;

    if (base === "_layout") {
      layouts.push({ prefix: dirPrefix, file: abs });
      continue;
    }
    if (base === "_middleware") {
      // In a group, middleware goes by containment (routeUnderPrefix), since the group has no URL.
      middleware.push(inGroup ? { prefix: dirPrefix, file: abs, group: true } : { prefix: dirPrefix, file: abs });
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
    if (base === "_500") {
      errorRoute = abs;
      continue;
    }
    if (Object.hasOwn(REMOVED_CONVENTIONS, base)) {
      throw new Error(`routes/${rel}: ${REMOVED_CONVENTIONS[base]}`);
    }
    if (base.startsWith("_")) continue; // reserved

    const urlRel = inGroup ? (urlPrefix ? urlPrefix.slice(1) + "/" : "") + path.posix.basename(rel) : rel;
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
    const prev = claimUrl(urls, segments, rel, inGroup);
    if (prev) {
      throw new Error(
        `routes/${prev} and routes/${rel} both serve ${urlPath}: route groups "(name)" add no URL segment. Rename or move one of them.`,
      );
    }
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

  // static > dynamic > catch-all: descending specificity (literal segments, a suffixed param
  // counting half); on ties, catch-all goes last.
  routes.sort(bySpecificity);
  // Root → leaf order, by segment count ("/[o]/x" is deeper than "/abcdefgh").
  layouts.sort((a, b) => prefixDepth(a.prefix) - prefixDepth(b.prefix));
  middleware.sort((a, b) => prefixDepth(a.prefix) - prefixDepth(b.prefix));
  // The client takes the boundary of the deepest URL prefix and, at the same prefix, the last
  // group boundary that lists the route (matchBoundary): ungrouped ones first, then groups
  // outermost first, so "(app)/(admin)/loading.tsx" wins over "(app)/loading.tsx".
  const ungroupedFirst = (a, b) => (a.urlPrefix !== a.prefix) - (b.urlPrefix !== b.prefix) || prefixDepth(a.prefix) - prefixDepth(b.prefix);
  loadingBoundaries.sort(ungroupedFirst);
  errorBoundaries.sort(ungroupedFirst);

  const slotList = [...slots.values()];
  for (const slot of slotList) {
    slot.routes.sort(bySpecificity);
    // Recorded-only entries (no segments) last; they never match.
    slot.intercepts.sort((a, b) => !a.segments - !b.segments || (a.segments ? bySpecificity(a, b) : 0));
  }
  return { routes, layouts, middleware, loadingBoundaries, errorBoundaries, notFound, errorRoute, slots: slotList, intercepts };
}

function bySpecificity(a, b) {
  return b.specificity - a.specificity || (a.rest ? 1 : 0) - (b.rest ? 1 : 0);
}

// A file under routes/…/@name/. `parts` is its path relative to routes/, split on "/", and
// parts[slotAt] is the "@name" directory.
function addSlotFile(slots, parts, slotAt, abs) {
  const name = parts[slotAt].slice(1);
  const inner = parts.slice(slotAt + 1);
  // routes/@x.tsx is a file, not a slot directory; "@" alone has no name.
  if (!name || inner.length === 0 || inner.some((p) => p.startsWith("@"))) return;
  const base = inner[inner.length - 1].replace(ROUTE_EXT, "");
  if (base.startsWith("_") || base === "loading" || base === "error") return;
  const ownerDir = slotAt ? "/" + parts.slice(0, slotAt).join("/") : "";
  const key = `${ownerDir}\0${name}`;
  let slot = slots.get(key);
  if (!slot) slots.set(key, (slot = { ownerDir, name, routes: [], default: null, intercepts: [] }));
  if (inner.some(isInterceptSegment)) {
    const pattern = interceptTarget(parts.slice(0, slotAt), inner);
    // Without a target (or as a file route name) it is recorded only, like one outside a slot.
    if (pattern === null || /\.[A-Za-z0-9]+$/.test(base.replace(/^.*\]/, ""))) {
      slot.intercepts.push({ file: abs, rel: inner.join("/") });
      return;
    }
    const segments = pattern.split("/").filter(Boolean).map(parseSegment);
    slot.intercepts.push({
      file: abs,
      rel: inner.join("/"),
      pattern,
      segments,
      specificity: segments.filter((s) => s.lit).length + segments.filter((s) => s.suffix).length / 2,
      rest: segments.some((s) => s.rest),
    });
    return;
  }
  if (base === "default") {
    // Only @name/default is the fallback; a nested default is reserved.
    if (inner.length === 1) slot.default = abs;
    return;
  }
  // A slot renders a page: a file route name (feed.xml, [card].png) has no place in one.
  if (/\.[A-Za-z0-9]+$/.test(base.replace(/^.*\]/, ""))) return;
  // The owner's URL followed by the slot file's path, groups left out of both.
  const urlParts = [...parts.slice(0, slotAt), ...inner.slice(0, -1)].filter((p) => !GROUP_DIR.test(p));
  if (base !== "index") urlParts.push(base);
  const segments = urlParts.map(parseSegment);
  slot.routes.push({
    file: abs,
    segments,
    specificity: segments.filter((s) => s.lit).length + segments.filter((s) => s.suffix).length / 2,
    rest: segments.some((s) => s.rest),
  });
}

/// The URL pattern an intercepting slot file takes over ("/photo/[id]"), or null when its marker
/// climbs above routes/ or the path has more than one. `owner` is the path to the slot directory
/// and `inner` the file's path inside it, both split on "/" (route groups still in). Kept in step
/// with nowaki-core routes::intercept_target.
export function interceptTarget(owner, inner) {
  const parts = [...inner];
  parts[parts.length - 1] = parts[parts.length - 1].replace(ROUTE_EXT, "");
  const k = parts.findIndex(isInterceptSegment);
  if (k < 0 || parts.slice(k + 1).some(isInterceptSegment)) return null;
  const base = [...owner, ...parts.slice(0, k)].filter((p) => !GROUP_DIR.test(p));
  let name = parts[k];
  if (name.startsWith("(...)")) {
    base.length = 0;
    name = name.slice(5);
  } else if (name.startsWith("(.)")) {
    name = name.slice(3);
  } else {
    while (name.startsWith("(..)")) {
      if (!base.length) return null;
      base.pop();
      name = name.slice(4);
    }
  }
  if (!name) return null;
  const out = [...base, name, ...parts.slice(k + 1).filter((p) => !GROUP_DIR.test(p))];
  if (out[out.length - 1] === "index") out.pop();
  return "/" + out.join("/");
}

/// The intercepting file of a slot that takes over a request path given as decoded segments
/// (`pathParts`, null when one didn't decode): { file, params }, or null.
export function matchIntercept(slot, parts) {
  if (!parts) return null;
  for (const r of slot.intercepts) {
    const params = r.segments && matchSegments(r.segments, parts);
    if (params) return { file: r.file, params };
  }
  return null;
}

/// The file a slot renders for a request path given as percent-decoded segments (`pathParts`;
/// null when one didn't decode): the first slot route that matches, else the slot's default.
/// Returns { file, params } (params null for the default), or null when there is neither.
export function matchSlot(slot, parts) {
  if (parts) {
    for (const r of slot.routes) {
      const params = matchSegments(r.segments, parts);
      if (params) return { file: r.file, params };
    }
  }
  return slot.default ? { file: slot.default, params: null } : null;
}

/// A request path split into percent-decoded segments, or null when one doesn't decode.
export function pathParts(pathname) {
  const parts = pathname.split("/").filter(Boolean).map(decodeSegment);
  return parts.includes(null) ? null : parts;
}

// Two route files serving the same URL is an error when a group causes it ((a)/about vs
// (b)/about, or about.tsx vs (b)/about.tsx). Param names don't matter: [slug] and [id] collide.
// Other duplicates (about.tsx vs about/index.tsx) are not an error here. Returns the earlier
// file's rel on a collision.
function claimUrl(seen, segments, rel, inGroup) {
  const key = segments.map((s) => (s.lit !== undefined ? `=${s.lit}` : s.rest ? "*" : `:${s.suffix ?? ""}`)).join("/");
  const prev = seen.get(key);
  if (prev && (prev.inGroup || inGroup)) return prev.rel;
  if (!prev) seen.set(key, { rel, inGroup });
  return null;
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
