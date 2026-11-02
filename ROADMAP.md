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

**alpha (CLI / crates 0.12.x, published on crates.io / npm)**. `npm create nowaki` scaffolds an app, and `nowaki dev / build / start / prerender` work end to end. Routing, loader/action, middleware, API routes, Islands, Jetstream (server-reactive islands, on `nowaki dev` / `nowaki start`; the deploy adapters render them as initial SSR only), server functions, 6 deploy adapters (node / static / bun / deno / cloudflare / vercel), and plugins/virtual modules are all in place. Production use is not yet recommended (the API is still stabilizing).

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
With **Jetstream islands**, an island that has `export const live = { state, on }` works without shipping its component JS to the client. The server holds state per WebSocket connection and pushes HTML patches. It coexists with client islands (optimistic UI) and degrades to the initial SSR on static deploys and the deploy adapters, which have no live transport yet.

### v0.7 "Beta": Groundwork for stability ✅
A `cargo test` suite, reproducible benchmarks ([BENCHMARKS.md](./BENCHMARKS.md)), documented trust boundaries ([SECURITY.md](./SECURITY.md)) with dependency auditing in CI, SemVer discipline and [CHANGELOG.md](./CHANGELOG.md).

### v0.8–v0.9 "Beta": Expansion and real-world readiness ✅
**Server functions (`"use server"` RPC)**, head-to-head benchmarks against Next/Astro + regression detection in CI, broader tests (router snapshots, Jetstream load), Jetstream presence and connection scaling, **plugin virtual modules (resolveId / load)**, docs site (`/docs`).

> State-preserving (prefresh) HMR is a follow-up (island hot-swap already exists). Scoped CSS for TSRX islands also continues.

### v0.10–v0.12 "Beta": DX & security audit ✅
An interactive wizard and template selection for `npm create nowaki`, dev/start banners. A multi-stage security audit of the dev/prod servers (15 issues, including file reads, CSRF on RPC, CSWSH, live state signing, and Vary on ISR), plus a CI regression suite that guards them (`scripts/security-e2e.mjs`).

### v0.13 "Zephyr": Solid footing
Before adding big features, make the code easier to read and harder to break.

**Exit criteria**: The comment policy is documented in AGENTS.md and the code follows it. Route enumeration has a single implementation on the Rust side. Live island state no longer resets to initial values on reconnect.

- [ ] Comment minimization (no behavior changes)
- [ ] Consolidate route enumeration in `nowaki-core` (shared by typegen / prerender, with a test cross-checking the JS-side routeTable)
- [ ] Restructure SECURITY.md and add a "Security invariants" section to AGENTS.md
- [ ] Sanitize incoming headers at the Rust front (`x-forwarded-host` / `x-nowaki-*`, `NOWAKI_TRUST_PROXY`)
- [ ] Jetstream: carry signed state in patches (fixes state resetting to initial values on reconnect)
- [ ] Jetstream: make the session loop async; sidecar timeouts and error reporting

### v0.14 "Gale": Secure by default
Safe without any configuration. Every claim is verified in CI on every push.

**Exit criteria**: Each row of SECURITY.md's "defenses enabled by default" maps to an implementation location and a CI check. security-e2e passes the same checks in both dev and prod.

- [ ] Origin checks by default for page actions and non-GET requests (phased rollout for API routes; opt out with `export const csrf = false`)
- [ ] Default security headers (nosniff / frame-ancestors / Referrer-Policy / COOP, also on ISR HITs)
- [ ] Body and argument limits for server functions, `serverFn(schema, impl)` (Standard Schema), a build warning for unvalidated exports
- [ ] Less error detail exposed in prod (`ServerFnError`); hardened handling of the live signing key (warning when unset, `iat` and max lifetime)
- [ ] CI: all checks in all modes, unit tests for the edge path, make `pnpm audit` required
- [ ] CSP nonce support (starting with Report-Only)

### v0.15 "Cyclone": Jetstream 2 ★flagship
Make "LiveView for the npm ecosystem, with 0KB of component JS" practical. Forms and inputs, authenticated handlers, live queries that push external changes, and state shared across connections (rooms).

**Exit criteria**: State survives reconnects and server restarts. `publish()` delivers patches to islands on other connections. A two-tab voting demo works with per-room presence. Fan-out p95 at 1000 connections is recorded in BENCHMARKS.md.

- [ ] More events (submit / input / change, debounce, keyed morph)
- [ ] Stable signing key, stale notifications, resume token (optional)
- [ ] Read request context from handlers (`getContext()`, `live.authorize`)
- [ ] Live queries (`subscribe` / `load` / `publish`, a Node→Rust event path)
- [ ] Multiplayer rooms (`room` / `shared` / per-room presence)
- [ ] Document in the docs that it assumes a single process and does not support edge

### v0.16 "Chinook": Show it with numbers
Prove the differentiation with numbers and tooling.

**Exit criteria**: `nowaki build` reports first-load JS per route and fails when a budget is exceeded. TTFB and Jetstream benchmark results are in the docs. Claude Code can connect to the `nowaki dev` MCP.

- [ ] Per-route client JS budgets (`export const budget`)
- [ ] Build-time "this island could be live" suggestions (including moving live detection to the AST)
- [ ] Serve ISR / static pages from Rust alone right after startup (prerender ingestion, ETag / 304, pre-gzip, TTFB measurement)
- [ ] An MCP endpoint for `nowaki dev` (routes, module graph, recent errors)
- [ ] Polish Jetstream docs, demos, and benchmarks

### v1.0 "Nowaki": Stable release
**Exit criteria**: Stability guarantees for the public API, complete documentation, established governance.

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
