# Changelog

All notable changes to Nowaki are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Nowaki is **0.x alpha**: minor versions may carry
breaking changes (documented per entry), patch versions do not.

The npm version and the milestone codename are offset — each release bundles a
milestone's worth of work; the codename is noted per entry.

## [Unreleased]

### Added
- **Parallel routes (`@slot`), server-rendered.** A directory named `@name` under `routes/` is a
  slot of the `_layout` in its parent directory, which gets it as `slots.name` (typed by the new
  `LayoutProps`). The slot's file matching the URL below the owner's directory renders there
  (`routes/@modal/photo/[id].tsx` for `/photo/42`, with its own `loader` and params), else its
  `default.tsx`, else `slots.name` is `null`. The rendered node is wrapped in
  `<nowaki-slot name="…" style="display:contents">`; its CSS and page scripts are linked with the
  page's, and it adds no `meta`. Slot files are never routes of their own: they're left out of
  typegen, prerendering and URL conflict checks; a page's JS budget counts the islands of every
  slot file its layouts can render. Files starting with `_` and nested slots inside a slot are
  ignored. Intercepting routes (a segment starting with `(.)`, `(..)` or `(...)`) are recorded
  but not served yet. Apps without slots pay one length check per request.
- **Route groups.** A directory named `(name)` under `routes/` groups files
  without adding a URL segment: `routes/(marketing)/about.tsx` serves `/about`.
  The group's `_layout`, `loading` and `error` apply to the files inside it.
  Its `_middleware` runs for the routes whose files are inside the group, not
  by URL, so it doesn't run for 404s; middleware outside groups still matches
  by URL. Two files serving the same URL because of groups
  (`(a)/about.tsx` and `(b)/about.tsx`) fail the build and show an error in
  dev. Names starting with `.` (`(.)`, `(..)`) are reserved. On client
  navigation, a group's `loading` / `error` boundary is matched by its URL
  prefix (the group left out), so it can also show for URLs outside the group;
  a boundary outside any group wins at the same prefix.
  The Cloudflare worker now also serves `loading` / `error` boundaries.
- **Remote images in `<Image>`.** `import hero from "https://images.example.com/photos/a.jpg?image"`
  is fetched at build time and optimized like a local `?image` import (AVIF + fallback widths,
  intrinsic size), when a `images.remotePatterns` entry in nowaki.config allows the URL
  (protocol, host with `*.` / `**.` prefixes, port, path glob; protocol defaults to https). Remote
  images in MDX and in Markdown content entries are optimized the same way when allowed; others
  stay a plain `<img>` with a warning. A disallowed `?image` import fails the build. Downloads are
  cached under `node_modules/.cache/nowaki/images/remote` (a cached image never starts Node or
  touches the network; `NOWAKI_IMAGES_REFRESH=1` fetches again) and refused for private,
  loopback, and link-local addresses, redirects outside the patterns (at most 3), bodies over
  20 MB, responses slower than 15 s, and anything but PNG, JPEG, WebP, or GIF. Nothing is fetched
  at runtime. A plain remote string `src` on `<Image>` is unchanged (a bare `<img>`).
- **Sessions: `ctx.session`** (also `getContext().session` in server functions).
  `await ctx.session.get(key)`, `set(key, value)`, `delete(key)`, `regenerate()` (call it on
  sign-in) and `destroy()` keep JSON values per visitor in an AES-256-GCM encrypted cookie
  (`HttpOnly; SameSite=Lax`, `Secure` over https, 4 KB at most), or, with a `store` in the
  optional app-root `session.ts` (`defineSession({ cookieName, maxAge, rolling, store })` from
  `@nowaki-dev/runtime/session`), server-side behind a signed random id. Keys come from
  `NOWAKI_SESSION_SECRET` (comma-separate several to rotate keys); production throws on the first
  `ctx.session` without it, dev generates `.nowaki/session-secret`. A cross-site non-GET request
  sees an empty, read-only session, and so do live renders (read-only). The session is created on
  first access: requests that don't use it cost nothing extra. Works on every adapter
  (WebCrypto only).
- **Routing config in nowaki.config** (v0.18, groundwork): `basePath`,
  `trailingSlash` (`"never"` / `"always"` / `"ignore"`, default `"ignore"`),
  `redirects`, `rewrites`, `headers` (arrays, or async functions called once at
  build), `i18n`, and `images.remotePatterns` are validated at build, before
  anything is built, and written to `dist/server/routing.json` (dev:
  `.nowaki/routing.json`). A redirect or rewrite destination that could leave
  the site (`//host`, `/\host`, a capture in an external host), a source or
  destination under `/__nowaki/`, and CR / LF / NUL in a header value fail the
  build.
- **`redirects`, `rewrites`, `headers`, `basePath` and `trailingSlash` are
  applied** by `nowaki start`, `nowaki dev`, the node / bun / deno / vercel
  adapters and the Cloudflare worker, in this order: basePath, trailing slash
  (GET / HEAD, 308), redirects, rewrites, then `/_nowaki/` assets, `public/`
  files and routes. A redirect keeps the request's query and gets the security
  headers. A rewrite is internal: the page renders the destination route while
  `ctx.url` stays the URL the browser asked for. Config headers go on every
  response (pages, ISR hits, assets, `public/` files, redirects, 404s) unless
  the route set the same header; they replace the default security headers of
  the same name. They don't apply to `/__nowaki/*` endpoints. On Vercel,
  redirects and headers are also emitted as platform routes in `config.json`.
  The static adapter writes `_redirects` (rewrites as 200 rules) and appends
  the headers to `_headers`, warning about rules a static host can't express.
  For now `basePath` only removes the prefix from requests (and 404s anything
  outside it); asset URLs and links don't carry it yet, and `/_nowaki/*` and
  `/__nowaki/*` stay at the root. Without a routing config nothing changes per
  request.
- **Markdoc** via the new `@nowaki-dev/markdoc` plugin. With
  `markdoc({ components, tags, nodes })` in `plugins`, a `.mdoc` file compiles to a Preact module
  at build and dev time. The module exports the rendered document, `frontmatter` and `headings`,
  with the same heading ids as Markdown and MDX. Validation errors fail the build. Capitalized
  tags render exports of the `components` module, islands included. `.mdoc` files can be content
  entries (YAML or TOML frontmatter, `render()`). They are not routes. Without the plugin, a
  `.mdoc` import fails with "add @nowaki-dev/markdoc to plugins".
- **Typed environment variables (`env.ts`).** Declare them at the app root with
  `defineEnv({ server, public })` from `@nowaki-dev/runtime/env`, each with a
  Standard Schema (Zod, Valibot, ArkType, ...). `nowaki build` / `dev` /
  `prerender` validate the environment (`.env`, `.env.local`, and the process
  environment) first and fail on a missing or invalid variable, naming it but
  never printing its value. Server code reads `env.X` from
  `@nowaki-dev/runtime/env/server`; `PUBLIC_*` values are inlined as
  `import.meta.env.PUBLIC_*` (replacing the `.env`-only values when env.ts
  exists). `nowaki start`, the node / bun / deno / vercel adapters, and the dev
  renderer validate again at startup and refuse to start; the Cloudflare worker
  validates its vars and secrets before the first request and answers 500 until
  they are fixed. Client code that imports `@nowaki-dev/runtime/env/server` fails
  the build with the import chain (dev serves an error module). `nowaki typegen`
  types `env` and `import.meta.env` from the schemas. Public names must start
  with `PUBLIC_` and server names must not. New core API:
  `NowakiCore::set_public_env`.
### Changed
- An error while saving a request's session (a store failure, a cookie over 4 KB) now renders
  the 500 page instead of escaping the request handler.
- **The CI performance regression gate also compares each PR with the latest
  release**, failing beyond −10% req/s or +20% TTFB against it (the existing
  limits against base stay the same). Every metric (build, dev startup, req/s and
  TTFB) now runs on one fixed app, `benchmarks/ci-perf-app` from the PR, on every
  side, instead of each side's own `examples/hello`, which grows with e2e
  coverage. Besides a plain `/about`, it measures `/posts/[slug]`, with nested
  layouts, a loader, page `meta` and layout/route CSS. Together these would have
  caught the ~17% throughput regression that runtime 0.16.0 shipped in small
  steps. The release's binary is cached per tag.

## [0.17.3] — 2026-11-09 · patch

Packages: `nowaki` / `nowaki-core` 0.17.3 (crates.io, npm), `@nowaki-dev/runtime`
0.16.3, `create-nowaki` / `create-nowaki-app` 0.18.3. The fix is in the runtime:
update `@nowaki-dev/runtime` to 0.16.3.

### Fixed
- **Server-rendered pages are fast again on `nowaki start` and the Node
  adapter.** `@nowaki-dev/runtime` 0.16.0 (with 0.17.0) served about 17% fewer
  requests per second than 0.15.x on uncached pages. A page asked for its layout
  chain and its layout modules several times per request (layouts, SEO, page
  scripts, document attributes), and each module import converted the file path
  to a URL again, and each page-script / route-CSS lookup recomputed a relative
  path. These are now computed once per file, and `ctx.site` is parsed only when
  read. On the comparison app's post page (Apple M2, `oha -c 50`), runtime
  0.15.3 served 9,993-10,208 req/s, 0.16.2 served 8,154-8,438, and 0.16.3 serves
  10,136-11,970.

## [0.17.2] — 2026-11-08 · patch

Packages: `nowaki` / `nowaki-core` 0.17.2 (crates.io, npm), `@nowaki-dev/runtime`
0.16.2, `create-nowaki` / `create-nowaki-app` 0.18.2.

### Added
- **TOML frontmatter** in content collections: a `.md` or `.mdx` entry whose
  first line is exactly `+++` reads TOML up to the next `+++` line (Hugo
  style). It is validated by the same schema as YAML, and values map the
  same way. Datetimes become ISO 8601 strings, as YAML dates stay strings;
  coerce them in the schema for `Date`s. A syntax error names the file and
  line (`content/blog/x.md:3: frontmatter: …`).

### Fixed
- AVIF images with transparency keep their alpha exactly. The alpha plane was
  encoded at the colour quality (60), so fully transparent and fully opaque
  pixels near edges came back slightly off (about 0.5% of transparent pixels in
  a test image were no longer fully transparent). Alpha is now encoded at
  quality 100. That costs about 5% more bytes on an image with transparency and
  nothing on an opaque one, which has no alpha plane.


## [0.17.1] — 2026-11-07 · patch

Packages: `nowaki` / `nowaki-core` 0.17.1 (crates.io, npm), `@nowaki-dev/runtime`
0.16.1, `create-nowaki` / `create-nowaki-app` 0.18.1. Update both `nowaki` and
`@nowaki-dev/runtime`.

### Upgrade notes
- `ctx.url.origin` on `nowaki start` / `nowaki dev` is now the browser's
  origin, not the sidecar's `http://127.0.0.1:<port>`. It is `https` only
  behind a trusted proxy (`NOWAKI_TRUST_PROXY`). Set `site` for fixed
  canonical / `og:url`.
- The `nowaki start` ISR cache is keyed per host.
- A response that sets a cookie and asks for `public` / `s-maxage` is sent as
  `private, no-cache`.
- Built asset names with characters outside `[A-Za-z0-9._-]` change; they
  returned 404 before.
- `nowaki prerender --out` refuses a path that is, contains, or is inside the
  build.

### Changed
- Dependencies: `oxc` 0.135 → 0.146 and `oxc_resolver` 11.21 → 11.24.3, with
  `nowaki-core` moved to oxc's split export AST (`ExportDeclaration` /
  `ExportNamedDeclaration` / `ExportFromDeclaration`) and its `diagnostics`
  field. Output is unchanged apart from the minifier: it now keeps
  `a.b || (a.b = c)` unless `a` provably can't change (an upstream correctness
  fix), so first-load JS grows by about 20 bytes gzip. `serde-saphyr` 2.1.0
  (yanked) → 2.1.1.

### Fixed
- The server build rewrites imports of `.mjs` modules to the `.js` file it
  writes, and copies JSON the server imports (`import site from
  "../data/site.json" with { type: "json" }`) into `dist/server`. Before,
  `nowaki start` failed with `ERR_MODULE_NOT_FOUND` where `nowaki dev` worked.
- A CSS Module that uses `@import` has the same class map in SSR as on the
  client. Before, SSR (dev and the server build) scoped the file without its
  imports, so classes from the imported file were `undefined` in the
  server-rendered HTML.
- CSS Modules scope only class selectors. Before, a `.ext` inside `url()`,
  a string, an attribute selector or a comment was scoped too:
  `url(/img/bg.png)` became `url(/img/bg.png_<hash>)` and 404ed, and
  `[href$=".pdf"]` stopped matching.
- Build output names in `dist/client` use only `[A-Za-z0-9._-]`: other
  characters in the source file name become `_` (`logo@2x.svg` →
  `logo_2x.<hash>.svg`). Before, the name kept the source stem as is, and
  `nowaki start`, which serves only such names, answered 404.
- The dev transform cache, in memory and in `node_modules/.cache/nowaki`,
  also checks the files a module inlines: a CSS Module's class map (with its
  `@import`s), plain CSS text in SSR, and `?image` sizes. Before, editing one
  of those kept serving the old class names or sizes until the importing file
  changed, even across restarts.
- The persistent dev transform cache is keyed on what import resolution
  depends on too: lockfiles and package-manager install state (in the app and
  the directories above it), `package.json` and `tsconfig.json`. Before, after
  an install that moved a dependency, `nowaki dev` kept serving import URLs
  that pointed at the old location.
- `nowaki start` and `nowaki dev` gave `ctx.url` (and canonical / `og:url` on an
  app without `site`) the sidecar's loopback origin, `http://127.0.0.1:<port>`.
  It is now the browser's `Host`, with `https` and `X-Forwarded-Host` taken from
  a proxy only under `NOWAKI_TRUST_PROXY`; `site` still wins for canonical /
  `og:url`. ISR entries are now kept per host (#150).
- With `NOWAKI_CSP` on, `nowaki start` sent `public/` HTML files with a
  constant ETag while each response carried a new nonce, so a 304 paired the
  cached body with a different policy. Those files are now sent without an ETag
  (#150).
- `HEAD` now mirrors `GET` for `/_nowaki/*` assets on `nowaki start` (it was a
  404) and for app files on `nowaki dev` (#150).
- An ISR page that set a cookie went out with a shared
  `public, s-maxage=…` Cache-Control next to `Set-Cookie`, so a CDN could
  replay one visitor's cookie to others. A response with `Set-Cookie` and a
  shared Cache-Control now gets `private, no-cache` (all servers and adapters).
  `nowaki start` already kept such responses out of its ISR cache (#150).
- `nowaki dev` now percent-decodes the request path before looking up an app
  file, so islands and files with spaces or non-ASCII names load (they were
  404). Malformed escapes and `..` / `.` segments are refused (#150).
- `nowaki dev` 404'd the client runtime (`/node_modules/@nowaki-dev/runtime/client/*.js`)
  when `@nowaki-dev/runtime` was a symlink out of the app (pnpm workspace,
  `npm link`), so no island hydrated. Files inside that package's own real
  directory are now served; other symlinks and its nested `node_modules` are
  still refused (#150).
- Dev SSR now picks up edits to the app's plain `.js` / `.mjs` modules (such as
  `lib/msg.js`); they were served stale until a restart. Files in
  `node_modules` and outside the app root still load once (#150).
- `?image` applies the EXIF orientation: a portrait phone photo (stored
  landscape with Orientation 6) is emitted upright, with width and height
  swapped to match, in build, dev, and the header-only size read. Image asset
  queries (`?w=`, `?format=`) apply it too. (#150)
- Google CJK fonts no longer preload every `unicode-range` slice on every page
  (121 preloads / 3.1 MB for Noto Sans JP). The numbered slices, which carry
  no subset name, are preloaded only when one covers basic Latin; the
  `@font-face` rules stay, so the browser fetches the slices a page uses.
  (#150)
- MDX footnote ids keep each label distinct: they are built like a Markdown
  entry's (lowercased, non-URL-safe bytes percent-encoded) instead of turning
  every non-ASCII character into `-`, so `[^é]` and `[^ü]` no longer share
  `fn--`. (#150)
- A content entry's `headings` ids match the HTML anchors for multi-line
  headings (a setext heading over two lines, or one with a hard break): the
  text is taken the way comrak anchorizes it, with a break as a space. MDX
  `headings` ids now agree with Markdown's for such headings too. (#150)
- `nowaki prerender --out dist` (or any `--out` that is, contains, or is
  inside `dist/client`, `dist/server`, or `dist/public`) is refused before
  building, instead of deleting the build it renders from. Paths like `dist/`
  and `./dist` are normalized first. (#150)
- Prerender keeps reading the temporary server's stdout for the whole run, and
  passes the app's logs through. It used to stop at READY, so on Linux (where
  Node writes to pipes synchronously) an app that logged more than ~64 KiB
  hung every pending render. (#150)
- Client router: back/forward restores the scroll position of the page you
  return to. It used to restore the position of the page you left.
- Client router: a same-page `#hash` link, and back/forward between such
  entries, no longer re-fetches and re-renders the page (which reset island
  state). It scrolls to the fragment, or to the position saved for that entry.
- Client router: a link to `/page#fragment` lands on the element with that id
  (or `name`) instead of the top of the page. A fragment with no such element
  still lands at the top.
- Client router: a link to a same-origin URL that answers with something other
  than an HTML page (JSON, CSV, `content-disposition: attachment`) or redirects
  to another origin is handed to the browser as a full navigation. Before, the
  response text was swapped in as the page body, or a cross-origin redirect
  showed the error page.

## [0.17.0] — 2026-11-06 · "Mistral": content sites

Packages: `nowaki` / `nowaki-core` 0.17.0 (crates.io, npm), `@nowaki-dev/runtime`
0.16.0, `create-nowaki` / `create-nowaki-app` 0.18.0. New apps start on Preact 11.

Content sites: typed content collections in Markdown and MDX, build-time code
highlighting, responsive images (AVIF), SEO metadata with a generated sitemap,
self-hosted fonts, `public/`, file routes, page scripts, and `<html>` attributes.
A static Astro site moves over with the migration guide.

### Added
- **Content collections** (v0.17). Each directory under `content/` is a
  collection, declared in `content/config.ts` with
  `defineCollection({ schema })`. Any Standard Schema library works.
  - Entries are Markdown files with YAML frontmatter, or `.json` / `.yaml`
    data files (`type: "data"`).
  - Loaders and `staticPaths` read them with `getCollection(name, filter?)`
    and `getEntry(name, slug)` from `@nowaki-dev/runtime/content`.
  - **Markdown is rendered at build time, in Rust** (comrak): GFM tables,
    task lists, strikethrough, footnotes, autolinks. Every heading gets an
    anchor id, and `headings` lists them for a table of contents.
  - Frontmatter is checked against the schema when the app is built and
    when the server starts. An invalid entry fails the build, listing each
    problem as `content/blog/x.md: title: …`. In `nowaki dev`, a change
    under `content/` re-renders on the next request, and errors show in the
    error overlay instead of stopping the server.
  - Typegen adds the collections to `.nowaki/types.d.ts`, so entries are
    typed by their schema's output.
  - Works on `nowaki start`, the node / bun / deno / vercel adapters,
    `nowaki prerender` (`staticPaths` can call `getCollection`), and
    Cloudflare, where the content is inlined into the worker.
  - `examples/hello` has a `docs` collection with `/docs` and
    `/docs/[slug]`.

  Images in Markdown, MDX, and TOML frontmatter come later in v0.17.
- **Code highlighting in Markdown, at build time.** Fenced code blocks with
  a language (` ```tsx `) are highlighted in Rust with syntect when the
  content is built. The colors are inline styles, so no client JS or theme
  CSS is needed, and an enforced CSP allows them.
  - Syntaxes come from two-face (bat's set), which adds TypeScript / TSX,
    Vue, Svelte, TOML, and more to syntect's defaults.
  - The theme is `InspiredGitHub` (light). A theme setting is a follow-up.
  - A block without a language, or with an unknown one, stays plain
    escaped text.
  - The regexes are pure Rust (no Oniguruma C library). The `nowaki`
    binary grows by about 4.8 MB with the syntax and theme data.
- **`public/`** (v0.17). Files in `public/` are served as-is at their own
  path: `public/robots.txt` → `/robots.txt`, `public/fonts/a.woff2` →
  `/fonts/a.woff2`. There is no transform: a `.css` or `.ts` there is sent as
  that file.
  - `nowaki dev` reads `public/` directly, so new files work without a
    restart. `nowaki build` copies it to `dist/public/`.
  - Served by `nowaki start` and the node / bun / deno adapters, with
    `cache-control: public, no-cache` and an ETag (304 when unchanged), since
    the names aren't hashed.
  - The Vercel and Cloudflare adapters and the static output serve them as
    static files. On Cloudflare the Assets directory is now
    `dist/worker/assets`, with `dist/client` under `_nowaki/`. A `public/_headers`
    is placed ahead of the generated rules in the static output's `_headers`.
  - A public file wins over a route at the same path. Dotfiles and
    dot-directories are left out, except `.well-known/`. A file under
    `public/_nowaki/` or `public/__nowaki/` is a build error.
- **Attributes on `<html>` and `<body>`** (v0.17). A route or layout can
  `export const htmlAttrs` / `bodyAttrs`, and `meta()` can return them too:
  `export const htmlAttrs = { "data-theme": "paper" }`.
  - Layouts apply first (root to leaf), then the route, then `meta()`. A later
    value wins, `false` / `null` removes one set earlier, and `class` values
    are joined. `true` renders a bare attribute.
  - Values are escaped. Event-handler attributes (`on*`) are ignored.
  - `export const lang` still sets `lang`, and `htmlAttrs.lang` is used when
    there is none.
  - The SPA router swaps these attributes on client navigation. It changes
    only the ones the server set (listed in `data-nowaki-attrs`), so
    attributes that client code added stay.
- **File routes** (v0.17). A route whose last segment has an extension returns
  a file instead of a page: `routes/feed.xml.ts` → `/feed.xml`, and
  `routes/og/[card].png.ts` → `/og/intro.png` (a param followed by a fixed
  extension).
  - Like an API route, it exports `GET` (or a default handler). A returned
    string or `Uint8Array` is the body, with the Content-Type of the extension.
    A `Response` is sent as it is, and objects are JSON.
  - `nowaki build --adapter static` writes file routes to their own path,
    binary included. Static ones are always written. Dynamic ones are written
    from `export const staticPaths`. `export const prerender = false` skips
    one.
  - File routes get no typegen entry, page budget, or route CSS. The SPA
    router leaves links that end in a file name (`/feed.xml`, `/robots.txt`)
    to the browser.
  - A page file's name can't end in a dot followed by letters or digits
    (`v1.2.tsx`); name such a page `v1.2/index.tsx` instead.
- **Page scripts** (v0.17). A route or layout can ship plain browser modules
  with no island, like Astro's `<script>`:
  `export const scripts = ["../scripts/hero.ts"]`.
  - Each listed module is bundled like an island, npm imports included, and
    loaded as `<script type="module">`, with preloads for its chunks. The
    module never runs on the server.
  - The list is read at build time, so it must be an array of string literals
    (relative paths or package names). An unreadable list or a missing module
    fails the build.
  - Layouts' scripts come first, and duplicates load once. Scripts count in
    the route's first-load JS and `budget`.
  - On client navigation the SPA router loads the new page's scripts and then
    dispatches `nowaki:page-load` on `document`. A module runs once, so a
    script that sets up the DOM should also listen for that event.
- **`<Image>` and `?image` imports** (v0.17).
  `import hero from "./hero.jpg?image"` gives the image's size and generated
  variants. `<Image src={hero} alt="…" />` from `@nowaki-dev/runtime/image`
  renders a `<picture>` with them.
  - Variants: AVIF, then the original format (JPEG / PNG / WebP) as the
    fallback. Widths are 640, 960, 1280, and 1920 below the original, plus the
    original (at most 2560); nothing is upscaled.
    `?w=400,800&image` picks the widths, and `q=` the AVIF quality (default
    60).
  - `width` / `height` come from the file, so there is no layout shift.
    `loading="lazy"` and `decoding="async"` are the defaults, and `sizes`
    defaults to the rendered width.
  - AVIF is encoded in pure Rust (ravif / rav1e without asm), so the release
    builds stay free of C codecs. Lossy WebP isn't offered, since it would
    need libwebp.
  - Every variant is cached in `node_modules/.cache/nowaki/images`, so a
    rebuild or a dev reload doesn't encode again. In dev, variants are encoded
    on first request at `/__nowaki/image`.
  - The image codecs are optimized in debug builds too
    (`[profile.dev.package]`), since unoptimized AVIF takes tens of seconds
    per image.
- **Local images in Markdown** (v0.17). `![alt](./hero.jpg "title")` in a
  content entry becomes the same `<picture>`, resolved relative to the entry.
  A missing file fails the build. Root-relative (`/logo.svg`, from `public/`)
  and remote URLs stay as written.
- **SEO and metadata** (v0.17).
  - `site` in nowaki.config (or `NOWAKI_SITE`, which wins) is the site's URL.
    The build writes it to `dist/server/site.json`, so the adapters and the
    edge have it too. Loaders, `meta()`, and file routes read it as
    `ctx.site`.
  - A typed `meta` writes the head tags: `description`, `canonical` (`true`
    for this page), `robots`, `openGraph`, `twitter`, and `jsonLd`. Use
    `export const meta = {...}`, or a `meta()` function of the loader data.
    - Relative URLs resolve against the site, and Open Graph / Twitter fall
      back to the page's title and description.
    - JSON-LD can't close its `<script>`.
    - A layout's `meta` object sets defaults for the pages under it;
      `openGraph` and `twitter` merge one level deep.
  - With a site, `sitemap.xml` (every page, including dynamic ones from
    `staticPaths`) and `robots.txt` are generated, unless a route or a
    `public/` file provides them. The static output writes both.
    - `export const sitemap = false` leaves a page out, and so does a static
      `meta.robots` of noindex.
- **MDX** (v0.17). `.mdx` files are pages (`routes/guide.mdx`) and content
  entries (`content/docs/x.mdx`): Markdown with JSX, `{expressions}`, and
  `import` / `export`.
  - They are parsed in Rust (markdown-rs: CommonMark, GFM, MDX) and compiled
    to TSX before the usual transform. Imported components and islands work as
    in TSX, in dev, the builds, and every adapter. No JavaScript runs to
    compile them.
  - Fenced code is highlighted like Markdown, local images go through
    `?image` / `<Image>`, and heading ids match Markdown's. Each module exports
    `headings`.
  - A content entry's frontmatter is validated like a Markdown entry's.
    `entry.render()` returns `{ Content, headings }`; render `<Content />`
    where a Markdown entry uses `html`.
  - YAML frontmatter in an `.mdx` page is ignored; pages use `export const`
    (`title`, `meta`, …).
- **Self-hosted fonts** (v0.17). `fonts` in nowaki.config, for example
  `{ family: "Inter", provider: "google", weights: [400, 700], subsets: ["latin"] }`
  or `{ family: "Brand", src: "./fonts/brand.ttf" }`, is built at build time.
  - Google fonts are downloaded once and served from the site, so pages never
    request a third-party host. There is one woff2 per subset with its
    `unicode-range`, so a page loads only the subsets it uses. Downloads are
    cached, so later builds work offline. Local fonts are copied as they are.
  - Each face gets a hashed file and an `@font-face` (`font-display: swap` by
    default).
  - Each family gets a fallback face (local Arial / Times New Roman / Courier
    New, chosen by `fallback`). Its `size-adjust` and ascent / descent /
    line-gap overrides are computed from the font's own metrics, so text
    doesn't shift when the font arrives.
  - `--font-<family>` (or `variable`) holds the stack, as in
    `font-family: var(--font-inter)`.
  - Every page gets the stylesheet and `<link rel="preload">` for the latin,
    upright faces. `preload: false` turns the preloads off for a family.
  - In dev, fonts build in the background at startup and are served at
    `/__nowaki/fonts/`.
- **A migration guide from Astro**
  ([docs/migrate-from-astro.md](docs/migrate-from-astro.md)). It was written
  from porting a real portfolio site, whose static output matched the Astro
  build. The port turned up the fixes listed under Fixed.

### Fixed
- These came up while porting an Astro site.
  - The server build compiles every app module that routes, islands, and
    actions import, wherever it lives (`data/`, `sections/`, …). Before, only
    the conventional folders were compiled. A page importing `../data/x.ts`
    built, then failed at prerender with `ERR_MODULE_NOT_FOUND`.
  - CSS `@import` is inlined (relative paths and packages, with
    `@media` / `@layer` / `@supports` conditions). Before, it was emitted as
    written and resolved against the served stylesheet's URL. Remote and
    root-relative imports stay as imports.
  - A layout's `export const head` goes into every page under it. Before, only
    the route's was used.
  - Fonts:
    - A weight range (`weight: "100 900"`, for variable fonts) gave a file name
      with a space and an unquoted `url()` the browser dropped. Font URLs are
      now quoted.
    - A family whose metrics can't be read (woff / woff2) no longer names a
      fallback face that doesn't exist.
  - `nowaki dev` adds the islands runtime, and with it the SPA router, only to
    pages with islands, as production does. Before, links on island-free pages
    were client-side navigations in dev and full loads in production.
  - Prerendering fails the build when a page returns a server error. Before,
    it printed "skipped" and left the page out of the static output.
- Production errors behind a custom `_500` page are logged. Before, an app
  with `routes/_500.tsx` rendered its error page and logged nothing, because
  only the built-in error page logged.
- The CI performance gate built head's Rust into base's target dir. Both had
  the same crate versions, so Cargo reused base's binary, and Rust changes were
  never measured (runtime changes were). Each side now has its own target dir,
  and the job fails if the two binaries match while `crates/` changed.
- Typed meta: `openGraph.image.type` (`og:image:type`, defaulting from the
  image's extension) and `twitter:image:alt` (defaulting to the Open Graph
  image's `alt`).
- **Security:** a shared Jetstream refresh render (one render per `publish`,
  #114) was handed to every connection with the same island and state, without
  checking that connection's own signature. A client that knew a room id could
  join with a forged signature, receive every patch of the room, and get a
  valid signature back to send events with. An expired signature was refreshed
  the same way instead of answering `stale`. A connection now gets the shared
  render only when its signature is the one the renderer had, or when the
  sidecar verifies it (a signature check, no render); otherwise it gets
  `render failed` or `stale`. Legitimate refreshes still render once per
  publish.
- Live island state is now signed as JSON carries it. A state with an
  undefined-valued property (`{ ...state, error: undefined }`, or an optional
  field left undefined) or a `Date` was signed differently from the JSON the
  client and the Rust session send back, so the next event failed with a
  signature error (403 on `POST /__nowaki/live-event`) and the island stopped
  working.
- One request could fill the `nowaki start` ISR cache entry that anonymous
  visitors get. The cache key read only the first value of each header the
  page varies on, and read a value with non-ASCII bytes as empty. The renderer
  sees every value, though. So `Cookie:` followed by `Cookie: user=attacker`,
  or `Cookie: user=` with a `\xff` byte in it, was rendered for that user and
  stored under the no-cookie key. Requests where a varied header repeats or
  has bytes outside visible ASCII now skip the cache (no lookup, no store). An
  empty header and a missing one now get separate keys.
- CSS Modules no longer corrupt non-ASCII text. The class scoper copied the
  file one byte at a time as Latin-1 characters, so Japanese font names,
  `content: "→"`, emoji and comments in a `*.module.css` came out as mojibake
  in dev, `nowaki start`, adapters and static output. Text outside class
  selectors is now copied through unchanged.
- Production island chunks no longer read undefined names when an island
  imports a binding that a module forwards with `export { x }` /
  `export { x as y }` (a barrel file), or one exported through destructuring
  (`export const { a, b } = obj`). Scope hoisting now follows the forwarded
  import to its binding and records every name a destructuring pattern binds.
  When an import still can't be resolved, the island is emitted unbundled
  instead of hoisted. Before, the build passed and hydration threw a
  ReferenceError.
- `nowaki build` now writes every app module the server can load to
  `dist/server`, including ones reached only through a `"use server"` module,
  `export … from`, or a string-literal `import()`. Such modules (an action's
  `../utils/` import, for example) were missing, so `nowaki start` returned 500
  with `ERR_MODULE_NOT_FOUND` where dev worked. String-literal `import()`
  specifiers in server output are also rewritten to `.js`, like static imports.
- **Security (dev):** `nowaki dev` refuses requests whose `Host` is not
  `localhost`, `127.0.0.1` or `[::1]` (403), unless it was started with
  `--host`. A page on another domain could rebind its name to 127.0.0.1 and
  read dev responses: server-only source with its source map, `/@fs/` files,
  and files such as `.npmrc`. The MCP endpoint and the WebSocket upgrades
  already checked this; app files and the other `/__nowaki/*` routes did not.
- A `console.log` in a plugin hook no longer kills the plugin host. Rust
  stopped reading the host's stdout after the handshake, so the host's next
  stdout write failed with EPIPE and it exited. Every transform after that was
  skipped without an error, and dev served untransformed source with a 200.
  The host now sends plugin console output to stderr, Rust keeps reading its
  stdout, and a failed hook (the host is down, a plugin threw, `.tsrx` has
  compile errors) is reported as an error in dev and fails the build.
- **`_middleware`, `_layout` and `error.tsx` inside a `[param]` directory now
  apply.** Their prefix kept the directory name (`/org/[org]`) and was compared
  as a plain string with the request path, so `routes/org/[org]/_middleware.ts`
  never ran (an auth guard there was skipped) and the layout never wrapped the
  pages. A prefix is now matched segment by segment: a `[param]` directory
  matches any one path segment, `[...rest]` the rest, and a literal directory
  the percent-decoded segment (so `/%61dmin/x` no longer skips
  `routes/admin/_middleware.ts`). Middleware still goes by the URL, for every
  request under its directory: pages, API routes and 404s, whichever route
  serves them. Layouts and `error.tsx` go by where the route file is, like the
  build's layout CSS: `routes/org/[org]/_layout.tsx` wraps the files inside
  `routes/org/[org]/`, not the sibling `routes/org/[org].tsx`. The same holds
  for literal names: `routes/admin.tsx` is no longer wrapped by
  `routes/admin/_layout.tsx`, whose CSS the build never gave it.
- **A malformed percent-escape in the path is a 404**, not a `URIError` thrown
  out of the request handler.
- **A cookie with a malformed percent-escape (`_ga=50%`) no longer makes every
  page that reads `ctx.cookies` return 500.** Each cookie is decoded on its own;
  one that fails to decode keeps its raw value.
- Jetstream islands now work on a page reached by client (SPA) navigation.
  The router swapped in the new `<body>`, but scripts parsed that way never run,
  so live.js didn't load when the previous page had no live islands. When it
  had, the open socket never joined the new page's islands, so their buttons
  did nothing. The router still runs none of the fetched body's scripts (so
  nothing else in the page's HTML runs or picks up the CSP nonce). It loads
  live.js (`id="nowaki-live"`, same origin only) if it isn't running yet, and
  otherwise calls `window.__nowakiLive.sync()`. The new page's islands replace
  the old ones on the socket (`join` with `replace: true`, in live.rs and the
  JS hub): the old ones' rooms and topics go, their queued events and
  refreshes are dropped, and a render still in flight for the old page is
  discarded, even when the new page reuses its nid (a Router Cache revisit).
  A page without live islands closes the socket. Patches and errors carry the
  server's count of replacing joins, and live.js drops one sent for the previous
  page (a click just before navigating could otherwise land on the new page).
- Node children no longer outlive a killed `nowaki`. That covers the dev and
  production sidecars, the prerender server, and the plugin host. When
  `nowaki` was stopped with SIGKILL (or crashed), it couldn't stop them, and
  they lingered with PID 1 as their parent. Fifty-one such sidecars had piled
  up over four days on one machine. Each child now gets a stdin pipe and exits
  when it closes, which happens however the parent ends. Run on their own (an
  adapter's `node index.mjs`), the scripts behave as before.
- These came up while porting an Astro site.
  - The server build compiles every app module that routes, islands, and
    actions import, wherever it lives (`data/`, `sections/`, …). Before, only
    the conventional folders were compiled. A page importing `../data/x.ts`
    built, then failed at prerender with `ERR_MODULE_NOT_FOUND`.
  - CSS `@import` is inlined (relative paths and packages, with
    `@media` / `@layer` / `@supports` conditions). Before, it was emitted as
    written and resolved against the served stylesheet's URL. Remote and
    root-relative imports stay as imports.
  - A layout's `export const head` goes into every page under it. Before, only
    the route's was used.
  - Fonts:
    - A weight range (`weight: "100 900"`, for variable fonts) gave a file name
      with a space and an unquoted `url()` the browser dropped. Font URLs are
      now quoted.
    - A family whose metrics can't be read (woff / woff2) no longer names a
      fallback face that doesn't exist.
  - `nowaki dev` adds the islands runtime, and with it the SPA router, only to
    pages with islands, as production does. Before, links on island-free pages
    were client-side navigations in dev and full loads in production.
  - Prerendering fails the build when a page returns a server error. Before,
    it printed "skipped" and left the page out of the static output.
- Typed meta: `openGraph.image.type` (`og:image:type`, defaulting from the
  image's extension) and `twitter:image:alt` (defaulting to the Open Graph
  image's `alt`).

### Changed
- **A module cache hit no longer asks the plugin host.**
  - The module cache used to be keyed by the source after the plugins ran,
    so every load, hits included, first made a round trip to the Node
    plugin host (and compiled MDX).
  - It's now keyed by the file's own text plus a hash of nowaki.config, so a
    hit returns before any plugin runs. The plugins' output is also kept per
    version of a file, so the graph, chunking, and budgets reading a module
    again don't run them again.
  - On the example app (two plugins, `.tsrx`) a warm build went from about
    0.35 s to 0.25 s, and dev's first render of a page got faster too.
  - This assumes plugins depend on the file and nowaki.config. A plugin
    reading other files or the environment should be reflected in one of
    them, or its cached output can go stale.
- **Content builds no longer decode every referenced image.**
  - A Markdown image's size is read from the file's header, and the pixels
    are decoded only when a variant isn't cached yet.
  - Each file's image set is built once per build, however many entries
    reference it. The images are built after the entries are read, all
    unique files in parallel. Building them inside the parallel read could
    deadlock a cold build: a worker waiting on a photo it was itself building
    picked up another entry that needed the same photo.
  - Entries are read and rendered in parallel.
  - On a 500-entry docs site (four photos, 1,500 code fences), a build with
    the caches warm went from 2.3 s to 0.25 s. Before, about 86% of it was
    decoding the same four JPEGs 500 times.
- AVIF for `<Image>` / `?image` encodes at rav1e speed 9 (was 7). On photos this
  is about 30% faster for the same or a slightly smaller file, which matters
  for a cold build (variants are cached after it).
- Static output: canonical URLs, the default `og:url`, and `sitemap.xml` give
  page URLs a trailing slash (`/docs/a/`), matching the files the static
  output writes (`docs/a/index.html`). A static host would otherwise redirect
  each one. Servers (`nowaki start`, the adapters) keep the route's own path.
- **Highlighted code is cached on disk** (`node_modules/.cache/nowaki/highlight`)
  for Markdown entries and MDX alike. Syntect's grammars (TypeScript alone takes
  about 150 ms to compile) load only on a cache miss, so a rebuild or a dev
  reload of a docs site doesn't pay for them again. On the example app a
  rebuild goes from about 0.5 s to 0.34 s.
- **Less client JS on every page with an island.**
  - **No `preact/jsx-runtime` chunk.** Client builds resolve it to a
    227-byte wrapper around Preact's `createElement` (in
    `@nowaki-dev/runtime/client/jsx-runtime.js`), which ships anyway. In
    the browser it behaves the same: `key` leaves props, function
    components keep `ref`, and children stay in `props.children`. This
    saves about 0.7 KB gzip per page.
  - **The SPA router loads on intent.** It used to load at idle on every
    page. Now it starts loading when a same-origin link is hovered,
    focused, or touched. A click that comes before it (keyboard, script) is
    replayed as a client navigation once the router arrives. Visitors who
    don't navigate never download its 2.4 KB.
  - `examples/hello` `/`: 9.76 → 9.08 KB first load. `/tsrx`: 8.74 →
    8.06 KB.
  - The size gate's app: 8.63 → 8.22 KB eager, plus a 2.77 KB router that
    no longer loads by default. Its baseline is updated.
- **CI gates performance, not just client JS size.** A new "Performance
  (regression gate)" job runs on pull requests that touch `crates/`, the
  runtime, or `Cargo.lock`. It builds the PR and its base branch in the same
  job, then measures `examples/hello` alternately, 3 rounds each: `nowaki
  build` time, `nowaki dev` startup, and `nowaki start` throughput and TTFB
  on `/about` (oha). The PR fails when the median gets worse than allowed:
  25% for build and dev, 15% for req/s, 25% for TTFB, with a small
  absolute allowance. An A/A run of the same build on one machine stayed
  within 5%. `node benchmarks/ci-perf.mjs --base <dir> --head <dir>` runs it
  locally.

## [0.16.3] — 2026-11-06 · security patch

Packages: `nowaki` / `nowaki-core` 0.16.3 (crates.io, npm), `@nowaki-dev/runtime`
0.15.3, `create-nowaki` / `create-nowaki-app` 0.17.3. Update both `nowaki` and
`@nowaki-dev/runtime`: the fixes are split between the binary and the runtime.

These come from a bug hunt on the v0.17 branch; each finding was confirmed by an
independent check before it was fixed.

### Security
- **A forged Jetstream signature could receive a shared room refresh.** When a
  publish refreshed several connections showing the same island and state, only
  the first connection's signature was checked. Another connection with a forged
  signature got the room's HTML and a valid signature, and could then send
  events. An expired signature was refreshed instead of answering `stale`. Now
  every connection's signature is checked (a verify-only call, no extra render)
  before it shares the result.
- **The `nowaki start` ISR cache could store a personal page under the
  anonymous key.** The key used only the first value of a varied header, and
  mapped non-ASCII values to empty. A request with `Cookie:` and a second
  `Cookie: user=…` header was cached as anonymous and served to everyone. Now
  the key uses every value, and a request whose varied header repeats or isn't
  visible ASCII skips the cache.
- **`_middleware` in a dynamic directory never ran.** `routes/[org]/_middleware.ts`
  (and `_layout`, `loading`, `error` there) didn't apply, so an auth check in
  it was bypassed. Middleware now matches the request URL against its
  directory, with `[param]` matching any segment and literal segments compared
  decoded (`/%61dmin` is still under `routes/admin/`). Layouts and boundaries
  apply to route files inside their directory.
  - Behavior change: a page file next to a same-named directory
    (`routes/admin.tsx` beside `routes/admin/_layout.tsx`) is no longer wrapped
    by that directory's layout, matching the CSS the build already gave it.
    Middleware still covers its URL.

### Fixed
- A state with an `undefined`-valued key or a `Date` no longer fails the
  Jetstream signature check on the next event.
- A malformed percent-escape in the path gives 404, and one in a cookie keeps
  that cookie's raw value, instead of a 500 on every page reading `ctx.cookies`.

## [0.16.2] — 2026-11-05 · security patch

Packages: `nowaki` / `nowaki-core` 0.16.2 (crates.io, npm), `@nowaki-dev/runtime`
0.15.2, `create-nowaki` / `create-nowaki-app` 0.17.2. The fix is in the runtime:
update `@nowaki-dev/runtime` to 0.15.2.

### Security
- **ISR pages that depend on the request could be shared by a CDN.**
  - An ISR page (`export const revalidate`) was always sent with
    `cache-control: public, s-maxage=…, stale-while-revalidate`. What its
    render read from the request (cookies, `accept-language`, …) went only
    into the internal `x-nowaki-vary` header. The `nowaki start` cache uses
    that header, but `start` strips it, and the adapters never turn it into
    HTTP `Vary`.
  - So a CDN in front of `nowaki start`, or the edge cache of an adapter's
    host (for example Vercel's), could store one visitor's page (a page that
    read `ctx.cookies`) and serve it to others. This also happened when the
    render read every header or the request body, which `nowaki start`
    already refused to cache.
  - Now:
    - A render that read `cookie`, `authorization`, the whole header set, or
      the body gets `cache-control: private, no-cache`. That means never
      shared. `Vary: Cookie` alone isn't enough, because some CDNs ignore
      it.
    - A render that read other headers stays `public, s-maxage=…` and sends
      `Vary` naming them.
    - The query string needs nothing, because every cache keys by the URL.
    - `streaming = true` pages get the same treatment: their loaders run
      before the headers are sent.
    - `streaming = "early"` pages send their headers before any loader runs,
      so they are never marked shareable.
  - `nowaki start` still caches cookie variants apart internally, as before.

## [0.16.1] — 2026-11-05 · patch

Packages: `nowaki` / `nowaki-core` 0.16.1 (crates.io, npm), `@nowaki-dev/runtime`
0.15.1, `create-nowaki` / `create-nowaki-app` 0.17.1. New apps get
`@nowaki-dev/runtime@^0.15.1` and `nowaki@^0.16.1`.

CSS that routes, layouts, and their components import now reaches the page,
as linked stylesheets. A plain `.css` import's default export is its text.
`nowaki dev` no longer drops quick changes, and no longer reloads on its own
cache writes on Windows.

### Fixed
- **CSS imported by routes and layouts now reaches the page.** Only islands
  ship JS to the browser, so `import "../styles/site.css"` in a route,
  layout, or component they use used to go nowhere: the server build
  replaced it with an empty module.
  - The build now follows each page route's imports (the route, every
    `_layout` above it, and the components they use), and writes each CSS
    file once to `dist/client` as `<name>.<hash>.css`. CSS Modules are
    scoped the same way as their class names, and CSS from packages is
    included too.
  - The page's `<head>` gets a `<link rel="stylesheet">` for each file,
    layouts first, before the route's own `head`. That covers
    `nowaki start`, every adapter, `nowaki prerender`, and streaming
    shells.
  - The SPA router swaps the links on client navigation.
  - `nowaki dev` links them from the dev server (`/__nowaki/css`, which
    serves only `.css` files under the app) and reloads on change.
  - The manifest gets a `routeCss` field.
- **A plain `.css` import's default export is its text**, as
  `nowaki-env.d.ts` declares. Before this change it was an empty module,
  so `import css from "./a.css"` failed with "does not provide an export
  named 'default'". This works on the server and on the client, so
  `` export const head = `<style>${css}</style>` `` works.
- **`nowaki dev` no longer drops quick changes, and stops reloading on its
  own cache writes on Windows.**
  - Changes are batched until 100 ms pass without one, then applied in one
    reload. A change inside the old 100 ms window used to be ignored.
  - Watched paths are compared by component. Before this change, the
    `/node_modules/` checks never matched Windows `\` paths, so every
    cache write reloaded the server modules and reset their state.
- **`nowaki prerender` names the `staticPaths` error** (`staticPaths
  failed: TypeError: …`). Before this change, it said only "see the error
  above".
- CSS strings embedded in JS (CSS shims, CSS Modules, CSS text) are now
  escaped as JavaScript, so control characters can't produce invalid
  modules.

### Upgrade notes
- Pages whose routes, layouts, or components import CSS now link it. If an
  app worked around the old behavior by importing the same CSS in an
  island, or by inlining it, it may now load the CSS twice. That is
  harmless, but the workaround can be removed.

## [0.16.0] — 2026-11-05 · "Chinook"

Packages: `nowaki` / `nowaki-core` 0.16.0 (crates.io, npm), `@nowaki-dev/runtime`
0.15.0, `create-nowaki` / `create-nowaki-app` 0.17.0. New apps get
`@nowaki-dev/runtime@^0.15.0` and `nowaki@^0.16.0`.

"Show it with numbers":
- **Speed.** `nowaki start` renders about 4x faster than 0.15. In a local
  run of the comparison app it outpaced Astro on post pages (1.5x req/s)
  and on `/` (2.2x req/s), and its TTFB was lower.
- **Fewer round trips.** ISR pages are cached from the first request,
  responses are pre-compressed with 304s, and streamed responses are no
  longer buffered.
- **Budgets.** Every build reports the first-load JS of each route and
  fails when a route goes over its budget.
- **Tooling.** `nowaki dev` serves an MCP endpoint for coding agents.

It also finishes v0.15: stale notifications, rooms that survive a restart,
and a 1000-connection fan-out benchmark, with publish refreshes now rendered
once.

### Upgrade notes
- `nowaki start` renders every ISR page once right after startup, so route
  middleware and loaders run at boot. `NOWAKI_ISR_WARM=0` turns this off.
- `nowaki start` stops its Node process with SIGTERM and a 3 s grace period,
  where it used to kill it outright. It writes rooms to
  `.nowaki/live-rooms.json`; set `NOWAKI_LIVE_ROOMS_FILE=off` to keep them
  in memory only.
- `nowaki build` writes `.br` / `.gz` siblings into `dist/client`, so a
  static host that uploads the whole directory uploads those too.
- A route with `export const budget` fails the build when it goes over.
  Routes without one only get the report.
- Live islands are now recognized by an exported binding named `live` in
  the AST. An island that only *mentions* `export const live` in a comment
  becomes a client island again.

### Added
- **`export const streaming = "early"`** (#112) sends the document shell
  before any loader runs, so the first byte doesn't wait for data. On
  `examples/hello` `/stream-early`, with a 300 ms loader, the shell arrives
  in about 3 ms. Once the shell is sent, the status and headers are fixed:
  - `meta` sees only the static `title` / `head`.
  - A loader redirect becomes a client-side `location.replace`.
  - A loader error renders the nearest `error.tsx` in the page, with the
    status still 200. The error message appears only in dev.
  - Cookies set by a loader are not sent.

  `streaming = true` is unchanged: loaders run first, then the shell is
  sent and the body streams.
  The route JS report counts the islands runtime for any streaming route.
  The shell always loads it, even on a page with no islands (5.96 KB on
  `/stream-early`).
- **Build hints for islands that could ship no JS.** `nowaki build` reads
  each client island's AST and points out two kinds:
  - Islands that only keep state (`useState` / `useReducer`) and handle
    click or form events (`onClick`, `onSubmit`, `onInput`, `onChange`).
    Rewritten as live islands, they ship no JS, and pages where they are the
    only client island lose the islands runtime too. The catch is a server
    round trip per event.
  - Islands with no state and no event handlers, which would render the same
    as plain components.

  No hint is given when an island uses other hooks, other events, `ref`,
  browser globals, or imports anything but preact / React / CSS.
  `NOWAKI_HINTS=0` hides the hints. In `examples/hello`: Counter,
  ReactCounter, and TsrxCounter could be live, and Badge needs no island.
- **First-load JS per route, and budgets that fail the build.** Every
  `nowaki build` and `nowaki prerender` now prints the gzip size of the JS
  each page route loads first, and writes the same data to
  `dist/route-js.json`.
  - Counted: the islands runtime and its preloads, every client island the
    page can render (found through the import graph from the route and each
    `_layout` above it, components included), and the live runtime for live
    islands. The lazy SPA router chunk is not counted.
  - A route sets `export const budget = { js: <KB> }`, and the build fails
    when the route goes over it. `{ js: 0 }` means the page ships no client
    JS.
  - The value is read from the AST. It must be a number literal, and an
    unreadable `budget` fails the build instead of being ignored.
  - `examples/hello` sets `{ js: 12 }` on `/` (9.76 KB today) and
    `{ js: 0 }` on `/about`.
  - `scripts/route-js-e2e.mjs` checks the report against the pages
    `nowaki start` serves. Each served chunk must be one the report counted;
    18 of 19 static routes match exactly. The other one is `/stream`, whose
    islands load later.
- **`nowaki dev` MCP endpoint:** while `nowaki dev` runs, a coding agent can
  inspect the app over MCP (Streamable HTTP) at
  `http://127.0.0.1:<port>/__nowaki/mcp`. The startup banner prints the URL and
  the command that adds it to Claude Code:
  `claude mcp add --transport http nowaki http://127.0.0.1:<port>/__nowaki/mcp`.
  The tools are read-only. `routes` lists the route table in match order, with
  kind, file, exports, ISR `revalidate`, and `csrf`. It also lists layouts,
  middleware, and boundaries. `module_graph` shows a file's imports and
  importers, and the islands with their `live` flag. `recent_errors` returns
  the last 50 build (transform), SSR, live, and HMR errors with timestamps,
  file, and stack. `dev_config` shows the port, the `NOWAKI_*` flags, and the
  Jetstream connections and rooms. The endpoint answers only loopback clients
  with a loopback `Host` / `Origin`, also under `--host`. `nowaki start` and
  the adapters don't serve it.
- **Jetstream stale notifications:** an event on a page older than
  `NOWAKI_LIVE_MAX_AGE` (24 h by default) used to fail like a forged one.
  The server now tells the two apart. A genuine, expired signature comes back
  as `reason: "stale"` over WebSocket and as HTTP 409 over POST. The client
  dispatches a cancelable `nowaki:live-stale` event and, unless the app calls
  `preventDefault()`, reloads the page to get fresh signed state. A tampered
  or future-dated signature is still rejected as before (`403`).
- **Jetstream rooms survive a restart:** `nowaki start` writes the rooms'
  shared state to `.nowaki/live-rooms.json` and loads it on the next start.
  It writes at most every 2 s after a change, through a temp file and a
  rename, and once more on shutdown. `nowaki start` now stops its Node
  process with SIGTERM and a 3 s grace period before killing it. Set
  `NOWAKI_LIVE_ROOMS_FILE` to choose another file (relative to the app), or
  `off` to keep rooms in memory only. A shared state that JSON can't hold
  (BigInt, a cycle) logs a warning and is not saved. This applies to a single
  process only: `nowaki dev` and the adapters don't save rooms.

### Changed
- **One render per publish for live queries and rooms** (#97). On a
  `publish(topic)`, every subscribed connection used to ask the renderer for
  its own refresh. Node renders one at a time, so the last of 1000
  connections waited for all the others.
  - Now the first connection renders, and connections with the same island,
    state, and topic reuse that result.
  - A render is reused only when the island has no `live.authorize` and the
    render never called `getContext()`. The runtime reports this, so
    anything that reads the request is still rendered per connection.
  - `examples/hello` has a new `LiveViewer` island, which shows the
    viewer's name. It is the per-connection case.
  - Measured locally with `benchmarks/live-fanout.mjs` at 1000 connections:
    - rooms: per-message p95 68 → 28 ms, everyone p50 69 → 24 ms;
    - live query: per-message p95 65 → 31 ms, everyone p50 62 → 25 ms.
- **Streamed responses reach the client as they are written** (#90). Before
  this change, `nowaki start` and `nowaki dev` read each response from the
  Node renderer in full before sending it on. With a
  `ReadableStream` API response, an SSE endpoint, or a streaming-SSR page,
  the client got nothing until the last byte. Non-page responses now pass
  straight through, and dev streams every response.
  - With 600 ms between two chunks, the first byte arrives in about 4 ms.
    It used to take about 400 ms.
  - Regular pages are still read whole, because Rust assembles their HTML
    from the renderer's JSON.
  - A `streaming = true` page still waits for its loader before the shell
    is sent. The example and its comments now say so.
- **The npm `nowaki` command no longer keeps a Node process running** (#91).
  On Linux and macOS, the shim now replaces itself with the Rust binary
  (`process.execve`, Node 22.15+ / 23.11+), so it no longer runs the binary
  as a child process. `npx nowaki start` used to leave a ~45 MB Node
  process running next to the server. It also forwarded signals indirectly.
  Windows and older Node versions keep the child-process fallback.
- **ISR pages are cached from the first request.** Right after startup,
  `nowaki start` renders every ISR page once in the background, so the first
  visitor gets a page from the Rust front instead of waiting for a render.
  - Covered: static routes with `export const revalidate` > 0, plus each
    `staticPaths` entry of dynamic ones. The list is capped at
    `NOWAKI_ISR_MAX`.
  - It renders two pages at a time, through the normal request path, with
    no cookies. A page that varies on a header is stored only under the
    empty value of that header, so it never serves someone else's variant.
  - The renders run route middleware and loaders like any request.
    `NOWAKI_ISR_WARM=0` turns this off.
  - `examples/hello`: 2 pages in 16 ms.
- **Compressed responses and 304s on `nowaki start`.** Before this change,
  every response went out uncompressed, and `/_nowaki/*` assets were read
  from disk on each request.
  - `nowaki build` now writes `.br` (quality 11) and `.gz` (level 9)
    siblings for client JS, CSS, JSON, and SVG files of 1 KB or more. Source
    maps are skipped. The output is reproducible.
  - `nowaki start` holds the assets in memory and picks br, gzip, or none
    from `Accept-Encoding` (q-values included).
  - ISR pages are compressed once, when they are stored.
  - Both send a weak `ETag` and `Vary: Accept-Encoding`, and answer a
    matching `If-None-Match` with `304`.
  - With `NOWAKI_CSP` on, ISR pages are left uncompressed and get no ETag,
    because each response carries a new nonce.
  - Uncached (proxied) responses are not compressed yet.

  The preact runtime chunk in `examples/hello` drops from 12.0 KB to 4.6 KB
  on the wire.
- **About 4x the throughput on `nowaki start` and the Node adapters.** In
  production, every request ran `import()` on the route's module again. The
  module was cached, but with the react-alias loader hooks registered, each
  `import()` made a synchronous round trip to the hooks thread, and that took
  half the CPU time of a page. Production modules are now imported once.
  Measured on `examples/hello`, 50 connections, Apple M2: `/about` on
  `nowaki start` went from 6,056 to 28,752 req/s, and `/api/hello` from
  8,895 to 32,101 req/s. Dev mode is unchanged: it re-imports on every edit.

### Fixed
- **Live islands are detected from the AST.** The build used to look for
  the text `export const live`. A comment containing it turned a client
  island into a live one, which then shipped no JS. `export { x as live }`
  and `export { live } from "…"` were missed and shipped a client chunk.
  Now any exported binding named `live` counts, and comments and strings
  don't.
- **Scope hoisting through a symlinked or verbatim app root** (#92).
  `NowakiCore::new` now canonicalizes the root with `dunce`. Before this
  change, a root opened through a symlink (macOS `/var` → `/private/var`)
  or given as a Windows `\\?\` path matched no resolved module. Every app
  module then became its own chunk, and the route JS report missed islands.
- **Static output no longer ships a live.js that can't work** (#93). Pages
  from `nowaki prerender` and the static adapter used to include live.js in
  POST mode. A static host has no server for its events, so every click
  logged "not applied". Live islands now keep their first HTML and ship no
  script. The build also lists the pages they are on, as a note. The node,
  bun, deno, vercel, and cloudflare adapters still ship live.js.

## [0.15.0] — 2026-11-04 · "Cyclone" (part 1)

Packages: `nowaki` / `nowaki-core` 0.15.0 (crates.io, npm), `@nowaki-dev/runtime`
0.14.0, `create-nowaki` / `create-nowaki-app` 0.16.0. New apps get
`@nowaki-dev/runtime@^0.14.0` and `nowaki@^0.15.0`.

Jetstream 2: live islands work on every deploy adapter (per event over POST),
handlers see the request, `publish()` pushes server-side changes, islands can
share a room, and forms and inputs are live. Still open in v0.15: rooms that
survive a server restart, stale-state notifications, and a fan-out benchmark.

### Upgrade notes
- The deploy adapters now ship `live.js`, so live islands that were static on
  them become interactive (over POST). Pin a page to the old behavior with
  `<meta name="nowaki-live" content="ws">`, which never falls back to POST.
- Room state and `publish()` live in one server process: they don't reach
  other instances, and rooms start empty after a restart.
- On the adapters, set `NOWAKI_LIVE_SECRET` when more than one instance (or
  Worker isolate) can serve a request, or live events fail signature checks.
  The Cloudflare `wrangler.jsonc` now enables `nodejs_compat_populate_process_env`
  so Worker vars and secrets reach `process.env`.

### Added
- **Jetstream rooms:** `live.room(props)` names a room and `live.shared()` is
  its initial state; every island in the same room shares that state, handlers
  receive and return it, and a change re-renders every member (on any
  connection in the process). `data-nowaki-presence="<room>"` shows how many
  connections are in the room. Rooms are held in the server process's memory
  (single process, lost on restart); on the deploy adapters a room island
  renders and handles events, but other members aren't pushed. See `/poll` in
  `examples/hello` for the two-tab demo.
- **Jetstream form events:** `data-live-submit="handler"` on a `<form>` sends
  its fields as an object (no navigation); `data-live-input="handler"` sends a
  field's value while typing, debounced by `data-live-debounce` (ms, default
  150); `data-live-change="handler"` fires on commit. Checkboxes and radios
  send `{ value, checked }`. Children with `data-key` are matched by key when
  a patch is applied, so reordered or filtered rows keep their elements, and a
  focused field's value is never overwritten by a patch.
- **Jetstream live queries:** `live.subscribe` (topics, or a function of the
  state) and `live.load(state, { topic })` on an island, plus `publish(topic)`
  from `@nowaki-dev/runtime`: after server code changes data (an action, a
  server function, an API route), every subscribed island reloads and gets a
  pushed patch without a client event. Under `nowaki dev` / `nowaki start` it
  reaches connections in the same process; on the deploy adapters it is a no-op
  for now.
- **Jetstream request context:** live handlers can call `getContext()` to read
  the cookies and `authorization` / `accept-language` / `user-agent` headers of
  the WebSocket upgrade, and `live.authorize({ name, handler, state, payload })`
  runs before each handler (after the signature check); anything but `true`
  refuses the event with `{ type: "error", reason: "forbidden" }`. Cookies set
  after the socket opened are seen after the next reconnect.
- **Jetstream on the deploy adapters.** Live islands are now interactive on the
  node / bun / deno / vercel / cloudflare adapters: each event is a
  `POST /__nowaki/live-event` carrying the island's signed state, and the reply
  is the new HTML, state, and signature. `nowaki dev` / `start` keep the
  WebSocket and fall back to POST for any event sent while the socket isn't
  open. `<meta name="nowaki-live" content="post">` (or `"ws"`) in a page's
  `head` pins the transport. Presence is only available over the WebSocket.
  The route has the same CSRF gate as server functions (JSON,
  `x-nowaki-live: 1`, cross-site requests rejected) and a 64 KiB body cap.

### Changed
- The scaffolded `AGENTS.md` and `README.md` gain a security checklist
  (`serverFn`, middleware running before the CSRF check, `csrf = true` for
  cookie-authenticated APIs, and the production env vars).
- **Smaller client JS:** the build mangled names but never printed them, so
  client chunks kept their full local names. They are now mangled, annotation
  comments (`/* @__PURE__ */`) are dropped (legal comments stay), and an island
  chunk imports each shared chunk in one statement. On the counter benchmark,
  first-load JS goes from 9.29 to 8.69 KB gzip and the idle-loaded router from
  4.05 to 2.77 KB.
- **Faster `nowaki prerender`:** the temporary prod server and the
  `staticPaths` evaluation (two Node processes) now start together instead of
  one after the other, and up to 8 pages are requested at once (results are
  written in the original order). On an M2, a 10-page blog prerenders in
  119 ms instead of 157 ms and a 1000-page one in 488 ms instead of 675 ms;
  the output is unchanged.

### Fixed
- **Security:** on the node / bun / deno / vercel adapters, the action and
  server-function same-origin checks compare against `Host`, not a
  client-sent `x-forwarded-host`. `x-forwarded-host` is used only behind
  `NOWAKI_TRUST_PROXY=1`, on the Rust front's own sidecar hop (loopback
  `Host`), or on Vercel, whose edge sets it.
- **Builds are reproducible:** an island that hoists several app modules (for
  example two modules in an import cycle) got a different chunk, hash and
  manifest from one build to the next, because the modules' order followed
  hash-set iteration. They are now ordered by path.
- **Security:** `nowaki dev` / `nowaki start` no longer proxy
  `/__nowaki/live-render` (404). That endpoint is the sidecar's internal
  re-render call from `live.rs`, and it trusts its body; reached through the
  public port, a cross-site `text/plain` POST could run live handlers with a
  replayed signed state, and with the new request context it could claim any
  cookie and pass `live.authorize`. The sidecars also match the path exactly.
  (The replay part also shipped in 0.14.1.)
- A Jetstream event can only call the island's own `live.on` handlers, not
  inherited object methods such as `toString`.

## [0.14.1] — 2026-11-04 · security patch

Packages: `nowaki` / `nowaki-core` 0.14.1, `@nowaki-dev/runtime` 0.13.1
(`create-nowaki` is unchanged; new apps already get these through `^` ranges).

### Fixed
- **Security:** `nowaki dev` / `nowaki start` no longer proxy
  `/__nowaki/live-render` (404). That endpoint is the sidecar's internal
  re-render call from the Rust live session, and it trusts its body. Reached
  through the public port, a cross-site `text/plain` POST could run any live
  island handler on a signed state copied from a page, with no CSRF gate. The
  sidecars also match the path exactly.

## [0.14.0] — 2026-11-04 · "Gale" (and "Zephyr" complete)

Packages: `nowaki` / `nowaki-core` 0.14.0 (crates.io, npm), `@nowaki-dev/runtime`
0.13.0, `create-nowaki` / `create-nowaki-app` 0.15.0. New apps get
`@nowaki-dev/runtime@^0.13.0` and `nowaki@^0.14.0`.

### Upgrade notes
- Cross-site non-GET requests to page actions now get **403**. Behind a proxy
  that rewrites `Host`, forward the public host as `x-forwarded-host` (and set
  `NOWAKI_TRUST_PROXY=1` for `nowaki start`). `export const csrf = false` opts
  a route out.
- In production, a server function error other than `ServerFnError` reaches
  the client as a generic `Internal Server Error`. Throw `ServerFnError` for
  messages users should see.
- Live (Jetstream) signatures from earlier versions no longer verify; pages
  left open across the deploy start from fresh state after a reload. Set
  `NOWAKI_LIVE_SECRET` in production.
- Every response now carries default security headers, including
  `cross-origin-opener-policy: same-origin`; a popup flow that needs
  `window.opener` should send its own value (or `NOWAKI_SECURITY_HEADERS=off`).

### Added
- **`npm create nowaki` templates:** `.env.example`, a Security section in scaffolded
  `AGENTS.md`, and (basics template only) `routes/_404.tsx`, `routes/api/health.ts`,
  and a validated `"use server"` example in `actions/echo.ts`.
- **Content Security Policy (opt-in):** `NOWAKI_CSP=report-only` or `enforce`
  sends a policy limiting scripts and style elements to `'self'` plus a
  per-response nonce, which Nowaki adds to every `<script>` / `<style>` in HTML
  responses (`nowaki dev` / `start` while streaming, ISR hits included, and the
  adapters). Island CSS and client navigation re-stamp the nonce on styles they
  insert. `NOWAKI_CSP_REPORT_URI` adds a `report-uri`. A CDN that caches HTML
  reuses the cached nonce.
- **`serverFn(schema, impl)`** validates a server function's first argument
  with any [Standard Schema](https://standardschema.dev) library (zod, valibot,
  arktype) before `impl` runs; invalid input is a 400 with `data.issues`.
  `nowaki build` warns about `"use server"` exports that take arguments without
  it.
- **`ServerFnError(message, { status, data })`**: thrown from a server function,
  its status, message, and `data` reach the client, where the thrown `Error`
  carries `status` and `data`.
- **Default security headers** on every response from `nowaki dev`,
  `nowaki start` (ISR hits and static assets included), all deploy adapters,
  and the `_headers` file `nowaki prerender` writes:
  `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`,
  `referrer-policy: strict-origin-when-cross-origin`,
  `cross-origin-opener-policy: same-origin`, and
  `content-security-policy: frame-ancestors 'self'` when the app sends no CSP.
  A header the response already sets is kept; `NOWAKI_SECURITY_HEADERS=off`
  turns them off.

### Fixed
- **Security:** the cloudflare adapter fills a missing `Host` from the request
  URL, so the action and server-function same-origin checks compare against the
  real host; Web `Request`s may omit it, which made same-origin form posts
  fail and let a cross-origin RPC through. The server-function check now also
  rejects an `Origin` when there is no host to compare it with.
- Jetstream: a live connection no longer stalls while the sidecar re-renders.
  The render runs off the session loop (pings, presence, and new events keep
  flowing), one at a time per connection so each island's state stays in
  order, with up to 32 events queued behind it. A render that takes longer
  than `NOWAKI_LIVE_RENDER_TIMEOUT_MS` (default 10000) or fails is reported to
  the client as `{ type: "error", nid, reason }` (`timeout`, `render failed`,
  or `busy` when the queue is full) and dispatched as a `nowaki:live-error`
  window event; the island keeps its last HTML and state. Before, a hung
  sidecar call blocked the connection with no timeout.
- **Security:** the Rust front (`nowaki dev` / `nowaki start`) no longer passes
  client-sent `x-forwarded-*`, `forwarded`, `x-real-ip`, or internal
  `x-nowaki-*` headers to the Node sidecar. It sets `x-forwarded-host` from
  `Host` itself, so a client can't choose the host the server-function
  same-origin check compares against. Behind a reverse proxy that sets these
  headers, `NOWAKI_TRUST_PROXY=1` uses its `x-forwarded-host` /
  `x-forwarded-proto` (also for the WebSocket Origin check) and keeps
  `x-forwarded-for`.
- The cloudflare adapter renders live (Jetstream) islands with their initial
  state. It ignored `liveIslands`, so a page with a live island returned 500.

### Changed
- **Security:** live (Jetstream) state signatures include their issue time
  (`v1.<iat>.<mac>`) and are rejected after `NOWAKI_LIVE_MAX_AGE` seconds
  (default 86400), so a captured state can't be replayed forever; every patch
  is re-signed, so an active island doesn't expire. Signatures from earlier
  versions no longer verify (live islands on an open page re-render from the
  server after a reload). The key is created on first use, and production
  servers warn at startup when `NOWAKI_LIVE_SECRET` is unset.
- **Security:** in production, a server function error other than
  `ServerFnError` returns a generic `Internal Server Error` (500) and is logged;
  before, its message was sent to the client. Dev still shows the message.
  Request bodies over `NOWAKI_FN_BODY_LIMIT` (default 1 MiB) get 413, and calls
  with more than 16 arguments get 400.
- **Security:** page actions reject cross-site non-GET requests with 403: an
  `Origin` from another site or `null`, or `Sec-Fetch-Site: cross-site`.
  Same-origin form posts and requests without either header (curl,
  server-to-server) are unaffected. API routes log a one-time warning for now;
  `export const csrf = true` rejects there too, and `export const csrf = false`
  opts any route out. Behind a proxy that rewrites `Host`, forward the public
  host as `x-forwarded-host`.
- Docs: clearer SECURITY.md layout (audience map, defenses ↔ AGENTS invariants) and
  contributor pointers in CONTRIBUTING.md.

## [0.13.0] — 2026-11-03 · "Zephyr" (part 1)

Packages: `nowaki` / `nowaki-core` 0.13.0 (crates.io, npm), `@nowaki-dev/runtime`
0.12.0, `create-nowaki` / `create-nowaki-app` 0.14.0. New apps get
`@nowaki-dev/runtime@^0.12.0` and `nowaki@^0.13.0`.

### Added
- **SSG for dynamic routes:** `export const staticPaths` on a `[param]` or
  `[...rest]` route lists the params to prerender (an array, or a sync/async
  function returning one; typed as `StaticPaths`). `nowaki prerender` and the
  static adapter render one page per entry. Values that would escape the output
  directory (`..`, `/`, empty) are rejected.
- `nowaki prerender` writes `404.html` from `routes/_404.tsx`, which static
  hosts (Cloudflare Pages, Netlify, GitHub Pages) serve for unknown paths.

### Changed
- `@nowaki-dev/runtime` accepts **preact 11** (`peerDependencies.preact` is now
  `^10.25.0 || ^11.1.0`) and requires `preact-render-to-string` **6.8.2 or
  later**. preact 11 with an older `preact-render-to-string` renders every page
  to an empty string, so the peer floor now rules that combination out. New
  apps from `npm create nowaki` get `preact-render-to-string@^6.8.2`.
- Nowaki is now a personal open-source project: the license holder and package
  author are Tettu0530, and the repository is `github.com/Tettu0530/nowaki`.
  Security reports go through GitHub private vulnerability reporting.

### Fixed
- `nowaki start` serves `/_nowaki/*` only for build-output file names
  (`[A-Za-z0-9._-]`). The previous check split the path on `/` only, which on
  Windows would have let `\`, drive letters, and `..` reach files outside
  `dist/client`. No released version was reachable this way, because
  `nowaki start` didn't start on Windows before this release.
- React libraries now SSR: `react` / `react-dom` imports inside node_modules
  resolve to `preact/compat` on the server (a Node resolve hook in the dev and
  production sidecars and the node adapter), instead of loading real React and
  failing every hook call. The client alias table also maps
  `react-dom/client`, `react-dom/server`, `react/compiler-runtime`, and
  `scheduler` to their `preact/compat` counterparts, and
  `process.env.NODE_ENV` is defined for client code.
- Jetstream: a reconnect no longer resets live islands to their initial state.
  Patches now carry the signed state, the client stores it on the element, and
  re-joining resumes from it.
- `nowaki build` starts from empty `dist/client` and `dist/server` (and the
  cloudflare / static adapter outputs), so islands you deleted no longer ship.
  `nowaki prerender --out <dir>` replaces only `<dir>/_nowaki` (#18).
- Statically prerendered sites (`nowaki prerender`, the static adapter) include
  `__nowaki/boundaries` (served as JSON via `_headers`), so the SPA router's
  loading/error boundaries work and no longer 404 on static hosts (#19).
- Client navigation applies the target page's `<style>` / `<link>` / `<meta>`
  and `<html lang>` / `dir`, and drops the previous page's. The server marks
  each page's own head content (`<meta name="nowaki-head">` start/end) and the
  router swaps only that region, so styles injected at runtime by CSS-in-JS
  libraries survive navigation (#21).
- Assets imported only from server code (e.g. a font URL in a server-side style
  module) are emitted to `dist/client` with a content-hashed name. They used to
  be referenced as `/_nowaki/<name>` without being written, and without a hash
  despite the immutable cache header (#17).
- **Security:** production servers (`nowaki start` and the node / bun / deno /
  vercel / cloudflare adapters) no longer send stack traces to clients. When a
  route fails and the app's `_500` page also fails (or there is none), the
  response is a plain `Internal Server Error`; the error is still logged. Before,
  the full stack, including absolute file paths, was returned.
- Windows: `nowaki dev` / `nowaki build` / `nowaki start` work (verbatim `\\?\`
  paths, SSR loader file URLs, and `/@fs/` drive-letter URLs).
- `nowaki dev` / `nowaki start` kill their Node children on SIGTERM instead of
  leaving them orphaned.
- The node/bun/deno adapter deploy hint and `start` script work from
  `dist/server`.
- Islands that use `import * as` (or other forms scope hoisting can't
  concatenate) are emitted unbundled instead of losing the import and throwing
  `ReferenceError` in the browser (#24).
- Adapter outputs (node/bun/deno/vercel/cloudflare) no longer ship `live.js`.
  They have no `/__nowaki/live` endpoint, so Jetstream islands there render
  their initial SSR only (Jetstream runs on `nowaki dev` / `nowaki start`).
  The live client also stops reconnecting after 8 consecutive failures.
- The vercel adapter targets the `nodejs22.x` runtime (was `nodejs20.x`,
  deprecated and below the `>=22` engines floor).

## [0.12.1] — 2026-06-15 · security audit

Packages: `nowaki` / `nowaki-core` 0.12.1, `@nowaki-dev/runtime` 0.11.1.

### Security
- Arbitrary file reads are closed: `/__nowaki/ssr-module?path=`, the dev `.env`
  fallback, virtual-module paths, and transform error bodies. Every source read
  goes through one canonicalize-and-allow-root check.
- Server-function RPC requires `application/json`, an `x-nowaki-rpc` header, and
  a same-origin request (CSRF).
- `/__nowaki/live` and `/__nowaki/hmr` check `Origin` in dev and production
  (cross-site WebSocket hijacking).
- ISR learns which query, header, and body inputs a route reads (`Vary`) and
  folds them into the cache key, so one user's page is not served to another
  and query floods do not grow the cache without bound.
- Live-island initial state is HMAC-signed and verified on every event, so a
  client can't forge it.
- Client assets no longer contain absolute build-machine paths (CSS scope ids
  and source-map sources are root-relative).

## [0.12.0] — 2026-06-14 · types, lazy hydration, Vercel

Packages: `nowaki` / `nowaki-core` 0.12.0, `@nowaki-dev/runtime` 0.11.0,
`create-nowaki` / `create-nowaki-app` 0.13.0.

### Added
- **Lazy hydration:** `client:load` (default), `client:idle`, `client:visible`,
  `client:media="<query>"`, and `client:only` on an island's usage site control
  when it hydrates. The directives are typed on any component.
- **Typed routes:** `nowaki typegen` (also run by `dev` and `build`) writes
  `.nowaki/types.d.ts`. `@nowaki-dev/runtime/navigation` exports a typed
  `route(pattern, params)` and `<Link>`; unknown paths and wrong params are
  compile errors.
- **Image optimization:** imported PNGs are losslessly re-compressed and
  stripped of metadata at build time (pure Rust, kept only when smaller).
- **Vercel adapter:** `nowaki build --adapter vercel` writes
  `.vercel/output/` (Build Output API v3) with a self-contained Node function.
  Deploy with `vercel deploy --prebuilt`.

## [0.11.0] — 2026-06-13 · scaffold templates

### Added
- **Template selection** in `npm create nowaki` (Astro-style): `-t/--template
  <basics|minimal>` or an interactive menu (default `basics`). `basics` is the
  starter with an interactive island; `minimal` is a single zero-JS page.
- **Polished starter designs** — both templates ship a clean, brand-aligned page
  (cyan accent, 野分 wordmark, subtle gradient) styled via `<style>` in
  `export const head`, so it works on zero-JS pages too.

Scaffolder-only (`create-nowaki` / `create-nowaki-app`); the CLI stays at 0.10.0
and the runtime at 0.9.0.

## [0.10.0] — 2026-06-13 · DevEx

### Added
- **Interactive `npm create nowaki` wizard** (dependency-free) — prompts for
  project name, package manager (auto-detected), git init, and dependency
  install; sets the package name and tailors the next steps. Non-interactive
  runs (`-y`, CI, pipes) scaffold with defaults and never auto-install (use
  `--install` to opt in). Flags: `-y/--yes`, `--install`, `--no-install`,
  `--no-git`, `--pm`.
- **dev/start banners** — `nowaki dev` and `nowaki start` print a clean banner
  (version, Local URL, ready time, active features). `--host` exposes the server
  on the LAN and shows the Network URL; `nowaki dev --open` opens the browser.
  Color respects `NO_COLOR` and non-TTY.
- **Fuller scaffold** — new apps now include `tsconfig.json` (Preact JSX, bundler
  resolution, `.tsx` extensions, `react`→`preact/compat` paths), `nowaki-env.d.ts`
  (css/asset/virtual/`import.meta.env` ambient types), a `README.md`, and a
  `.gitignore`, so editors give correct IntelliSense out of the box.
- **`nowaki build` summary** — build time, client modules/islands/JS size, server
  modules, and output path.

### Changed
- Missing-dependency errors are now actionable and package-manager-agnostic.
- The runtime (`@nowaki-dev/runtime`) is unchanged and stays at 0.9.0.

## [0.9.1] — 2026-06-13 · scaffolder patch

### Added
- Scaffolded apps (`npm create nowaki`) now ship `AGENTS.md` + `CLAUDE.md` so AI
  coding agents know Nowaki's conventions (islands, loaders/actions, API routes,
  `"use server"`, Jetstream) out of the box. Only `create-nowaki` and
  `create-nowaki-app` move to 0.9.1; the runtime and CLI stay at 0.9.0.

## [0.9.0] — 2026-06-13 · "Beta" (v0.8–v0.9 band)

### Added
- **Server functions (`"use server"`)** — a module with a top-of-file
  `"use server"` directive becomes an RPC boundary. Its exports run only on the
  server; the client gets a tiny `fetch` proxy (implementation and server-only
  deps are stripped from the bundle). Dispatch is allowlisted by a stable
  `module#export` id (the client can't reach arbitrary exports); `getContext()`
  exposes the request's cookies/headers via AsyncLocalStorage. Works in dev,
  `nowaki start`, and on edge adapters.
- **Plugin virtual modules** — plugins gain `resolveId(source, importer)` and
  `load(id)` hooks for modules that don't exist on disk. Client imports bundle
  the generated source inline; SSR inlines it as a self-contained `data:` module.
  Only invoked when normal resolution fails — zero overhead otherwise.
- **Jetstream presence + connection scaling** — a shared hub broadcasts the live
  connection count (`{type:"presence",count}`, mirrored into
  `[data-nowaki-presence]`), pings/expires idle connections (heartbeat), and caps
  concurrent connections (`NOWAKI_LIVE_MAX`), degrading gracefully over the cap.
- **Head-to-head benchmarks** — `benchmarks/head-to-head.mjs` compares Nowaki,
  Next.js, and Astro on the same one-counter app (measuring only what's
  installed, never fabricating). A `bench-regression` CI job gates the
  deterministic client-JS size against `benchmarks/baseline.json`.
- **Documentation site** — `/docs` (built with Nowaki, zero client JS): Overview,
  Quickstart, Routing, Server functions, Jetstream, Plugins, Deploy, and a
  Migrate-from-Next.js guide.

### Notes
- State-preserving (prefresh) HMR remains a follow-up; island hot-swap already
  gives fast feedback. Scoped CSS for TSRX islands also remains on the roadmap.

## [0.6.0] — 2026-06-13 · "Jetstream"

### Added
- **Jetstream islands** — server-reactive islands (the flagship). Mark an island
  `export const live = { state, on }` and it ships **no component JavaScript**:
  state lives on the server (per WebSocket connection), `data-live` events go to
  the Rust server, which re-renders and pushes an HTML patch that a ~2 KB client
  runtime morphs in. Client islands (optimistic UI) coexist on the same page;
  static deploys serve the initial SSR and degrade gracefully.

## [0.5.0] — 2026-06-13 · "Typhoon" (complete)

### Added
- **TSRX bridge** — `.tsrx` files (TSRX statement-container syntax) compile to
  Preact via `@tsrx/preact` and run through the oxc pipeline, in dev and prod.
- **Rust production hot path** — `nowaki start` is a Rust (axum) front that
  serves static assets and assembles the HTML document (island wiring,
  modulepreload) in Rust, delegating only component rendering to a Node sidecar.

## [0.4.0] — 2026-06-13 · "Typhoon" (core)

### Added
- **Deploy adapters** — `nowaki build --adapter <node|static|bun|deno|cloudflare>`:
  a self-contained Node server, static (SSG), Bun/Deno, and a Cloudflare Workers
  (edge) worker.
- **Streaming SSR** — opt-in per route with `export const streaming = true`.
- **Plugin API** — `nowaki.config` `transform(code, id)` hooks (dev + build).

## [0.3.0] — 2026-06-13 · "Monsoon"

### Added
- **Production bundler** — true chunk bundling with scope hoisting, tree-shaking,
  a persistent disk cache, end-to-end source maps, CSS Modules, hashed asset
  imports, and cyclic-dependency handling.
- **Next.js migration** — `react` / `react-dom` alias to `preact/compat`, so
  React-style code and React libraries run unchanged on a single Preact instance.

## [0.2.0] — 2026-06-13 · "Squall"

### Added
- **Routing & data** — nested `_layout`s, `_middleware`, server `loader`s, form
  `action`s, API routes with method dispatch and streaming, `_404`/`_500`, a
  `LoaderContext` (cookies/headers/redirect/json/formData), and an
  island-to-island SPA router.
- **npm-only install** — the CLI ships as prebuilt native binaries via npm's
  optional dependencies; no Rust toolchain required.

## [0.1.0] — [0.1.1] — 2026-06-12 · "Gust" / "Breeze"

### Added
- Initial public alpha: `nowaki dev` / `build` / `start` / `prerender`, islands
  architecture with on-demand oxc transforms, a full-screen error overlay,
  code-frame diagnostics, island hot-swap HMR, `.env` (`PUBLIC_*` exposure), and
  global CSS import.
- Published to crates.io (`nowaki-core`, `nowaki`) and npm (`@nowaki-dev/runtime`,
  `create-nowaki`, `create-nowaki-app`).

[Unreleased]: https://github.com/Tettu0530/nowaki/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.17.0
[0.16.2]: https://github.com/Tettu0530/nowaki/releases/tag/v0.16.2
[0.16.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.16.1
[0.16.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.16.0
[0.15.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.15.0
[0.14.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.14.1
[0.14.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.14.0
[0.13.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.13.0
[0.12.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.1
[0.12.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.0
[0.6.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.6.0
[0.5.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.5.0
[0.4.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.4.0
[0.3.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.3.0
[0.2.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.2.0
[0.1.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.1.1
