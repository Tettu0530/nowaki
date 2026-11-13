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
packages/nowaki-markdoc   `@nowaki-dev/markdoc`, the official Markdoc plugin (`.mdoc`).
examples/hello/       kitchen-sink app used by CLI tests + e2e.
examples/gallery/     the v0.18 + v0.19 exit-criteria app (basePath, i18n, modal routes, sessions,
                      env.ts; ISR posts with tags + revalidateTag, View Transitions, a Likes island
                      for HMR, a `budget`); scripts/gallery-e2e.mjs + gallery-browser-test.mjs.
benchmarks/           bench.mjs, head-to-head.mjs (Next/Astro), check-regression.mjs,
                      ci-perf.mjs + ci-perf-app/ (CI perf gate: head vs base vs last release,
                      all on the fixed ci-perf-app).
benchmarks/compare/   scaled benchmark against Astro / SvelteKit / Next / Nuxt
                      (build, TTFB, throughput; results in BENCHMARKS.md).
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
  POST / PUT / PATCH / DELETE requests to page actions and to API / file routes via
  `server/origin.mjs` (`isCrossSite`), after middleware and before the action or
  handler runs; GET / HEAD / OPTIONS skip the check. API routes and actions share
  the one `FORBIDDEN` response. Don't move the check after the
  action, and keep `csrf = false` as the only opt-out.
- **Every server sets the default security headers** (`security_headers.rs` for
  dev/start, `server/security-headers.mjs` for the adapters, `_headers` for
  static output). Add new defaults to both lists, and never overwrite a header
  the response already set.
- **The CSP nonce covers everything Nowaki inserts.** `csp.rs` / `server/csp.mjs`
  stamp `<script>` / `<style>` in HTML responses; client code that inserts a
  `<style>` (CSS shims, router head/body swaps, boundaries) must set
  `window.__nowakiNonce` on it. Fetched HTML goes through `router-core.js` `nonceStyles`
  before `DOMParser` (its document shares this one's CSP, so another response's nonce is a
  violation as it parses). Re-run the browser tests with
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
  its tools read-only. The dev toolbar's `/__nowaki/devtools` sits behind the
  same gate and stays read-only too; the toolbar is loaded only by dev `hmr.js`. Dev errors reach its log from the sidecar through a
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
- **ISR purges come only from the sidecar.** `start.rs` reads `x-nowaki-purge` / `x-nowaki-tags`
  from the sidecar's reply (never from the client: `forward::passes` drops them) and strips them,
  and any new internal response header, on **both** branches of `proxy`. The stdout channel needs
  `NOWAKI_PUBLISH_TOKEN`. `POST /__nowaki/revalidate` stays off unless `NOWAKI_REVALIDATE_SECRET`
  is set, and compares it in constant time.
- **Observability stays opt-in and free when off.** Server-Timing is off in production unless
  `NOWAKI_SERVER_TIMING=1`; tracing only with an OTLP endpoint (or a registered OTel API tracer).
  With everything off, `start.rs` pays one `Obs::active` check and the handler one `env.trace` /
  `ctx.__trace` null check per phase, allocating nothing. `x-nowaki-route` is internal (stripped
  on both `proxy` branches), and an ISR hit never replays a stored `server-timing`.
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

v0.19 at a glance (each has its entry below): on-demand revalidation and the CDN purge per
adapter (plus the Cloudflare Worker ISR cache), View Transitions, observability, Dev HMR / Fast
Refresh, the dev toolbar and the dev MCP. `examples/gallery` (`routes/posts/`) uses all of them,
and `scripts/gallery-e2e.mjs` / `gallery-browser-test.mjs` check the exit criteria end to end.

- **Dev MCP (`/__nowaki/mcp`)** — `crates/nowaki/src/mcp.rs` (JSON-RPC over
  Streamable HTTP, tools, error ring buffer); route table + island registry from
  the dev sidecar's `/__nowaki/dev-info` (`server/sidecar.mjs`); imports /
  importers from `crates/nowaki-core/src/graph.rs`. E2E: `scripts/mcp-e2e.mjs`.
  Tools `page` (dev-info `?url=` → `sidecar.mjs` `devPage`: route, layouts, middleware,
  `revalidate` / `tags`; then `mcp.rs` `page_js`: islands from `chunk::collect_app_modules` of the
  route + layouts + slots, `live_hint`, and the JS estimate: `module_closure` per group, dev
  transform → `chunk::minify_chunk` (cached per module output in `MINIFIED`) → one gzip, plus
  `dist/route-js.json` as the last build figure) and `live` (`LiveHub::stats`).
- **Dev toolbar** — `packages/nowaki-runtime/client/toolbar.js` (plain DOM in an open Shadow DOM
  root appended to `<html>`, outside `<body>`; a constructed stylesheet, or a nonced `<style>`),
  imported on idle by `client/hmr.js` unless `data-toolbar="0"` (`render.mjs` `HMR_SCRIPT`, from
  `--no-toolbar` / `NOWAKI_TOOLBAR=0`, set in `main.rs`) or `localStorage["nowaki:toolbar"]`
  is `"off"`. Data: `GET /__nowaki/devtools?url=` (`mcp.rs` `devtools`, the same functions as the
  MCP tools, the same `request_allowed` gate; listed in `forward::is_internal_path`). Timings come
  from the browser: the navigation entry's `serverTiming`, else the `timing` field of
  `nowaki:page-load` (`router.js` `fetchPage`, `hmr.js` `page`). Refreshes on `nowaki:page-load`,
  `nowaki:hmr` (also `{ type: "error" }`) and on tab changes. Editor links from `NOWAKI_EDITOR`
  (`mcp.rs` `EDITORS` / `editor_template`). Browser test: `scripts/toolbar-browser-test.mjs`
  (in e2e-dev).
- **Dev HMR / Fast Refresh** — `crates/nowaki/src/dev.rs` `apply_changes` →
  `plan_changes` (`css` / `hot` / `page` / `reload`, from the import graph walked up to
  island entries) → `hmr_messages` (bumps hot versions via `NowakiCore::bump_dev_version`;
  `transform.rs` `map_specifier` appends `?t=<n>`). The refresh transform runs only for dev
  browser modules of the app (`NowakiCore::set_dev_refresh`, `transform_file_dev`); a module
  that registers components imports `client/refresh.js` (families + an `options.vnode`
  proxy, public Preact API). `client/hmr.js` applies the messages. Live islands re-render
  through `/__nowaki/live-event`; `live::handle_versioned` reads the SSR version per render.
  `page` (routes, layouts, server-only modules only routes reach; sent after `css` / `hot` of
  the same batch): `hmr.js` `page` refetches `location.href` with the router's
  `x-nowaki-nav` (the open slot's fragment with `x-nowaki-intercept`), syncs the head region
  (a copy of `router.js` `syncHead` that keeps unchanged nodes) and `morphTree`s the body:
  the top-level `<nowaki-island>` / `<nowaki-live>` at each index is moved over when `src` +
  `props` (live: `name`) match, other nodes are patched in place or replaced; reloads on a
  non-200, a redirect or a page without head markers (the dev error page). It fires
  `nowaki:hmr`, on which `router.js` clears its Router Cache.
  Builds never see any of it. Browser test: `scripts/hmr-browser-test.mjs` (in e2e-dev).

- **On-demand revalidation (`revalidatePath` / `revalidateTag`, `export const tags`)** —
  `server/revalidate.mjs` (validation, path expansion over basePath / locales / trailingSlash,
  the `t:<tag>` / `p:<browser path>` entry encoding, `POST /__nowaki/revalidate`). Calls inside a
  request (page actions and API routes now run in `runWithContext`, like server functions and live
  events) collect on `ctx.__purge`; `handler.mjs` `finalize` hands them over before the response
  returns: `x-nowaki-purge` on `nowaki start` (`env.isrStore`, set by `prod-sidecar.mjs`), and the
  adapter seams `env.purge(entries)` / `env.cacheTagHeader(entries)` (set by `createApp({ cdn })`,
  Vercel only; see below). Outside a
  request, or after its response was built (`ctx.__purgeClosed`, set only on those wrapped
  requests): a `NOWAKI_PURGE <token>` stdout line (`start.rs::run`) or `env.purge`. ISR renders with tags send
  `x-nowaki-tags` (static arrays cached per module). Rust side: `start.rs` `IsrCache::purge` (one
  scan, delete) and `insert` (a purge epoch log keeps an in-flight render from re-storing purged
  content). The store is per process. Dev only records calls (dev-info `revalidations`); static
  output warns. Encoding fixture: `crates/nowaki/tests/fixtures/purge-cases.json` (`start.rs`
  units, `scripts/revalidate-test.mjs`); e2e in `scripts/ci/e2e-prod.sh` (`routes/isr-tagged.tsx`).
- **CDN purge per adapter** — `server/purge-vercel.mjs` `vercelCdn()`, passed as `createApp({ cdn })`
  by the function `vercel-build.mjs` generates. ISR renders send `Vercel-Cache-Tag` (`t:<tag>` and
  `p:<browser path>` through `cdnTag`: percent-encoded, `h:<hash>` past 256 bytes, the same on emit
  and purge); `purge` lazily imports `@vercel/functions` and calls `dangerouslyDeleteByTag` (16 tags
  per call, raced against a 2 s timeout), warning once when the package is missing.
  `vercel-build.mjs` `copyWithDeps` copies the package and its dependencies into the function when
  the app has it. Behavior per server:

  | Server | Tag header | Purge |
  | --- | --- | --- |
  | `nowaki start` | `x-nowaki-tags` (internal) | Rust ISR store, before the response |
  | vercel | `Vercel-Cache-Tag` | `@vercel/functions` `dangerouslyDeleteByTag`, awaited (2 s cap) |
  | node / bun / deno | none | warn-once no-op (no cache of their own) |
  | cloudflare | `Cache-Tag` (on the Cache API entry only) | local `cache.delete` of path entries + zone purge by tag with `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN`, awaited (2 s cap) |
  | static | none | warn-once no-op |

  On node / bun / deno / vercel, `app.mjs` drops the `nowaki start` cache headers
  (`x-nowaki-revalidate` / `-vary` / `-vary-query` / `-tags`, via `purge-cloudflare.mjs`
  `stripInternal`) from an ISR render before sending it; `Vercel-Cache-Tag` stays for Vercel.
  Tests: `scripts/purge-adapters-test.mjs` (mocked package, a generated function on port 5540);
  `scripts/ci/e2e-adapters.sh` checks the header from the built `examples/hello` function.
- **Cloudflare Worker ISR cache** — `server/purge-cloudflare.mjs` `cloudflareCdn()`, created by
  `web.mjs` `createFetchHandler` only when some page exports `revalidate` (else the worker runs
  as before). `fetch` sends eligible GET / HEAD requests (no `x-nowaki-intercept`, path not in
  the isolate's negative set) through `cached()`: `caches.default.match` of `<origin><path>`,
  which holds either the page (it varies on nothing) or a stub (`x-nowaki-stub` generation id,
  `x-nowaki-vary` names, query flag) pointing at the variant key
  `<origin><path>?__nowaki=<gen>&q=…&h.<name>=…`. The Cache API ignores Vary, hence the key.
  Stored only when `shareable(result)`: `x-nowaki-revalidate`, 200, string body (no stream),
  no Set-Cookie, `public, s-maxage`, no per-user Vary input (the handler's own signals; nothing
  re-derived). Entries are kept a year (`max-age`); `x-nowaki-stored` decides HIT / STALE, and
  a stale hit re-renders once per key per isolate in `ctx.waitUntil`. The render is stored
  before CSP (re-nonced per response); internal headers (`x-nowaki-revalidate` / `-vary` /
  `-vary-query`, `cache-tag`) never reach the browser. `purge(entries, ctx)` bumps an epoch (an
  in-flight render doesn't store), deletes `p:` entries at `<origin><path>` locally (dropping
  every variant via the stub), and calls `POST /zones/<id>/purge_cache` `{ tags }` (100 per call,
  `cfTag`: `server/cdn-tag.mjs` `cdnTag` capped at 240 characters so 65 tags fit Cloudflare's
  16 KB header; the worker must never import `purge-vercel.mjs`, whose lazy `@vercel/functions`
  import breaks wrangler's bundle, which `cf-cache-test.mjs` checks); a
  timed-out purge continues in `ctx.waitUntil` (`takePending`). `revalidatePath` / `-Tag`
  pass the request context to `env.purge` so the local delete knows the origin. Tests:
  `scripts/cf-cache-test.mjs` (mocked `caches.default` and fetch), the built worker in
  `scripts/edge-handler-test.mjs`.
- **Observability (Server-Timing, JSON logs, OpenTelemetry, health)** — env vars:
  `NOWAKI_SERVER_TIMING=1` (always on in dev), `NOWAKI_LOG=json`, and the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (tracing is on iff one is set
  and `OTEL_SDK_DISABLED` isn't true), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`,
  `OTEL_TRACES_SAMPLER` / `_ARG`, `OTEL_BSP_SCHEDULE_DELAY` / `_MAX_EXPORT_BATCH_SIZE` /
  `_MAX_QUEUE_SIZE`. Rust: `crates/nowaki/src/obs.rs` (one `OnceLock`: config, traceparent,
  sampler, spans, the bounded batch exporter over reqwest, plain HTTP only; log lines; the
  Server-Timing tail); `start.rs` `handle` → `observed` (only when `Obs::active`: the SERVER span,
  `isr` + `total`, the access log), `proxy` (CLIENT span, `forward::apply_traced` replaces the
  client's `traceparent`, reads the internal `x-nowaki-route`), `health` (`/__nowaki/health`, a
  cached 1 s sidecar ping); `live.rs` `render_once` (a span per WS event / refresh, `traceparent`
  on `/__nowaki/live-render`). JS: `server/trace.mjs` (`env.trace`, null when off: the handler does
  `ctx.__trace?.begin/end` around middleware, loader, render, action, API, server functions and
  POST live events, and `finish` in `finalizeResult` writes `server-timing` and, for
  prod-sidecar.mjs, `x-nowaki-route`), `server/otel.mjs` (config, OTLP JSON, fetch exporter; the
  worker flushes in `waitUntil`), the `@opentelemetry/api` bridge (used when the app registered a
  tracer), `server/log.mjs` (every runtime error log; text mode reads as before),
  `server/health.mjs`. `env.trace` is set by `app.mjs`, `web.mjs` and dev `sidecar.mjs`. `kept_headers`
  never stores `server-timing`. Shared fixture: `crates/nowaki/tests/fixtures/otel-cases.json`
  (`obs.rs` units, `scripts/otel-test.mjs`); e2e: `scripts/otel-e2e.mjs` (a local OTLP receiver,
  in e2e-prod), `scripts/ci/e2e-{dev,prod,adapters}.sh`, `scripts/edge-handler-test.mjs`.
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
  `server/fonts-fetch.mjs`, config via `site.rs` / `plugins.rs` (normalized by `server/site-config.mjs`); the links go into
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
  (`dist/server/site.json`, normalized by `server/site-config.mjs`), `NOWAKI_SITE` winning. Unit checks:
  `scripts/seo-unit-test.mjs`.
- **Routing config (`basePath`, `trailingSlash`, `redirects`, `rewrites`, `headers`)** —
  normalized and validated by `server/site-config.mjs`, read before the build (in the plugin
  host's Node process, `plugins.rs` `spawn`, or by `site.rs` `config` on its own) and
  written to `dist/server/routing.json` (dev: `.nowaki/routing.json`). The compiler / matcher
  exists twice, `crates/nowaki-core/src/rules.rs` and `server/rules.mjs`, driven by one fixture
  (`crates/nowaki-core/tests/fixtures/rules-cases.json`, run by `tests/rules.rs` and
  `scripts/rules-test.mjs`); change both together. The segment grammar is shared with the router
  through `server/segments.mjs`. Applied at the fronts by `crates/nowaki/src/front.rs`
  (`start.rs` `handle`, `dev.rs` `serve_or_proxy`, the headers layer; the route path reaches the
  sidecars in `x-nowaki-route-path` → `info.routePath`) and `server/front.mjs` (`app.mjs` `handle`,
  the worker `fetch` from `edge-build.mjs`); Vercel platform routes from `server/vercel-routes.mjs`,
  static `_redirects` / `_headers` from `prerender.rs`. Without a routing config each front does
  one null check. With `i18n`, the engines match rule sources without the locale prefix
  (`locale: false` opts a rule out) and put the locale back on internal destinations; the
  handler then splits the locale off the route path once, as for any request. Tests:
  `scripts/rules-front-test.mjs`, `scripts/rules-e2e.mjs` (every front).
- **Route groups (`routes/(name)/`)** — no URL segment. JS: `server/router.mjs` `scanRoutes`
  (URL without groups, `dir` stays physical, collision error; group `_middleware` marked
  `group` and run by containment in `handler.mjs` `runMiddleware`; boundaries keep their
  physical `prefix` for the server and a group-free `urlPrefix`, and reach the client with the
  routes they cover from `handler.mjs` `groupRoutes`). Rust: `routes.rs` `strip_route_groups` (in
  `url_pattern_from_stem`) and `check_url_conflicts` (called by `build_with_client`). Layout /
  CSS lookups stay on physical dirs. Tests: `scripts/router-test.mjs`, `routes.rs` units.
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
- **View Transitions (opt-in)** — per link: `<Link viewTransition>` (`navigation.js`) renders
  `data-nowaki-transition`, which the router also honours on a plain `<a>` or an ancestor. Per
  route: `export const viewTransition = true`; `document.mjs` `pageMeta` appends
  `<meta name="nowaki-view-transition">` and a `@view-transition { navigation: auto }` style
  (cross-document, inside `prefers-reduced-motion: no-preference`) to the head region, so it
  reaches every front that uses `pageMeta` (dev `render.mjs`, `prodDocument` / `prodShell`,
  `prod-sidecar.mjs` → `start.rs::assemble`) and is nonced like any other `<style>`. Without the
  export the HTML is byte-identical. Client: `client/router.js` `apply` → `swap` wraps the DOM
  swap (title, `syncHead`, body or slot) in `document.startViewTransition` when
  `router-core.js` `shouldTransition` agrees (opted in, API present, no reduced motion); hydration,
  page scripts and `nowaki:page-load` run after `updateCallbackDone`, and the `navToken` check
  runs inside the update callback. Types `forward` / `back` (`history.state.i` orders entries;
  skipped on `hasUAVisualTransition`). `transitionName()` in `navigation.js` gives a `style` its
  `viewTransitionName`. All of it is in the lazy router chunk (`lazyBytes`, budget +350 B gzip).
  Tests: `scripts/router-test.mjs`, `scripts/router-browser-test.mjs` (also with
  `NOWAKI_CSP=enforce` and `BASE=…/app`), `scripts/ci/e2e-{dev,prod,adapters}.sh` (`/vt`).
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

## API snapshots

`api/*.txt` is the public surface (runtime `.d.ts` exports per subpath, route exports,
file conventions, config keys, CLI flags, env vars, `/__nowaki/*` endpoints, client
events), generated by `scripts/api-surface.mjs` (format in `api/README.md`). A change
to any of them updates the snapshot in the same PR: run `node scripts/api-surface.mjs`
(it also runs `NOWAKI_UPDATE_SNAPSHOTS=1 cargo test -p nowaki --bin nowaki cli_surface`
for `api/cli.txt`), classify any `[unclassified]` name, and commit the diff. CI runs
`--check`; from 0.20.0 a removed or changed `[stable]` entry needs the `breaking` PR
label. Don't edit generated lines by hand, except the section and the text of entries
in the classified files (`env.txt`, `http.txt`, `client.txt`, `route-exports.txt`).
Details: [CONTRIBUTING.md § API snapshots](./CONTRIBUTING.md#api-snapshots).

## Releasing (maintainers)

Since 0.19.3 the CLI and crates (`Cargo.toml` `[workspace.package]`, the `nowaki`
crate's `nowaki-core` path-dep version, `packages/nowaki-cli`), `@nowaki-dev/runtime`
and `create-nowaki` / `create-nowaki-app` share one version and are bumped together;
`@nowaki-dev/markdoc` (`packages/nowaki-markdoc`) keeps its own semver (0.1.x). The
CLI refuses a runtime older than its own version (`runtime::MIN_RUNTIME`). The
scaffold template (`packages/create-nowaki/templates/_shared/package.json`) pins
that version for both. After bumping, run `pnpm install` so
`pnpm-lock.yaml` matches (CI uses a frozen lockfile). Then: `cargo publish -p
nowaki-core` → `-p nowaki`; push a `vX.Y.Z` tag (triggers `release.yml` for the
CLI binaries); `gh workflow run publish-npm.yml -f package=all` for runtime,
markdoc, and scaffolders (a version already on npm is skipped, via
`scripts/ci/npm-publish-if-new.sh`). See [docs/RELEASING.md](docs/RELEASING.md).
