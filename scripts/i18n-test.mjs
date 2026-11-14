// Unit checks for i18n: the locale split and localePath (shared fixture with prerender.rs), the
// handler's localized requests (ctx.locale, getLocale(), <html lang>, hreflang, redirects, 404s),
// the sitemap's alternates, getCollection / getEntry per locale, the page list per locale, the
// client's <Link> / href(), and locale detection at the JS fronts.
// Usage: node scripts/i18n-test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { compileI18n, localeGroups, localePathFor, splitLocale } from "../packages/nowaki-runtime/server/i18n.mjs";
import { runWithLocale } from "../packages/nowaki-runtime/server/i18n-context.mjs";
import { hreflangTags, sitemapXml } from "../packages/nowaki-runtime/server/seo.mjs";
import { pageUrls } from "../packages/nowaki-runtime/server/isr-urls.mjs";
import { setContent, validateContent } from "../packages/nowaki-runtime/server/content-store.mjs";
import { getCollection, getEntry } from "../packages/nowaki-runtime/content.js";
import { getLocale, href, Link, localePath, setLocale } from "../packages/nowaki-runtime/navigation.js";
import { compileRules } from "../packages/nowaki-runtime/server/rules.mjs";
import { frontLocale, mergeVary, withVary, withVaryHeaders } from "../packages/nowaki-runtime/server/front.mjs";

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
  "routes/links.tsx": {
    htmlAttrs: { "data-theme": "dark" },
    default: () => h("p", null, h(Link, { href: "/contact" }, "c"), h(Link, { href: "/contact", locale: false }, "raw"), ` form:${href("/logout")}`),
  },
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
    { file: "routes/links.tsx", segments: [{ lit: "links" }], dir: "", isApi: false },
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
  const again = await text(await req(env, "/ja/about"));
  check("a second request gets the same document (cached attributes and hreflang)", again.includes(`data-i18n='{"locale":"ja"`) && again.includes('hreflang="ja" href="https://example.com/ja/about"'), again.slice(0, 300));
  const ja = await text(await req(env, "/ja/links"));
  check("server: <Link> keeps the request's locale", ja.includes('<a href="/ja/contact">c</a>'), ja);
  check("server: <Link locale={false}> leaves the href alone", ja.includes('<a href="/contact">raw</a>'), ja);
  check("server: href() for a form action", ja.includes("form:/ja/logout"), ja);
  check("a page's htmlAttrs keep the client's i18n settings", ja.includes(`data-i18n='{"locale":"ja"`), ja.slice(0, 200));
  const en = await text(await req(env, "/links"));
  check("server: in the default locale <Link> and href() add no prefix", en.includes('<a href="/contact">c</a>') && en.includes("form:/logout"), en);
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
  // basePath + trailingSlash together: the default-locale redirect lands on the canonical URL in
  // one hop (the front has already moved the request to the policy's form).
  const always = makeEnv({ basePath: "/app", trailingSlash: "always", ...I18N }, { trailingSlash: "always" });
  let res = await req(always, "/app/en/", { routePath: "/en/" });
  check("base + always: /app/en/ → /app/", res.status === 308 && res.headers.location === "/app/", JSON.stringify(res));
  res = await req(always, "/app/en/about/?q=1", { routePath: "/en/about/" });
  check("base + always: /app/en/about/ → /app/about/", res.status === 308 && res.headers.location === "/app/about/?q=1", JSON.stringify(res));
  const body = await text(await req(always, "/app/ja/about/", { routePath: "/ja/about/" }));
  check("base + always: alternates with the slash", body.includes('hreflang="en" href="https://example.com/app/about/"') && body.includes('hreflang="ja" href="https://example.com/app/ja/about/"'), body);
  const home = await text(await req(always, "/app/", { routePath: "/" }));
  check("base + always: the home page /app/ gets alternates", home.includes('hreflang="ja" href="https://example.com/app/ja/"') && home.includes('hreflang="x-default" href="https://example.com/app/"'), home);
  const prefixedAlways = makeEnv({ basePath: "/app", trailingSlash: "always", i18n: { locales: ["en", "ja"], defaultLocale: "en", prefixDefaultLocale: true } });
  res = await req(prefixedAlways, "/app/", { routePath: "/" });
  check("base + always + prefixDefaultLocale: /app/ → 307 /app/en/", res.status === 307 && res.headers.location === "/app/en/", JSON.stringify(res));
  const never = makeEnv({ basePath: "/app", trailingSlash: "never", ...I18N }, { trailingSlash: "never", staticOutput: true });
  const neverBody = await text(await req(never, "/app/ja/about", { routePath: "/ja/about" }));
  check("base + never in static output: alternates without the slash", neverBody.includes('hreflang="en" href="https://example.com/app/about"') && !neverBody.includes('href="https://example.com/app/about/"'), neverBody);
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
  const anchor = (props) => renderToString(h(Link, props, "x"));
  check("client: <Link> keeps the page's locale", anchor({ href: "/about?q=1#t" }) === '<a href="/ja/about?q=1#t">x</a>', anchor({ href: "/about?q=1#t" }));
  check("client: <Link> keeps an explicit locale prefix", anchor({ href: "/ja/about" }) === '<a href="/ja/about">x</a>' && anchor({ href: "/en/about" }) === '<a href="/en/about">x</a>');
  check("client: <Link locale={false}> leaves the href alone", anchor({ href: "/about", locale: false }) === '<a href="/about">x</a>');
  check("client: <Link> leaves other URLs alone", anchor({ href: "https://x.dev/a" }) === '<a href="https://x.dev/a">x</a>' && anchor({ href: "#top" }) === '<a href="#top">x</a>');
  globalThis.__nowakiBase = "/app";
  check("client: <Link> under basePath: base, then locale", anchor({ href: "/about" }) === '<a href="/app/ja/about">x</a>' && anchor({ href: "/" }) === '<a href="/app/ja">x</a>' && anchor({ href: "/", locale: "en" }) === '<a href="/app" hreflang="en">x</a>');
  check("client: href()", href("/logout") === "/app/ja/logout" && href("/a", { locale: "en" }) === "/app/a" && href("/a", { locale: false }) === "/app/a" && href("/a", { basePath: false }) === "/ja/a");
  delete globalThis.__nowakiBase;
  delete globalThis.document;
  check("client: without i18n, <Link> and href() change nothing", anchor({ href: "/about" }) === '<a href="/about">x</a>' && href("/about") === "/about" && href("/about", { locale: "ja" }) === "/about");
  const jar = [];
  globalThis.document = { documentElement: { getAttribute: () => null }, set cookie(v) { jar.push(v); } };
  globalThis.location = { protocol: "https:" };
  globalThis.__nowakiBase = "/app";
  setLocale("ja");
  check("client: setLocale sets nowaki_locale under the base", jar[0] === "nowaki_locale=ja; Path=/app; Max-Age=31536000; SameSite=Lax; Secure", jar[0]);
  delete globalThis.__nowakiBase;
  globalThis.location = { protocol: "http:" };
  setLocale("pt-BR");
  check("client: setLocale at the root over http", jar[1] === "nowaki_locale=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax", jar[1]);
  let own = 0;
  const link = Link({ href: "/", locale: "ja", onClick: () => own++ });
  const ev = { defaultPrevented: false };
  link.props.onClick(ev);
  check(
    "client: a click on <Link locale> sets the cookie, runs the own onClick, leaves the click to the router",
    jar[2]?.startsWith("nowaki_locale=ja; Path=/;") && own === 1 && !ev.defaultPrevented,
    jar[2],
  );
  jar.length = 2;
  delete globalThis.document;
  delete globalThis.location;
  setLocale("ja");
  check("setLocale does nothing on the server", jar.length === 2);
}

// --- locale detection at the JS fronts (front.mjs) ------------------------------------------------
{
  const rules = compileRules({ basePath: "/app", i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true } });
  const url = (p) => new URL(`http://x${p}`);
  const r = frontLocale(rules, "GET", url("/app?x=1"), "ja", undefined);
  check(
    "frontLocale: redirect with the query, Vary and private cache-control",
    r?.redirect?.status === 307 && r.redirect.location === "/app/ja?x=1" && r.headers.vary === "Accept-Language, Cookie" && r.headers["cache-control"] === "private, no-cache",
    JSON.stringify(r),
  );
  check("frontLocale: staying on the root", JSON.stringify(frontLocale(rules, "GET", url("/app/"), "en", "")) === "{}");
  check("frontLocale: not the root", frontLocale(rules, "GET", url("/app/about"), "ja", undefined) === null);
  check("mergeVary", mergeVary(undefined) === "Accept-Language, Cookie" && mergeVary("Origin") === "Origin, Accept-Language, Cookie" && mergeVary("cookie, accept-language") === "cookie, accept-language" && mergeVary("*") === "*" && mergeVary(["Origin", "Cookie"]) === "Origin, Cookie, Accept-Language");
  const h = withVaryHeaders({ "content-type": "text/html", Vary: "Origin" });
  check("withVaryHeaders merges whatever the key's case", h.vary === "Origin, Accept-Language, Cookie" && !("Vary" in h) && h["content-type"] === "text/html", JSON.stringify(h));
  const res = withVary(new Response("x", { headers: { vary: "Origin" } }));
  check("withVary on a Web Response", res.headers.get("vary") === "Origin, Accept-Language, Cookie");
}

console.log(failures ? `\n${failures} i18n check(s) FAILED` : "\ni18n checks passed");
process.exit(failures ? 1 : 0);
