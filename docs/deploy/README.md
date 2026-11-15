# Deploying Nowaki

`nowaki build` compiles the app into `dist/` and, with `--adapter`, turns it into something a
host runs. `nowaki start` serves `dist/` itself. Every target below is built and run in CI
([SUPPORT.md](../../SUPPORT.md#deploy-adapters)); its output paths and the environment variables
it reads are part of the stability contract ([docs/STABILITY.md](../STABILITY.md#what-is-frozen)).

| Target | Build | Output | Run |
| --- | --- | --- | --- |
| [`nowaki start`](./self-hosted.md) | `nowaki build` | `dist/` | `nowaki start` |
| [node](./node.md) | `nowaki build` (default) or `--adapter node` | `dist/server/index.mjs` | `node index.mjs` in `dist/server` |
| [bun](./bun.md) | `nowaki build --adapter bun` | `dist/server/index.mjs` | `bun index.mjs` |
| [deno](./deno.md) | `nowaki build --adapter deno` | `dist/server/index.mjs` | `deno run -A index.mjs` |
| [cloudflare](./cloudflare.md) | `nowaki build --adapter cloudflare` | `dist/worker/` | `npx wrangler deploy` |
| [vercel](./vercel.md) | `nowaki build --adapter vercel` | `.vercel/output/` | `npx vercel deploy --prebuilt` |
| [static](./static.md) | `nowaki build --adapter static` | `dist/static/` | any static host |

## What works where

| Feature | `nowaki start` | node / bun / deno | cloudflare | vercel | static |
| --- | --- | --- | --- | --- | --- |
| Pages, loaders, actions, API routes, server functions | yes | yes | yes | yes | prerendered pages and file routes only |
| Sessions (`ctx.session`) | yes | yes | yes | yes | no |
| ISR (`revalidate`) | in-memory cache per process | `s-maxage` for a CDN in front | Cache API per data center | Vercel's CDN | no (files) |
| `revalidatePath` / `revalidateTag` | yes, before the response | no-op (warned once) | local delete; zone purge with credentials | yes, with `@vercel/functions` | no-op |
| Live islands: events | WebSocket (POST fallback) | POST | POST | POST | no (first HTML only) |
| Live islands: `publish()`, rooms across visitors, presence | yes, per process | no | no | no | no |
| `<Image>`, fonts | yes (built at build time) | yes | yes | yes | yes |
| `nowaki.config` redirects / rewrites / headers | yes | yes | yes | yes (platform routes + function) | `_redirects` / `_headers` |
| i18n detection on `/` | yes | yes | yes | yes | no (default locale) |
| CSP nonce (`NOWAKI_CSP`) | yes, fresh per response, ISR included | yes | yes, ISR included | yes (a CDN-cached page shares its nonce) | no (set a CSP in `_headers`) |
| `/__nowaki/health` | yes | yes | yes | yes | no |
| OpenTelemetry | yes | yes | yes | yes | no |

## Production environment variables

| Variable | When |
| --- | --- |
| `NOWAKI_SESSION_SECRET` | the app uses `ctx.session` (32+ characters; production refuses sessions without it) |
| `NOWAKI_LIVE_SECRET` | the app has live islands (same value on every instance) |
| `NOWAKI_TRUST_PROXY=1` | `nowaki start` or node / bun / deno behind a reverse proxy that sets `x-forwarded-*` |
| `NOWAKI_SITE` | to override `site` from nowaki.config |
| `NOWAKI_CSP` | `report-only`, then `enforce` |
| `NOWAKI_REVALIDATE_SECRET` | to enable `POST /__nowaki/revalidate` |
| `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | cloudflare, for a global ISR purge |
| `PORT`, `NOWAKI_HOST` | the listen address (`nowaki start`, node / bun / deno) |
| your `env.ts` variables | at build time and at startup |

The full list with defaults is in the [environment variable reference](../reference/env-vars.md).

## Before every deploy

- The `nowaki` CLI and `@nowaki-dev/runtime` must have the same version: the CLI refuses
  another one.
- With an `env.ts`, `nowaki build` validates the environment, so the build machine needs the
  variables too (or schema defaults for the build).
- `public` values from `env.ts` and `PUBLIC_*` variables are inlined at build time; changing
  one needs a new build.
- Netlify and other hosts have no adapter. The node output or the static output may work there,
  but they are not tested.
