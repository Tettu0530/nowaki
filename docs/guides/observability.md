# Observability: Server-Timing, logs, traces and health

Nowaki can report request timings, write structured logs, export OpenTelemetry traces and
answer a health check. All of it is off in production until you turn it on, and costs a request
one check while off.

| What | Turn it on |
| --- | --- |
| `Server-Timing` header | `NOWAKI_SERVER_TIMING=1` (always on in `nowaki dev`) |
| JSON logs and an access log | `NOWAKI_LOG=json` |
| OpenTelemetry traces | `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) |
| Health check | always: `GET /__nowaki/health` |

## Server-Timing

With `NOWAKI_SERVER_TIMING=1`, responses carry a `Server-Timing` header with the time spent in
`mw` (middleware), `loader`, `render` and `action`; `nowaki start` adds `isr;desc=HIT|STALE|MISS`
and `total`. Browsers show it in the network panel, and the dev toolbar reads it.

```
Server-Timing: mw;dur=0.4, loader;dur=12.1, render;dur=3.2, isr;desc=MISS, total;dur=16.9
```

It is off in production by default because timings can tell a visitor something (whether a
lookup found a user, say). An ISR hit carries only its own entries, never the timings of the
render that filled the cache. A streamed page has what was known when its headers went out.

After a client navigation, `nowaki:page-load` carries the response's timings in
`event.detail.timing`.

## JSON logs

With `NOWAKI_LOG=json`, the Rust front and the Node runtime write one JSON object per line:

```json
{"time":"2026-11-15T09:12:03.512Z","level":"error","msg":"loader failed","source":"node","trace_id":"4bf9...","span_id":"00f0..."}
```

| Field | |
| --- | --- |
| `time`, `level`, `msg`, `source` | always |
| `trace_id`, `span_id` | inside a traced request |
| the error with its stack | on errors |

`nowaki start` adds an access log line per request. Lines the app writes that are already JSON
pass through unchanged. Error details go only to the logs; clients get generic messages.
Without `NOWAKI_LOG=json`, logs are text lines starting with `[nowaki]`.

## OpenTelemetry traces

Set an OTLP/HTTP endpoint, and Nowaki exports traces as OTLP JSON:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=my-app \
npx nowaki start
```

- Read: `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_SERVICE_NAME`,
  `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, `OTEL_BSP_SCHEDULE_DELAY`,
  `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_MAX_QUEUE_SIZE`. `OTEL_SDK_DISABLED=true` turns
  tracing off.
- The exporters are built in (one in Rust, a fetch-based one in the runtime that also runs on
  the Cloudflare Worker). No dependency is needed. Spans are batched in a bounded queue and
  dropped when it is full, never holding up a request.
- On `nowaki start`, one request is one trace: a SERVER span `GET <route>` in Rust (under an
  incoming `traceparent`), a CLIENT span to the renderer, and the renderer's SERVER span with
  `middleware`, `loader`, `render`, `action`, server function and live event spans under it.
  Jetstream WebSocket events and `publish()` refreshes get a trace of their own.
- Attributes follow the HTTP semantic conventions: `http.request.method`, `url.path`,
  `http.response.status_code`, plus `nowaki.isr` on `nowaki start`.
- The Rust exporter speaks plain HTTP only: point it at a local collector. An `https://`
  endpoint turns the Rust spans off with a warning; the runtime's exporter still sends its own.
- When the app registered a tracer with `@opentelemetry/api`, the runtime creates its spans
  there instead.
- On Cloudflare, spans are flushed in `waitUntil` after the response.

An incoming `traceparent` is honored as the parent, as W3C Trace Context specifies.

## Health check

`GET /__nowaki/health` answers `{"status":"ok"}`, never cached and with no data in it. Use it
for load balancer and container health checks.

- `nowaki start` answers it in Rust: 200 while the renderer answers a ping (1 s timeout, cached
  for 1 s), 503 otherwise.
- The node, bun, deno, vercel and cloudflare adapters answer it before routing.
- Under a `basePath` it also answers at `<basePath>/__nowaki/health`.

```dockerfile
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/__nowaki/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
```

## In development

`nowaki dev` always sends Server-Timing, and the [dev toolbar](./dev-experience.md#dev-toolbar)
shows it with the route, layouts and middleware of the page on screen, plus recent errors.

## Reference

- [Environment variables](../reference/env-vars.md) (`NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, the
  `OTEL_*` variables)
- [Endpoints](../reference/endpoints.md) (`/__nowaki/health`)
- [Client events and attributes](../reference/client-events.md) (`nowaki:page-load`)
