# AGENTS.md — working on the Nowaki codebase

Guidance for AI coding agents (Claude Code, Codex, Gemini, Cursor, Copilot, etc.)
working **on this repository** — the Nowaki framework itself. If you are building
an *app* with Nowaki, read the app guide instead: a scaffolded app ships its own
`AGENTS.md`, and the public conventions live at <https://nowaki.dev/docs>.

This file is the single source of truth; the per-agent files (`CLAUDE.md`,
`GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/`) just point here.

## What this repo is

Nowaki is a full-stack web framework with a Rust toolchain: full-stack like
Next.js, islands like Astro, installed with npm. A Rust pipeline (oxc) does
transform / resolve / bundle / serve; pages render to HTML and only `islands/`
hydrate.

```
crates/nowaki-core/   Rust library — transform, resolve, bundle, chunk (scope hoist),
                      css, server_fn, plugin bridge. JS-FREE (no JS execution).
crates/nowaki/        Rust CLI binary — dev / build / start / prerender, adapters,
                      plugin host client, Jetstream WS (live.rs).
packages/nowaki-runtime/   JS the framework runs: server/ (SSR sidecar, handler,
                      app, functions, plugin-host) + client/ (islands, router, live, hmr).
packages/create-nowaki, create-nowaki-app   scaffolders (npm create nowaki).
packages/nowaki-cli   the `nowaki` npm wrapper (prebuilt binary shim).
examples/hello/       kitchen-sink app used by CLI tests + e2e.
examples/gallery/     the v0.18 exit-criteria app (basePath, i18n, modal routes, sessions, env.ts);
                      scripts/gallery-e2e.mjs + gallery-browser-test.mjs.
benchmarks/           bench.mjs, head-to-head.mjs (Next/Astro), check-regression.mjs,
                      ci-perf.mjs + ci-perf-app/ (CI perf gate: head vs base vs last release,
                      all on the fixed ci-perf-app).
```

## Build, test, lint (run before you claim done)

```bash
# Rust (the core of the project)
cargo build                                          # workspace
cargo fmt --all --check                              # must be clean
cargo clippy --workspace --all-targets -- -D warnings  # must be clean
cargo test --workspace                               # unit + integration + CLI

# JS / app-level
pnpm install                                         # workspace deps (frozen in CI)
node scripts/router-test.mjs                         # router snapshot/unit test
node benchmarks/check-regression.mjs                 # client-JS size gate

# Run the example app end to end
cargo run -p nowaki -- dev examples/hello            # dev server on :3000
cargo run -p nowaki -- build examples/hello          # production build
cargo run -p nowaki -- start examples/hello          # Rust front + Node renderer
```

CI (`.github/workflows/ci.yml`) mirrors all of the above and adds e2e runs on
Linux/macOS/Windows, browser tests, scaffolding, adapter runtimes, and audits.
The e2e steps are plain scripts in `scripts/ci/`, so you can run them locally
(e.g. `bash scripts/ci/e2e-dev.sh` after `cargo build -p nowaki`). The single
required check is `CI OK`.

## Architecture facts you must not break

- **`nowaki-core` executes no JavaScript.** JS interop goes through the
  `PluginBridge` trait (implemented by the CLI's `plugins.rs` over a localhost
  HTTP plugin host). Keep the core JS-free.
- **`NowakiCore::read_source` is the single source-read chokepoint.** Plugin
  `transform`, `.tsrx` compile, virtual-module `load`, and `"use server"`
  detection all hinge on every read going through it.
- **Transforms run in several modes** — dev browser, dev SSR, build client
  (`transform_for_bundle`), build server (`transform_for_server`), and chunk
  hoisting (`chunk.rs`). A change to import handling usually needs touching all
  of them. They all apply the `react`→`preact/compat` alias.
- **Unit tests go at the END of each Rust file** (`#[cfg(test)] mod tests`).
  Placing them mid-file trips clippy's `items-after-test-module`.
- **Relative imports use explicit extensions** (`../islands/Counter.tsx`). The
  dev loader hooks and server build assume this; extensionless relative imports
  break SSR.
- **Preact, not React.** SSR uses `preact` + `preact-render-to-string`. `react*`
  specifiers are aliased to `preact/compat` across every transform path
  (`resolve.rs::alias_specifier`).

## Security invariants

When you change dev/start, sidecars, Jetstream, or server functions, preserve
these properties. Trust boundaries and reporter guidance are in
[SECURITY.md](./SECURITY.md); each default defense is listed in
[Defenses enabled by default](./SECURITY.md#defenses-enabled-by-default) with
code locations and CI coverage.

- **`nowaki-core` stays JS-free.** Security logic belongs in the CLI (`dev.rs`,
  `start.rs`, `live.rs`), runtime (`packages/nowaki-runtime/server`), or
  build-time artifacts (`functions.json`) — not embedded JS execution inside
  core.
- **Sidecars stay on localhost.** Do not bind SSR, prod-sidecar, plugin host, or
  live-render to public interfaces; the Rust binary is the only intended entry.
- **Production never exposes dev file surfaces.** No `/@fs/`, dev-only
  `ssr-module` shortcuts, or arbitrary project reads on `nowaki start` / adapter
  paths — only `dist/` (static basenames under `/_nowaki/`).
- **Single read chokepoint.** Sensitive detection (`"use server"`, plugins,
  virtual loads) must go through `NowakiCore::read_source`; do not bypass it with
  ad-hoc `fs::read` for app sources in core.
- **Server functions are allowlist-only.** Clients send an opaque id; never accept
  module paths or export names from the browser. Keep dispatch in
  `functions.mjs` aligned with `dist/server/functions.json`.
- **Do not weaken default CSRF / CSWSH gates** without an explicit opt-in API and
  ROADMAP/SECURITY updates: JSON + `x-nowaki-rpc` + Origin/Host for RPC;
  JSON + `x-nowaki-live` + `isCrossSite` for `/__nowaki/live-event`;
  Origin checks on `/__nowaki/live` and `/__nowaki/hmr` upgrades.
- **Server function errors stay generic in production.** Only a `ServerFnError`'s
  status, message, and `data` reach the client; anything else is logged and sent
  as "Internal Server Error" (dev keeps the message). Keep the body / argument
  limits in `functions.mjs` ahead of parsing and dispatch.
- **State-changing routes check the origin.** `handler.mjs` rejects cross-site
  non-GET requests to page actions (and to API routes with `csrf = true`) via
  `server/origin.mjs`, before the action runs. Don't move the check after the
  action, and keep `csrf = false` as the only opt-out.
- **Every server sets the default security headers** (`security_headers.rs` for
  dev/start, `server/security-headers.mjs` for the adapters, `_headers` for
  static output). Add new defaults to both lists, and never overwrite a header
  the response already set.
- **The CSP nonce covers everything Nowaki inserts.** `csp.rs` / `server/csp.mjs`
  stamp `<script>` / `<style>` in HTML responses; client code that inserts a
  `<style>` (CSS shims, router head/body swaps, boundaries) must set
  `window.__nowakiNonce` on it. Re-run the browser tests with
  `NOWAKI_CSP=enforce` when touching those paths.
- **Live handlers see only allowlisted request headers.** `live::context_headers`
  picks cookie / authorization / accept-language / user-agent and the public
  host from the upgrade; `live.authorize` runs after the signature check and
  before the handler. Keep both orders.
- **Internal sidecar endpoints stay internal.** Anything the sidecar trusts
  without checks (today `/__nowaki/live-render` and the dev-only
  `/__nowaki/dev-info`) must be listed in `forward::is_internal_path`, so
  dev/start return 404 instead of proxying it.
- **The dev MCP stays loopback-only and dev-only.** `/__nowaki/mcp`
  (`crates/nowaki/src/mcp.rs`) answers only a loopback peer with a loopback
  `Host` and `Origin`, also under `--host`; only `nowaki dev` mounts it. Keep
  its tools read-only. Dev errors reach its log from the sidecar through a
  stdout line carrying `NOWAKI_PUBLISH_TOKEN`, like `publish()`.
- **`publish()` has no network endpoint.** The sidecar reaches the Rust hub only
  through its stdout with `NOWAKI_PUBLISH_TOKEN`; keep it that way, and keep the
  topic caps in `live.rs` and `live.mjs` in step.
- **Sidecar requests go through `forward::apply`** (`crates/nowaki/src/forward.rs`).
  Clients never set `x-forwarded-*` or internal `x-nowaki-*` headers on the
  sidecar hop unless `NOWAKI_TRUST_PROXY` is set; new client-facing `x-nowaki-*`
  request headers must be added to its allowlist. Adapter runtimes (Node/Edge)
  apply the same host trust in `server/origin.mjs` (`browserHost`) for CSRF
  checks — `NOWAKI_TRUST_PROXY`, loopback sidecar `Host`, Vercel `x-forwarded-host`,
  otherwise `Host`; do not derive the comparison host from `Origin`.
- **Client-supplied Jetstream state is used only after its signature verifies**
  (`live.mjs` checks before every render and handler run); do not skip or bypass
  that path. The POST transport (`server/live-event.mjs`, `/__nowaki/live-event`)
  goes through the same `liveRender` and keeps the RPC-style CSRF gate (JSON +
  `x-nowaki-live` + `isCrossSite`) and its 64 KiB body cap ahead of parsing.
- **ISR keys must include learned `Vary` inputs** (`context.mjs` `__vary()` →
  `x-nowaki-vary`, folded in `isr_key` in `start.rs`) so cached pages cannot
  bleed across users. The query string is part of the key only when the route reads
  it; unread queries are dropped, so they can't grow the cache.
- **Only `PUBLIC_*` (and `MODE`) reach client bundles** via env inlining; never
  ship secrets or raw `.env` contents to the browser.
- **Production error responses stay generic.** Do not expose stack traces or other
  internal details from prod SSR/sidecar paths (`server/app.mjs`, `server/web.mjs`,
  `server/prod-sidecar.mjs`).
- **Regressions need tests.** If you add or change a default defense, extend
  `scripts/security-e2e.mjs` and/or `scripts/ci/e2e-*.sh` when CI does not already
  cover the behavior, and update the defenses table in SECURITY.md.

## Feature map (where things live)

- **Dev MCP (`/__nowaki/mcp`)** — `crates/nowaki/src/mcp.rs` (JSON-RPC over
  Streamable HTTP, tools, error ring buffer); route table + island registry from
  the dev sidecar's `/__nowaki/dev-info` (`server/sidecar.mjs`); imports /
  importers from `crates/nowaki-core/src/graph.rs`. E2E: `scripts/mcp-e2e.mjs`.

- **Server functions (`"use server"`)** — `crates/nowaki-core/src/server_fn.rs`
  (detect, id, client proxy, discover) + `packages/nowaki-runtime/server/functions.mjs`
  (dispatch + `getContext`). Allowlist: `dist/server/functions.json`.
- **Jetstream islands** — `crates/nowaki/src/live.rs` (`LiveHub` + WS session),
  `server/live.mjs`, `client/live.js`. State on the server, HTML patches over WS;
  `server/live-event.mjs` is the per-event POST transport (all servers, the only
  one on the adapters). `server/live-hub.mjs` is a runtime-neutral JS port of the
  WS session, not wired into a server yet.
- **Plugins / virtual modules** — `PluginBridge` (`transform`, `compile_tsrx`,
  `resolve_id`, `load`); `NowakiCore::resolve_spec` + the `VirtualResolve` trait.
  The host (`server/plugin-host.mjs`, started by `plugins::spawn` before typegen) also
  normalizes the build-time config with site-config.mjs's `normalizeConfig` and returns it in
  `/caps` (`siteConfig`, under `NOWAKI_SITE_CONFIG=1`), so build / dev / prerender import
  nowaki.config once. `runtime::check` (`MIN_RUNTIME`) refuses runtimes older than that,
  so the CLI has no fallback paths for them.
- **Scope hoisting / chunking** — `crates/nowaki-core/src/chunk.rs`.
- **Deploy adapters** — `crates/nowaki/src/adapter.rs` (+ `server/edge-build.mjs`).
- **Images (`?image`, `<Image>`)** — `crates/nowaki-core/src/image.rs` (widths, AVIF via ravif
  + fallback, disk cache, `picture_html` for Markdown), emitted by `build.rs` `emit` (client) and
  `ServerAssets::image_module` (server); dev modules from `transform.rs` `dev_asset_module`,
  variants from `dev.rs` `dev_image` (`/__nowaki/image`). Component: `packages/nowaki-runtime/image.js`.
  Markdown images: `content.rs` `local_image`. Remote `?image` (`images.remotePatterns`):
  `crates/nowaki-core/src/remote_image.rs` (allow-list, cache, `RemoteFetch` trait; resolved to the
  cached file in `NowakiCore::resolve_remote_image`, so every transform mode reuses the local path),
  downloads in `server/images-fetch.mjs` via `crates/nowaki/src/remote_images.rs`; the matcher
  exists in both, driven by `crates/nowaki-core/tests/fixtures/remote-patterns-cases.json`
  (`tests/remote_patterns.rs`, `scripts/images-fetch-test.mjs`).
- **Fonts** — `crates/nowaki/src/fonts.rs` (faces, size-adjusted fallbacks from metrics
  read from head / hhea / OS/2 by hand, `dist/server/fonts.json`; dev: `.nowaki/fonts`), Google downloads in
  `server/fonts-fetch.mjs`, config via `site.rs` + `server/site-config.mjs`; the links go into
  every page from `handler.mjs` `withFonts` (`env.fonts`).
- **MDX** — `crates/nowaki-core/src/mdx.rs` (markdown-rs mdast → TSX: hoisted ESM, JSX
  pass-through, `headings`, images via `?image`, code via `highlight.rs`); applied in
  `NowakiCore::read_source`, so `.mdx` is an ordinary transformable module (routes, graph, dev,
  builds). Content entries: `content.rs` (`module`), `render()` in `server/content-store.mjs`.
- **Markdoc** — `packages/nowaki-markdoc` (`@nowaki-dev/markdoc`): a plugin whose `transform`
  compiles `.mdoc` in the plugin host (parse / validate / transform with `@markdoc/markdoc`) into a
  TSX module holding the tree as data; `render.js` renders it with Preact. Core only marks `.mdoc`
  transformable and errors when no plugin compiled it (`lib.rs` `compile_source`). Content
  entries: `content.rs` (`module`). Tests: `node --test "packages/nowaki-markdoc/test/*.test.mjs"`.
- **Typed env (`env.ts`)** — `defineEnv` / `validateEnv` / `initServerEnv` in
  `server/env-schema.mjs`, the frozen values behind `@nowaki-dev/runtime/env/server` in
  `server/env-server.mjs`. Before a build (and at `nowaki dev` startup) `crates/nowaki/src/env_schema.rs`
  runs `server/env-check.mjs` and passes the public values to `NowakiCore::set_public_env`; the server
  build compiles env.ts to `dist/server/env.js` and writes `env-public.json`. Startup validation:
  `app.mjs` `createApp`, `web.mjs` (first request), dev `sidecar.mjs` (first request). Client import
  guard: `build.rs` `emit` and the dev browser transform (`env::is_server_env_module`). Types:
  `typegen.rs` `render_env`. Tests: `scripts/env-schema-test.mjs`.
- **Sessions (`ctx.session`)** — `server/session.mjs` (`defineSession`, `configureSessions`,
  `createSession`: WebCrypto only, keys from `NOWAKI_SESSION_SECRET` via HKDF). `context.mjs`
  creates the session on first access (`__sessionMode`: `"crossSite"` / `"live"` make it
  read-only); it sets `ctx.__commit` when it has a cookie to write, which `handler.mjs`
  `commitAndFinalize` awaits (a failure renders the 500 page). `handler.mjs` `routeRequest` marks
  cross-site writes before middleware. Config: app-root `session.ts`, compiled by `build.rs`
  `build_server` to `dist/server/session.js`; loaded by `app.mjs` `createApp`, `web.mjs` (the
  worker imports it, `edge-build.mjs`), and dev `sidecar.mjs` (`ensureSession`, plus the
  generated `.nowaki/session-secret`). Tests: `scripts/session-test.mjs`.
- **SEO** — `packages/nowaki-runtime/server/seo.mjs` (site URL, meta tags, sitemap, robots);
  `handler.mjs` `withSeo` (layout + route meta) and the generated `/sitemap.xml` / `/robots.txt`;
  page URLs from `server/isr-urls.mjs` `pageUrls`, shaped by `pagePath` per `trailingSlash`
  (`env.trailingSlash`; the static output files from `prerender.rs` `out_file_for` match it).
  The site comes from `crates/nowaki/src/site.rs`
  (`dist/server/site.json`, via `server/site-config.mjs`), `NOWAKI_SITE` winning. Unit checks:
  `scripts/seo-unit-test.mjs`.
- **Routing config (`basePath`, `trailingSlash`, `redirects`, `rewrites`, `headers`)** —
  normalized and validated by `server/site-config.mjs`, read by `site.rs` before the build and
  written to `dist/server/routing.json` (dev: `.nowaki/routing.json`). The compiler / matcher
  exists twice, `crates/nowaki-core/src/rules.rs` and `server/rules.mjs`, driven by one fixture
  (`crates/nowaki-core/tests/fixtures/rules-cases.json`, run by `tests/rules.rs` and
  `scripts/rules-test.mjs`); change both together. The segment grammar is shared with the router
  through `server/segments.mjs`.
- **Route groups (`routes/(name)/`)** — no URL segment. JS: `server/router.mjs` `scanRoutes`
  (URL without groups, `dir` stays physical, collision error; group `_middleware` marked
  `group` and run by containment in `handler.mjs` `runMiddleware`; boundaries carry a
  group-free `urlPrefix` for the client). Rust: `routes.rs` `strip_route_groups` (in
  `url_pattern_from_stem`) and `check_url_conflicts` (called by `build_with_client`). Layout /
  CSS lookups stay on physical dirs. Tests: `scripts/router-test.mjs`, `routes.rs` units.
  through `server/segments.mjs`. Applied at the fronts by `crates/nowaki/src/front.rs`
  (`start.rs` `handle`, `dev.rs` `serve_or_proxy`, the headers layer; the route path reaches the
  sidecars in `x-nowaki-route-path` → `info.routePath`) and `server/front.mjs` (`app.mjs` `handle`,
  the worker `fetch` from `edge-build.mjs`); Vercel platform routes from `server/vercel-routes.mjs`,
  static `_redirects` / `_headers` from `prerender.rs`. Without a routing config each front does
  one null check. With `i18n`, the engines match rule sources without the locale prefix
  (`locale: false` opts a rule out) and put the locale back on internal destinations; the
  handler then splits the locale off the route path once, as for any request. Tests: `scripts/rules-front-test.mjs`, `scripts/rules-e2e.mjs` (every front).
- **`basePath`** — build: `NowakiCore::set_base_path` (asset URLs via `asset_base()`, the server
  function proxy path, the `import.meta.env.BASE_URL` define, plus `__NOWAKI_BASE_URL__` for the
  classic-script `client/live.js`), set by `site::configure`; fonts and content images read
  `site::asset_base()`. Runtime: `server/base-path.mjs` (`globalThis.__nowakiBase`, `withBase`)
  set by `app.mjs` / `web.mjs` / dev `sidecar.mjs`, used by `<Link>`, `ctx.redirect`, `seo.mjs`,
  the session cookie Path; asset hrefs from `assetBase` in `app.mjs` / `web.mjs` / `document.mjs`
  and `Manifest.asset_base` in `start.rs`. Fronts: `<base>/_nowaki/*` and `<base>/__nowaki/*`
  skip the rules (`front.rs` `framework_path`, `front.mjs` `frontStep` `internal`), and
  `front.rs` `base_layer` wraps the router in start / dev so `<base>/__nowaki/*` reaches the
  root handlers. Client: every base-dependent line compares `BASE_URL` with `"/"`, so it folds
  away without a base (keep it that way: no-base output must stay byte-identical). Adapters:
  `edge-build.mjs` / `vercel-build.mjs` place static files under the base. Tests:
  `crates/nowaki-core/tests/base_path.rs`, `scripts/rules-e2e.mjs` (config B), `seo-unit-test`,
  `session-test`, `router-browser-test.mjs` with `BASE=http://host:port/app`.
- **i18n (`i18n` in nowaki.config)** — locale prefixes, `localePath` and the sitemap's alternate
  groups in `server/i18n.mjs` (runtime-neutral; `navigation.js` uses it in the browser too). The
  locale comes off the route path in `handler.mjs` `localizedRequest` (one `env.i18n` check per
  request when off), which runs the request inside `server/i18n-context.mjs` (an
  AsyncLocalStorage published on `globalThis[Symbol.for("nowaki.locale")]`, so `getLocale()` /
  `getCollection` never import `node:async_hooks`) and renders through `localizedEnv` (`<html
  lang>`, `data-nowaki-i18n`, hreflang from `seo.mjs` `hreflangTags`; the attributes are cached per
  locale in `localeAttrs`, the hreflang tags per route path in `hreflangFor`, and document.mjs
  caches the string of a frozen htmlAttrs object: keep the per-request work to the split and the
  AsyncLocalStorage `run`). `<Link>` and `href()` (`navigation.js`) add the current locale
  (server: the request's locale state, browser: `data-nowaki-i18n`) unless the href has a locale
  prefix or `locale={false}`, then the base. `env.i18n` is set by `app.mjs`, `web.mjs` (`routing`, passed by `edge-build.mjs`) and dev `sidecar.mjs`
  (`.nowaki/routing.json`). Content locales: `content.rs` `split_locale` (locales from the routing
  config). Per-locale URLs: `isr-urls.mjs` `localeUrls`, `static-paths.mjs` `localePages`,
  `prerender.rs` `locale_urls` / `locale_404s` / `locale_redirects`; `locale_url` and
  `localePathFor` share `crates/nowaki/tests/fixtures/i18n-cases.json`. Tests:
  `scripts/i18n-test.mjs`, `scripts/i18n-e2e.mjs` (start, dev, node, cloudflare, static; its
  "combo" app composes i18n with basePath, trailingSlash "never" and a parallel-route slot).
  Locale detection (`i18n.detect`, `/` only): `Rules::negotiate` / `negotiateLocale` in the
  shared rules engines (the rules fixture's `negotiate` cases), run before the ISR lookup by
  `front.rs` `headers_layer` (installed only when `has_response_layer`) and `front.mjs`
  `frontLocale` (`app.mjs` `handle`, the worker `fetch`); `Vary: Accept-Language, Cookie` on every
  root response. The `nowaki_locale` cookie comes from `navigation.js` `setLocale`, also called by
  `<Link locale>`'s click handler (inside islands; nothing in `client/islands.js`, so apps without
  i18n ship no extra bytes); static output only warns
  (`prerender.rs` `static_host_rules`).
- **Parallel routes (`routes/…/@name/`)** — JS: `server/router.mjs` `scanRoutes` collects
  `slots: [{ ownerDir, name, routes, default, intercepts }]` (slot files are never in `routes`;
  intercepting `(.)x` files go to `slot.intercepts`; outside a slot, `table.intercepts`, not served),
  `matchSlot`; `handler.mjs` `resolveSlots` (owners cached per table + file in `slotOwners`, one
  length check without slots), `wrapLayouts` / `renderSlots` pass `slots` to the owner layout;
  `withRouteCss` / `withScripts` take the rendered slot files. Rust: `routes.rs` `is_slot_rel`,
  `is_intercept_segment`, `slot_route_patterns` (parity with `scripts/route-enumeration-parity.mjs`
  in `crates/nowaki/tests/route_js_parity.rs`); `budget.rs` `slot_files_for`. The worker routeTable
  carries `slots` (`edge-build.mjs`). Tests: `scripts/router-test.mjs`, `scripts/handler-test.mjs`,
  `examples/hello/routes/photos/`.
- **Intercepting routes (`@slot/(.)x`)** — the URL a file takes over: `router.mjs`
  `interceptTarget` / Rust `routes.rs` `intercept_target`, both run on
  `crates/nowaki-core/tests/fixtures/intercept-cases.json` (`slot_route_patterns` lists them for
  the parity test). Server (`handler.mjs`): `interceptAttrs` (a slot with intercepts always renders
  its `<nowaki-slot>`, with `data-nowaki-slot` = its id and `data-nowaki-intercepts` = the
  patterns as browser paths, base + locale prefix in front), `renderIntercept` (GET with
  `x-nowaki-intercept: <slot id>` → the fragment: `<template data-nowaki-head>` + the file,
  `private, no-store`, `x-nowaki-slot`), `varyIntercept` (`Vary: X-Nowaki-Intercept` on the full
  page); all behind `table.slots?.length` and the per-table `interceptIndex`. `start.rs`
  `isr_eligible` keeps those requests out of the ISR cache; `forward.rs` lets the header through.
  Client: `client/router.js` `interceptFor` / `apply` / `saveSlots` / `restoreSlots`,
  `router-core.js` `matchPattern`. Group boundaries carry `routes` (`groupRoutes`) for the
  client's `matchBoundary`. Tests: `scripts/router-test.mjs`, `scripts/router-cache-test.mjs`,
  `scripts/slot-browser-test.mjs` (Chrome: start, dev, `NOWAKI_CSP=enforce`, basePath + locale).
- **Page scripts (`export const scripts`)** — read from the AST in
  `crates/nowaki-core/src/page_scripts.rs`, emitted as client entries by
  `build.rs` `build_route_scripts` (manifest `routeScripts` per module and
  `scriptPreload`), counted by `budget.rs`. The tags come from `handler.mjs`
  `withScripts` via `env.routeScripts` (`app.mjs`, `web.mjs`, dev `sidecar.mjs`);
  `client/router.js` `loadPageScripts` + `nowaki:page-load` on navigation.
- **`public/`** — rules (path safety, dotfiles, reserved prefixes, content types) in
  `crates/nowaki-core/src/public.rs`; copied to `dist/public` by `build_with_client`.
  Served by `dev.rs` `serve_public` (straight from `public/`), `start.rs`
  `serve_public` (index built at startup), `server/public-files.mjs` (node / bun /
  deno), and as static files by `vercel-build.mjs`, `edge-build.mjs`
  (`dist/worker/assets`), and `prerender.rs`. A public file wins over a route at
  the same path.

## Conventions

- This repo is English-only: comments, docs, and user-facing strings are
  written in English, as are code identifiers.
- Keep comments minimal: write only the non-obvious *why* (ordering
  constraints, workarounds, perf reasons) and security/trust-boundary
  invariants. Don't restate the code, add section banners, narrate history, or
  leave commented-out code. Public API docs (`///` on `pub` items in
  `nowaki-core`, JSDoc in `*.d.ts`, clap `///` that becomes `--help`) and
  comments in scaffold templates / `examples/` that teach conventions stay.
- Keep changes minimal and idiomatic to the surrounding code.
- Don't commit secrets or `.env`. Only `PUBLIC_*` env reaches the client.
- Commit messages end with a `Co-Authored-By:` trailer (see git history).

## Releasing (maintainers)

Versions are synced across `Cargo.toml` (`[workspace.package]`), the `nowaki`
crate's `nowaki-core` path-dep version, and the four npm `package.json`s +
`create-nowaki/template` (`@nowaki-dev/markdoc` in `packages/nowaki-markdoc`
has its own semver). After bumping, run `pnpm install` so `pnpm-lock.yaml`
matches (CI uses a frozen lockfile). Then: `cargo publish -p nowaki-core` →
`-p nowaki`; push a `vX.Y.Z` tag (triggers `release.yml` for the CLI binaries);
`gh workflow run publish-npm.yml -f package=all` for runtime, markdoc, and
scaffolders.
