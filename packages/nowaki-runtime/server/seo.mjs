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
function absolute(value, base) {
  try {
    return new URL(String(value), base).href;
  } catch {
    return String(value);
  }
}

/// The head tags for a resolved meta. `title` is the page's <title> (Open Graph / Twitter
/// default to it). `pathname` and `origin` are the request's; `site` wins over `origin`.
export function seoTags(meta, { title, pathname, origin, site }) {
  if (!isObj(meta)) return "";
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

/// sitemap.xml for `urls` (paths), against the site.
export function sitemapXml(site, urls) {
  const items = [...new Set(urls)]
    .sort()
    .map((u) => `  <url><loc>${esc(absolute(u, site + "/"))}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

/// robots.txt that allows everything and points at the sitemap when there is a site.
export function robotsTxt(site) {
  return `User-agent: *\nAllow: /\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ""}`;
}
