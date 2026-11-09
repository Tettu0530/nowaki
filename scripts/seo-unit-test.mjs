// Unit checks for server/seo.mjs (meta tags, sitemap, robots, site URL). No server needed.
import { mergeMeta, normalizeSite, robotsTxt, seoTags, sitemapXml, staticPagePath } from "../packages/nowaki-runtime/server/seo.mjs";
import { basePath, setBasePath, withBase } from "../packages/nowaki-runtime/server/base-path.mjs";
import { Link } from "../packages/nowaki-runtime/navigation.js";
import { makeContext } from "../packages/nowaki-runtime/server/context.mjs";

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

check("site is normalized without a trailing slash", normalizeSite("https://example.com/") === "https://example.com");
check("a site with a path keeps it", normalizeSite("https://example.com/blog/") === "https://example.com/blog");
let threw = false;
try {
  normalizeSite("example.com");
} catch {
  threw = true;
}
check("a site that isn't an absolute URL throws", threw);

const tags = seoTags(
  mergeMeta(
    { openGraph: { siteName: "Site", title: "layout title" }, twitter: { site: "@s" } },
    {
      description: 'Say "hi" <b>',
      canonical: true,
      robots: { index: false },
      openGraph: { title: "Page", image: { url: "/og.png", alt: "A card" } },
      jsonLd: { "@type": "Thing", name: "</script><script>alert(1)</script>" },
    },
  ),
  { title: "Page title", pathname: "/a/b", origin: "http://127.0.0.1:3000", site: "https://example.com" },
);
check("description is escaped", tags.includes('<meta name="description" content="Say &quot;hi&quot; &lt;b&gt;" />'));
check("canonical: true is this page on the site", tags.includes('<link rel="canonical" href="https://example.com/a/b" />'));
check("robots object", tags.includes('<meta name="robots" content="noindex, follow" />'));
check("openGraph merges over the layout's", tags.includes('og:title" content="Page"') && tags.includes('og:site_name" content="Site"'));
check("og:image is absolute against the site", tags.includes('og:image" content="https://example.com/og.png"'));
check("og:image:type from the extension", tags.includes('og:image:type" content="image/png"'));
check("twitter falls back to openGraph", tags.includes('twitter:title" content="Page"') && tags.includes('twitter:image" content="https://example.com/og.png"'));
check("twitter:image:alt from the Open Graph image", tags.includes('twitter:image:alt" content="A card"'));
check("JSON-LD can't close its script element", !tags.includes("</script><script>") && tags.includes("\\u003c/script>"));
check("no site: the request origin", seoTags({ canonical: "/x" }, { pathname: "/", origin: "http://h:1" }).includes('href="http://h:1/x"'));
check("no meta, no tags", seoTags(undefined, { pathname: "/" }) === "");

const map = sitemapXml("https://example.com", ["/b", "/a", "/a", "/x%20y"]);
check("sitemap lists each URL once, sorted, absolute", map.indexOf("https://example.com/a<") < map.indexOf("https://example.com/b<") && map.split("/a<").length === 2);
check("sitemap keeps encoded paths", map.includes("https://example.com/x%20y"));
check("static output: page URLs get the slash their index.html implies", staticPagePath("/docs/a") === "/docs/a/" && staticPagePath("/") === "/" && staticPagePath("/feed.xml") === "/feed.xml");
check("static output: canonical with a slash", seoTags({ canonical: true }, { pathname: "/docs/a", site: "https://e.x", staticOutput: true }).includes('href="https://e.x/docs/a/"'));
check("static output: sitemap with slashes", sitemapXml("https://e.x", ["/", "/docs/a"], { staticOutput: true }).includes("<loc>https://e.x/docs/a/</loc>"));
check("robots.txt points at the sitemap", robotsTxt("https://example.com") === "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n");

// basePath (server/base-path.mjs): canonical, Open Graph and sitemap URLs carry it, and so do
// <Link> and ctx.redirect.
check("no basePath: withBase is the identity", withBase("/about") === "/about" && basePath() === "");
check("no basePath: Link renders the href as written", Link({ href: "/about" }).props.href === "/about");
setBasePath("/app");
check("withBase prefixes root-relative paths", withBase("/about") === "/app/about" && withBase("/") === "/app" && withBase("/?q=1") === "/app?q=1" && withBase("/#top") === "/app#top");
check("withBase leaves the base, URLs and relative paths alone",
  withBase("/app") === "/app" && withBase("/app/x") === "/app/x" && withBase("/app?x") === "/app?x" && withBase("https://e.x/a") === "https://e.x/a" && withBase("//e.x/a") === "//e.x/a" && withBase("/\\e.x") === "/\\e.x" && withBase("a/b") === "a/b");
check("withBase: a path that only starts like the base still gets it", withBase("/apple") === "/app/apple");
check("basePath: canonical: true keeps the request path (it has the base)", seoTags({ canonical: true }, { pathname: "/app/docs", site: "https://e.x" }).includes('href="https://e.x/app/docs"'));
check("basePath: a canonical path and og:image get the base", (() => {
  const t = seoTags({ canonical: "/docs", openGraph: { image: "/og.png", url: "https://other.x/p" } }, { pathname: "/app/docs", site: "https://e.x" });
  return t.includes('href="https://e.x/app/docs"') && t.includes('content="https://e.x/app/og.png"') && t.includes('content="https://other.x/p"');
})());
check("basePath: sitemap URLs get the base", sitemapXml("https://e.x", ["/", "/a"]).includes("<loc>https://e.x/app</loc>") && sitemapXml("https://e.x", ["/a"]).includes("<loc>https://e.x/app/a</loc>"));
check("basePath: robots.txt points at the sitemap under the base", robotsTxt("https://e.x").includes("Sitemap: https://e.x/app/sitemap.xml"));
check("basePath: Link prefixes, basePath={false} keeps the href", Link({ href: "/about" }).props.href === "/app/about" && Link({ href: "/about", basePath: false }).props.href === "/about" && !("basePath" in Link({ href: "/x", basePath: false }).props));
{
  const ctx = makeContext({ url: new URL("http://x/app/a") });
  check("basePath: ctx.redirect prefixes a root-relative path", ctx.redirect("/login").headers.location === "/app/login" && ctx.redirect("/login", 303).status === 303);
  check("basePath: ctx.redirect leaves prefixed paths and URLs, and opts out", ctx.redirect("/app/x").headers.location === "/app/x" && ctx.redirect("https://e.x/").headers.location === "https://e.x/" && ctx.redirect("/x", { basePath: false }).headers.location === "/x" && ctx.redirect("/x", 307, { basePath: false }).status === 307);
}
setBasePath("");

console.log(failures === 0 ? "\nSEO UNIT TEST PASSED" : `\nSEO UNIT TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
