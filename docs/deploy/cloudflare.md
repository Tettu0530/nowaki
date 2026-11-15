# Deploy to Cloudflare Workers (cloudflare adapter)

The cloudflare adapter bundles the app into a Worker: one `fetch` handler for pages and
endpoints, with the client files and `public/` served from the Workers static assets binding.

## Build

```sh
npx nowaki build --adapter cloudflare
```

Output:

```
dist/worker/
  index.js        the Worker (routes, islands, server functions, content inlined)
  wrangler.jsonc  name, main, compatibility flags, the ASSETS binding
  assets/         dist/client under _nowaki/, and public/ (both under basePath if set)
```

The Worker's name comes from the app's `package.json` `name` (lowercase letters, digits and
hyphens). `dist/worker` is emptied and rewritten on every build, so edits to `wrangler.jsonc`
there are lost.

## Run and deploy

```sh
cd dist/worker
npx wrangler dev      # local test
npx wrangler deploy   # deploy
```

Run Wrangler from `dist/worker` inside the app directory: it bundles the npm packages your server
code imports from the app's `node_modules`.

The generated config sets `"compatibility_flags": ["nodejs_compat",
"nodejs_compat_populate_process_env"]`. The second flag puts the Worker's vars and secrets on
`process.env`, where the runtime reads them.

## Environment variables

Set them on the Worker. Secrets persist across deploys:

```sh
npx wrangler secret put NOWAKI_SESSION_SECRET
npx wrangler secret put NOWAKI_LIVE_SECRET
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

Plain values can be passed on deploy (`npx wrangler deploy --var CLOUDFLARE_ZONE_ID:<zone id>`)
or set in the dashboard.

| Variable | |
| --- | --- |
| `NOWAKI_SESSION_SECRET` | required if the app uses sessions |
| `NOWAKI_LIVE_SECRET` | required if the app has live islands: without it each isolate would sign with its own key, so live events are refused (503); pages still render |
| `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | a global ISR purge by tag (the token needs the Cache Purge permission) |
| `NOWAKI_CSP`, `NOWAKI_SECURITY_HEADERS`, `NOWAKI_SITE`, `NOWAKI_REVALIDATE_SECRET` | as on other servers |
| `NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, `OTEL_*` | observability |
| your `env.ts` variables | checked before the first request |

With an `env.ts`, the Worker validates its vars and secrets before the first request and answers
500 until they are fixed.

## What works

- Pages, loaders, actions, API and file routes, server functions, sessions (WebCrypto),
  content collections (inlined into the Worker), images and fonts (built at build time, served
  as assets), nowaki.config routing, i18n detection, `loading` / `error` boundaries, the CSP
  nonce, `/__nowaki/health`.
- **ISR**: when some page exports `revalidate`, the Worker caches eligible pages in the Cache API
  of each data center, with `x-nowaki-cache: HIT | STALE | MISS`. A stale page is served while
  one background render (`waitUntil`) replaces it, and each cached response gets a fresh CSP
  nonce. Pages that read cookies, the session or `authorization`, set a cookie, or stream are
  never stored. The Cache API works on custom domains only, not on workers.dev, in the dashboard
  editor or in previews.
- **Purge**: `revalidatePath` deletes the page from the local data center's cache. With
  `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`, `revalidatePath` / `revalidateTag` also purge
  every data center by `Cache-Tag`, awaited up to 2 s. Without them, and on workers.dev,
  `revalidateTag` clears nothing (warned once). The zone purge API is rate limited per account.
- **Live islands**: each event is a POST to `/__nowaki/live-event`. `publish()` does nothing
  (warned once), there is no presence, and a room's shared state lives in one isolate's memory,
  with no push to other members.
- **OpenTelemetry**: spans are exported with `fetch` and flushed in `waitUntil`.

## Edge cases

- The Worker has no filesystem: Jetstream rooms aren't saved, and `ctx.req` is undefined.
- Code that needs Node APIs beyond `nodejs_compat` won't run in the Worker.
- Request size and CPU time limits are Cloudflare's, per plan.

## See also

[Caching](../guides/caching.md#cloudflare), [Jetstream](../guides/jetstream.md#where-it-runs),
[Sessions and env](../guides/sessions-and-env.md).
