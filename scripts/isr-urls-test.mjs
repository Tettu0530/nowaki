// Unit test for server/isr-urls.mjs: which URLs `nowaki start` warms at startup, and which pages
// the generated sitemap.xml lists (sitemap = false, meta.robots of the page and its layouts).
// Usage: node scripts/isr-urls-test.mjs
const { isrUrls } = await import("../packages/nowaki-runtime/server/isr-urls.mjs");

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const seg = (path) =>
  path
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("[...") ? { param: s.slice(4, -1), rest: true } : s.startsWith("[") ? { param: s.slice(1, -1) } : { lit: s }));
const mods = {
  "/": { revalidate: 60 },
  "/about": {},
  "/isr-zero": { revalidate: 0 },
  "/blog/[slug]": { revalidate: 30, staticPaths: [{ slug: "a b" }, { slug: "c" }, { slug: "../x" }] },
  "/docs/[...path]": { revalidate: 30, staticPaths: async () => [{ path: ["x", "y"] }] },
  "/user/[id]": { revalidate: 30 }, // no staticPaths: nothing to warm
  "/broken/[id]": { revalidate: 30, staticPaths: async () => { throw new Error("db down"); } },
  "/api/x": { revalidate: 30 },
};
const routes = Object.keys(mods).map((p) => ({ file: p, segments: seg(p), isApi: p.startsWith("/api") }));
const env = { routeTable: () => ({ routes }), importModule: async (f) => mods[f] };

const urls = await isrUrls(env);
check("a static ISR route is listed", urls.includes("/"));
check("routes without revalidate (or 0) are not", !urls.includes("/about") && !urls.includes("/isr-zero"));
check("staticPaths entries are listed, percent-encoded", urls.includes("/blog/a%20b") && urls.includes("/blog/c"));
check("an entry that would escape its segment is dropped", !urls.some((u) => u.includes("..")));
check("a catch-all expands its array", urls.includes("/docs/x/y"));
check("dynamic routes without staticPaths are skipped", !urls.some((u) => u.startsWith("/user")));
check("a failing staticPaths is skipped, not fatal", !urls.some((u) => u.startsWith("/broken")));
check("API routes are never warmed", !urls.some((u) => u.startsWith("/api")));
check("max caps the list", (await isrUrls(env, { max: 2 })).length === 2);

// sitemap.xml: a static `meta.robots` noindex leaves a page out, from the page or (when the page
// sets none) the nearest layout's, combined root → nested → page like the document metadata.
{
  const { sitemapUrls } = await import("../packages/nowaki-runtime/server/isr-urls.mjs");
  const C = () => null;
  const sm = {
    "routes/_layout.tsx": { meta: { openGraph: { siteName: "S" } } },
    "routes/private/_layout.tsx": { meta: { robots: { index: false } } },
    "routes/private/draft/_layout.tsx": { meta: { robots: "noindex, nofollow" } },
    "routes/fn/_layout.tsx": { meta: () => ({ robots: "noindex" }) },
    "routes/index.tsx": { default: C },
    "routes/hidden.tsx": { default: C, meta: { robots: "noindex" } },
    "routes/opt-out.tsx": { default: C, sitemap: false },
    "routes/private/a.tsx": { default: C },
    "routes/private/public.tsx": { default: C, meta: { robots: { index: true } } },
    "routes/private/draft/b.tsx": { default: C },
    "routes/private/fn-page.tsx": { default: C, meta: () => ({}) },
    "routes/fn/c.tsx": { default: C },
  };
  const page = (file, url, dir) => ({ file, segments: seg(url), dir, isApi: false });
  const table = {
    routes: [
      page("routes/index.tsx", "/", ""),
      page("routes/hidden.tsx", "/hidden", ""),
      page("routes/opt-out.tsx", "/opt-out", ""),
      page("routes/private/a.tsx", "/private/a", "/private"),
      page("routes/private/public.tsx", "/private/public", "/private"),
      page("routes/private/draft/b.tsx", "/private/draft/b", "/private/draft"),
      page("routes/private/fn-page.tsx", "/private/fn-page", "/private"),
      page("routes/fn/c.tsx", "/fn/c", "/fn"),
    ],
    layouts: [
      { prefix: "", file: "routes/_layout.tsx" },
      { prefix: "/private", file: "routes/private/_layout.tsx" },
      { prefix: "/private/draft", file: "routes/private/draft/_layout.tsx" },
      { prefix: "/fn", file: "routes/fn/_layout.tsx" },
    ],
  };
  const list = await sitemapUrls({ routeTable: () => table, importModule: async (f) => sm[f] });
  check("sitemap: a plain page is listed", list.includes("/"));
  check("sitemap: the page's own noindex and sitemap = false leave it out", !list.includes("/hidden") && !list.includes("/opt-out"));
  check("sitemap: a layout's meta.robots noindex leaves its pages out", !list.includes("/private/a"));
  check("sitemap: the nearest layout's robots applies", !list.includes("/private/draft/b"));
  check("sitemap: the page's robots wins over its layout's", list.includes("/private/public"));
  check("sitemap: a page meta() isn't run, so its layout's robots applies", !list.includes("/private/fn-page"));
  check("sitemap: a layout meta() isn't run (no request): the page is listed", list.includes("/fn/c"));
}

console.log(failures ? `\nISR URLS TEST FAILED (${failures})` : "\nISR URLS TEST PASSED");
process.exit(failures ? 1 : 0);
