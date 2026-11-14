// SEO and metadata. Pure string work with no node deps, so it runs on the edge too.
//
// - The site's URL: NOWAKI_SITE, else `site` in nowaki.config (written to dist/server/site.json
//   at build). It makes canonical / Open Graph URLs absolute and feeds sitemap.xml / robots.txt.
// - A typed `meta` (route `export const meta = {...}` or `meta()`, with layouts' meta objects as
//   defaults) becomes head tags: description, canonical, robots, Open Graph, Twitter, JSON-LD.
// - sitemap.xml / robots.txt are generated when the app has neither a route nor a public/ file
//   for them.

/// The site URL without a trailing slash, or undefined. Throws on a value that isn't an absolute
/// http(s) URL, so a typo shows up at startup rather than as broken canonical links.
export function normalizeSite(value) {
  if (value === undefined || value === null || value === "") return undefined;
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error(`site must be an absolute URL like https://example.com (got ${JSON.stringify(value)})`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`site must be an http(s) URL (got ${JSON.stringify(value)})`);
  }
  return u.href.replace(/\/+$/, "");
}

/// NOWAKI_SITE wins over what the build or config says.
export function resolveSite(fromConfig) {
  const env = typeof process !== "undefined" ? process.env?.NOWAKI_SITE : undefined;
  return normalizeSite(env || fromConfig);
}

import { basePath, withBase } from "./base-path.mjs";

const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/// Layouts' meta objects (root first), then the route's: later wins, and `openGraph` / `twitter`
/// merge one level deep, so a layout can set `openGraph.siteName` and a page its own `title`.
export function mergeMeta(...metas) {
  const out = {};
  for (const m of metas) {
    if (!isObj(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if ((k === "openGraph" || k === "twitter") && isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
      else out[k] = v;
    }
  }
  return out;
}

/// An absolute URL for `value` (absolute already, or a path against the site / request origin).
/// A root-relative path gets nowaki.config `basePath` unless it already starts with it.
function absolute(value, base) {
  try {
    return new URL(withBase(String(value)), base).href;
  } catch {
    return String(value);
  }
}

/// A page's path as the static output serves it: `/docs/a` is written to `docs/a/index.html`, so
/// its URL there is `/docs/a/` (a static host redirects the bare form). Paths that end in a file
/// name (`/feed.xml`) or a slash stay as they are.
export function staticPagePath(p) {
  const s = String(p);
  if (s.endsWith("/") || /\.[A-Za-z0-9]+$/.test(s.split("/").pop())) return s;
  return `${s}/`;
}

/// A page's own URL under nowaki.config `trailingSlash`: `"always"` adds the slash, `"never"`
/// drops it (`/` stays), `"ignore"` keeps the path as it is, except in static output, where the
/// page is the file `x/index.html` and so `x/` (`staticOutput`). File names stay as they are.
export function pagePath(p, trailingSlash = "ignore", staticOutput = false) {
  if (trailingSlash === "never") return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") || "/" : p;
  return trailingSlash === "always" || staticOutput ? staticPagePath(p) : p;
}

/// The head tags for a resolved meta. `title` is the page's <title> (Open Graph / Twitter
/// default to it). `pathname` and `origin` are the request's; `site` wins over `origin`.
/// `trailingSlash` / `staticOutput` (prerendering for `nowaki build --adapter static`) shape this
/// page's own URL (canonical: true, the default og:url) with `pagePath`.
export function seoTags(meta, { title, pathname, origin, site, trailingSlash, staticOutput = false }) {
  if (!isObj(meta)) return "";
  pathname = pagePath(pathname, trailingSlash, staticOutput);
  const base = (site ?? origin ?? "http://localhost") + "/";
  const tags = [];
  const name = (n, c) => c !== undefined && c !== null && c !== "" && tags.push(`<meta name="${n}" content="${esc(c)}" />`);
  const prop = (p, c) => c !== undefined && c !== null && c !== "" && tags.push(`<meta property="${p}" content="${esc(c)}" />`);

  name("description", meta.description);
  if (meta.canonical) {
    const href = meta.canonical === true ? absolute(pathname, base) : absolute(meta.canonical, base);
    tags.push(`<link rel="canonical" href="${esc(href)}" />`);
  }
  if (meta.robots !== undefined) {
    const r = isObj(meta.robots)
      ? [meta.robots.index === false ? "noindex" : "index", meta.robots.follow === false ? "nofollow" : "follow"].join(", ")
      : meta.robots;
    name("robots", r);
  }
  const og = isObj(meta.openGraph) ? meta.openGraph : null;
  if (og) {
    prop("og:title", og.title ?? title);
    prop("og:description", og.description ?? meta.description);
    prop("og:type", og.type ?? "website");
    prop("og:url", absolute(og.url ?? pathname, base));
    prop("og:site_name", og.siteName);
    prop("og:locale", og.locale);
    for (const img of [].concat(og.image ?? [])) {
      const i = typeof img === "string" ? { url: img } : img;
      if (!i?.url) continue;
      prop("og:image", absolute(i.url, base));
      prop("og:image:type", i.type ?? imageType(i.url));
      prop("og:image:width", i.width);
      prop("og:image:height", i.height);
      prop("og:image:alt", i.alt);
    }
  }
  const tw = isObj(meta.twitter) ? meta.twitter : null;
  if (tw) {
    name("twitter:card", tw.card ?? "summary_large_image");
    name("twitter:site", tw.site);
    name("twitter:creator", tw.creator);
    name("twitter:title", tw.title ?? og?.title ?? title);
    name("twitter:description", tw.description ?? og?.description ?? meta.description);
    const img = tw.image ?? (og ? [].concat(og.image ?? [])[0] : undefined);
    const url = typeof img === "string" ? img : img?.url;
    if (url) {
      name("twitter:image", absolute(url, base));
      name("twitter:image:alt", tw.imageAlt ?? (typeof img === "object" ? img?.alt : undefined));
    }
  }
  for (const ld of [].concat(meta.jsonLd ?? [])) {
    if (!isObj(ld)) continue;
    // `</script>` (or `<!--`) inside a string would end the element: escape every `<`.
    const json = JSON.stringify(ld).replaceAll("<", "\\u003c");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join("\n");
}

/// The MIME type an image URL's extension implies, for `og:image:type` (undefined if unknown).
function imageType(url) {
  const ext = String(url).split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" }[ext];
}

/// sitemap.xml for `urls` (route paths), against the site. Each page URL gets basePath and then
/// the trailing-slash policy (`pagePath`), so the base's root follows the policy too.
/// `alternates(paths)` (i18n) maps a listed route path to its versions in every locale
/// ([[hreflang, route path]]), written as `xhtml:link` alternates shaped the same way.
export function sitemapXml(site, urls, { trailingSlash, staticOutput = false, alternates } = {}) {
  const shape = (u) => pagePath(withBase(u), trailingSlash, staticOutput);
  const paths = [...new Set(urls)];
  const alt = typeof alternates === "function" ? alternates(paths) : null;
  const seen = new Set();
  const items = paths
    .map((u) => [shape(u), u])
    .filter(([loc]) => !seen.has(loc) && seen.add(loc))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([shaped, u]) => {
      const loc = `<loc>${esc(absolute(shaped, site + "/"))}</loc>`;
      const links = alt?.get(u);
      if (!links) return `  <url>${loc}</url>`;
      const xl = links.map(([l, p]) => `    <xhtml:link rel="alternate" hreflang="${esc(l)}" href="${esc(absolute(shape(p), site + "/"))}"/>`);
      return `  <url>\n    ${loc}\n${xl.join("\n")}\n  </url>`;
    })
    .join("\n");
  const ns = alt ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>\n${items}\n</urlset>\n`;
}

/// `<link rel="alternate" hreflang>` for a page in every locale (i18n), and `x-default` for the
/// default locale's. `alternates`: [[locale, browser path]] (i18n.mjs `localeAlternates`).
/// `trailingSlash` / `staticOutput` shape each URL like the page's own (`pagePath`).
export function hreflangTags(alternates, defaultLocale, { origin, site, trailingSlash, staticOutput = false }) {
  const base = (site ?? origin ?? "http://localhost") + "/";
  const href = (p) => esc(absolute(pagePath(p, trailingSlash, staticOutput), base));
  const tags = alternates.map(([l, p]) => `<link rel="alternate" hreflang="${esc(l)}" href="${href(p)}" />`);
  const def = alternates.find(([l]) => l === defaultLocale);
  if (def) tags.push(`<link rel="alternate" hreflang="x-default" href="${href(def[1])}" />`);
  return tags.join("\n");
}

/// robots.txt that allows everything and points at the sitemap when there is a site.
export function robotsTxt(site) {
  return `User-agent: *\nAllow: /\n${site ? `\nSitemap: ${site}${basePath()}/sitemap.xml\n` : ""}`;
}
