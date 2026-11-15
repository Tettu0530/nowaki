# Self-hosting with `nowaki start`

`nowaki start` serves a built app with the Rust front: static assets, the ISR cache, the
Jetstream WebSocket hub and the health check run in Rust, and pages render in a Node process
it starts on localhost. It is the most complete target: every feature works, including an
in-memory ISR cache with purges, live push (`publish()`), rooms and presence.

## Build and run

```sh
npm ci
npx nowaki build
npx nowaki start --host        # all interfaces; default 127.0.0.1
```

- `nowaki start [dir]` serves `<dir>/dist` (default: the current directory). It needs the app
  directory with `dist/`, `node_modules` (the `nowaki` CLI and the runtime) and Node 22 or newer.
- **Listen address**: `--port` wins over `PORT`, default 3000. `--host [addr]` wins over
  `NOWAKI_HOST`, default `127.0.0.1`; `--host` alone is `0.0.0.0`. In a container, set
  `--host` or `NOWAKI_HOST=0.0.0.0`, or nothing outside the container can reach it.
- A taken port fails at once: `port 3000 is already in use on 127.0.0.1`.
- `.env` and `.env.local` in the app directory are read, with the real environment winning.
- With an `env.ts`, the server validates the `server` variables at startup and refuses to start
  on a missing or invalid one.
- On SIGTERM or SIGINT it stops the renderer, which first saves Jetstream rooms.

## Environment variables

| Variable | |
| --- | --- |
| `PORT`, `NOWAKI_HOST` | listen address (the flags win) |
| `NOWAKI_SESSION_SECRET` | required if the app uses sessions |
| `NOWAKI_LIVE_SECRET` | if the app has live islands; it warns at startup without it |
| `NOWAKI_TRUST_PROXY=1` | behind a reverse proxy that sets `x-forwarded-host` / `-proto` |
| `NOWAKI_ISR_MAX` | ISR cache entries (default 1024) |
| `NOWAKI_ISR_WARM=0` | don't render every ISR page once at startup |
| `NOWAKI_REVALIDATE_SECRET` | enables `POST /__nowaki/revalidate` |
| `NOWAKI_LIVE_MAX`, `NOWAKI_LIVE_MAX_AGE`, `NOWAKI_LIVE_RENDER_TIMEOUT_MS`, `NOWAKI_LIVE_ROOMS_FILE` | Jetstream |
| `NOWAKI_CSP`, `NOWAKI_CSP_REPORT_URI`, `NOWAKI_SECURITY_HEADERS`, `NOWAKI_SITE` | as everywhere |
| `NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, `OTEL_*` | observability |

## Docker

The prebuilt `nowaki` binaries are for glibc Linux (x64, arm64), so use a Debian-based Node
image, not Alpine.

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# With an env.ts, the build validates the environment: provide the variables here
# (build args or secrets) or give them defaults in the schema.
RUN npx nowaki build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NOWAKI_HOST=0.0.0.0 PORT=3000
COPY --from=build /app /app
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/__nowaki/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npx", "nowaki", "start"]
```

```sh
docker build -t my-app .
docker run -p 3000:3000 -e NOWAKI_SESSION_SECRET=... -e NOWAKI_LIVE_SECRET=... my-app
```

- The `nowaki` CLI is a dev dependency in a scaffolded app, so the image keeps the dev
  dependencies; move `nowaki` to `dependencies` if you prune them.
- Rooms are saved to `.nowaki/live-rooms.json` in the app directory. Mount a volume there (or
  point `NOWAKI_LIVE_ROOMS_FILE` at one) to keep them across container restarts.
- `docker stop` sends SIGTERM, so rooms are saved on shutdown.

## Behind a reverse proxy

Terminate TLS in the proxy and forward to `nowaki start` on localhost. Pass the WebSocket
upgrade for live islands (`/__nowaki/live`), and either keep `Host` or forward the public host:

```nginx
server {
  listen 443 ssl;
  server_name app.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}

map $http_upgrade $connection_upgrade {
  default upgrade;
  ""      close;
}
```

Then start with `NOWAKI_TRUST_PROXY=1`:

```sh
NOWAKI_TRUST_PROXY=1 npx nowaki start
```

- With `NOWAKI_TRUST_PROXY=1`, the first `x-forwarded-host` / `x-forwarded-proto` value is used
  for `ctx.url` and the same-origin checks, so `ctx.url` is `https://app.example.com/...`.
- Without it, these headers are ignored (a client could send them). If the proxy then rewrites
  `Host`, same-origin form posts and API writes get 403, and `ctx.url` names the internal host.
- Only set it when every request comes through the proxy. Keep `nowaki start` bound to
  127.0.0.1 (the default) or a private network.
- Set `site` in nowaki.config for canonical URLs that don't depend on headers.

## ISR on `nowaki start`

- Responses of ISR pages carry `x-nowaki-cache: HIT | STALE | MISS`.
- The cache is in memory, per host, with up to `NOWAKI_ISR_MAX` entries. Right after startup,
  every ISR page is rendered once in the background (`NOWAKI_ISR_WARM=0` turns that off).
- `revalidatePath` / `revalidateTag` purge it before the response is sent.

See [Caching](../guides/caching.md).

## Several instances

Each `nowaki start` process has its own memory. Behind a load balancer with several instances:

- **ISR**: each instance has its own cache. A `revalidatePath` / `revalidateTag` call purges only
  the instance that ran it. Set `NOWAKI_REVALIDATE_SECRET` and send `POST /__nowaki/revalidate`
  to every instance (from the code that made the change, or a CMS webhook) to purge them all.
- **Jetstream**: connections, rooms and `publish()` reach only one instance. Use sticky sessions
  so a visitor stays on one instance, and expect a room to be per instance. Share
  `NOWAKI_LIVE_SECRET`, so a reconnect to another instance accepts the island's state.
- **Sessions**: share `NOWAKI_SESSION_SECRET`. With a `store` in `session.ts`, use one every
  instance reaches (not memory).
- **Rooms file**: give each instance its own `NOWAKI_LIVE_ROOMS_FILE`, or `off`.

## Health check

`GET /__nowaki/health` answers `{"status":"ok"}` (200) while the renderer answers a ping (1 s
timeout, cached for 1 s), and 503 otherwise. It is never cached and also answers under the
basePath.

## See also

- [Observability](../guides/observability.md) (JSON access logs, traces)
- [Security](../guides/security.md#proxies-and-nowaki_trust_proxy)
- [SECURITY.md](../../SECURITY.md) (trust boundaries: the renderer must stay on localhost)
