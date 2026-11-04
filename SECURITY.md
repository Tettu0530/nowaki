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

Sidecars are not designed to be exposed directly on a network interface.

The Rust front decides which request headers reach a sidecar
(`crates/nowaki/src/forward.rs`). It drops client-sent `x-forwarded-*`,
`forwarded`, and `x-real-ip` headers and every internal `x-nowaki-*` header
(only `x-nowaki-rpc` and `x-nowaki-nav` pass). It then sets `x-forwarded-host`
from `Host` and `x-forwarded-proto` to `http`. Behind a reverse proxy that sets
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
- Server function errors return **`error.message` only**, not stacks
  (`packages/nowaki-runtime/server/functions.mjs`).

### Build-time code you trust

Plugins (`nowaki.config`) and TSRX (`@tsrx/preact`) run as Node during dev/build
with your project's privileges — treat them like any build dependency. They do
not run on the production request path unless you embed their output in the app.

### Application author responsibilities

- **Set `NOWAKI_LIVE_SECRET`** in production when the app has live islands.
  Without it, each process signs live state with its own random key: state
  can't resume after a restart or on another instance, and `nowaki start` /
  the node adapter log a warning at startup.
- **Cross-site writes.** Page actions reject cross-site non-GET requests. API
  routes still accept them (with a one-time warning) unless they
  `export const csrf = true`; a later release makes that the default. Requests
  without `Origin` or `Sec-Fetch-Site` (curl, server-to-server) are allowed, so
  authenticate those another way. `_middleware` runs before the check. Behind a
  proxy that rewrites `Host`, forward the public host as `x-forwarded-host` (and
  set `NOWAKI_TRUST_PROXY=1` for `nowaki start`), or same-origin posts are
  rejected too.
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
- **Jetstream `on` handlers** — State is server-held per WebSocket connection;
  validate event payloads like any server handler.
- **Actions / API routes** — Same as in any web app: CSRF and auth are your
  concern unless a framework defense applies (see table below).

## Defenses enabled by default

These are implemented in the repo today. When you change one, keep this table
accurate and follow the [Security invariants](./AGENTS.md#security-invariants)
checklist (extend `scripts/security-e2e.mjs` when CI does not already cover the
behavior). ROADMAP v0.14 aims to map **every row** to an automated CI check in
both dev and prod; coverage is noted in the last column.

| Defense | What it limits | Primary location | CI regression |
|---------|----------------|------------------|---------------|
| `@fs` / `ssr-module` allow roots + deny sensitive paths | Arbitrary file read via dev URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Dev fallback does not serve `.env` | Secret file leak via catch-all | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Virtual module `..` rejected | Path traversal in plugin URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Server function allowlist | Calling arbitrary server exports | `nowaki-core` + `dist/server/functions.json` + `functions.mjs` | e2e scripts (`/__nowaki/fn` unknown id → 404) |
| RPC CSRF gate (JSON + `x-nowaki-rpc` + Origin/Host) | Cross-site POST with victim cookies | `packages/nowaki-runtime/server/functions.mjs`; Rust sets `x-forwarded-host` from browser `Host` on the sidecar hop | `scripts/security-e2e.mjs` (dev) |
| Server function input and error limits | Oversized or malformed RPC payloads; internal error messages reaching the client | `server/functions.mjs`: bodies over `NOWAKI_FN_BODY_LIMIT` (default 1 MiB) → 413, more than 16 arguments → 400, errors other than `ServerFnError` → generic 500 in production. `serverFn(schema, impl)` (`server/server-fn.mjs`) validates the first argument with a Standard Schema; `nowaki build` warns about exports that take arguments without it | `scripts/security-e2e.mjs` (dev + prod), `scripts/ci/e2e-prod.sh` (build warning) |
| Same-origin check on page actions and API routes (`server/origin.mjs`) | Cross-site form posts and `fetch` writes with the victim's cookies | `server/handler.mjs`: a non-GET to a route with `action` is rejected (403) when `Origin` is another site or `null`, or `Sec-Fetch-Site` is `cross-site`. API routes only warn for now unless they `export const csrf = true`; `export const csrf = false` opts a route out | `scripts/security-e2e.mjs` (dev + prod) |
| Default security headers (`x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `cross-origin-opener-policy: same-origin`, and `content-security-policy: frame-ancestors 'self'` when the app sends no CSP) | MIME sniffing, clickjacking, cross-origin referrer and `window.opener` leaks | `crates/nowaki/src/security_headers.rs` (dev/start, ISR hits, static assets); `server/security-headers.mjs` (node/bun/deno/vercel/cloudflare adapters); `_headers` from `nowaki prerender` | `scripts/security-e2e.mjs` (dev + prod), `scripts/ci/e2e-adapters.sh`, `scripts/ci/e2e-runtimes.sh` |
| Forwarding and internal headers sanitized at the Rust front | Spoofing the host the same-origin checks use; forging internal `x-nowaki-*` headers | `crates/nowaki/src/forward.rs` (`NOWAKI_TRUST_PROXY` opt-in) | `scripts/security-e2e.mjs` (dev + prod) |
| WebSocket Origin check (CSWSH) | Cross-origin upgrades to HMR / Jetstream | `crates/nowaki/src/dev.rs`, `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (dev) |
| Jetstream state signature | Forged live state used in render/handlers; replaying a captured state indefinitely | `server/live-sign.mjs` (`v1.<iat>.<mac>`: HMAC over name, issue time, and state; rejected after `NOWAKI_LIVE_MAX_AGE`, default 24 h); `server/live.mjs` (verify before each render/handler); `crates/nowaki/src/live.rs` (holds state per session) | `scripts/security-e2e.mjs` (dev), `scripts/live-sign-test.mjs` |
| ISR cache key + `Vary` learning | Cross-user HTML cache bleed | `server/context.mjs` (`__vary()`), `server/handler.mjs` (`x-nowaki-vary`); `crates/nowaki/src/start.rs` (`isr_key`); e.g. `examples/hello/routes/vary.tsx` | `scripts/security-e2e.mjs` (prod) |
| ISR query folding | Cache flood via distinct query strings | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
| Static client assets by basename | Path traversal on `/_nowaki/*` | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
| Generic production 500s | Stack traces (file paths, code) reaching clients | `server/app.mjs`, `server/web.mjs`, `server/prod-sidecar.mjs` (`renderError` and top-level catches) | `scripts/security-e2e.mjs` (prod) |
| Dependency advisories | Known-vulnerable crates/packages | `.github/workflows/ci.yml` | `cargo audit`, `cargo-deny`, `pnpm audit` jobs |

**Planned (not yet default):** inbound proxy header sanitization (`NOWAKI_TRUST_PROXY`),
default security headers (CSP, `X-Frame-Options`, etc.), and broader
`security-e2e` parity in prod — see [ROADMAP.md](./ROADMAP.md) v0.13–v0.14.

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
- [ROADMAP.md](./ROADMAP.md) — milestone exit criteria (v0.13–v0.14 security work)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — PR expectations before you submit
