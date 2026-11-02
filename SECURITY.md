# Security Policy

<div align="right">

[**Japanese version →**](./SECURITY-Ja.md)

</div>

Nowaki is a full-stack framework with a **Rust HTTP front** (dev/start) and **Node
sidecars** (SSR, plugins). Production traffic should hit `nowaki start` or a deploy
adapter output — not `nowaki dev`. This document covers reporting, trust boundaries,
and defenses the framework applies by default.

## Supported versions

Nowaki is in alpha; only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Report security issues privately to **dev@voredge.com** — do not open a public
GitHub issue. Include reproduction steps and the affected version or commit. We
aim to acknowledge reports within 72 hours.

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

Framework defaults do not replace app-level checks:

- **Server functions (`"use server"`)** — Allowlisted RPC only, but each export
  is still a public endpoint: validate JSON arguments and authorize via
  `getContext()` (cookies/headers).
- **Jetstream `on` handlers** — State is server-held per WebSocket connection;
  validate event payloads like any server handler.
- **Actions / API routes** — Same as in any web app: CSRF and auth are your
  concern unless a framework defense applies (see table below).

## Defenses enabled by default

These are implemented in the repo today. ROADMAP v0.14 aims to map **every row**
to an automated CI check in both dev and prod; coverage is noted in the last
column.

| Defense | What it limits | Primary location | CI regression |
|---------|----------------|------------------|---------------|
| `@fs` / `ssr-module` allow roots + deny sensitive paths | Arbitrary file read via dev URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Dev fallback does not serve `.env` | Secret file leak via catch-all | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Virtual module `..` rejected | Path traversal in plugin URLs | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs` (dev) |
| Server function allowlist | Calling arbitrary server exports | `nowaki-core` + `dist/server/functions.json` + `functions.mjs` | e2e scripts (`/__nowaki/fn` unknown id → 404) |
| RPC CSRF gate (JSON + `x-nowaki-rpc` + Origin/Host) | Cross-site POST with victim cookies | `packages/nowaki-runtime/server/functions.mjs`; Rust sets `x-forwarded-host` from browser `Host` on the sidecar hop | `scripts/security-e2e.mjs` (dev) |
| WebSocket Origin check (CSWSH) | Cross-origin upgrades to HMR / Jetstream | `crates/nowaki/src/dev.rs`, `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (dev) |
| Jetstream state signature | Forged live state used in render/handlers | `server/live.mjs` (verify before each render/handler); `crates/nowaki/src/live.rs` (holds state per session) | `scripts/security-e2e.mjs` (dev) |
| ISR cache key + `Vary` learning | Cross-user HTML cache bleed | `server/context.mjs` (`__vary()`), `server/handler.mjs` (`x-nowaki-vary`); `crates/nowaki/src/start.rs` (`isr_key`); e.g. `examples/hello/routes/vary.tsx` | `scripts/security-e2e.mjs` (prod) |
| ISR query folding | Cache flood via distinct query strings | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
| Static client assets by basename | Path traversal on `/_nowaki/*` | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs` (prod) |
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

## Further reading

- Agent-oriented invariants when changing the codebase: [AGENTS.md](./AGENTS.md#security-invariants)
- Architecture and data flow: [DESIGN.md](./DESIGN.md)
- Direction and security milestone exit criteria: [ROADMAP.md](./ROADMAP.md)
