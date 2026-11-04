// Unit test for server/isr-urls.mjs: which URLs `nowaki start` warms at startup.
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

console.log(failures ? `\nISR URLS TEST FAILED (${failures})` : "\nISR URLS TEST PASSED");
process.exit(failures ? 1 : 0);
