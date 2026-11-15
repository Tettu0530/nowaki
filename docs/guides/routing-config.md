# Routing config: redirects, rewrites, headers, basePath, trailingSlash

`nowaki.config.mjs` (or `.js`) can redirect, rewrite and add headers by path, serve the app under
a path prefix, and fix a trailing-slash policy. Every server applies the same rules: `nowaki dev`,
`nowaki start`, the node / bun / deno / vercel adapters, the Cloudflare Worker, and, as far as a
static host can express them, the static output's `_redirects` and `_headers`. Locales are in
their own guide, [i18n](./i18n.md).

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";

export default defineConfig({
  basePath: "/docs",
  trailingSlash: "never",
  redirects: [
    { source: "/old-docs/[...rest]", destination: "/[...rest]", permanent: true },
    { source: "/go/[to]", destination: "/[to]" },
  ],
  rewrites: [{ source: "/p/[slug]", destination: "/blog/[slug]" }],
  headers: [{ source: "/api/[...rest]", headers: { "cache-control": "no-store" } }],
});
```

- The config is the module's default export. `defineConfig()` from
  `@nowaki-dev/runtime/config` only adds types.
- The config is validated when `nowaki dev`, `build` or `prerender` reads it. An unknown key, at
  any level, is an error with a "did you mean" hint:
  `unknown top-level key "basepath". Did you mean "basePath"?`.
- `nowaki dev` reads the config at startup. After a change it prints
  `[nowaki] nowaki.config.mjs changed; restart nowaki dev to apply it`.

## Order

A request goes through, in order: `basePath`, the trailing-slash policy, `redirects`,
`rewrites`, then `/_nowaki/` assets, `public/` files and routes. Without a routing config, none
of this costs anything per request.

## Patterns

`source` uses the route syntax: `/blog/[slug]` matches one segment, `/docs/[...rest]` one or
more. A param captured in `source` can be used in `destination`. Captured values are
percent-encoded, so a capture can't make a destination leave the site.

`redirects`, `rewrites` and `headers` are arrays, or functions (possibly async) returning one.
A function is called once, when the config is read, not per request.

## Redirects

```js
redirects: [
  { source: "/old/[slug]", destination: "/blog/[slug]", permanent: true }, // 308
  { source: "/twitter", destination: "https://x.com/example" },            // 307
  { source: "/legacy", destination: "/", statusCode: 301 },
],
```

- `permanent: true` sends 308, otherwise 307; `statusCode` (301, 302, 303, 307 or 308) wins.
- `destination` is a path or an absolute http(s) URL (hosts written in ASCII). The request's
  query string is kept.
- A destination that could leave the site through a path (`//host`, `/\host`) and a source or
  destination under `/__nowaki/` fail the build.

## Rewrites

```js
rewrites: [{ source: "/p/[slug]", destination: "/blog/[slug]" }],
```

A rewrite is internal: the request is routed as `destination`, while the browser keeps its URL.
In the page, `ctx.url` is the URL the browser asked for and `ctx.routePath` is the rewritten
path. A destination must be a path in the app; use a redirect for another site.

ISR caches a rewritten page under the browser's path, so purge it with a tag rather than
`revalidatePath` (see [Caching](./caching.md)).

## Headers

```js
headers: [
  { source: "/api/[...rest]", headers: { "cache-control": "no-store" } },
  { source: "/embed/[...rest]", headers: [{ key: "x-frame-options", value: "ALLOWALL" }] },
],
```

- Config headers go on every matching response: pages, ISR hits, assets, `public/` files,
  redirects and 404s, unless the route set the same header itself.
- They replace the default security headers of the same name (see
  [Security](./security.md#default-security-headers)).
- They don't apply to `/__nowaki/*` endpoints.
- A value with CR, LF or NUL, or an invalid header name, fails the build.

## basePath

`basePath: "/app"` serves the whole app under `/app`:

- Built asset URLs (scripts, island chunks, CSS, fonts, images) are `/app/_nowaki/*`; server
  functions, live events and the live socket go to `/app/__nowaki/*`.
- `<Link href="/about">` renders `/app/about`, and `ctx.redirect("/login")` sends `/app/login`
  (a path that already starts with the base is kept, and `{ basePath: false }` sends it as
  written). A plain `<a href="/about">` is left as written.
- Canonical, Open Graph and sitemap URLs carry the base, and so does the session cookie's
  `Path`.
- `import.meta.env.BASE_URL` is `"/app/"` (`"/"` without a base).
- `redirects`, `rewrites` and `headers` sources are relative to the base.
- `/_nowaki/*` at the root is a 404; `/__nowaki/*` endpoints (such as `/__nowaki/health`) also
  answer at the root.
- The client router does a full page load for links outside the base.
- The Vercel and Cloudflare adapters place the static files under the base. Static output keeps
  them at the output root with the base in the pages' URLs: deploy it at the base.

### Links under a base path

Don't concatenate `import.meta.env.BASE_URL` by hand. `<Link>` builds hrefs for you; for URLs it
doesn't build (a form `action`, `fetch`, `location.assign`), use `href()` from
`@nowaki-dev/runtime/navigation`, which adds the base (and the current locale with i18n). The
reverse, the app path of a browser URL, is `routePath(url)` in components and islands and
`ctx.routePath` on the server.

```tsx
import { href, routePath } from "@nowaki-dev/runtime/navigation";

<form method="post" action={href("/logout")}>...</form>;  // "/app/logout"
await fetch(href("/api/items"));                           // "/app/api/items"
routePath("/app/photo/1");                                 // "/photo/1"
```

Working example: `examples/gallery` (`basePath: "/gallery"`).

## trailingSlash

| Value | Effect |
| --- | --- |
| `"ignore"` (default) | `/about` and `/about/` both serve the page; static output writes `about/index.html` |
| `"never"` | `/about/` redirects (308) to `/about`; static output writes `about.html` |
| `"always"` | `/about` redirects (308) to `/about/` |

Redirects apply to GET and HEAD. Canonical URLs, the default `og:url` and `sitemap.xml` follow
the policy. Cloudflare Pages serves the static files with the right policy on its own; other
static hosts may need their own clean-URL setting.

## Static output

The static adapter writes `_redirects` (rewrites become 200 rules) and appends the header rules
to `_headers`, after the contents of a `public/_headers` file. Rules a static host can't express
are left out with a warning naming them. On Vercel, redirects and headers are also written as
platform routes in `.vercel/output/config.json`.

## Reference

- [Config](../reference/config.md) (`redirects`, `rewrites`, `headers`, `basePath`,
  `trailingSlash`, `RedirectRule`, `RewriteRule`, `HeaderRule`)
- [Runtime API](../reference/runtime.md) (`href`, `routePath`, `Link`, `LoaderContext.routePath`)
