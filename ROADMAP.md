# Nowaki Roadmap

> This shows direction only. Items, order, and timing may change without notice. See
> [DESIGN.md](./DESIGN.md) for the design rationale and [CHANGELOG.md](./CHANGELOG.md) for per-release details.

## Vision

A "structural answer to the slowness of Next.js", built on three pillars:

1. Rust toolchain: oxc-based Rust handles transforming, resolving, bundling, and serving, keeping startup and builds fast.
2. Zero JS by default (Islands): pages render on the server, and only explicitly marked "islands" run on the client.
3. npm ecosystem compatibility: SSR is delegated to Node, so npm packages run on the server. React libraries go through `preact/compat`; which ones work is being verified in CI.

**Success metrics (targets for 1.0)**: dev startup < 300ms, HMR update < 100ms, client JS for a typical page < 15KB (gzip), and adoption in real apps.

## Where we are

**alpha (every package 0.19.x except `@nowaki-dev/markdoc`, published on crates.io / npm)**. `npm create nowaki` scaffolds an app, and `nowaki dev / build / start / prerender` work end to end. Routing, loader/action, middleware, API routes, Islands, Jetstream (server-reactive islands: WebSocket on `nowaki dev` / `nowaki start`, per-event HTTP POST on every deploy adapter), server functions, 6 deploy adapters (node / static / bun / deno / cloudflare / vercel), and plugins/virtual modules are all in place. Content sites (content collections, Markdown / MDX / Markdoc, `<Image>`, SEO metadata and sitemaps, fonts) arrived in 0.17. 0.18 added routing for larger apps: route groups, parallel and intercepting routes, `redirects` / `rewrites` / `headers`, `basePath`, `trailingSlash`, i18n routing, sessions, and a typed `env.ts`. 0.19 added production and dev experience: on-demand revalidation with CDN purge (Vercel, Cloudflare), View Transitions, observability (Server-Timing, JSON logs, OpenTelemetry), HMR that keeps island state and updates pages in place, a dev toolbar, and API routes that reject cross-site writes by default. Production use is not yet recommended (the API is still stabilizing).

## Milestones

Each milestone is defined by a "theme" and "Exit criteria". See the CHANGELOG for implementation details of completed work.

### v0.1 "Gust": Public alpha ✅
Ship it. Anyone can run `npm create nowaki` → `nowaki dev`, and the packages and docs are published.

### v0.2 "Breeze": DX & correctness ✅
A dev experience you can use every day. Error overlay, CSS (`.css` imports, scoped styles), environment variables (`.env`, exposure control for `PUBLIC_*`), code-frame diagnostics, `modulepreload` manifest.

### v0.3 "Squall": Routing & data ✅
Nested layouts (`_layout.tsx`), middleware (`_middleware.ts`), `action` (form submissions), per-method API routes, SPA router across islands, 404/500 conventions, `LoaderContext`.

### v0.4 "Monsoon": Deeper bundler ✅
Real chunk bundling + scope hoisting, tree shaking, persistent disk cache, end-to-end source maps, CSS Modules, asset imports and hashing, circular dependency support.

### v0.5 "Typhoon": Ecosystem & deploy ✅
5 deploy adapters (node / static / bun / deno / cloudflare edge), streaming SSR, plugin transform hooks, TSRX bridge, a Rust production hot path for `nowaki start`.

### v0.6 "Jetstream": Server-reactive islands ★flagship ✅
With **Jetstream islands**, an island that has `export const live = { state, on }` works without shipping its component JS to the client. The server holds state per WebSocket connection and pushes HTML patches. It coexists with client islands (optimistic UI) and degrades to the initial SSR on static deploys. The deploy adapters (Cloudflare included) send each event as an HTTP POST instead (no presence there yet).

### v0.7 "Beta": Groundwork for stability ✅
A `cargo test` suite, reproducible benchmarks ([BENCHMARKS.md](./BENCHMARKS.md)), documented trust boundaries ([SECURITY.md](./SECURITY.md)) with dependency auditing in CI, SemVer discipline and [CHANGELOG.md](./CHANGELOG.md).

### v0.8–v0.9 "Beta": Expansion and real-world readiness ✅
**Server functions (`"use server"` RPC)**, head-to-head benchmarks against Next/Astro + regression detection in CI, broader tests (router snapshots, Jetstream load), Jetstream presence and connection scaling, **plugin virtual modules (resolveId / load)**, docs site (`/docs`).

> State-preserving (prefresh) HMR is part of v0.19 (island hot-swap already exists). Scoped CSS for TSRX islands also continues.

### v0.10–v0.12 "Beta": DX & security audit ✅
An interactive wizard and template selection for `npm create nowaki`, dev/start banners. A multi-stage security audit of the dev/prod servers (15 issues, including file reads, CSRF on RPC, CSWSH, live state signing, and Vary on ISR), plus a CI regression suite that guards them (`scripts/security-e2e.mjs`).

### v0.13 "Zephyr": Solid footing ✅
Before adding big features, make the code easier to read and harder to break.

**Exit criteria**: The comment policy is documented in AGENTS.md and the code follows it. Route enumeration has a single implementation on the Rust side. Live island state no longer resets to initial values on reconnect.

- [x] Comment minimization (no behavior changes)
- [x] Consolidate route enumeration in `nowaki-core` (shared by typegen / prerender, with a test cross-checking the JS-side routeTable)
- [x] Restructure SECURITY.md and add a "Security invariants" section to AGENTS.md
- [x] Sanitize incoming headers at the Rust front (`x-forwarded-host` / `x-nowaki-*`, `NOWAKI_TRUST_PROXY`)
- [x] Jetstream: carry signed state in patches (fixes state resetting to initial values on reconnect)
- [x] Jetstream: make the session loop async; sidecar timeouts and error reporting

### v0.14 "Gale": Secure by default ✅
Safe without any configuration. Every claim is verified in CI on every push.

**Exit criteria**: Each row of SECURITY.md's "defenses enabled by default" maps to an implementation location and a CI check. security-e2e passes the same checks in both dev and prod.

- [x] Origin checks by default for page actions and non-GET requests (phased rollout for API routes; opt out with `export const csrf = false`)
- [x] Default security headers (nosniff / frame-ancestors / Referrer-Policy / COOP, also on ISR HITs)
- [x] Body and argument limits for server functions, `serverFn(schema, impl)` (Standard Schema), a build warning for unvalidated exports
- [x] Less error detail exposed in prod (`ServerFnError`); hardened handling of the live signing key (warning when unset, `iat` and max lifetime)
- [x] CI: all checks in all modes, unit tests for the edge path, make `pnpm audit` required
- [x] CSP nonce support (starting with Report-Only)

### v0.15 "Cyclone": Jetstream 2 ★flagship ✅
Make "LiveView for the npm ecosystem, with 0KB of component JS" practical. Forms and inputs, authenticated handlers, live queries that push external changes, and state shared across connections (rooms).

**Exit criteria**: State survives reconnects and server restarts. `publish()` delivers patches to islands on other connections. A two-tab voting demo works with per-room presence. Fan-out p95 at 1000 connections is recorded in BENCHMARKS.md.

**Status**: 0.15.0 ships the checked items below, live islands on every deploy adapter (per event over POST), and the two-tab demo (`/poll`). Since 0.15.0, every exit criterion is met: stale notifications, rooms that survive a `nowaki start` restart (saved to `.nowaki/live-rooms.json`), and the fan-out p95 in BENCHMARKS.md (63 ms at 1000 connections). Deferred (see v0.19 below): the resume token, and rooms shared across instances (a pluggable store).

- [x] More events (submit / input / change, debounce, keyed morph)
- [x] Stable signing key (`NOWAKI_LIVE_SECRET`) and stale notifications; resume token (optional) deferred
- [x] Read request context from handlers (`getContext()`, `live.authorize`)
- [x] Live queries (`subscribe` / `load` / `publish`, a Node→Rust event path)
- [x] Multiplayer rooms (`room` / `shared` / per-room presence), kept across a restart
- [x] Fan-out p95 at 1000 connections in BENCHMARKS.md
- [x] Document in the docs that it assumes a single process and does not support edge (nowaki.dev Jetstream page)

### v0.16 "Chinook": Show it with numbers ✅
Prove the differentiation with numbers and tooling.

**Exit criteria**: `nowaki build` reports first-load JS per route and fails when a budget is exceeded. TTFB and Jetstream benchmark results are in the docs. Claude Code can connect to the `nowaki dev` MCP.

**Status**: 0.16.0 ships the checked items below, plus streamed responses through the Rust front, `streaming = "early"`, and one render per publish for live queries and rooms. The Jetstream fan-out benchmark and the TTFB / throughput numbers from the 0.16.0 re-run of `benchmarks/compare` are in BENCHMARKS.md. Polishing the Jetstream docs and demos moved to the deferred list under v0.19 (it is nowaki.dev work).

- [x] Per-route client JS budgets (`export const budget = { js: <KB> }`; every build prints first-load JS per route and fails over budget)
- [x] Build-time "this island could be live" suggestions (including moving live detection to the AST)
- [x] Serve ISR pages from Rust alone right after startup (a warm-up render at startup instead of prerender ingestion, ETag / 304, pre-compressed br / gzip)
- [x] TTFB measurement in BENCHMARKS.md (with the 0.16.0 re-run of `benchmarks/compare`)
- [x] An MCP endpoint for `nowaki dev` (routes, module graph, recent errors)

### v0.17 "Mistral": Content sites ✅
Make Nowaki a first-class choice for blogs, docs, and marketing sites: content, images, and SEO out of the box.

**Exit criteria**: a docs site is built from a typed content collection of Markdown and MDX, with responsive images and a generated sitemap, without third-party Markdown or image code in the app. Its build time and first-load JS are in BENCHMARKS.md, next to Astro's. A static Astro site of the size of a personal portfolio (page scripts, `public/` assets, generated OG images, attributes on `<html>`) moves to Nowaki without workarounds, following the migration guide.

**Status**: 0.17.0 ships every item below. The portfolio exit criterion was met by porting a real Astro site (static output matched, OG images byte-identical) after fixing what the port turned up. The docs-site build time and first-load JS against Astro are in BENCHMARKS.md. Markdoc and remote images moved to v0.18. Lossy WebP is not offered: there was no MIT-licensed pure-Rust encoder mature enough to ship; the comparison of candidates is deferred (see v0.19 below).

- [x] Content collections: `content/<name>/*` (declared in `content/config.ts`) with YAML frontmatter validated by a Standard Schema (the same as `serverFn`), `getCollection` / `getEntry`, generated types; TOML frontmatter (`+++`, after 0.17.1)
- [x] Built-in Markdown, rendered in Rust at build time: heading anchors and table of contents, code highlighting, and local images through the image pipeline
- [x] MDX: components and islands inside `.mdx` pages and content entries, parsed in Rust (markdown-rs) and compiled to TSX, with the same highlighting, images, and heading ids as Markdown
- [x] Image component: `srcset` / `sizes`, `width` / `height` from the file (no layout shift), lazy loading by default, AVIF (pure Rust) with the original format as the fallback
- [x] SEO and metadata: a typed `meta` (Open Graph, Twitter cards, canonical, robots, JSON-LD), `sitemap.xml` and `robots.txt` generated from the routes
- [x] `public/`: files served as-is at their own path (favicon, `robots.txt`, fonts referenced from CSS), by `nowaki dev`, `nowaki start`, every adapter, and static output
- [x] File routes, prerendered: dynamic routes with an extension (`og/[card].png.ts`, `feed.xml.ts`) and API routes written to files by `nowaki prerender` / the static adapter, for OG images, feeds, and sitemaps
- [x] Attributes on `<html>` and `<body>` from a route or layout (`export const htmlAttrs` / `bodyAttrs`)
- [x] Page scripts: a route or layout can ship a bundled TS module (npm imports included) without an island, like Astro's `<script>`; counted in the route's first-load JS and `budget`
- [x] Migration guide from Astro ([docs/migrate-from-astro.md](docs/migrate-from-astro.md)): `.astro` components to TSX, `<style>` to CSS, `<script>` to page scripts, endpoints to file routes, written from moving a real site
- [x] Font optimization: self-hosted Google and local fonts at build time (no third-party request), Google subsets by `unicode-range`, `preload`, `font-display`, and size-adjusted fallbacks so text doesn't shift when the font arrives

### v0.18 "Sirocco": Routing for real apps ✅
Routing features that larger apps and existing Next.js / Remix users expect.

**Exit criteria**: a photo gallery opens a photo in a modal on client navigation and as a full page on reload (intercepting + parallel routes). The same app is served under a `basePath` in two locales, with a signed-in session, and fails to start when a required env var is missing.

**Status**: every item below is on main for 0.18.0. The exit criteria are met by [examples/gallery](examples/gallery) (a modal photo gallery under `/gallery` in English and Japanese, with sign-in and an `env.ts`). CI checks it on `nowaki start`, `nowaki dev`, the node adapter, and the Cloudflare worker (`scripts/gallery-e2e.mjs`), and in Chrome (`scripts/gallery-browser-test.mjs`). Static output serves the pages, redirects, and headers, but not sessions or `Accept-Language` detection. 0.18.1 made config rules and `<Link>` locale-aware, added `href()`, and cut most of the per-request i18n cost. `.mdoc` files are not routes yet (deferred, see v0.19 below).

- [x] Markdoc as an official plugin (it runs on the Node side through the plugin host) (moved from v0.17)
- [x] Remote images in `<Image>` with an allow-list (fetched and optimized at build time) (moved from v0.17)
- [x] Route groups: `(group)` directories that share layouts without adding a URL segment
- [x] Parallel routes (`@slot` directories rendered side by side in a layout) and intercepting routes (`(.)photo`, for modals)
- [x] Config-level `redirects`, `rewrites`, and `headers` in `nowaki.config.mjs`, applied by the Rust front and every adapter (`_redirects` / `_headers` / Vercel config where the host supports them)
- [x] `basePath`, and a `trailingSlash` policy (`"never"` / `"always"` / `"ignore"`, with redirects)
- [x] i18n routing: locale prefixes, a default locale, optional `Accept-Language` negotiation, `getLocale()`, `hreflang`, and per-locale content collections
- [x] Typed env schema: declare server and `PUBLIC_` variables with a Standard Schema; validated at build and at startup (a missing or malformed value fails fast), with generated types for `import.meta.env` and a server-only `env` that the client build refuses to import
- [x] Sessions: `ctx.session` (and `getContext().session`) backed by a signed and encrypted cookie by default, or a pluggable store; rotation on sign-in, expiry, and the same CSRF rules as actions

### v0.19 "Bora": Production and dev experience ✅
Control over what is cached, smooth navigation, visibility into a running app, and edits that keep their state.

**Exit criteria**: an action updates a post and the next request for it is fresh on `nowaki start` and on a CDN adapter. A list-to-detail navigation animates with View Transitions and falls back cleanly where they are unsupported. A request shows up as one OpenTelemetry trace (route, middleware, loader, render). Editing an island in `nowaki dev` keeps its state, and the dev toolbar shows the page's islands and JS budget.

**Status**: 0.19.3 ships every item below (the first release with one shared version; 0.19.0–0.19.2 were skipped for the CLI and runtime). The exit criteria are met by [examples/gallery](examples/gallery) (its `/gallery/posts`): CI checks the fresh post after an edit on `nowaki start`, the Cloudflare worker and the Vercel function (`scripts/gallery-e2e.mjs`), the trace from a local OTLP receiver, and in Chrome the View Transition with its fallbacks, the island edit that keeps its state and the toolbar (`scripts/gallery-browser-test.mjs`).

- [x] Upgrade oxc to the latest release (raises the minimum Rust version), before the transform work below lands on top of it
- [x] API routes reject cross-site requests by default (CSRF); `export const csrf = false` stays as the opt-out
- [x] CLI, runtime and create-* versions move together (from 0.19.3, since create-* had already published 0.19.2)
- [x] Cache invalidation: `revalidatePath()` / `revalidateTag()` from actions and API routes (route-level `tags`), purging the `nowaki start` ISR cache and calling the adapter's CDN purge where there is one
- [x] View Transitions in the client router (`document.startViewTransition`, opt-in per link or route, `view-transition-name` helpers), with a reduced-motion fallback
- [x] Observability: `Server-Timing` (middleware, loader, render, ISR status), structured JSON logs (`NOWAKI_LOG=json`), OpenTelemetry traces over OTLP (Rust front and renderer joined by `traceparent`, live events included), and a health endpoint
- [x] HMR: island edits keep component state (Preact Fast Refresh), CSS and CSS modules update without a reload, and route / layout edits re-render the page in place
- [x] Dev toolbar in `nowaki dev`, from the same data as the dev MCP endpoint:
  - the current route, its layouts, and their loaders' timing
  - each island on the page: client or live, hydration state, size, and the "could be live" hint
  - the route's first-load JS against its `budget`
  - ISR status and live connections and rooms
  - recent errors with links to the source

  It is injected only in dev and can be turned off.

**Deferred / candidates for later** (from earlier milestones; not scheduled):

- Polish the Jetstream docs and demos (v0.16): nowaki.dev work, outside this repo
- Jetstream live push on the deploy adapters (`publish()` is a no-op there, and `server/live-hub.mjs` is not wired into a server): a candidate for v0.20
- Jetstream resume token (v0.15)
- Jetstream rooms shared across instances, through a pluggable store (v0.15)
- A lossy WebP encoder, after comparing the candidates (v0.17)
- `.mdoc` files as page routes (v0.18; `.mdoc` works in content collections today)
- Caching the evaluated nowaki.config, so a build whose config has not changed (and has no plugins) skips the Node start
- Cloudflare [Workers Caching](https://developers.cloudflare.com/workers/cache/) as an alternative to the Worker's Cache API ISR cache (v0.19): it honors Vary and stale-while-revalidate, collapses concurrent requests, uses tiered cache and purges globally, but serves hits without running middleware or nowaki.config rules and bills static asset requests; measure before switching

### v1.0 "Nowaki": Stable release
**Exit criteria**: Stability guarantees for the public API, complete documentation, established governance.

**Status**: in progress. The policies are written: [docs/STABILITY.md](docs/STABILITY.md) (everything public is frozen at 1.0, with no experimental tier; what counts as breaking; deprecation; platforms), [SUPPORT.md](SUPPORT.md) (the latest 1.y gets fixes; 1.x gets security fixes for 6 months after 2.0), [GOVERNANCE.md](GOVERNANCE.md), [MAINTAINERS.md](MAINTAINERS.md) and [RFCs](rfcs/README.md). Next: 0.20.0, the last breaking release and the API freeze, then `1.0.0-rc.N` on npm `next` for at least 14 days with no API snapshot change before 1.0.0.

- [ ] Stability guarantees for the public API + a breaking-change policy
- [ ] Complete documentation and migration guides
- [ ] Governance (maintainer structure, RFC process, release process)
- [ ] LTS / support policy

## Ongoing work

If the milestones are the warp, the following is the weft that runs continuously.

- DX: HMR, error display, CLI experience, type completion (`.d.ts`), more templates
- Performance: bundle graph, caching, source maps, benchmark regression detection
- Ecosystem: adapters, plugin API, TSRX
- Quality: tests, `cargo audit` / `pnpm audit`, security reviews
- Community: docs, recipes, RFCs, contributor onboarding
