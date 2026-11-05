// Unit checks for server/seo.mjs (meta tags, sitemap, robots, site URL). No server needed.
import { mergeMeta, normalizeSite, robotsTxt, seoTags, sitemapXml } from "../packages/nowaki-runtime/server/seo.mjs";

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
check("robots.txt points at the sitemap", robotsTxt("https://example.com") === "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n");

console.log(failures === 0 ? "\nSEO UNIT TEST PASSED" : `\nSEO UNIT TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
