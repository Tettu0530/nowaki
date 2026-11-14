// Router (scanRoutes / matchRoute) tests. Match results for examples/hello/routes
// are pinned as snapshots; precedence is checked with a synthetic table.
// Usage: node scripts/router-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { scanRoutes, matchRoute, underPrefix, routeUnderPrefix, isRouteGroup, stripRouteGroups, interceptTarget } from "../packages/nowaki-runtime/server/router.mjs";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { matchBoundary, nonceStyles, shouldTransition } from "../packages/nowaki-runtime/client/router-core.js";
import { pageMeta, prodDocument, prodShell } from "../packages/nowaki-runtime/server/document.mjs";
import { Link, transitionName } from "../packages/nowaki-runtime/navigation.js";

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
  ["", "/(marketing)", "/blog", "/photos"],
  "layouts: root + nested /blog + the (marketing) group + /photos (owns @modal)",
);
eq(
  table.slots.map((s) => [s.ownerDir, s.name, s.routes.map((r) => path.basename(r.file)), path.basename(s.default ?? ""), s.intercepts.map((i) => [i.rel, i.pattern])]),
  [["/photos", "modal", ["[id].tsx"], "default.tsx", [["(.)[id].tsx", "/photos/[id]"]]]],
  "examples/hello: photos/@modal with a route, a default and an intercept of /photos/[id]",
);
eq(snap(table, "/photos/1"), { file: "[id].tsx", params: { id: "1" }, isApi: false }, "/photos/1 → photos/[id] (not the slot file)");
eq(table.routes.some((r) => r.file.includes("@modal")), false, "slot files are never routes");
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
  eq(
    [bounds.loading.map((b) => b.routes ?? null), bounds.error.map((b) => b.routes)],
    [[null, ["/api/ping", "!/docs/guide", "/dashboard", "/docs/[slug]"]], [["!/docs/guide", "/docs/[slug]"]]],
    "a group's boundaries list its routes in matching order, and the competing routes outside it marked \"!\"",
  );
  eq(
    [matchBoundary(bounds.loading, "/dashboard")?.html, matchBoundary(bounds.loading, "/about")?.html, matchBoundary(bounds.error, "/docs/guide")],
    ["<p>app loading</p>", "<p>root loading</p>", null],
    "client: the group's loading boundary for its routes, the root one elsewhere; /docs/guide (another group) gets no docs error",
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
  const removed = await clash(["index.js", "_error.js"]);
  eq(
    /routes\/_error\.js: `_error` is no longer a file convention.*Rename it to `_500`/.test(removed ?? ""),
    true,
    `_error (the removed alias of _500) is an error naming _500 (${removed})`,
  );
  eq(await clash(["index.js", "_500.js", "error.js"]), null, "_500 and error are fine");
  eq(await clash(["about.js", "about/index.js"]), null, "duplicates without a group are left as they were");
  eq(await clash(["(a)/_layout.js", "(b)/_layout.js", "(a)/loading.js", "loading.js"]), null, "convention files never collide");
  eq(await clash(["photo/[id].js", "@modal/photo/[id].js", "@m/(g)/photo/[x].js"]), null, "slot files serve no URL of their own");
}

// Parallel routes: @slot directories render beside the page in their owner's layout.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "nowaki-slots-"));
  const put = async (rel, src) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), src);
  };
  const runtimeRequire = createRequire(path.join(ROOT, "packages/nowaki-runtime/server/handler.mjs"));
  const preactDir = path.dirname(runtimeRequire.resolve("preact/package.json"));
  const preact = JSON.stringify(pathToFileURL(path.join(preactDir, "dist/preact.mjs")).href);
  const page = (text) => `import { h } from ${preact};\nexport default () => h("p", null, ${JSON.stringify(text)});\n`;
  // A layout printing its children, then each slot it got (name=node, or name=null).
  const layout = (id, names) =>
    `import { h } from ${preact};\nexport default (p) => h("div", { id: ${JSON.stringify(id)} }, p.children, ${names
      .map((n) => `p.slots.${n} === null ? "${n}=null" : p.slots.${n}`)
      .join(", ")});\n`;
  await put("routes/_layout.js", layout("root", ["modal", "empty"]));
  await put("routes/index.js", page("home"));
  await put("routes/photo/[id].js", page("photo page"));
  await put("routes/about.js", page("about"));
  await put("routes/@modal/default.js", page("modal default"));
  await put(
    "routes/@modal/photo/[pid].js",
    `import { h } from ${preact};\nexport const loader = (ctx) => { ctx.setHeader("x-slot", "1"); return "slot " + JSON.stringify(ctx.params); };\nexport const meta = { title: "ignored" };\nexport default ({ data, params, url }) => h("i", null, data + " " + params.pid + " " + url.pathname);\n`,
  );
  await put("routes/@modal/(.)photo/[id].js", page("intercepted"));
  await put("routes/@modal/_layout.js", page("ignored layout"));
  await put("routes/@modal/@nested/x.js", page("nested"));
  await put("routes/@empty/about.js", page("empty about"));
  await put("routes/(g)/shop/_layout.js", layout("shop", ["cart"]));
  await put("routes/(g)/shop/[item].js", page("item"));
  await put("routes/(g)/shop/@cart/[item].js", `import { h } from ${preact};\nexport default ({ params }) => h("b", null, "cart " + params.item);\n`);
  await put("routes/(.)intercepted/x.js", page("top-level intercept"));
  const t = await scanRoutes(dir);
  eq(
    t.slots.map((s) => [s.ownerDir, s.name, s.routes.map((r) => path.relative(dir, r.file).split(path.sep).join("/")), s.default && path.basename(s.default), s.intercepts.map((i) => i.rel)]).sort(),
    [
      ["", "empty", ["routes/@empty/about.js"], null, []],
      ["", "modal", ["routes/@modal/photo/[pid].js"], "default.js", ["(.)photo/[id].js"]],
      ["/(g)/shop", "cart", ["routes/(g)/shop/@cart/[item].js"], null, []],
    ],
    "slots: owner dir, name, routes, default, intercepts; _ files and nested slots ignored",
  );
  eq(t.intercepts.map((i) => i.dir), ["/(.)intercepted"], "an intercepting route outside a slot is recorded, not routed");
  eq(matchRoute(t, "/intercepted/x"), null, "an intercepting route is not served");
  eq(matchRoute(t, "/(.)intercepted/x"), null, "an intercepting route is not served under its literal name either");
  eq(matchRoute(t, "/@modal/photo/1"), null, "a slot directory is not a URL segment");
  const env = {
    routeTable: async () => t,
    importModule: async (file) => import(pathToFileURL(file).href),
    ensureIslands: async () => {},
    renderDocument: ({ body, meta }) => `${meta?.title ?? ""}|${body}`,
    renderError: (err) => ({ status: 500, headers: {}, body: String(err?.stack ?? err) }),
  };
  const get = async (p, extra = {}) => {
    const r = await handleRequest(env, { method: "GET", url: new URL("http://x" + p), headers: {}, version: 1, ...extra });
    return { status: r.status, body: String(r.body ?? ""), headers: r.headers };
  };
  const slot = (name, inner) => `<nowaki-slot name="${name}" style="display:contents">${inner}</nowaki-slot>`;
  // @modal has an intercepting file: its wrapper says which URLs the router may ask it for.
  const modal = (inner) =>
    `<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/@modal" data-nowaki-intercepts="[&quot;/photo/[id]&quot;]">${inner}</nowaki-slot>`;
  eq(
    (await get("/")).body,
    `|<div id="root"><p>home</p>${modal("<p>modal default</p>")}empty=null</div>`,
    "no slot route matches: the default renders; a slot without a default is null",
  );
  const photo = await get("/photo/7");
  eq(
    photo.body,
    `|<div id="root"><p>photo page</p>${modal('<i>slot {&quot;pid&quot;:&quot;7&quot;} 7 /photo/7</i>')}empty=null</div>`,
    "the slot route matching the URL renders with its own params and loader; slots add no meta",
  );
  eq(photo.headers["x-slot"], "1", "a slot loader's ctx writes reach the response");
  eq(
    (await get("/about")).body,
    `|<div id="root"><p>about</p>${modal("<p>modal default</p>")}${slot("empty", "<p>empty about</p>")}</div>`,
    "each slot resolves independently",
  );
  eq(
    (await get("/shop/hat")).body,
    `|<div id="root"><div id="shop"><p>item</p>${slot("cart", "<b>cart hat</b>")}</div>${modal("<p>modal default</p>")}empty=null</div>`,
    "a slot in a group dir matches the URL with the group left out, below its owner's URL",
  );
  eq(
    (await get("/x/photo/9", { routePath: "/photo/9" })).body.includes("<i>slot {&quot;pid&quot;:&quot;9&quot;} 9 /x/photo/9"),
    true,
    "slots match the route path (rewrites), not the browser path",
  );
  eq((await get("/photo/%zz")).status, 404, "a malformed path is still a 404");
  await rm(dir, { recursive: true, force: true });
}

// Intercepting routes: the URL a marker targets, on the fixture nowaki-core's
// routes::intercept_target runs on too (tests/intercepts.rs).
{
  const { cases } = JSON.parse(await readFile(path.join(ROOT, "crates/nowaki-core/tests/fixtures/intercept-cases.json"), "utf8"));
  for (const c of cases) eq(interceptTarget(c.owner ? c.owner.split("/") : [], (c.inner + ".tsx").split("/")), c.target, `interceptTarget: ${c.name}`);
}

// Intercepting routes end to end through handleRequest: the fragment the router asks for with
// x-nowaki-intercept, the empty mount point, Vary on the full page.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), "nowaki-intercepts-"));
  const put = async (rel, src) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), src);
  };
  const runtimeRequire = createRequire(path.join(ROOT, "packages/nowaki-runtime/server/handler.mjs"));
  const preact = JSON.stringify(pathToFileURL(path.join(path.dirname(runtimeRequire.resolve("preact/package.json")), "dist/preact.mjs")).href);
  const page = (text) => `import { h } from ${preact};\nexport default () => h("p", null, ${JSON.stringify(text)});\n`;
  await put("routes/_layout.js", `import { h } from ${preact};\nexport default (p) => h("div", null, p.children, p.slots.modal);\n`);
  await put("routes/index.js", page("gallery"));
  await put("routes/photo/[id].js", `import { h } from ${preact};\nexport const revalidate = 60;\nexport default ({ params }) => h("h1", null, "photo " + params.id);\n`);
  await put("routes/about.js", page("about"));
  await put(
    "routes/@modal/(.)photo/[id].js",
    `import { h } from ${preact};\nexport const scripts = ["./m.js"];\nexport const loader = (ctx) => "caption " + ctx.params.id;\nexport default ({ data, params, url }) => h("aside", null, data + " " + params.id + " " + url.pathname);\n`,
  );
  await put("routes/(g)/shop/_layout.js", `import { h } from ${preact};\nexport default (p) => h("section", null, p.children, p.slots.cart);\n`);
  await put("routes/(g)/shop/index.js", page("shop"));
  await put("routes/(g)/shop/@cart/(.)item/[x].js", page("cart item"));
  const t = await scanRoutes(dir);
  const env = {
    routeTable: async () => t,
    importModule: async (file) => import(pathToFileURL(file).href),
    ensureIslands: async () => {},
    renderDocument: ({ body }) => body,
    renderError: (err) => ({ status: 500, headers: {}, body: String(err?.stack ?? err) }),
    routeCss: async (file) => (file.includes("(.)photo") ? ["/site.css", "/modal.css"] : ["/site.css"]),
    routeScripts: async (file, mod) => (mod?.scripts ?? []).map((s) => ({ src: `/m.${s.length}.js`, preload: ["/dep.js"] })),
  };
  const get = async (p, headers = {}, method = "GET") => {
    const r = await handleRequest(env, { method, url: new URL("http://x" + p), headers, version: 1 });
    return { status: r.status, body: String(r.body ?? ""), headers: r.headers };
  };
  const mount = `<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/@modal" data-nowaki-intercepts="[&quot;/photo/[id]&quot;]"></nowaki-slot>`;
  eq((await get("/")).body, `<div><p>gallery</p>${mount}</div>`, "a slot with an intercepting file and nothing to render is an empty mount point");
  const full = await get("/photo/3");
  eq(full.body, `<div><h1>photo 3</h1>${mount}</div>`, "without the header the intercepted URL renders the full page");
  eq(full.headers.vary, "X-Nowaki-Intercept", "the full page of an intercepted URL varies on x-nowaki-intercept");
  eq(full.headers["x-nowaki-revalidate"], "60", "it stays an ISR page");
  eq((await get("/about")).headers.vary, undefined, "a URL nothing intercepts gets no Vary");
  const frag = await get("/photo/3?x=1", { "x-nowaki-intercept": "/@modal" });
  eq(
    frag.body,
    '<template data-nowaki-head><link rel="stylesheet" href="/site.css" /><link rel="stylesheet" href="/modal.css" /><link rel="modulepreload" href="/dep.js" /><script type="module" src="/m.6.js" data-nowaki-script></script></template><aside>caption 3 3 /photo/3</aside>',
    "x-nowaki-intercept renders the intercepting file alone, with its loader, params, CSS and page scripts",
  );
  eq(
    [frag.status, frag.headers["x-nowaki-slot"], frag.headers["cache-control"], frag.headers.vary, frag.headers["x-nowaki-revalidate"]],
    [200, "modal", "private, no-store", "X-Nowaki-Intercept", undefined],
    "the fragment says so (x-nowaki-slot) and is never cached",
  );
  eq((await get("/about", { "x-nowaki-intercept": "/@modal" })).body, `<div><p>about</p>${mount}</div>`, "a URL the slot doesn't intercept: the full page");
  eq((await get("/photo/3", { "x-nowaki-intercept": "/@other" })).body.startsWith("<div><h1>photo 3"), true, "an unknown slot id: the full page");
  eq((await get("/photo/3", { "x-nowaki-intercept": "/@modal" }, "POST")).body.startsWith("<div><h1>photo 3"), true, "only GET asks for a fragment");
  const shop = await get("/shop");
  eq(
    shop.body.includes('data-nowaki-slot="/(g)/shop/@cart" data-nowaki-intercepts="[&quot;/shop/item/[x]&quot;]"'),
    true,
    "a slot owned in a group: its id is its directory, its patterns are URLs",
  );
  eq(
    (await get("/shop/item/9", { "x-nowaki-intercept": encodeURI("/(g)/shop/@cart") })).body.endsWith("<p>cart item</p>"),
    true,
    "the group-owned slot's fragment",
  );
  globalThis.__nowakiBase = "/app";
  eq(
    (await get("/")).body.includes("data-nowaki-intercepts=\"[&quot;/app/photo/[id]&quot;]\""),
    true,
    "patterns are browser paths: basePath in front",
  );
  globalThis.__nowakiBase = "";
  await rm(dir, { recursive: true, force: true });
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

// nonceStyles: a fetched page's <style> tags get this document's nonce before DOMParser parses
// them (the nonce the server injected, or none); scripts and text are left alone.
{
  const html = '<style nonce="aa">a{}</style><STYLE nonce="aa" media="x">b{}</STYLE><style>c{}</style><script nonce="aa">1</script><stylex></stylex><p>&lt;style</p>';
  eq(
    nonceStyles(html, "me"),
    '<style nonce="me">a{}</style><style nonce="me" media="x">b{}</STYLE><style nonce="me">c{}</style><script nonce="aa">1</script><stylex></stylex><p>&lt;style</p>',
    "nonceStyles: every <style> gets this document's nonce",
  );
  eq(nonceStyles(html, undefined), html, "nonceStyles: no nonce (no CSP), the HTML as it came");
}

// View Transitions: when the client router transitions, the route export's document output, and
// what <Link viewTransition> / transitionName() render.
{
  eq(
    [
      shouldTransition(true, () => {}, false),
      shouldTransition({ tagName: "A" }, () => {}, false), // the element that opted in
      shouldTransition(null, () => {}, false), // nothing opted in
      shouldTransition(false, () => {}, false), // the browser animated the gesture itself
      shouldTransition(true, undefined, false), // no document.startViewTransition
      shouldTransition(true, () => {}, true), // prefers-reduced-motion: reduce
    ],
    [true, true, false, false, false, false],
    "shouldTransition: opted in, supported, and no reduced motion",
  );

  const VT = '<meta name="nowaki-view-transition" content="1" />\n<style>@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}</style>';
  const manifest = { runtime: "islands.1.js", routerRuntime: "router.1.js", islands: { C: "C.1.js" }, preload: {} };
  const page = (mod, meta) => prodDocument(manifest, { mod, body: '<nowaki-island name="C"></nowaki-island>', meta });
  const meta = { title: "T", head: '<link rel="stylesheet" href="/a.css" />' };
  // A route without the export renders exactly what it did before View Transitions existed.
  const golden = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>T</title>
<meta name="nowaki-head" content="start" />
<link rel="modulepreload" href="/_nowaki/islands.1.js" />
<link rel="modulepreload" href="/_nowaki/C.1.js" />
<link rel="stylesheet" href="/a.css" />
<meta name="nowaki-head" content="end" />
</head>
<body>
<nowaki-island name="C"></nowaki-island>
<script id="nowaki-runtime" type="module" src="/_nowaki/islands.1.js" data-router="/_nowaki/router.1.js"></script>

</body>
</html>`;
  eq(page({ title: "x" }, meta), golden, "a route without viewTransition: prod HTML byte-identical");
  eq([page({ viewTransition: false }, meta), page({ viewTransition: "yes" }, meta)], [golden, golden], "viewTransition other than true adds nothing");
  eq(pageMeta(meta, { viewTransition: true }).head, `${meta.head}\n${VT}`, "viewTransition = true: <meta> + @view-transition after the page's head");
  eq(pageMeta({}, { viewTransition: true }).head, VT, "viewTransition = true on a page without a head");
  const opted = page({ viewTransition: true }, meta);
  eq(opted.indexOf(VT) > 0 && opted.indexOf(VT) < opted.indexOf('<meta name="nowaki-head" content="end" />'), true, "inside the head region (the router swaps it with the page)");
  const shell = prodShell(manifest, { viewTransition: true }, meta).head;
  eq(shell.includes(VT), true, "streaming shells get it too");

  const runtimeRequire = createRequire(path.join(ROOT, "packages/nowaki-runtime/server/handler.mjs"));
  const esm = (pkg, file) => pathToFileURL(path.join(path.dirname(runtimeRequire.resolve(`${pkg}/package.json`)), file)).href;
  const { render } = await import(esm("preact-render-to-string", "dist/index.mjs"));
  const { h } = await import(esm("preact", "dist/preact.mjs"));
  eq(render(h(Link, { href: "/x", viewTransition: true }, "x")), '<a href="/x" data-nowaki-transition>x</a>', "<Link viewTransition> renders data-nowaki-transition");
  eq(render(h(Link, { href: "/x", viewTransition: false }, "x")), '<a href="/x">x</a>', "<Link viewTransition={false}> renders nothing extra");
  eq(render(h(Link, { href: "/x" }, "x")), '<a href="/x">x</a>', "<Link> without it is unchanged");
  const prevBase = globalThis.__nowakiBase;
  globalThis.__nowakiBase = "/app";
  eq(render(h(Link, { href: "/x", viewTransition: true }, "x")), '<a href="/app/x" data-nowaki-transition>x</a>', "<Link viewTransition> under basePath");
  globalThis.__nowakiBase = prevBase;

  eq(
    ["photo-1", 1, "-1", "--x", "-", "", "none", "AUTO", "revert-layer", "revert-layers", "a b/c", "\u00e9t\u00e9", "_x"].map((n) => transitionName(n).viewTransitionName),
    ["photo-1", "_1", "_-1", "--x", "_-", "_", "_none", "_AUTO", "_revert-layer", "revert-layers", "a_b_c", "\u00e9t\u00e9", "_x"],
    "transitionName: a CSS identifier, not a keyword",
  );
  eq(render(h("img", { style: transitionName("photo-1") })), '<img style="view-transition-name:photo-1;"/>', "transitionName in a style prop (SSR)");
}

console.log(failed ? `\nROUTER TEST FAILED (${failed})` : "\nROUTER TEST PASSED");
process.exit(failed ? 1 : 0);
