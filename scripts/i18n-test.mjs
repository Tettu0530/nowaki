// Unit checks for i18n: the locale split and localePath (shared fixture with prerender.rs), the
// handler's localized requests (ctx.locale, getLocale(), <html lang>, hreflang, redirects, 404s),
// the sitemap's alternates, getCollection / getEntry per locale, and the page list per locale.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { compileI18n, localeGroups, localePathFor, splitLocale } from "../packages/nowaki-runtime/server/i18n.mjs";
import { runWithLocale } from "../packages/nowaki-runtime/server/i18n-context.mjs";
import { hreflangTags, sitemapXml } from "../packages/nowaki-runtime/server/seo.mjs";
import { pageUrls } from "../packages/nowaki-runtime/server/isr-urls.mjs";
import { setContent, validateContent } from "../packages/nowaki-runtime/server/content-store.mjs";
import { getCollection, getEntry } from "../packages/nowaki-runtime/content.js";
import { getLocale, Link, localePath } from "../packages/nowaki-runtime/navigation.js";

const require = createRequire(new URL("../packages/nowaki-runtime/server/handler.mjs", import.meta.url));
const { h } = require("preact");
const { renderToString } = require("preact-render-to-string");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};

// --- the shared fixture -------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(new URL("../crates/nowaki/tests/fixtures/i18n-cases.json", import.meta.url), "utf8"));
const configs = Object.fromEntries(Object.entries(fixture.configs).map(([k, v]) => [k, compileI18n({ i18n: v })]));
for (const c of fixture.localePath) {
  const got = localePathFor(configs[c.config], c.path, c.locale);
  check(`localePath ${c.config} ${c.path} ${c.locale} → ${c.expected}`, got === c.expected, got);
}
for (const c of fixture.split) {
  const s = splitLocale(configs[c.config], c.path);
  check(`split ${c.config} ${c.path}`, s.locale === c.locale && s.path === c.rest && s.prefixed === c.prefixed, JSON.stringify(s));
}
check("compileI18n without i18n is null", compileI18n({ basePath: "/app" }) === null && compileI18n(null) === null);
check("localePathFor without i18n keeps the path", localePathFor(null, "/about", "ja") === "/about");

// --- the handler ----------------------------------------------------------------------------------
const seen = [];
const modules = {
  "routes/_layout.tsx": { default: ({ children }) => h("div", { id: "root" }, children) },
  "routes/index.tsx": { default: () => h("p", null, `home ${getLocale()}`) },
  "routes/about.tsx": {
    loader: (ctx) => ({ locale: ctx.locale, path: ctx.url.pathname, href: localePath("/contact") }),
    default: ({ data }) => h("p", null, `about ${data.locale} ${getLocale()} ${data.path} ${data.href} `, h(Link, { href: "/about", locale: "ja" }, "ja")),
  },
  "routes/langset.tsx": { lang: "fr", default: () => h("p", null, "langset") },
  "routes/early.tsx": { streaming: "early", default: () => h("p", null, `early ${getLocale()}`) },
  "routes/api/ping.ts": { GET: (ctx) => ({ locale: ctx.locale ?? null }) },
  "routes/_404.tsx": { default: () => h("p", null, `missing ${getLocale()}`) },
  "routes/_middleware.ts": { default: (ctx) => void seen.push(`mw ${ctx.locale}`) },
};
const table = {
  routes: [
    { file: "routes/index.tsx", segments: [], dir: "", isApi: false },
    { file: "routes/about.tsx", segments: [{ lit: "about" }], dir: "", isApi: false },
    { file: "routes/langset.tsx", segments: [{ lit: "langset" }], dir: "", isApi: false },
    { file: "routes/early.tsx", segments: [{ lit: "early" }], dir: "", isApi: false },
    { file: "routes/api/ping.ts", segments: [{ lit: "api" }, { lit: "ping" }], dir: "/api", isApi: true },
  ],
  layouts: [{ prefix: "", file: "routes/_layout.tsx" }],
  middleware: [{ prefix: "", file: "routes/_middleware.ts" }],
  notFound: "routes/_404.tsx",
};
const makeEnv = (routing, extra = {}) => ({
  i18n: compileI18n(routing),
  site: "https://example.com",
  routeTable: async () => table,
  importModule: async (file) => modules[file],
  ensureIslands: async () => {},
  renderDocument: ({ mod, body, meta }) => {
    const lang = meta?.lang ?? mod?.lang ?? "en";
    return `<html lang="${lang}" data-i18n='${meta?.htmlAttrs?.["data-nowaki-i18n"] ?? ""}'><head>${meta?.head ?? ""}</head><body>${body}</body></html>`;
  },
  renderShell: ({ mod, meta }) => ({ head: `<html lang="${meta?.lang ?? mod?.lang ?? "en"}"><head>${meta?.head ?? ""}</head><body>`, tail: "</body></html>" }),
  renderError: (err) => ({ status: 500, headers: {}, body: String(err) }),
  onError: () => {},
  ...extra,
});
const I18N = { i18n: { locales: ["en", "ja"], defaultLocale: "en", prefixDefaultLocale: false } };
const env = makeEnv(I18N);
const text = async (res) => res.body ?? (await new Response(res.stream).text());
const req = (e, path, extra = {}) => {
  const url = new URL(`http://x.test${path}`);
  return handleRequest(e, { method: "GET", url, headers: {}, version: 1, ...extra });
};

{
  seen.length = 0;
  const res = await req(env, "/ja/about");
  const body = await text(res);
  check("/ja/about renders the about route", res.status === 200 && body.includes("about ja ja /ja/about"), body);
  check("ctx.url stays the browser URL; localePath uses the request's locale", body.includes("/ja/about /ja/contact"), body);
  check("<html lang> is the locale", body.startsWith('<html lang="ja"'), body.slice(0, 60));
  check("the client gets the i18n settings", body.includes(`data-i18n='{"locale":"ja","locales":["en","ja"],"defaultLocale":"en","prefixDefaultLocale":false}'`), body.slice(0, 200));
  check(
    "hreflang alternates for every locale and x-default (site URL)",
    body.includes('<link rel="alternate" hreflang="en" href="https://example.com/about" />') &&
      body.includes('<link rel="alternate" hreflang="ja" href="https://example.com/ja/about" />') &&
      body.includes('<link rel="alternate" hreflang="x-default" href="https://example.com/about" />'),
    body,
  );
  check("<Link locale> links to the localized page", body.includes('<a href="/ja/about" hreflang="ja">ja</a>'), body);
  check("middleware sees ctx.locale", seen.includes("mw ja"), seen.join(","));
}
{
  const body = await text(await req(env, "/about"));
  check("/about is the default locale", body.startsWith('<html lang="en"') && body.includes("about en en /about /contact"), body.slice(0, 200));
}
{
  const body = await text(await req(env, "/ja"));
  check("/ja is the locale's root", body.includes("home ja") && body.includes('hreflang="ja" href="https://example.com/ja"'), body);
}
{
  const res = await req(env, "/en/about?x=1");
  check("/en/about → 308 /about with the query", res.status === 308 && res.headers.location === "/about?x=1", JSON.stringify(res));
  const root = await req(env, "/en");
  check("/en → 308 /", root.status === 308 && root.headers.location === "/", JSON.stringify(root));
  const evil = await req(env, "/en//evil.com");
  check("/en//evil.com is not a protocol-relative redirect", evil.status === 404, `${evil.status} ${evil.headers?.location}`);
}
{
  const body = await text(await req(env, "/ja/langset"));
  check("a page's own lang wins over the locale", body.startsWith('<html lang="fr"'), body.slice(0, 40));
}
{
  const res = await req(env, "/ja/early");
  const body = await text(res);
  check("early streaming: lang and getLocale() in the stream", body.startsWith('<html lang="ja"') && body.includes("early ja"), body);
}
{
  const res = await req(env, "/ja/nope");
  const body = await text(res);
  check("a 404 under a locale renders in that locale", res.status === 404 && body.includes("missing ja") && body.startsWith('<html lang="ja"'), body);
}
{
  const res = await req(env, "/ja/api/ping");
  check("API routes see ctx.locale", res.body === '{"locale":"ja"}', res.body);
}
{
  const res = await req(env, "/ja/sitemap.xml");
  check("sitemap.xml exists only at the root", res.status === 404, String(res.status));
  const sm = await req(env, "/sitemap.xml");
  const xml = await text(sm);
  check(
    "sitemap.xml lists every locale with xhtml:link alternates",
    xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"') &&
      xml.includes("<loc>https://example.com/ja/about</loc>") &&
      xml.includes('<xhtml:link rel="alternate" hreflang="ja" href="https://example.com/ja/about"/>') &&
      xml.includes('<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>'),
    xml,
  );
}
{
  // A rewrite (the front's routePath isn't the browser path): no redirect, no alternates.
  const res = await req(env, "/p/en/about", { routePath: "/en/about" });
  const body = await text(res);
  check("a rewritten default-locale path is served, not redirected", res.status === 200 && body.includes("about en") && !body.includes('rel="alternate"'), body);
}
{
  // basePath: the front strips it (routePath); the redirect and alternates put it back.
  const based = makeEnv({ basePath: "/app", ...I18N });
  const res = await req(based, "/app/en/about", { routePath: "/en/about" });
  check("basePath: /app/en/about → /app/about", res.status === 308 && res.headers.location === "/app/about", JSON.stringify(res));
  const root = await req(based, "/app/en", { routePath: "/en" });
  check("basePath: /app/en → /app", root.status === 308 && root.headers.location === "/app", JSON.stringify(root));
  const body = await text(await req(based, "/app/ja/about", { routePath: "/ja/about" }));
  check("basePath: alternates carry it", body.includes('hreflang="ja" href="https://example.com/app/ja/about"') && body.includes('hreflang="en" href="https://example.com/app/about"'), body);
}
{
  const prefixed = makeEnv({ i18n: { locales: ["en", "ja"], defaultLocale: "en", prefixDefaultLocale: true } });
  const root = await req(prefixed, "/?a=1");
  check("prefixDefaultLocale: / → 307 /en", root.status === 307 && root.headers.location === "/en?a=1", JSON.stringify(root));
  const bare = await req(prefixed, "/about");
  check("prefixDefaultLocale: an unprefixed page is a 404", bare.status === 404, String(bare.status));
  const en = await text(await req(prefixed, "/en/about"));
  check("prefixDefaultLocale: /en/about renders", en.includes("about en en /en/about /en/contact"), en);
  const api = await req(prefixed, "/api/ping");
  check("prefixDefaultLocale: an unprefixed API route answers", api.status === 200, String(api.status));
}
{
  const plain = makeEnv(null);
  const body = await text(await req(plain, "/about"));
  check("without i18n: no locale, no lang override, no alternates", body.startsWith('<html lang="en"') && body.includes("about undefined undefined /about /contact") && !body.includes('rel="alternate"') && body.includes("data-i18n=''"), body);
}
{
  const noSite = makeEnv(I18N, { site: undefined });
  const body = await text(await req(noSite, "/ja/about", { headers: { host: "evil.test" } }));
  check("without a site URL: no hreflang (never built from the request's Host)", body.includes("about ja") && !body.includes('rel="alternate"'), body);
}
{
  const res = await req(env, "/__nowaki/boundaries");
  check("framework endpoints have no locale", res.status === 200, String(res.status));
}

// --- hreflang / sitemap helpers -------------------------------------------------------------------
{
  const tags = hreflangTags([["en", "/about"], ["ja", "/ja/about"]], "en", { origin: "http://x.test", staticOutput: true });
  check("hreflang: static output gets trailing slashes; origin without a site", tags.includes('href="http://x.test/ja/about/"') && tags.includes('hreflang="x-default" href="http://x.test/about/"'), tags);
  const groups = localeGroups(configs.plain, ["/", "/ja", "/about", "/ja/about", "/only-en", "/en/x"]);
  check("localeGroups pairs a page's locales", JSON.stringify(groups.get("/ja/about")) === JSON.stringify([["en", "/about"], ["ja", "/ja/about"], ["x-default", "/about"]]), JSON.stringify([...groups]));
  check("localeGroups leaves single-locale pages and default-locale prefixes out", !groups.has("/only-en") && !groups.has("/en/x"));
  const xml = sitemapXml("https://e.test", ["/b", "/a"]);
  check("sitemap without alternates is unchanged", xml === '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://e.test/a</loc></url>\n  <url><loc>https://e.test/b</loc></url>\n</urlset>\n', xml);
}

// --- content per locale ---------------------------------------------------------------------------
{
  const raw = {
    blog: [
      { slug: "hello", file: "content/blog/en/hello.md", locale: "en", data: { t: "Hello" } },
      { slug: "hello", file: "content/blog/ja/hello.md", locale: "ja", data: { t: "Konnichiwa" } },
      { slug: "only-ja", file: "content/blog/ja/only-ja.md", locale: "ja", data: { t: "J" } },
      { slug: "shared", file: "content/blog/shared.md", data: { t: "S" } },
    ],
  };
  const config = { blog: { __nowakiCollection: true } };
  setContent(await validateContent(raw, config));
  const slugs = (list) => list.map((e) => `${e.slug}:${e.locale ?? "-"}`).join(",");
  check("outside a request: every entry", slugs(await getCollection("blog")) === "hello:en,hello:ja,only-ja:ja,shared:-");
  const ja = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getCollection("blog"));
  check("in a ja request: ja entries and shared ones", slugs(ja) === "hello:ja,only-ja:ja,shared:-", slugs(ja));
  const all = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getCollection("blog", { locale: "*" }));
  check('{ locale: "*" } returns all of them', all.length === 4);
  const en = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getCollection("blog", { locale: "en", filter: (e) => e.slug !== "shared" }));
  check("{ locale, filter }", slugs(en) === "hello:en", slugs(en));
  const fn = await runWithLocale({ locale: "en", i18n: configs.plain }, () => getCollection("blog", (e) => e.slug === "hello"));
  check("a filter function still works and is per locale", slugs(fn) === "hello:en", slugs(fn));
  const entry = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getEntry("blog", "hello"));
  check("getEntry picks the request's locale", entry?.data.t === "Konnichiwa");
  const shared = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getEntry("blog", "shared"));
  check("getEntry falls back to the locale-less entry", shared?.data.t === "S");
  const other = await runWithLocale({ locale: "ja", i18n: configs.plain }, () => getEntry("blog", "hello", { locale: "en" }));
  check("getEntry { locale }", other?.data.t === "Hello");
  check("getEntry without a match in the locale", (await runWithLocale({ locale: "en", i18n: configs.plain }, () => getEntry("blog", "only-ja"))) === undefined);
}

// --- page lists per locale ------------------------------------------------------------------------
{
  const pmods = {
    "a.tsx": { default: () => null },
    "post.tsx": { default: () => null, staticPaths: ({ locale }) => [{ slug: `${locale}-${getLocale()}` }] },
  };
  const penv = {
    i18n: configs.plain,
    routeTable: async () => ({
      routes: [
        { file: "a.tsx", segments: [{ lit: "a" }], isApi: false },
        { file: "post.tsx", segments: [{ lit: "p" }, { param: "slug" }], isApi: false },
      ],
    }),
    importModule: async (f) => pmods[f],
  };
  const urls = await pageUrls(penv, { keep: () => true });
  check(
    "pageUrls: every page in every locale; staticPaths per locale with getLocale()",
    JSON.stringify(urls) === JSON.stringify(["/a", "/ja/a", "/pt-BR/a", "/p/en-en", "/ja/p/ja-ja", "/pt-BR/p/pt-BR-pt-BR"]),
    JSON.stringify(urls),
  );
}

// --- client side ----------------------------------------------------------------------------------
{
  check("getLocale() outside a request and without a document", getLocale() === undefined && localePath("/x", "ja") === "/x");
  const attrs = { "data-nowaki-i18n": JSON.stringify({ locale: "ja", locales: ["en", "ja"], defaultLocale: "en", prefixDefaultLocale: false }) };
  globalThis.document = { documentElement: { getAttribute: (n) => attrs[n] ?? null } };
  check("client: getLocale() reads <html data-nowaki-i18n>", getLocale() === "ja");
  check("client: localePath", localePath("/about") === "/ja/about" && localePath("/ja/about", "en") === "/about");
  check("client: <Link locale>", renderToString(h(Link, { href: "/about", locale: "en" }, "x")) === '<a href="/about" hreflang="en">x</a>');
  delete globalThis.document;
}

console.log(failures ? `\n${failures} i18n check(s) FAILED` : "\ni18n checks passed");
process.exit(failures ? 1 : 0);
