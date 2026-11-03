// Router (scanRoutes / matchRoute) tests. Match results for examples/hello/routes
// are pinned as snapshots; precedence is checked with a synthetic table.
// Usage: node scripts/router-test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRoutes, matchRoute } from "../packages/nowaki-runtime/server/router.mjs";

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
  ["", "/blog"],
  "layouts: root + nested /blog",
);
eq(table.middleware.map((m) => m.prefix), [""], "middleware at app root");
eq(table.loadingBoundaries.map((b) => b.prefix), [""], "loading boundary at root");
eq(table.errorBoundaries.map((b) => b.prefix), [""], "error boundary at root");
eq(
  table.routes.every((r) => path.basename(r.file) !== "loading.tsx" && path.basename(r.file) !== "error.tsx"),
  true,
  "loading.tsx / error.tsx are not navigable routes",
);

eq(snap(table, "/api/echo"), { file: "echo.ts", params: {}, isApi: true }, "/api/echo → api");
eq(snap(table, "/about/"), snap(table, "/about"), "trailing slash matches same route");

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

console.log(failed ? `\nROUTER TEST FAILED (${failed})` : "\nROUTER TEST PASSED");
process.exit(failed ? 1 : 0);
