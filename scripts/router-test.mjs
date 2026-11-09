// Router (scanRoutes / matchRoute) tests. Match results for examples/hello/routes
// are pinned as snapshots; precedence is checked with a synthetic table.
// Usage: node scripts/router-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { scanRoutes, matchRoute, underPrefix, routeUnderPrefix, isRouteGroup, stripRouteGroups } from "../packages/nowaki-runtime/server/router.mjs";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(ROOT, "examples/hello");

let failed = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

const snap = (table, pathname) => {
  const m = matchRoute(table, pathname);
  return m ? { file: path.basename(m.file), params: m.params, isApi: m.isApi } : null;
};

const table = await scanRoutes(app);

eq(snap(table, "/"), { file: "index.tsx", params: {}, isApi: false }, "/ -> index");
eq(snap(table, "/about"), { file: "about.tsx", params: {}, isApi: false }, "/about -> about");
eq(snap(table, "/blog/hello"), { file: "[slug].tsx", params: { slug: "hello" }, isApi: false }, "/blog/:slug param");
eq(snap(table, "/api/hello"), { file: "hello.ts", params: {}, isApi: true }, "/api/hello -> api (isApi)");
eq(snap(table, "/server-fn"), { file: "server-fn.tsx", params: {}, isApi: false }, "/server-fn route");
eq(snap(table, "/virtual"), { file: "virtual.tsx", params: {}, isApi: false }, "/virtual route");
eq(snap(table, "/blog"), null, "/blog (depth 1) does not match /blog/:slug (depth 2)");
eq(snap(table, "/nope/x/y"), null, "unknown deep path -> null");

// catch-all [...path]: collects the remaining segments into an array (≥1 required).
eq(
  snap(table, "/files/a/b/c"),
  { file: "[...path].tsx", params: { path: ["a", "b", "c"] }, isApi: false },
  "catch-all binds the rest as an array",
);
eq(
  snap(table, "/files/x"),
  { file: "[...path].tsx", params: { path: ["x"] }, isApi: false },
  "catch-all matches a single trailing segment",
);
eq(snap(table, "/files"), null, "catch-all needs at least one segment");
eq(
  snap(table, "/files/a%2Fb"),
  { file: "[...path].tsx", params: { path: ["a/b"] }, isApi: false },
  "catch-all segments are url-decoded",
);

// URL decoding (encoded characters in [slug]).
eq(snap(table, "/blog/a%20b"), { file: "[slug].tsx", params: { slug: "a b" }, isApi: false }, "param is url-decoded");

// Convention files are not routes (_layout/_middleware/_404/_500 are tracked separately in the table).
eq(
  table.routes.every((r) => !path.basename(r.file).startsWith("_")),
  true,
  "convention files are not routes",
);

// scanRoutes collects convention metadata separately from navigable routes.
eq(path.basename(table.notFound ?? ""), "_404.tsx", "notFound → routes/_404.tsx");
eq(path.basename(table.errorRoute ?? ""), "_500.tsx", "errorRoute → routes/_500.tsx");
eq(
  table.layouts.map((l) => l.prefix).sort(),
  ["", "/(marketing)", "/blog"],
  "layouts: root + nested /blog + the (marketing) group",
);
eq(table.middleware.map((m) => [m.prefix, m.group === true]), [["", false], ["/(marketing)", true]], "middleware at app root and in a group");
eq(snap(table, "/pricing"), { file: "pricing.tsx", params: {}, isApi: false }, "/pricing → (marketing)/pricing (group left out of the URL)");
eq(snap(table, "/(marketing)/pricing"), null, "a group name is not a URL segment");
eq(table.routes.find((r) => r.file.endsWith("pricing.tsx"))?.dir, "/(marketing)", "a grouped route keeps its physical dir");
eq(table.loadingBoundaries.map((b) => b.prefix), [""], "loading boundary at root");
eq(table.errorBoundaries.map((b) => b.prefix), [""], "error boundary at root");
eq(
  table.routes.every((r) => path.basename(r.file) !== "loading.tsx" && path.basename(r.file) !== "error.tsx"),
  true,
  "loading.tsx / error.tsx are not navigable routes",
);

eq(snap(table, "/api/echo"), { file: "echo.ts", params: {}, isApi: true }, "/api/echo → api");
eq(snap(table, "/about/"), snap(table, "/about"), "trailing slash matches same route");
eq(snap(table, "/vary"), { file: "vary.tsx", params: {}, isApi: false }, "/vary → ISR demo route");
eq(snap(table, "/live"), { file: "live.tsx", params: {}, isApi: false }, "/live → Jetstream demo route");
eq(snap(table, "/poll"), { file: "poll.tsx", params: {}, isApi: false }, "/poll → multiplayer demo");
eq(snap(table, "/todos"), { file: "todos.tsx", params: {}, isApi: false }, "/todos → action demo");
eq(snap(table, "/live-post"), { file: "live-post.tsx", params: {}, isApi: false }, "/live-post → POST transport demo");
eq(snap(table, "/live-form"), { file: "live-form.tsx", params: {}, isApi: false }, "/live-form → live form demo");
eq(snap(table, "/isr"), { file: "isr.tsx", params: {}, isApi: false }, "/isr → ISR demo");
eq(snap(table, "/lazy"), { file: "lazy.tsx", params: {}, isApi: false }, "/lazy → lazy hydration demo");
eq(snap(table, "/stream"), { file: "stream.tsx", params: {}, isApi: false }, "/stream → streaming SSR demo");
eq(snap(table, "/nav"), { file: "nav.tsx", params: {}, isApi: false }, "/nav → SPA nav demo");
eq(snap(table, "/plugin"), { file: "plugin.tsx", params: {}, isApi: false }, "/plugin → virtual module demo");
eq(snap(table, "/styled"), { file: "styled.tsx", params: {}, isApi: false }, "/styled → scoped CSS demo");
eq(snap(table, "/tsrx"), { file: "tsrx.tsx", params: {}, isApi: false }, "/tsrx → TSRX demo");
eq(snap(table, "/api/tick"), { file: "tick.ts", params: {}, isApi: true }, "/api/tick → api");
eq(snap(table, "/api/stream"), { file: "stream.ts", params: {}, isApi: true }, "/api/stream → api");

const syn = [
  { segments: [{ lit: "users" }, { param: "id" }], file: "dyn", isApi: false, specificity: 1 },
  { segments: [{ lit: "users" }, { lit: "me" }], file: "static", isApi: false, specificity: 2 },
].sort((a, b) => b.specificity - a.specificity);
eq(matchRoute(syn, "/users/me")?.file, "static", "static route wins over dynamic at same depth");
eq(matchRoute(syn, "/users/42")?.params, { id: "42" }, "dynamic route catches the rest");

// static > dynamic > catch-all.
const syn2 = [
  { segments: [{ lit: "docs" }, { lit: "intro" }], file: "static", isApi: false, specificity: 2, rest: false },
  { segments: [{ lit: "docs" }, { param: "slug" }], file: "dynamic", isApi: false, specificity: 1, rest: false },
  { segments: [{ lit: "docs" }, { param: "slug", rest: true }], file: "catchall", isApi: false, specificity: 1, rest: true },
].sort((a, b) => b.specificity - a.specificity || (a.rest ? 1 : 0) - (b.rest ? 1 : 0));
eq(matchRoute(syn2, "/docs/intro")?.file, "static", "static beats dynamic and catch-all");
eq(matchRoute(syn2, "/docs/x")?.file, "dynamic", "dynamic beats catch-all for a single segment");
eq(matchRoute(syn2, "/docs/x/y")?.file, "catchall", "catch-all handles deeper paths");

// Two dynamic segments in one route.
const syn3 = [
  {
    segments: [{ lit: "shop" }, { param: "category" }, { param: "id" }],
    file: "item",
    isApi: false,
    specificity: 1,
    rest: false,
  },
].sort((a, b) => b.specificity - a.specificity);
eq(matchRoute(syn3, "/shop/shoes/42")?.params, { category: "shoes", id: "42" }, "two dynamic params");
eq(matchRoute(syn3, "/shop/shoes"), null, "two-param route rejects missing segment");

// matchRoute accepts a bare routes array (not only a scanRoutes table).
eq(matchRoute(syn, "/users/me")?.file, "static", "matchRoute(array) same as table.routes");

// A malformed percent-escape in a segment is no route (404), not a URIError thrown out of the handler.
eq(snap(table, "/blog/50%"), null, "malformed escape in a param → no match");
eq(snap(table, "/files/a/%E0%A4"), null, "malformed escape in a catch-all → no match");

// Convention-file prefixes are directories as written; [param] matches any one segment.
eq(underPrefix("/org/acme/settings", "/org/[org]"), true, "[param] dir prefix matches a real segment");
eq(underPrefix("/org", "/org/[org]"), false, "[param] dir prefix needs its segment");
eq(underPrefix("/orgs/acme", "/org/[org]"), false, "literal part of a dynamic prefix still compared");
eq(underPrefix("/%61dmin/x", "/admin"), true, "literal prefix compared percent-decoded");
eq(underPrefix("/docs/a/b", "/docs/[...rest]"), true, "[...rest] dir prefix matches deeper paths");
eq(underPrefix("/blogger", "/blog"), false, "/blogger is not under /blog");
eq(underPrefix("/rel/7.v2/x", "/rel/[id].v2"), true, "suffixed-param dir prefix matches like a route segment");
eq(underPrefix("/rel/7/x", "/rel/[id].v2"), false, "suffixed-param dir prefix needs the suffix");
eq(underPrefix("/admin/50%", "/admin"), true, "a malformed escape past the prefix still counts as under it");
eq(underPrefix("/50%/x", "/[a]"), false, "a malformed escape in a prefix segment never matches");
// Layout / error-boundary containment goes by the route file's directory (as budget::layouts_for).
eq(routeUnderPrefix({ dir: "/org/[org]" }, "/org/[org]"), true, "a file directly in the dir is inside it (index too)");
eq(routeUnderPrefix({ dir: "/org/[org]/x" }, "/org/[org]"), true, "a file deeper in the dir is inside it");
eq(routeUnderPrefix({ dir: "/org" }, "/org/[org]"), false, "the sibling file routes/org/[org].tsx is not inside it");
eq(routeUnderPrefix({ dir: "/org/[orgs]" }, "/org/[org]"), false, "a differently named dir is not inside it");
eq(routeUnderPrefix({ dir: "/org" }, ""), true, "root prefix contains everything");

eq(isRouteGroup("(marketing)"), true, "(name) is a route group");
eq(["(.)", "(..)", "(...)", "()", "(a)b", "a"].map(isRouteGroup), [false, false, false, false, false, false], "reserved / malformed names are not groups");
eq(stripRouteGroups("/(a)/docs/(b)"), "/docs", "groups stripped from a prefix");
eq(stripRouteGroups("/(a)"), "", "a top-level group prefix is the root");
eq(stripRouteGroups("/(.)/x"), "/(.)/x", "(.) stays literal");

// Route groups end to end: URL, layout / middleware / boundary containment, collisions.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "nowaki-groups-"));
  const put = async (rel, src) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), src);
  };
  const runtimeRequire = createRequire(path.join(ROOT, "packages/nowaki-runtime/server/handler.mjs"));
  const preactDir = path.dirname(runtimeRequire.resolve("preact/package.json"));
  const preact = JSON.stringify(pathToFileURL(path.join(preactDir, "dist/preact.mjs")).href);
  const wrap = (id) => `import { h } from ${preact};\nexport default (p) => h("div", { id: ${JSON.stringify(id)} }, p.children);\n`;
  const page = (text) => `import { h } from ${preact};\nexport default () => h("p", null, ${JSON.stringify(text)});\n`;
  const deny = (msg) => `export default (ctx) => { if (!ctx.cookies.ok) return ctx.text(${JSON.stringify(msg)}, { status: 401 }); };\n`;
  await put("routes/_layout.js", wrap("root"));
  await put("routes/(marketing)/_layout.js", wrap("mkt"));
  await put("routes/(marketing)/about.js", page("about"));
  await put("routes/(marketing)/index.js", page("home"));
  await put("routes/(app)/_middleware.js", deny("app only"));
  await put("routes/(app)/dashboard.js", page("dash"));
  await put("routes/(app)/docs/[slug].js", page("doc"));
  await put("routes/(app)/loading.js", page("app loading"));
  await put("routes/loading.js", page("root loading"));
  await put("routes/(app)/docs/error.js", page("docs error"));
  await put("routes/(app)/api/ping.js", `export const GET = (ctx) => ctx.text("pong");\n`);
  await put("routes/open.js", page("open"));
  await put("routes/docs/(x)/_middleware.js", deny("docs-x only"));
  await put("routes/docs/(x)/guide.js", page("guide"));
  const t = await scanRoutes(dir);
  const env = {
    routeTable: async () => t,
    importModule: async (file) => import(pathToFileURL(file).href),
    ensureIslands: async () => {},
    renderDocument: ({ body }) => body,
    renderError: (err) => ({ status: 500, headers: {}, body: String(err?.stack ?? err) }),
  };
  const get = async (p, headers = {}) => {
    const r = await handleRequest(env, { method: "GET", url: new URL("http://x" + p), headers, version: 1 });
    return { status: r.status, body: String(r.body ?? ""), headers: r.headers };
  };
  const about = await get("/about");
  eq([about.status, about.body], [200, '<div id="root"><div id="mkt"><p>about</p></div></div>'], "group page at /about, wrapped by the group layout");
  eq((await get("/")).body, '<div id="root"><div id="mkt"><p>home</p></div></div>', "(marketing)/index serves /");
  eq((await get("/open")).body, '<div id="root"><p>open</p></div>', "a page outside the group doesn't get its layout");
  eq((await get("/open")).status, 200, "group middleware doesn't run outside the group");
  eq((await get("/dashboard")).status, 401, "group middleware runs for a route inside the group");
  eq((await get("/docs/a")).status, 401, "group middleware runs for a nested route inside the group");
  eq((await get("/dashboard", { cookie: "ok=1" })).status, 200, "group middleware lets the request through");
  eq((await get("/nothing")).status, 404, "group middleware doesn't run for 404s");
  eq((await get("/api/ping")).status, 401, "api/ in a group is an API route guarded by the group's middleware");
  eq((await get("/api/ping", { cookie: "ok=1" })).body, "pong", "grouped API route served at /api/ping");
  eq((await get("/docs/guide")).status, 401, "a nested group's middleware runs for its routes");
  eq((await get("/docs/b", { cookie: "ok=1" })).status, 200, "a nested group's middleware doesn't run for a sibling URL served elsewhere");
  eq(
    t.loadingBoundaries.map((b) => [b.prefix, b.urlPrefix]),
    [["", ""], ["/(app)", ""]],
    "boundaries keep their physical prefix and a URL prefix; at the same URL prefix the ungrouped one goes first",
  );
  const bounds = JSON.parse((await get("/__nowaki/boundaries")).body);
  eq(
    [bounds.loading.map((b) => b.prefix), bounds.error.map((b) => b.prefix)],
    [["", ""], ["/docs"]],
    "boundaries are sent to the client with groups stripped",
  );
  await rm(dir, { recursive: true, force: true });

  const clash = async (files) => {
    const d = await mkdtemp(path.join(os.tmpdir(), "nowaki-clash-"));
    for (const f of files) {
      await mkdir(path.dirname(path.join(d, "routes", f)), { recursive: true });
      await writeFile(path.join(d, "routes", f), "export default () => null;\n");
    }
    try {
      await scanRoutes(d);
      return null;
    } catch (err) {
      return String(err.message);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  };
  const msg = await clash(["(a)/about.js", "(b)/about.js"]);
  eq(
    [/routes\/\(a\)\/about\.js/.test(msg ?? ""), /routes\/\(b\)\/about\.js/.test(msg ?? ""), / \/about:/.test(msg ?? "")],
    [true, true, true],
    `two groups serving /about is an error (${msg})`,
  );
  eq((await clash(["about.js", "(b)/about.js"])) !== null, true, "a group and an ungrouped file serving one URL is an error");
  eq((await clash(["(a)/blog/[slug].js", "blog/[id].js"])) !== null, true, "param names don't avoid a collision");
  eq(await clash(["(a)/blog/[slug].js", "(b)/blog/new.js"]), null, "a literal beside a param is not a collision");
  eq(await clash(["about.js", "about/index.js"]), null, "duplicates without a group are left as they were");
  eq(await clash(["(a)/_layout.js", "(b)/_layout.js", "(a)/loading.js", "loading.js"]), null, "convention files never collide");
}

// _middleware / _layout / error.tsx inside a [param] directory apply to the URLs under it,
// end to end through handleRequest (plain .js route files, no JSX).
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "nowaki-router-"));
  const put = async (rel, src) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), src);
  };
  // The same preact copy (ESM build) the runtime renders with.
  const runtimeRequire = createRequire(path.join(ROOT, "packages/nowaki-runtime/server/handler.mjs"));
  const preactDir = path.dirname(runtimeRequire.resolve("preact/package.json"));
  const preact = JSON.stringify(pathToFileURL(path.join(preactDir, "dist/preact.mjs")).href);
  const wrap = (id) => `import { h } from ${preact};\nexport default (p) => h("div", { id: ${JSON.stringify(id)} }, p.children);\n`;
  await put("routes/_layout.js", wrap("root"));
  await put("routes/org/[org]/_layout.js", wrap("org-layout"));
  await put(
    "routes/org/[org]/_middleware.js",
    `export default (ctx) => { if (!ctx.cookies.admin) return ctx.text("denied by middleware", { status: 401 }); };\n`,
  );
  await put(
    "routes/org/[org]/settings.js",
    `import { h } from ${preact};\nexport default ({ params }) => h("p", null, "settings of " + params.org);\n`,
  );
  await put("routes/org/[org]/error.js", `export default () => null;\n`);
  await put("routes/org/acme-public.js", `import { h } from ${preact};\nexport default () => h("p", null, "public");\n`);
  await put("routes/api/me.js", `export const GET = (ctx) => ctx.text("sid:" + ctx.cookies.sid + " ga:" + ctx.cookies._ga);\n`);
  // A sibling file named like the [org] directory is not inside it.
  await put("routes/org/[org].js", `import { h } from ${preact};\nexport default ({ params }) => h("p", null, "org " + params.org);\n`);
  // Literal-directory guards. URLs under them are also served by routes outside the directory
  // (a catch-all page and a dynamic API route), and must still be guarded.
  const guard = `export default (ctx) => { if (!ctx.cookies.admin) return ctx.text("admin only", { status: 401 }); };\n`;
  await put("routes/admin/_middleware.js", guard);
  await put("routes/admin/_layout.js", wrap("admin-layout"));
  await put("routes/admin/dash.js", `import { h } from ${preact};\nexport default () => h("p", null, "dash");\n`);
  await put("routes/docs/[...slug].js", `import { h } from ${preact};\nexport default ({ params }) => h("p", null, "doc " + params.slug.join("/"));\n`);
  await put("routes/[top]/secret.js", `import { h } from ${preact};\nexport default ({ params }) => h("p", null, "secret of " + params.top);\n`);
  await put("routes/api/admin/_middleware.js", guard);
  await put("routes/api/admin/users.js", `export const GET = (ctx) => ctx.text("users");\n`);
  await put("routes/api/[section]/[page].js", `export const GET = (ctx) => ctx.text("dyn " + ctx.params.section);\n`);
  await put("routes/vault/_middleware.js", guard);
  const t = await scanRoutes(dir);
  const env = {
    routeTable: async () => t,
    importModule: async (file) => import(pathToFileURL(file).href),
    ensureIslands: async () => {},
    renderDocument: ({ body }) => body,
    renderError: (err) => ({ status: 500, headers: {}, body: String(err?.stack ?? err) }),
  };
  const get = async (p, headers = {}) => {
    const r = await handleRequest(env, { method: "GET", url: new URL("http://x" + p), headers, version: 1 });
    let body = r.body ?? "";
    if (r.stream) for await (const c of r.stream) body += typeof c === "string" ? c : new TextDecoder().decode(c);
    return { status: r.status, body: String(body) };
  };
  eq(
    t.middleware.map((m) => m.prefix).sort(),
    ["/admin", "/api/admin", "/org/[org]", "/vault"],
    "middleware prefixes keep the directory name",
  );
  eq(
    t.middleware.map((m) => m.prefix.split("/").length).every((d, i, a) => i === 0 || a[i - 1] <= d),
    true,
    "middleware in root→leaf order",
  );
  eq(t.errorBoundaries.map((m) => m.prefix), ["/org/[org]"], "error boundary prefix keeps the directory name");
  const denied = await get("/org/acme/settings");
  eq([denied.status, denied.body], [401, "denied by middleware"], "middleware in a [param] dir runs");
  const allowed = await get("/org/acme/settings", { cookie: "admin=1" });
  eq(allowed.status, 200, "middleware in a [param] dir lets the request through");
  eq(
    /<div id="root"><div id="org-layout"><p>settings of acme<\/p><\/div><\/div>/.test(allowed.body),
    true,
    `layout in a [param] dir wraps its pages (${allowed.body.slice(0, 120)})`,
  );
  // /org/acme-public is under /org/[org] by URL, so the guard runs (middleware goes by URL),
  // but the page file is outside [org]/, so it doesn't get that layout (layouts go by file).
  eq((await get("/org/acme-public")).status, 401, "[param]-dir guard covers a URL a sibling page serves");
  const pub = await get("/org/acme-public", { cookie: "admin=1" });
  eq([pub.status, pub.body.includes("org-layout")], [200, false], "a sibling page outside [org]/ doesn't get its layout");
  const enc = await get("/org/acme/settings%2", { cookie: "admin=1" });
  eq(enc.status, 404, "a malformed percent-escape in the path is a 404");
  eq((await get("/org/acme")).status, 401, "[param]-dir guard covers the directory's own URL");
  const sib = await get("/org/acme", { cookie: "admin=1" });
  eq(
    [sib.status, sib.body.includes("org-layout"), sib.body.includes("org acme")],
    [200, false, true],
    "the sibling routes/org/[org].js is not inside routes/org/[org]/ (no layout, as layouts_for)",
  );
  // Literal guards apply by URL, whichever route serves it.
  eq((await get("/admin/dash")).status, 401, "literal guard on a matched page inside its dir");
  const dash = await get("/admin/dash", { cookie: "admin=1" });
  eq([dash.status, dash.body.includes("admin-layout")], [200, true], "literal guard lets through; its layout wraps");
  eq((await get("/admin/secret")).status, 401, "literal guard on a URL served by a dynamic route outside its dir");
  const viaSlug = await get("/admin/secret", { cookie: "admin=1" });
  eq([viaSlug.status, viaSlug.body.includes("admin-layout")], [200, false], "a route outside admin/ doesn't get admin's layout");
  eq((await get("/%61dmin/secret")).status, 401, "literal guard compared percent-decoded");
  eq((await get("/admin")).status, 401, "literal guard on the directory's own URL");
  eq((await get("/vault/nothing-here")).status, 401, "literal guard on a 404 under it");
  eq((await get("/vault/nothing-here", { cookie: "admin=1" })).status, 404, "past the guard, it is a 404");
  eq((await get("/docs/a/b")).body.includes("doc a/b"), true, "unguarded catch-all still served");
  eq((await get("/api/admin/users")).status, 401, "literal guard on an API route inside its dir");
  const apiOther = await get("/api/admin/other");
  eq([apiOther.status, apiOther.body], [401, "admin only"], "literal guard on an API URL served by api/[section]/[page]");
  eq((await get("/api/admin/other", { cookie: "admin=1" })).body, "dyn admin", "API guard lets through");
  eq((await get("/api/public/other")).body, "dyn public", "API guard doesn't apply outside its dir");
  eq((await get("/org/acme/nope/deeper/x")).status, 401, "[param]-dir guard on a 404 under it");
  eq((await get("/org/acme/nope/deeper/x", { cookie: "admin=1" })).status, 404, "past the [param]-dir guard, a 404");
  const ck = await get("/api/me", { cookie: "_ga=50%; sid=a%20b" });
  eq([ck.status, ck.body], [200, "sid:a b ga:50%"], "a malformed cookie keeps its raw value; others decode");
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\nROUTER TEST FAILED (${failed})` : "\nROUTER TEST PASSED");
process.exit(failed ? 1 : 0);
