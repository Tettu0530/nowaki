# Security Policy

Nowaki is a full-stack framework with a **Rust HTTP front** (dev/start) and **Node
sidecars** (SSR, plugins). Production traffic should hit `nowaki start` or a deploy
adapter output — not `nowaki dev`. This document covers reporting, trust boundaries,
and defenses the framework applies by default.

## How this document is organized

| Audience | Start here |
|----------|------------|
| Vulnerability reporters | [Reporting a vulnerability](#reporting-a-vulnerability) |
| App authors operating a deployment | [Trust boundaries](#trust-boundaries) (especially [application author responsibilities](#application-author-responsibilities)) |
| Framework contributors and coding agents | [Defenses enabled by default](#defenses-enabled-by-default) plus the [Security invariants](./AGENTS.md#security-invariants) checklist in AGENTS.md |

## Supported versions

Nowaki is in alpha; only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Report security issues privately through
[GitHub private vulnerability reporting](https://github.com/Tettu0530/nowaki/security/advisories/new).
Do not open a public GitHub issue. Include reproduction steps and the affected
version or commit. We aim to acknowledge reports within 72 hours.

The dev server (`nowaki dev`) is a **development tool**. It serves files from the
local filesystem (e.g. `/@fs/`) by design and must never be exposed to untrusted
networks. Reports about the dev server are still welcome, but production-facing
issues (`nowaki build` output, SSR runtime, adapters) take priority.

## Trust boundaries

### Rust front vs Node sidecars

| Component | Role | Exposure |
|-----------|------|----------|
| `nowaki dev` / `nowaki start` (Rust) | HTTP entry, static assets, ISR cache, Jetstream WS, proxy to sidecar | Intended to be user-facing in prod (`start`) or localhost-only (`dev`) |
| SSR / prod sidecar (`packages/nowaki-runtime/server`) | Route rendering, server functions, actions | **127.0.0.1** ephemeral port; reached only via the Rust process |
| Plugin host | `nowaki.config` transforms at dev/build | Localhost only |
| Jetstream `/__nowaki/live-render` | Re-evaluate live islands | Localhost only; invoked by Rust |
| Dev sidecar `/__nowaki/dev-info` | Route table and island registry for the dev MCP | Localhost only; invoked by Rust (`nowaki dev`) |
| Dev MCP `/__nowaki/mcp` (`nowaki dev` only) | Read-only routes / module graph / recent errors for coding agents | Loopback peers with a loopback `Host` / `Origin`, even under `--host` |
| Dev toolbar data `GET /__nowaki/devtools` (`nowaki dev` only) | The page / live / recent-errors data the dev toolbar shows (same functions as the MCP tools) | Same gate as the MCP endpoint; a LAN client under `--host` gets 403 and the toolbar hides itself |
| `POST /__nowaki/revalidate` | Purge the ISR cache by path or tag (fan-out across `nowaki start` instances) | Off (404) unless `NOWAKI_REVALIDATE_SECRET` is set; then any client holding the secret |
| `GET /__nowaki/health` | Liveness for load balancers and orchestrators (`{"status":"ok"}` / 503) | Public on every server; no data in it, `no-store`. On `nowaki start` Rust answers it and pings the sidecar at most once a second |

Sidecars are not designed to be exposed directly on a network interface.

The Rust front decides which request headers reach a sidecar
(`crates/nowaki/src/forward.rs`). It drops client-sent `x-forwarded-*`,
`forwarded`, and `x-real-ip` headers and every internal `x-nowaki-*` header
(only `x-nowaki-rpc`, `x-nowaki-nav`, `x-nowaki-live` and `x-nowaki-intercept` pass). It then sets `x-forwarded-host`
from `Host` and `x-forwarded-proto` to `http`, and `x-nowaki-route-path` when a
nowaki.config rewrite or `basePath` changes the path a request is routed by. Behind a reverse proxy that sets
these headers itself, set `NOWAKI_TRUST_PROXY=1`: the first `x-forwarded-host`
/ `x-forwarded-proto` value is used (for the RPC and WebSocket same-origin
checks) and `x-forwarded-for` is passed through. Leave it unset when clients
reach `nowaki start` directly, or they can choose the host those checks compare
against.

### Dev-only surfaces

- **`/@fs/`** — Serves files under allowed roots (app root, workspace root) so
  on-demand transforms and pnpm realpaths work. Canonicalize, allow-root, and
  deny-list gates apply (see `crates/nowaki/src/dev.rs`). **Never enabled in
  production** (`nowaki start` and adapters serve only `dist/`).
- **`/__nowaki/ssr-module`** — Dev SSR loader; path allowlisting matches `@fs`
  policy.
- **Virtual modules** — Resolved through the plugin bridge; traversal in the URL
  path is rejected.

Treat `nowaki dev` as **localhost-only** (or LAN only with `--host`, understanding
the expanded attack surface).

### Production asset serving

- **`/_nowaki/<file>`** — Resolved by **basename** against `dist/client`, so
  `../` cannot escape the client output directory (`crates/nowaki/src/start.rs`).

### Secrets and client-visible env

- Only `import.meta.env.PUBLIC_*` and `MODE` are inlined into client bundles.
  Other `.env` values stay on the server. `.env*` files are gitignored.
- With an `env.ts`, only its declared `public` variables (all `PUBLIC_*`) are
  inlined. `@nowaki-dev/runtime/env/server` holds the server values; a client
  import of it fails the build, and validation errors name a variable without
  printing its value.
- Server function errors return **`error.message` only**, not stacks
  (`packages/nowaki-runtime/server/functions.mjs`).

### Build-time code you trust

Plugins (`nowaki.config`) and TSRX (`@tsrx/preact`) run as Node during dev/build
with your project's privileges — treat them like any build dependency. They do
not run on the production request path unless you embed their output in the app.

### Application author responsibilities

- **Content Security Policy (opt-in).** `NOWAKI_CSP=report-only` sends
  `Content-Security-Policy-Report-Only` and `NOWAKI_CSP=enforce` sends
  `Content-Security-Policy`, with `script-src` / `style-src-elem` limited to
  `'self'` plus a nonce that Nowaki adds to every `<script>` and `<style>` in the
  HTML (including `export const head`). `NOWAKI_CSP_REPORT_URI` adds a
  `report-uri`. Start with `report-only`: inline event handlers (`onclick="…"`),
  `javascript:` URLs, and third-party scripts are blocked under `enforce`. A
  response that sets its own CSP is left alone. **A CDN that caches HTML**
  (`s-maxage` on Vercel) caches the nonce too, so every visitor of a cached copy
  gets the same one; `nowaki start`'s own ISR cache and the Cloudflare Worker's
  ISR cache re-nonce each response.

- **Set `NOWAKI_LIVE_SECRET`** in production when the app has live islands.
  Without it, each process signs live state with its own random key: state
  can't resume after a restart or on another instance, and `nowaki start` /
  the node adapter log a warning at startup. On the adapters every live event
  is a POST that any instance may serve, so without a shared secret events fail
  as soon as more than one instance (or Worker isolate) is running.
- **Cross-site writes.** Page actions and API routes (`routes/api/**` and file
  routes such as `feed.xml.ts`) reject cross-site POST / PUT / PATCH / DELETE
  requests with 403 (since 0.19.0 for API routes). A route that must accept
  them (a webhook, a third-party callback) exports `csrf = false` and
  authenticates its caller another way (a signature, a shared secret), never
  with cookies. Requests without `Origin` or `Sec-Fetch-Site` (curl,
  server-to-server, most native apps) are allowed, so authenticate those another
  way too. `_middleware` runs before the check. Behind a
  proxy that rewrites `Host`, forward the public host as `x-forwarded-host` (and
  set `NOWAKI_TRUST_PROXY=1` for `nowaki start` and adapter runtimes), or
  same-origin posts are rejected too.
- **Default security headers are only defaults.** A response that sets one of
  them (or its own `content-security-policy`) keeps its value. For example, an
  OAuth popup flow that needs `window.opener` can send
  `cross-origin-opener-policy: same-origin-allow-popups`.
  `NOWAKI_SECURITY_HEADERS=off` removes them all (on the Vercel adapter, also
  set it at build time: the headers for static files are written into the route
  config).

Framework defaults do not replace app-level checks:

- **Server functions (`"use server"`)** — Allowlisted RPC only, but each export
  is still a public endpoint: validate JSON arguments and authorize via
  `getContext()` (cookies/headers).
- **Jetstream `on` handlers** — State is server-held per WebSocket connection,
  or sent back by the client (signed) with each POST event; validate event
  payloads like any server handler.
- **Actions / API routes** — Cross-site writes are rejected by default (see table
  below); authentication, authorization and input validation are your
  concern, as are routes that opt out with `csrf = false`.

## Defenses enabled by default

These are implemented in the repo today. When you change one, keep this table
accurate and follow the [Security invariants](./AGENTS.md#security-invariants)
checklist (extend `scripts/security-e2e.mjs` when CI does not already cover the
behavior). v0.14 mapped most rows to automated checks (last column); add or update
tests when you change a default defense.

| Defense | What it limits | Primary location | CI regression |
|---------|----------------|------------------|---------------|
| `@fs` / `ssr-module` allow roots + deny sensitive paths | Arbitrary file read via dev URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Dev fallback does not serve `.env` | Secret file leak via catch-all | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Virtual module `..` rejected | Path traversal in plugin URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Server function allowlist | Calling arbitrary server exports | `nowaki-core` + `dist/server/functions.json` + `functions.mjs` | e2e scripts (`/__nowaki/fn` unknown id → 404) |
| RPC CSRF gate (JSON + `x-nowaki-rpc` + Origin/Host) | Cross-site POST with victim cookies | `packages/nowaki-runtime/server/functions.mjs` (`browserHost`); Rust sets `x-forwarded-host` from browser `Host` on the sidecar hop | `scripts/security-e2e.mjs` (dev + prod), `scripts/edge-handler-test.mjs` (Edge) |
| Server function input and error limits | Oversized or malformed RPC payloads; internal error messages reaching the client | `server/functions.mjs`: bodies over `NOWAKI_FN_BODY_LIMIT` (default 1 MiB) → 413, more than 16 arguments → 400, errors other than `ServerFnError` → generic 500 in production. `serverFn(schema, impl)` (`server/server-fn.mjs`) validates the first argument with a Standard Schema; `nowaki build` warns about exports that take arguments without it | `scripts/security-e2e.mjs` (dev + prod), `scripts/ci/e2e-prod.sh` (build warning) |
| Same-origin check on page actions and API routes (`server/origin.mjs`) | Cross-site form posts and `fetch` writes with the victim's cookies | `server/handler.mjs`: a POST / PUT / PATCH / DELETE to a route with `action`, or to an API or file route, is rejected (403, after middleware) when `Origin` is another site or `null`, or `Sec-Fetch-Site` is `cross-site`; GET / HEAD / OPTIONS are never checked. The same code runs on dev, `nowaki start` and every adapter. `export const csrf = false` opts a route out (`csrf = true` is the default and still accepted) | `scripts/handler-test.mjs`, `scripts/security-e2e.mjs` (dev + prod), `scripts/edge-handler-test.mjs` (Edge), `scripts/ci/e2e-adapters.sh` (node, vercel), `scripts/ci/e2e-runtimes.sh` |
| Opt-in CORS (`nowaki.config` `cors`, off by default) | Cross-origin *reads* of app/API responses from listed browser origins; credentialed fetches when `credentials` is true and origins are explicit (not `*`) | `server/cors.mjs` + `server/handler.mjs`: preflight for browser `OPTIONS` with `Access-Control-Request-Method`; never on `/__nowaki/*` or `/_nowaki/*`; does not relax RPC, live-event, or page-action CSRF gates | `scripts/cors-test.mjs` |
| Default security headers (`x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `cross-origin-opener-policy: same-origin`, and `content-security-policy: frame-ancestors 'self'` when the app sends no CSP) | MIME sniffing, clickjacking, cross-origin referrer and `window.opener` leaks | `crates/nowaki/src/security_headers.rs` (dev/start, ISR hits, static assets); `server/security-headers.mjs` (node/bun/deno/vercel/cloudflare adapters); `_headers` from `nowaki prerender` | `scripts/security-e2e.mjs` (dev + prod), `scripts/ci/e2e-adapters.sh`, `scripts/ci/e2e-runtimes.sh` |
| Opt-in CSP with a per-response nonce (`NOWAKI_CSP=report-only` or `enforce`) | Injected inline scripts and styles | `crates/nowaki/src/csp.rs` (dev/start, streamed and ISR responses), `server/csp.mjs` (adapters); every `<script>` / `<style>` gets the response's nonce; the client runtime stamps it on styles it inserts (island CSS, client navigation, boundaries) | `scripts/csp-e2e.mjs` (start + node adapter), `scripts/csp-test.mjs`, browser tests under `enforce` |
| Live request context and `live.authorize` | Unauthorized live events; leaking internal headers to handlers | `crates/nowaki/src/live.rs` `context_headers` (only cookie, authorization, accept-language, user-agent, and the public host from the upgrade); `server/live.mjs` (`authorize` after the signature check, before the handler; refusal → `forbidden`) | `scripts/livetest.mjs` (dev + prod) |
| Internal sidecar endpoints not proxied (`/__nowaki/live-render`, `/__nowaki/dev-info`) | Calling the trusted re-render endpoint with a forged request context or replayed state; listing app files through the public port | `crates/nowaki/src/forward.rs` `is_internal_path` (404 in dev/start; `/__nowaki/mcp` is listed too, so `start` never forwards it) | `scripts/security-e2e.mjs` (dev + prod), `scripts/mcp-e2e.mjs` |
| Dev MCP endpoint is loopback-only (`/__nowaki/mcp`, `nowaki dev` only) | Reading routes, source paths, and error text (which can quote source) from another machine under `--host`, or from a web page via DNS rebinding | `crates/nowaki/src/mcp.rs` `request_allowed`: the TCP peer must be loopback, `Host` must be `localhost` / `127.0.0.1` / `[::1]`, and `Origin`, when sent, must be loopback (403 otherwise). Read-only tools; `module_graph` only reads app modules under the root and skips `.env` / `.git` / keys | `crates/nowaki/src/mcp.rs` unit tests, `scripts/mcp-e2e.mjs` |
| Dev toolbar endpoint is loopback-only and dev-only (`GET /__nowaki/devtools`) | Reading route files, island sources' sizes, error text and the app root path from another machine under `--host` or through DNS rebinding; dev tooling leaking into production pages | `crates/nowaki/src/mcp.rs` `devtools` runs `request_allowed` first (403 otherwise; read-only); `forward::is_internal_path` lists the path, so `nowaki start` returns 404; the toolbar script is loaded only by dev `client/hmr.js`, which only dev `server/render.mjs` injects; editor links are built in the browser from `NOWAKI_EDITOR` templates whose scheme isn't `javascript:` / `data:` (the server never starts an editor) | `scripts/mcp-e2e.mjs`, `scripts/toolbar-browser-test.mjs`, `scripts/ci/e2e-prod.sh` and `e2e-adapters.sh` (no toolbar / hmr reference in start, node, cloudflare and static pages; 404 on start / node) |
| `publish()` channel (sidecar → Rust) | Triggering live refreshes from outside, or from log output | The sidecar writes `NOWAKI_PUBLISH <token> <topic>` to stdout; `crates/nowaki/src/live.rs` accepts it only with the per-process `NOWAKI_PUBLISH_TOKEN` it gave its own sidecars, with topics capped (16 per island, 128 chars). No network endpoint | `crates/nowaki/src/live.rs` unit tests, `scripts/livetest.mjs` |
| Live rooms bound to the signed state | Joining another room's shared state by naming it | `server/live.mjs`: a room island's signed state is `{ room }`; renders and handlers read the shared state of that signed room only, so a forged room fails the signature check | `scripts/livetest.mjs` (forged room refused) |
| Forwarding and internal headers sanitized at the Rust front; adapter runtimes mirror host trust | Spoofing the host the same-origin checks use; forging internal `x-nowaki-*` headers | `crates/nowaki/src/forward.rs` (`NOWAKI_TRUST_PROXY` opt-in); `server/origin.mjs` `browserHost()` on Node/Edge adapters | `scripts/security-e2e.mjs` (dev + prod), `scripts/origin-test.mjs`, `scripts/edge-handler-test.mjs` (Edge forwarded-host spoof) |
| Jetstream POST transport gate (`POST /__nowaki/live-event`) | Cross-site live events with the victim's cookies; oversized bodies; handlers running on forged state | `server/live-event.mjs` (same shape as RPC: `application/json` only → 415, `x-nowaki-live: 1` required and cross-site `Origin` / `Sec-Fetch-Site` rejected via `server/origin.mjs` → 403, bodies over 64 KiB → 413, generic error bodies); the signature is verified in `server/live.mjs` before any handler (forged → 403, no html); handler names must be own keys of `live.on`; served by dev/start (via the sidecar) and every adapter. The Rust fronts answer 404 for the sidecar-internal `/__nowaki/live-render` (`dev.rs`, `start.rs`) so it cannot be used to skip the gate | `scripts/security-e2e.mjs` (dev + prod), `scripts/edge-handler-test.mjs` (Edge), `scripts/ci/e2e-adapters.sh` (node adapter) |
| Dev `Host` check (DNS rebinding) | A web page rebinding its name to 127.0.0.1 and reading dev responses (server-only source and source maps, `/@fs/`, `.npmrc`) | `crates/nowaki/src/dev.rs` `host_guard` layer: on the default bind every route answers 403 unless `Host` is `localhost` / `127.0.0.1` / `[::1]`; `--host` accepts any `Host` | `crates/nowaki/src/dev.rs` unit tests |
| Config redirects can't leave the site; the route path header is internal | Open redirects through a capture (`//evil.com`, `/\evil.com`, `https:%2F%2F…`), header injection through an encoded CR / LF, and a client choosing the route a request renders | `nowaki-core` `rules.rs` / `server/rules.mjs`: captures are percent-encoded per segment and an internal location must start with exactly one `/` (else 404); external hosts are config literals. The fronts (`crates/nowaki/src/front.rs`, `server/front.mjs`) send redirects with the security headers and never apply rules to `/__nowaki/*`; under `basePath`, `<base>/__nowaki/*` is moved to `/__nowaki/*` before routing (`front.rs` `base_layer`, `front.mjs` `frontStep`), so internal endpoints still 404 and the same CSRF / Origin checks run. `x-nowaki-route-path` (the rewritten route) is set by the Rust front after `forward.rs` drops any client value; the adapters compute it in-process and never read it. Vercel platform redirects (`server/vercel-routes.mjs`) only match captures that need no encoding | `scripts/security-e2e.mjs` (dev + prod), `scripts/rules-e2e.mjs` (start, dev, node, cloudflare, vercel, static), `scripts/edge-handler-test.mjs`, `scripts/rules-front-test.mjs`, `front.rs` / `forward.rs` unit tests |
| WebSocket Origin check (CSWSH) | Cross-origin upgrades to HMR / Jetstream | `crates/nowaki/src/dev.rs`, `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (dev + prod) |
| Jetstream state signature | Forged live state used in render/handlers; replaying a captured state indefinitely | `server/live-sign.mjs` (`v1.<iat>.<mac>`: HMAC over name, issue time, and state; rejected after `NOWAKI_LIVE_MAX_AGE`, default 24 h); `server/live.mjs` (verify before each render/handler); `crates/nowaki/src/live.rs` (holds state per session) | `scripts/security-e2e.mjs` (dev + prod), `scripts/live-sign-test.mjs` |
| ISR cache key + `Vary` learning | Cross-user HTML cache bleed | `server/context.mjs` (`__vary()`), `server/handler.mjs` (`x-nowaki-vary`; a response with `Set-Cookie` gets `private, no-cache` instead of a shared `Cache-Control`); `crates/nowaki/src/start.rs` (`isr_key`, folding in the public host; `Set-Cookie` responses are never stored); an intercepting route's fragment request (`x-nowaki-intercept`) is never answered from or stored in the ISR cache (`start.rs` `isr_eligible`), the fragment is `private, no-store`, and the full page at that URL sends `Vary: X-Nowaki-Intercept` (`handler.mjs`); e.g. `examples/hello/routes/vary.tsx`, `isr-sets-cookie.tsx`. The Cloudflare Worker's cache (`server/purge-cloudflare.mjs` `shareable`) stores only renders the handler marked shared (`public, s-maxage`, no `Set-Cookie`, no cookie / authorization / raw-request read), keys them by origin, path and the varied header and query values (the Cache API ignores `Vary`), and skips intercept fragments | `scripts/security-e2e.mjs` (prod), `scripts/ci/e2e-prod.sh`, `scripts/slot-browser-test.mjs`, `scripts/ci/e2e-adapters.sh`, `scripts/edge-handler-test.mjs`, `scripts/cf-cache-test.mjs` |
| Sessions (`ctx.session`) | Reading or forging another visitor's session; cross-site requests writing to the victim's session; sessions without a real key in production | `server/session.mjs`: keys from `NOWAKI_SESSION_SECRET` via HKDF-SHA256 (WebCrypto only). Cookie store: AES-256-GCM with a random 96-bit IV and the cookie name as additional data, expiry inside the ciphertext; store mode: a random 256-bit id with an HMAC-SHA256 tag checked by `crypto.subtle.verify`. A tampered, foreign, or expired cookie reads as an empty session. The cookie is `HttpOnly; SameSite=Lax; Path=/` (`Path=<basePath>` under nowaki.config `basePath`), `Secure` over https, at most 4 KB. `server/handler.mjs`: a cross-site non-GET (`isCrossSite`, unless the route has `csrf = false`) sees an empty, read-only session from middleware on; live renders get a read-only one. Production refuses a session without the secret (or with an entry under 32 characters) on first access; dev generates `.nowaki/session-secret`. Several comma-separated secrets rotate keys | `scripts/session-test.mjs`, `scripts/security-e2e.mjs` (dev + prod), `scripts/edge-handler-test.mjs` (Edge), `scripts/ci/e2e-adapters.sh` (node adapter), `scripts/ci/e2e-runtimes.sh` |
| ISR query folding | Cache flood via distinct query strings | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
| Observability off by default (Server-Timing, traces, internal route header) | Timing side channels (a slow branch telling a visitor whether a user exists), and internal route names or trace ids reaching clients | `NOWAKI_SERVER_TIMING=1` turns Server-Timing on in production (dev always has it); `nowaki start` never stores the render's `server-timing` in the ISR cache (`start.rs` `kept_headers`), so a hit doesn't replay another visitor's timings. Traces only with `OTEL_EXPORTER_OTLP_*` (or an app-registered `@opentelemetry/api` tracer). `x-nowaki-route` is sent by the sidecar only while tracing and stripped on both `proxy` branches. While tracing, the Rust front replaces the client's `traceparent` / `tracestate` toward the sidecar with its own span (`forward.rs` `apply_traced`); an incoming `traceparent` is honored as the parent, as W3C Trace Context specifies, so a client can ask for its request to be sampled under a parent-based sampler. JSON logs (`NOWAKI_LOG=json`) carry error details; responses stay generic | `scripts/otel-e2e.mjs`, `scripts/otel-test.mjs`, `obs.rs` / `forward.rs` unit tests, `scripts/ci/e2e-{dev,prod,adapters}.sh`, `scripts/edge-handler-test.mjs` |
| Cache purges come only from the app's own server code | A client emptying the ISR cache (a re-render flood), or putting content into it | `crates/nowaki/src/start.rs`: `x-nowaki-purge` / `x-nowaki-tags` are read only from the sidecar's reply and stripped from every response (both `proxy` branches); a client's copy is dropped on the way in (`forward.rs` `passes`). Purges outside a request arrive as `NOWAKI_PURGE <token> …` stdout lines with the per-process `NOWAKI_PUBLISH_TOKEN`. A purge only deletes entries (the next request renders as a MISS), and a render that started before a purge is not stored | `start.rs` / `forward.rs` unit tests, `scripts/revalidate-test.mjs`, `scripts/ci/e2e-prod.sh` |
| Revalidate endpoint is opt-in (`POST /__nowaki/revalidate`) | Purging the cache without authorization; timing attacks on the secret; oversized purge requests | `server/revalidate.mjs`: 404 while `NOWAKI_REVALIDATE_SECRET` is unset; `Authorization: Bearer <secret>` compared as SHA-256 digests in constant time (401 otherwise); `application/json` only (415), bodies over 64 KiB → 413, 1 to 256 valid paths / tags (400), `cache-control: no-store` | `scripts/revalidate-test.mjs`, `scripts/ci/e2e-prod.sh` |
| Server env stays out of client code (`env.ts`) | Server variables reaching the browser; a `PUBLIC_*` secret by mistake; secrets in build logs | `defineEnv` (`server/env-schema.mjs`) refuses public names without `PUBLIC_` and server names with it; `nowaki-core` `build.rs` `emit` fails the client build when an island or page script reaches `@nowaki-dev/runtime/env/server` (`env::is_server_env_module`), and the dev browser transform answers it with a module that throws; validation errors name the variable, never its value | `scripts/env-schema-test.mjs`, `scripts/ci/e2e-dev.sh` |
| Locale detection (`i18n.detect`) can't redirect off the site or mix languages in a cache | An open redirect through `Accept-Language` or the `nowaki_locale` cookie, a shared cache serving one language's `/` to another, and unbounded header parsing | `nowaki-core` `rules.rs` `Rules::negotiate` / `server/rules.mjs` `negotiateLocale`: the location is built from the configured locale strings only (tags of letters, digits and `-`, checked when the rules compile); a cookie counts only when it names a configured locale exactly; at most 32 ranges of an `Accept-Language` value up to 4 KB are read. The fronts (`front.rs` `headers_layer`, `front.mjs` `frontLocale`) run it before the ISR lookup, only for GET / HEAD of the root; the redirect is `Cache-Control: private, no-cache` and every response to the root carries `Vary: Accept-Language, Cookie` | `crates/nowaki-core/tests/rules.rs` + `scripts/rules-test.mjs` (shared fixture), `rules.rs` / `front.rs` unit tests, `scripts/i18n-e2e.mjs` (start with ISR, dev, node, cloudflare, static), `scripts/locale-browser-test.mjs` (the cookie from `<Link locale>` in Chrome) |
| Remote image downloads (`images.remotePatterns`, build time only) | SSRF from the build machine (internal hosts, cloud metadata), redirects to other hosts, oversized or non-image bodies reaching the image pipeline | `crates/nowaki-core/src/remote_image.rs` checks every URL against the patterns before anything is fetched (strict parse: http(s) only, no user info, fragment, IP-literal brackets, dot segments, or encoded slashes); `server/images-fetch.mjs` checks the patterns again for the URL and each redirect (at most 3), refuses a host when any of its addresses is private, loopback, link-local, multicast, or reserved (IPv4-mapped and NAT64 forms too; checked in the socket's DNS lookup so the answer can't change after the check, and for IP literals), caps the body at 20 MB while streaming, aborts after 15 s, and accepts only PNG / JPEG / WebP / GIF by their bytes (no SVG); core then requires the file to decode within 50 megapixels. Nothing is fetched at runtime, and a cached image never starts Node | `crates/nowaki-core/src/remote_image.rs` unit tests, `crates/nowaki-core/tests/remote_images.rs`, `crates/nowaki-core/tests/remote_patterns.rs` + `scripts/images-fetch-test.mjs` (shared fixture; local HTTP server, no network) |
| Static client assets by basename | Path traversal on `/_nowaki/*` | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
| Generic production 500s | Stack traces (file paths, code) reaching clients | `server/app.mjs`, `server/web.mjs`, `server/prod-sidecar.mjs` (`renderError` and top-level catches) | `scripts/security-e2e.mjs` (prod) |
| Dependency advisories | Known-vulnerable crates/packages | `.github/workflows/ci.yml` | `cargo audit`, `cargo-deny`, `pnpm audit` jobs |

**Opt-in or phased (not missing, but not every row above):**

- **Full CSP enforcement** — default responses add `frame-ancestors` only unless the
  app sets CSP. Set `NOWAKI_CSP=report-only` or `enforce` for nonce-based
  `script-src` / `style-src-elem` (see [Application author responsibilities](#application-author-responsibilities)).

## Dependency auditing

CI runs `cargo audit`, `cargo-deny`, and `pnpm audit` on pushes (and on a daily
schedule). Locally:

```bash
cargo audit
pnpm audit --prod
```

## Related documentation

- [AGENTS.md § Security invariants](./AGENTS.md#security-invariants) — checklist for
  code changes (maps to the table above)
- [DESIGN.md](./DESIGN.md) — architecture and data flow
- [ROADMAP.md](./ROADMAP.md) — milestone exit criteria (v0.14 security defaults shipped; see v0.15+)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — PR expectations before you submit
