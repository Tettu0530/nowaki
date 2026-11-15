# Deploy as a static site (static adapter)

The static adapter renders every page to HTML at build time. The output is plain files for any
static host (Cloudflare Pages, GitHub Pages, S3, nginx). Client islands still hydrate; anything
that needs a server at request time doesn't run.

## Build

```sh
npx nowaki build --adapter static     # writes dist/static
npx nowaki prerender --out public-html # the same, into another directory
npx nowaki prerender --skip-build      # render from an existing `nowaki build` output
```

`nowaki build --adapter static` builds, then prerenders into `dist/static`. `nowaki prerender`
does the same with its own `--out` (default `dist/static`, relative to the app; it can't be or
contain `dist/client`, `dist/server` or `dist/public`).

Output:

```
dist/static/
  index.html, about/index.html, ...   one file per page
  404.html                            from routes/_404.tsx
  feed.xml, og/intro.png, ...         file routes
  sitemap.xml, robots.txt             with a site URL
  _nowaki/                            client assets
  _redirects, _headers                routing rules and headers
  ...                                 public/ files
```

## What gets rendered

- Every page without params, and every dynamic page for each entry of its `staticPaths`. A
  dynamic page without `staticPaths` is left out.
- File routes: static ones always, dynamic ones from `staticPaths`.
- `export const prerender = false` leaves a page or file route out.
- A page that redirects or answers 404 is skipped (logged). A page that fails with a 5xx fails
  the build.
- With `i18n`, each locale is written under its prefix with its own `404.html`, and
  `staticPaths` functions run once per locale.
- `trailingSlash` decides the file layout: `about/index.html` (`"ignore"`, `"always"`) or
  `about.html` (`"never"`).
- Above 256 pages, pages are rendered by a pool of Node workers.

## What works and what doesn't

| Works | Doesn't (no server at request time) |
| --- | --- |
| Pages and layouts as HTML, loaders run at build time | actions, API routes (except prerendered file routes), server functions |
| Client islands (all `client:*` strategies), page scripts, the client router | sessions: a page that reads `ctx.session` fails the build |
| `<Image>`, fonts, content collections, MDX, Markdoc | live islands: they stay as their first HTML (the build lists those pages) |
| View Transitions (cross-document ones too) | ISR and `revalidatePath` / `revalidateTag` (no-ops, warned once) |
| `redirects`, `rewrites` and `headers` that `_redirects` / `_headers` can express | i18n detection: `/` serves the default locale (the build warns) |
| | a CSP nonce: pages are written without one |

## Redirects and headers

`_redirects` gets the nowaki.config redirects (rewrites become 200 rules) and the default-locale
prefix redirects with i18n. `_headers` gets the default security headers and the config header
rules, after the contents of a `public/_headers` file. Rules a static host can't express (a
parameter in the middle of a path, for some hosts) are left out with a warning naming them.
These files follow the Cloudflare Pages / Netlify format; other hosts need the same rules in
their own configuration.

## basePath

The files are written at the output root, with the base in the pages' URLs and in `_redirects`
/ `_headers`. Deploy the directory so it is served at the base path.

## CSP

Static pages have no per-response nonce, and `NOWAKI_CSP` adds nothing to them. To use a CSP,
set it in `public/_headers` yourself, with hashes or `'self'` and no inline code. Check it in the
browser with `Content-Security-Policy-Report-Only` first.

## See also

[Routing: dynamic segments](../guides/routing.md#dynamic-segments),
[Routing config](../guides/routing-config.md#static-output), [Islands](../guides/islands.md).
