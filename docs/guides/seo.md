# SEO, metadata and sitemaps

Pages set their `<title>`, meta tags, Open Graph and Twitter cards, JSON-LD and `<html>` /
`<body>` attributes through route exports. With the site's URL configured, Nowaki makes those
URLs absolute and generates `sitemap.xml` and `robots.txt`.

## The site URL

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";

export default defineConfig({ site: "https://example.com" });
```

`NOWAKI_SITE` overrides it at runtime (a preview deployment, say). Loaders, `meta()` and file
routes read it as `ctx.site` (a `URL`, or `undefined` when neither is set). Without a site,
canonical and Open Graph URLs use the request's origin, and no sitemap or robots.txt is
generated. A value that isn't an absolute http(s) URL is an error at startup.

## Title and meta tags

A page or layout exports `meta`, an object or a function (possibly async) of
`{ data, params, url }`:

```tsx
// routes/docs/[slug].tsx
import type { MetaFn } from "@nowaki-dev/runtime";

type Data = { title: string; summary: string };

export const meta: MetaFn<Data> = ({ data, params }) => ({
  title: `${data.title} | Docs`,
  description: data.summary,
  canonical: true,
  openGraph: {
    type: "article",
    image: { url: `/og/${params.slug}.png`, width: 1200, height: 630, alt: data.title },
  },
  twitter: { card: "summary_large_image" },
  jsonLd: { "@context": "https://schema.org", "@type": "TechArticle", headline: data.title },
});
```

| Field | Renders |
| --- | --- |
| `title` | `<title>` |
| `description` | `<meta name="description">`; Open Graph and Twitter fall back to it |
| `canonical` | `<link rel="canonical">`: a URL or path, or `true` for this page |
| `robots` | `<meta name="robots">`: a string, or `{ index, follow }` |
| `openGraph` | `og:*` tags; `title`, `description` and `url` default to the page's; `image` is a URL or `{ url, type, width, height, alt }` (or an array) |
| `twitter` | `twitter:*` tags; `card` defaults to `summary_large_image`, the rest falls back to Open Graph |
| `jsonLd` | one `<script type="application/ld+json">` per object; it can't close its own `<script>` |
| `lang`, `htmlAttrs`, `bodyAttrs` | see below |
| `head` | raw HTML for `<head>` (see below) |

Relative URLs resolve against the site. Simple pages can export `title`, `head` and `lang` as
plain strings instead; `meta.title` wins over `title`.

### Defaults from layouts

A layout's `meta` (an object, or a function of `{ data, params, url }` with the layout's own
loader data) applies to every page under it, and so do its `title`, `lang` and `head` exports.
Layouts combine root to leaf, then the page:

- `title` and `lang`: the page's, else the nearest layout's that sets one. In each module
  `meta.title` / `meta.lang` win over the `title` / `lang` exports. Any `lang` wins over the
  i18n locale, which wins over `htmlAttrs.lang`.
- `head`: each layout's (root first), then the page's.
- The other fields: later values win; `openGraph` and `twitter` merge one level deep.

```tsx
// routes/_layout.tsx
export const meta = { openGraph: { siteName: "Example" }, twitter: { site: "@example" } };
```

### Raw `head`

`head` (an export, or a field of `meta`) is inserted into `<head>` as written, without escaping.
Never build it from user input. A layout's `head` comes before the page's. Under `NOWAKI_CSP`,
an inline `<script>` / `<style>` in it needs the nonce: return it from a `meta()` function with
`nonce()` (see [Security](./security.md#inline-scripts-and-styles-nonce)).

## HTML and body attributes

```tsx
export const htmlAttrs = { "data-theme": "paper" };
export const bodyAttrs = { class: "docs" };
```

Layouts apply first (root to leaf), then the route, then `meta()`. A later value wins,
`false` / `null` removes one set earlier, `class` values are joined, and `true` renders a bare
attribute. Values are escaped; `on*` attributes are ignored. `export const lang` sets `lang`
(with `i18n`, it defaults to the request's locale). On client navigation, the router updates
the attributes the server set and leaves the ones client code added.

## sitemap.xml and robots.txt

With a site URL, Nowaki serves `/sitemap.xml` and `/robots.txt` unless a route or a `public/`
file provides them. The static adapter writes both files.

- The sitemap lists every page, including dynamic ones that have `staticPaths` (a dynamic page
  without it can't be enumerated).
- `export const sitemap = false` leaves a page out, and so does a noindex `robots` in a static
  `meta` object: the page's, else the nearest layout's (a `meta` function isn't run for the
  sitemap).
- With `i18n`, each page is listed in every locale with `xhtml:link` alternates.
- URLs follow `basePath` and `trailingSlash`.
- The generated robots.txt allows everything and points at the sitemap. For anything else, write
  `public/robots.txt` or a `routes/robots.txt.ts` file route.

## Localized pages

With `i18n` and a site URL, pages get `<link rel="alternate" hreflang>` for every locale plus
`x-default`, and `<html lang>` follows the locale. See [i18n](./i18n.md).

## Feeds and Open Graph images

Feeds and generated images are [file routes](./routing.md#file-routes): `routes/feed.xml.ts`,
`routes/og/[card].png.ts`. Use `ctx.site` for absolute links. Working examples:
`examples/hello/routes/feed.xml.ts`, `examples/hello/routes/og/[card].png.ts`,
`examples/hello/routes/docs/[slug].tsx` (meta with an Open Graph image and JSON-LD).

## Reference

- [Runtime API](../reference/runtime.md) (`Meta`, `MetaFn`, `OpenGraphImage`, `DocumentAttrs`)
- [Route module exports](../reference/route-exports.md) (`meta`, `title`, `head`, `lang`,
  `htmlAttrs`, `bodyAttrs`, `sitemap`)
- [Config](../reference/config.md) (`site`)
