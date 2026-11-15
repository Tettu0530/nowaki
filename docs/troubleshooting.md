# Troubleshooting

The errors and warnings people run into, with the message (or the start of it), the cause and
the fix. Messages are quoted as of 0.20; their exact wording is not covered by semver. If
something isn't here, run `npx nowaki upgrade --check` (it lists known problems in an app) and
see [SUPPORT.md](../SUPPORT.md) for where to ask.

- [Install and versions](#install-and-versions)
- [Config](#config)
- [Routes and modules](#routes-and-modules)
- [Starting a server](#starting-a-server)
- [Requests: 403, 413, 400](#requests-403-413-400)
- [Sessions and env](#sessions-and-env)
- [CSP](#csp)
- [Live islands](#live-islands)
- [Caching](#caching)
- [Builds](#builds)

## Install and versions

### Runtime too old, or of another major

```
@nowaki-dev/runtime 0.19.3 is too old for nowaki 0.20.0, which needs 0.20.0 or newer.
  → Run `npm i @nowaki-dev/runtime@^0.20.0` (or pnpm / yarn / bun) in the app directory.
```

```
@nowaki-dev/runtime 0.21.0 is a newer major than nowaki 0.20.0 (on 0.x, each minor is a major). Use the same version of both.
```

**Cause:** the `nowaki` CLI and `@nowaki-dev/runtime` are released together and must have the
same version. The CLI refuses a runtime that is older than itself or of another major (on 0.x,
another minor). Prereleases count: a 1.0.0 CLI refuses a 1.0.0-rc runtime.

**Fix:** install the same version of both (`npx nowaki upgrade` does), then reinstall
dependencies so the lockfile matches.

### Runtime not installed

```
the cloudflare adapter needs @nowaki-dev/runtime: @nowaki-dev/runtime is not installed.
  → Run `npm install @nowaki-dev/runtime@0.20.0` in /path/to/app.
```

**Cause:** `node_modules/@nowaki-dev/runtime` is missing or incomplete (the message then says
"a broken install"). **Fix:** run the install command it prints.

### No prebuilt binary (Alpine, Windows arm64)

**Cause:** the `nowaki` npm package ships binaries for macOS (arm64, x64), Linux glibc (x64,
arm64) and Windows x64. musl (Alpine) and Windows arm64 have none. **Fix:** use a glibc image
(`node:22-bookworm-slim`), or build the CLI with `cargo install nowaki` (Rust 1.97 or newer).

## Config

### Unknown config key

```
unknown top-level key "basepath". Did you mean "basePath"? (allowed: site, fonts, basePath, trailingSlash, redirects, rewrites, headers, i18n, images, plugins)
nowaki.config is invalid (see above)
```

**Cause:** since 0.20.0 every key of nowaki.config is checked, at every level, when `nowaki dev`,
`build` or `prerender` reads it. A typo used to be ignored silently. **Fix:** correct the key.
If you keep your own settings in the same file, move them out of the default export (a named
export isn't read). Nested keys report their path (`redirects[0]: unknown key "statuscode". Did you mean "statusCode"? (allowed: ...)`).

### Font keys

```
fonts[0]: `weights` is for `provider: "google"`; a local font takes `weight` (or one `src` entry per weight)
```

**Cause:** a key of the other font kind: `weights` / `styles` / `subsets` are for Google fonts,
`weight` / `style` for a local `src`. **Fix:** use the key the message names; a local font with
several files takes `src: [{ path, weight, style }]`.

### `export const config` is no longer read

```
`export const config` is no longer read (removed in 0.20.0): use `export default { ... }` (or `export default defineConfig({ ... })` from @nowaki-dev/runtime/config)
```

**Fix:** make the config the module's default export.

### A config change has no effect in dev

```
[nowaki] nowaki.config.mjs changed; restart nowaki dev to apply it
```

**Cause:** `nowaki dev` reads nowaki.config, `env.ts`, `.env` and `.env.local` at startup.
**Fix:** restart it.

## Routes and modules

### `_error` is no longer a file convention

```
`_error` is no longer a file convention (removed in 0.20.0). Rename it to `_500` (the server's error page); `error.tsx` is the client navigation error boundary.
```

**Fix:** rename `routes/_error.tsx` to `routes/_500.tsx`.

### `export const middleware` is no longer read

```
routes/_middleware.ts: `export const middleware` is no longer read (removed in 0.20.0). Use `export default`.
```

**Fix:** `export default function middleware(ctx) { ... }`.

### Lowercase API method exports

```
API route exports `get`: method exports are uppercase (`GET`). The lowercase alias was removed in 0.20.0.
```

**Fix:** rename `get` to `GET`, `post` to `POST`, and so on.

### `ERR_MODULE_NOT_FOUND` / "Cannot find module" on the server

**Cause:** usually a relative import without its file extension (`import x from "./lib/db"`).
The server build runs as plain ESM, which doesn't guess extensions. **Fix:** write the extension:
`import x from "./lib/db.ts"`.

On the node / bun / deno adapters and Vercel, it can also be an npm package your server code
imports that isn't installed next to the server output: see
[Deploy to Node: your own dependencies](./deploy/node.md#your-own-dependencies).

### `ctx.formData()` result has no `toString()` / `sort()`

**Cause:** since 0.20.0 `ctx.formData()` always returns `FormData` (urlencoded bodies returned
`URLSearchParams` before). **Fix:** read fields with `String(form.get("x") ?? "")`; for a query
string, build one with `new URLSearchParams([...form].filter(([, v]) => typeof v === "string"))`.

### A page renders but its hooks or `onClick` do nothing

**Cause:** only components in `islands/` hydrate; pages, layouts and `components/` render to
HTML only. **Fix:** move the interactive part into an island
([Islands](./guides/islands.md)).

## Starting a server

### Port in use

```
port 3000 is already in use on 127.0.0.1.
  → Stop the other server, or pass --port <PORT> (or set PORT).
```

**Fix:** stop the other process, or pick another port.

### `PORT` is not a port number

```
PORT="http" is not a port number (0-65535).
  → Fix PORT, or pass --port <PORT>.
```

**Cause:** since 0.20.0 `nowaki dev` and `nowaki start` read `PORT` when `--port` is absent, and
something in your environment sets it to another value. **Fix:** unset or correct `PORT`, or
pass `--port`.

### `--host "my-app" is not an address`

```
--host "my-app" is not an address. `--host` takes an optional address since 0.20.0, so a directory right after it is read as the address.
```

**Fix:** put the directory first: `nowaki dev my-app --host`. Check `package.json` scripts too
(`nowaki upgrade --check` finds them).

### `nowaki start` isn't reachable from outside the machine or container

**Cause:** `nowaki start` and `nowaki dev` listen on `127.0.0.1` by default. **Fix:** pass
`--host` (all interfaces) or set `NOWAKI_HOST=0.0.0.0`. The node / bun / deno adapters listen on
`0.0.0.0` by default.

### Dev server: "Blocked request: Host ... is not allowed"

```
Blocked request: Host "dev.example.test" is not allowed by the dev server. Open it at localhost; `nowaki dev --host` also accepts IP addresses and *.local names, and the names listed in NOWAKI_DEV_ALLOWED_HOSTS.
```

**Cause:** `nowaki dev` refuses unknown `Host` names (DNS rebinding protection). On the default
loopback bind it accepts only `localhost`, `127.0.0.1` and `[::1]`; under `--host`, also IP
addresses, `*.localhost` and `*.local`. **Fix:** open it through one of those, or list the name
(a tunnel, an `/etc/hosts` alias) in `NOWAKI_DEV_ALLOWED_HOSTS` (comma-separated, `*` for any).

### Dev: HMR or live islands don't connect through a proxy ("forbidden origin")

**Cause:** since 0.20.0 `nowaki dev` accepts its HMR and live WebSockets only from its own
origin, or when `Origin` equals `Host`. A proxy on another port that rewrites `Host` fails that.
**Fix:** open the page from the dev server's own address, or keep `Host` in the proxy.

### The server refuses to start: invalid environment

```
[nowaki] env: invalid environment (env.ts):
  DATABASE_URL: missing (Invalid input: expected string, received undefined)
```

**Cause:** `env.ts` validation at startup (`nowaki start`, the adapters, `nowaki dev` on the
first request). The value is never printed. **Fix:** set the variable in the environment (or
`.env`), or give it a default in the schema. `nowaki build` checks the same variables before
building, so the build machine needs them as well.

## Requests: 403, 413, 400

### 403 Forbidden on a form post or API write

**Cause:** the same-origin check. A POST / PUT / PATCH / DELETE to a page action or API route was
rejected because its `Origin` names another host (or `null`), or `Sec-Fetch-Site` is
`cross-site`. Common situations:

- **Behind a reverse proxy** that rewrites `Host` (`proxy_pass http://127.0.0.1:3000` without
  `proxy_set_header Host $host`): the server compares the browser's `Origin` with the internal
  host. **Fix:** keep `Host` in the proxy, or send `X-Forwarded-Host` and set
  `NOWAKI_TRUST_PROXY=1`. Since 0.20.0 the node / bun / deno adapters ignore `x-forwarded-host`
  without it, also when the proxy connects over `localhost`.
- **A webhook or a callback** from another service, or a frontend on another origin. **Fix:**
  `export const csrf = false` on that route, and authenticate the caller with a signature or a
  token, not cookies.
- **A form on a page served from another origin** (a preview domain posting to production).
  **Fix:** post to the same origin.

See [Security: cross-site writes](./guides/security.md#cross-site-writes-csrf).

### 403 on server functions or live events

Server function calls (`/__nowaki/fn`) and live events (`/__nowaki/live-event`) are rejected
with 403 when they come from another site, and live events also when the `x-nowaki-live` header
is missing. The same proxy fix applies. A live event whose state signature doesn't verify (see
[Live islands](#live-islands)) is a 403 too.

### 413 Payload Too Large

**Cause:** the request body is over a limit:

| Endpoint | Limit | Setting |
| --- | --- | --- |
| `ctx.formData()`, `bodyText()`, `bodyJson()` | 10 MiB | `NOWAKI_FORM_BODY_LIMIT` (bytes) |
| server functions | 1 MiB | `NOWAKI_FN_BODY_LIMIT` (bytes) |
| live events, `POST /__nowaki/revalidate` | 64 KiB | fixed |
| `nowaki dev` / `nowaki start` proxy buffer | 16 MiB, or `NOWAKI_FORM_BODY_LIMIT` when larger | |

Since 0.20.0 the form limit also applies to `bodyText()` and `bodyJson()`. A chunked upload
over the limit on Node may end with a connection reset instead of a 413. The host's own limit
(Vercel, Cloudflare) can be lower. **Fix:** raise the setting, or upload large files straight to
storage.

### 400 Bad Request on a form post

**Cause:** a malformed body: a bad multipart boundary, or (on Node 22) a multipart part with
`filename*`. In production the response says only "Bad Request"; `nowaki dev` says why.

### 405 Method Not Allowed

**Cause:** the API route has no export for that method and no `default`. Method exports are
uppercase.

## Sessions and env

### `NOWAKI_SESSION_SECRET` is not set

```
[nowaki] session: NOWAKI_SESSION_SECRET is not set. Sessions encrypt and sign their cookie with it: set it to a random string of at least 32 characters ...
```

**Cause:** production refuses to use `ctx.session` without a secret (dev generates one into
`.nowaki/session-secret`). **Fix:** set `NOWAKI_SESSION_SECRET` (32+ characters, the same on
every instance). Declare it in `env.ts` so the server refuses to start without it instead of
failing on the first request.

```
[nowaki] session: every NOWAKI_SESSION_SECRET entry must be at least 32 characters (one has 12)
```

**Fix:** use longer secrets; with several (key rotation), each one counts.

### `ctx.session is read-only on a cross-site request`

**Cause:** a cross-site POST / PUT / PATCH / DELETE sees an empty, read-only session (CSRF). Often
the same proxy problem as the [403 above](#403-forbidden-on-a-form-post-or-api-write). For a
route that must accept cross-site writes, `export const csrf = false`.

### `ctx.session is read-only in live island renders`

**Fix:** change the session in an action, API route or server function.

### `ctx.session can't be used in a prerendered page`

**Cause:** a page that reads the session was prerendered (`nowaki prerender`, the static
adapter). **Fix:** read the session in an API route or a server-rendered page, or add
`export const prerender = false`.

### Session cookie over 4096 bytes

```
[nowaki] session: the session cookie would be 5120 bytes, over the 4096-byte cookie limit. ...
```

**Fix:** keep an id in the session instead of the record, or add a `store` in `session.ts`.

### `@nowaki-dev/runtime/env/server is server-only, but client code imports it`

```
@nowaki-dev/runtime/env/server is server-only, but client code imports it: islands/A.tsx → lib/config.ts → @nowaki-dev/runtime/env/server.
```

**Fix:** read server variables in a loader, action or server function and pass the values down,
or declare them as `PUBLIC_*` in `env.ts`.

### A `PUBLIC_*` value didn't change after a redeploy

**Cause:** public values are inlined at build time. **Fix:** rebuild. `.env.local` overrides
`.env` (on the server too since 0.20.0), and the real environment overrides both.

## CSP

### `Refused to execute inline script` / `Refused to apply inline style` after 0.20

**Cause:** since 0.20.0, under `NOWAKI_CSP`, the nonce goes only on the tags Nowaki emits and on
tags written with `nonce()`. An inline `<script>` / `<style>` in raw HTML (an `export const head`
string, `dangerouslySetInnerHTML`, Markdown / MDX / Markdoc output, `ctx.html()` markup, a
`public/` HTML file) no longer gets it. **Fix:**

- put `nonce={nonce()}` on the tag (`import { nonce } from "@nowaki-dev/runtime"`),
- for a tag in `head`, return it from `meta()`:
  `` export const meta = () => ({ head: `<style nonce="${nonce()}">...</style>` }) ``,
- or move the code to a file (`export const scripts`, a CSS import, `public/`).

Run with `NOWAKI_CSP=report-only` first to see what `enforce` would block. See
[Security: CSP](./guides/security.md#content-security-policy).

### Images, fonts or scripts from another host are blocked

**Cause:** the built-in policy allows `'self'` (and `data:` for images and fonts). **Fix:**
optimize remote images at build time (`images.remotePatterns`), self-host fonts (`fonts`), or
send your own `content-security-policy` header (a nowaki.config `headers` rule), which Nowaki
then leaves alone.

## Live islands

### `NOWAKI_LIVE_SECRET is not set`

```
NOWAKI_LIVE_SECRET is not set: live islands are signed with a random per-process key, so their state can't resume after a restart or on another instance. Set it to a long random value.
```

**Fix:** set `NOWAKI_LIVE_SECRET` to the same long random value on every instance. On the
node / bun / deno adapters with several instances, live events fail with 403 without it.

### `live events are refused (503): NOWAKI_LIVE_SECRET is not set`

The cloudflare and vercel adapters answer every `POST /__nowaki/live-event` with 503 while
`NOWAKI_LIVE_SECRET` is unset (logged once per instance); pages and the first HTML of live
islands still render. **Fix:** set it as a Worker secret (`npx wrangler secret put
NOWAKI_LIVE_SECRET`) or a Vercel environment variable.

### `[nowaki live] event on ... not applied: <reason>`

The island keeps its last HTML. `nowaki:live-error` is dispatched with the reason:

- `forbidden`: `live.authorize` returned something other than `true`.
- `render failed`: the handler or the render threw (see the server log), or the state's
  signature didn't verify.
- `stale`: the page's signed state is older than `NOWAKI_LIVE_MAX_AGE` (default 24 h); the page
  reloads unless a `nowaki:live-stale` listener calls `preventDefault()`.

### `server at capacity; staying on the initial SSR view`

**Cause:** the process has `NOWAKI_LIVE_MAX` (default 10000) WebSocket connections. **Fix:**
raise it, or add instances.

### `publish() reaches live islands only under nowaki dev / nowaki start`

**Cause:** the deploy adapters have no WebSocket hub, so `publish()` does nothing there. Live
islands still work per event over POST. **Fix:** use `nowaki start` for live push. See
[Jetstream: where it runs](./guides/jetstream.md#where-it-runs).

### A live island doesn't react in static output

**Cause:** there is no server for its events; the build lists such pages. **Fix:** deploy to a
server target, or make it a client island.

## Caching

### `revalidatePath` / `revalidateTag` "has no effect here"

```
[nowaki] revalidateTag has no effect here: this server keeps no ISR cache (`nowaki start` does, and the Vercel adapter purges Vercel's CDN). Purge a CDN in front of it through that CDN's API.
```

**Cause:** the node / bun / deno adapters and static output have no cache to purge; `nowaki dev`
only records the calls. **Fix:** purge your CDN through its API, or use `nowaki start`, Vercel
or Cloudflare.

### Vercel: "no @vercel/functions in the app"

**Fix:** `npm install @vercel/functions` and rebuild; the build then includes it in the
function and the purges reach Vercel's CDN.

### Cloudflare: "CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are not set" / "on workers.dev"

**Cause:** without them (and on workers.dev, which has no zone) only the local data center's
cache is cleared, and `revalidateTag` clears nothing. **Fix:** serve the Worker on a custom
domain and set both (the token needs the Cache Purge permission).

### An ISR page is never cached (`x-nowaki-cache` is always MISS, or `Cache-Control: private`)

**Cause:** the render read the session or a cookie, set a cookie, uses `streaming = "early"`,
or didn't answer 200. **Fix:** keep per-visitor reads off ISR pages (move them into an island or
a page without `revalidate`). See [Caching](./guides/caching.md#what-can-be-cached).

### Content is stale on some instances only

**Cause:** each `nowaki start` instance has its own ISR cache, and a purge reaches only the one
that ran it. **Fix:** send `POST /__nowaki/revalidate` to every instance (with
`NOWAKI_REVALIDATE_SECRET`).

## Builds

### A route over its JS budget

```
1 route(s) over their JS budget (`export const budget`). Shrink their islands or raise the budget.
```

**Fix:** use `client:visible` / `client:idle`, turn islands that only handle clicks into live
islands, or raise `budget`.

### `remote image ... is not allowed`

```
remote image https://cdn.example.com/a.jpg is not allowed: add a matching entry to images.remotePatterns in nowaki.config
```

**Fix:** add a `remotePatterns` entry for the host and path.

### `no plugin compiled this Markdoc file`

**Fix:** `npm install @nowaki-dev/markdoc` and add `markdoc()` to `plugins` in nowaki.config.

### `server function(s) take unvalidated input`

**Cause:** a `"use server"` export takes arguments without `serverFn(schema, impl)`. It is a
warning. **Fix:** wrap it, so invalid input is rejected with 400 before your code runs.

### `<page>: the page failed to render (500)` while prerendering

**Cause:** a page answered with a server error during `nowaki prerender` or the static adapter.
Redirects and 404s are skipped; 5xx fails the build. **Fix:** run the page in `nowaki dev` to see
the error.

### Content: `content/blog/x.md: title: ...`

**Cause:** an entry doesn't match its collection's schema. **Fix:** correct the frontmatter or
the schema. A directory under `content/` that `content/config.ts` doesn't export is an error too.

## Still stuck

- `npx nowaki --version` and the `@nowaki-dev/runtime` version in `package.json` must match.
- In dev, the toolbar's error list and the MCP tool `recent_errors` show the latest errors with
  stacks.
- Report bugs as described in [SUPPORT.md](../SUPPORT.md), and security issues privately as in
  [SECURITY.md](../SECURITY.md#reporting-a-vulnerability).
