# Deploy to Node (node adapter)

The node adapter turns the build into a plain Node HTTP server that runs without the `nowaki`
binary: `@nowaki-dev/runtime` renders and serves everything. Use it on any host that runs Node
22 or newer (a VM, a container, a PaaS), especially where you can't run the Rust binary. To keep
the Rust front (its ISR cache, WebSockets for live islands), use [`nowaki start`](./self-hosted.md)
instead.

## Build

```sh
npx nowaki build                 # node is the default adapter
npx nowaki build --adapter node  # the same, explicitly
```

Output:

```
dist/
  client/        hashed assets, served at /_nowaki/
  public/        a copy of public/
  server/
    index.mjs    the server entry
    package.json the runtime dependencies (@nowaki-dev/runtime, preact, preact-render-to-string)
    ...          the compiled routes, islands, env.js, session.js, routing.json
```

## Run

```sh
cd dist/server
npm install --omit=dev
node index.mjs        # or: npm start
```

- It listens on `PORT` (default 3000) and `NOWAKI_HOST` (default `0.0.0.0`, every interface).
- It serves `dist/client` at `/_nowaki/` and `dist/public` at the root, so deploy the whole
  `dist/` directory.
- `.env` and `.env.local` are read from the working directory (`dist/server` with the commands
  above), with the real environment winning. On a host, set real environment variables instead.
- With an `env.ts`, the server validates the `server` variables at startup and refuses to start
  when one is missing or invalid.

### Your own dependencies

The compiled server code imports npm packages by name, and `dist/server/package.json` lists only
the runtime packages. Packages your server code imports (a database client, `zod` in `env.ts`)
must resolve from `dist/server` too. Either:

- run `dist/server/index.mjs` inside the app directory, after `npm ci --omit=dev` there (Node
  finds the app's `node_modules` above `dist/server`), or
- add those packages to `dist/server/package.json` before `npm install`.

## Environment variables

| Variable | |
| --- | --- |
| `PORT`, `NOWAKI_HOST` | listen address |
| `NOWAKI_SESSION_SECRET` | required if the app uses sessions |
| `NOWAKI_LIVE_SECRET` | if the app has live islands; the server warns at startup without it |
| `NOWAKI_TRUST_PROXY=1` | behind a reverse proxy that sets `x-forwarded-host` / `-proto` |
| `NOWAKI_CSP`, `NOWAKI_CSP_REPORT_URI`, `NOWAKI_SECURITY_HEADERS` | security |
| `NOWAKI_SITE` | overrides `site` |
| `NOWAKI_FORM_BODY_LIMIT`, `NOWAKI_FN_BODY_LIMIT` | body limits |
| `NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, `OTEL_*` | observability |
| `NOWAKI_REVALIDATE_SECRET` | enables `POST /__nowaki/revalidate` |

## What works

- Pages, loaders, actions, API and file routes, server functions, sessions, content
  collections, images, fonts, nowaki.config routing, i18n detection, the CSP nonce, health and
  OpenTelemetry.
- **ISR**: an ISR page is sent with `Cache-Control: public, s-maxage=<n>, stale-while-revalidate`
  for a CDN in front of the server. The node server keeps no cache of its own, so
  `revalidatePath` / `revalidateTag` do nothing here (warned once): purge that CDN through its
  API, or use `nowaki start`.
- **Live islands**: each event is a POST to `/__nowaki/live-event`. There is no WebSocket, so
  `publish()` does nothing (warned once), there is no presence, and rooms don't push to other
  members. Set `NOWAKI_LIVE_SECRET` when more than one instance runs.
- Under `NOWAKI_CSP`, a CDN that caches HTML caches the nonce with it.

## Behind a proxy

Without `NOWAKI_TRUST_PROXY`, the server ignores `x-forwarded-*` headers, also when the proxy
connects over `localhost`. If the proxy rewrites `Host`, same-origin form posts get 403 and
`ctx.url` names the internal host. Keep `Host` in the proxy, or forward the public host as
`x-forwarded-host` and set `NOWAKI_TRUST_PROXY=1`. See
[`nowaki start`: behind a reverse proxy](./self-hosted.md#behind-a-reverse-proxy) for an nginx
example.

## Health check

`GET /__nowaki/health` answers `{"status":"ok"}` before routing.

## See also

- [Bun](./bun.md) and [Deno](./deno.md) run the same entry.
- [Caching](../guides/caching.md), [Jetstream](../guides/jetstream.md#where-it-runs),
  [Security](../guides/security.md).
