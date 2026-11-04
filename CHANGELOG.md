# Changelog

All notable changes to Nowaki are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Nowaki is **0.x alpha**: minor versions may carry
breaking changes (documented per entry), patch versions do not.

The npm version and the milestone codename are offset — each release bundles a
milestone's worth of work; the codename is noted per entry.

## [Unreleased]

### Added
- **Content Security Policy (opt-in):** `NOWAKI_CSP=report-only` or `enforce`
  sends a policy limiting scripts and style elements to `'self'` plus a
  per-response nonce, which Nowaki adds to every `<script>` / `<style>` in HTML
  responses (`nowaki dev` / `start` while streaming, ISR hits included, and the
  adapters). Island CSS and client navigation re-stamp the nonce on styles they
  insert. `NOWAKI_CSP_REPORT_URI` adds a `report-uri`. A CDN that caches HTML
  reuses the cached nonce.
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

[Unreleased]: https://github.com/Tettu0530/nowaki/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.13.0
[0.12.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.1
[0.12.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.0
[0.6.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.6.0
[0.5.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.5.0
[0.4.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.4.0
[0.3.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.3.0
[0.2.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.2.0
[0.1.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.1.1
