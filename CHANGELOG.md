# Changelog

All notable changes to Nowaki are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Nowaki is **0.x alpha**: minor versions may carry
breaking changes (documented per entry), patch versions do not.

The npm version and the milestone codename are offset — each release bundles a
milestone's worth of work; the codename is noted per entry.

## [Unreleased]

### Added
- **Build hints for islands that could ship no JS.** `nowaki build` reads
  each client island's AST and points out two kinds:
  - Islands that only keep state (`useState` / `useReducer`) and handle
    click or form events (`onClick`, `onSubmit`, `onInput`, `onChange`).
    Rewritten as live islands, they ship no JS, and pages where they are the
    only client island lose the islands runtime too. The catch is a server
    round trip per event.
  - Islands with no state and no event handlers, which would render the same
    as plain components.

  No hint is given when an island uses other hooks, other events, `ref`,
  browser globals, or imports anything but preact / React / CSS.
  `NOWAKI_HINTS=0` hides the hints. In `examples/hello`: Counter,
  ReactCounter, and TsrxCounter could be live, and Badge needs no island.
- **First-load JS per route, and budgets that fail the build.** Every
  `nowaki build` and `nowaki prerender` now prints the gzip size of the JS
  each page route loads first, and writes the same data to
  `dist/route-js.json`.
  - Counted: the islands runtime and its preloads, every client island the
    page can render (found through the import graph from the route and each
    `_layout` above it, components included), and the live runtime for live
    islands. The lazy SPA router chunk is not counted.
  - A route sets `export const budget = { js: <KB> }`, and the build fails
    when the route goes over it. `{ js: 0 }` means the page ships no client
    JS.
  - The value is read from the AST. It must be a number literal, and an
    unreadable `budget` fails the build instead of being ignored.
  - `examples/hello` sets `{ js: 12 }` on `/` (9.76 KB today) and
    `{ js: 0 }` on `/about`.
  - `scripts/route-js-e2e.mjs` checks the report against the pages
    `nowaki start` serves. Each served chunk must be one the report counted;
    18 of 19 static routes match exactly. The other one is `/stream`, whose
    islands load later.
- **`nowaki dev` MCP endpoint:** while `nowaki dev` runs, a coding agent can
  inspect the app over MCP (Streamable HTTP) at
  `http://127.0.0.1:<port>/__nowaki/mcp`. The startup banner prints the URL and
  the command that adds it to Claude Code:
  `claude mcp add --transport http nowaki http://127.0.0.1:<port>/__nowaki/mcp`.
  The tools are read-only. `routes` lists the route table in match order, with
  kind, file, exports, ISR `revalidate`, and `csrf`. It also lists layouts,
  middleware, and boundaries. `module_graph` shows a file's imports and
  importers, and the islands with their `live` flag. `recent_errors` returns
  the last 50 build (transform), SSR, live, and HMR errors with timestamps,
  file, and stack. `dev_config` shows the port, the `NOWAKI_*` flags, and the
  Jetstream connections and rooms. The endpoint answers only loopback clients
  with a loopback `Host` / `Origin`, also under `--host`. `nowaki start` and
  the adapters don't serve it.
- **Jetstream stale notifications:** an event on a page older than
  `NOWAKI_LIVE_MAX_AGE` (24 h by default) used to fail like a forged one.
  The server now tells the two apart. A genuine, expired signature comes back
  as `reason: "stale"` over WebSocket and as HTTP 409 over POST. The client
  dispatches a cancelable `nowaki:live-stale` event and, unless the app calls
  `preventDefault()`, reloads the page to get fresh signed state. A tampered
  or future-dated signature is still rejected as before (`403`).
- **Jetstream rooms survive a restart:** `nowaki start` writes the rooms'
  shared state to `.nowaki/live-rooms.json` and loads it on the next start.
  It writes at most every 2 s after a change, through a temp file and a
  rename, and once more on shutdown. `nowaki start` now stops its Node
  process with SIGTERM and a 3 s grace period before killing it. Set
  `NOWAKI_LIVE_ROOMS_FILE` to choose another file (relative to the app), or
  `off` to keep rooms in memory only. A shared state that JSON can't hold
  (BigInt, a cycle) logs a warning and is not saved. This applies to a single
  process only: `nowaki dev` and the adapters don't save rooms.

### Changed
- **ISR pages are cached from the first request.** Right after startup,
  `nowaki start` renders every ISR page once in the background, so the first
  visitor gets a page from the Rust front instead of waiting for a render.
  - Covered: static routes with `export const revalidate` > 0, plus each
    `staticPaths` entry of dynamic ones. The list is capped at
    `NOWAKI_ISR_MAX`.
  - It renders two pages at a time, through the normal request path, with
    no cookies. A page that varies on a header is stored only under the
    empty value of that header, so it never serves someone else's variant.
  - The renders run route middleware and loaders like any request.
    `NOWAKI_ISR_WARM=0` turns this off.
  - `examples/hello`: 2 pages in 16 ms.
- **Compressed responses and 304s on `nowaki start`.** Before this change,
  every response went out uncompressed, and `/_nowaki/*` assets were read
  from disk on each request.
  - `nowaki build` now writes `.br` (quality 11) and `.gz` (level 9)
    siblings for client JS, CSS, JSON, and SVG files of 1 KB or more. Source
    maps are skipped. The output is reproducible.
  - `nowaki start` holds the assets in memory and picks br, gzip, or none
    from `Accept-Encoding` (q-values included).
  - ISR pages are compressed once, when they are stored.
  - Both send a weak `ETag` and `Vary: Accept-Encoding`, and answer a
    matching `If-None-Match` with `304`.
  - With `NOWAKI_CSP` on, ISR pages are left uncompressed and get no ETag,
    because each response carries a new nonce.
  - Uncached (proxied) responses are not compressed yet.

  The preact runtime chunk in `examples/hello` drops from 12.0 KB to 4.6 KB
  on the wire.
- **About 4x the throughput on `nowaki start` and the Node adapters.** In
  production, every request ran `import()` on the route's module again. The
  module was cached, but with the react-alias loader hooks registered, each
  `import()` made a synchronous round trip to the hooks thread, and that took
  half the CPU time of a page. Production modules are now imported once.
  Measured on `examples/hello`, 50 connections, Apple M2: `/about` on
  `nowaki start` went from 6,056 to 28,752 req/s, and `/api/hello` from
  8,895 to 32,101 req/s. Dev mode is unchanged: it re-imports on every edit.

### Fixed
- **Live islands are detected from the AST.** The build used to look for
  the text `export const live`. A comment containing it turned a client
  island into a live one, which then shipped no JS. `export { x as live }`
  and `export { live } from "…"` were missed and shipped a client chunk.
  Now any exported binding named `live` counts, and comments and strings
  don't.

## [0.15.0] — 2026-11-04 · "Cyclone" (part 1)

Packages: `nowaki` / `nowaki-core` 0.15.0 (crates.io, npm), `@nowaki-dev/runtime`
0.14.0, `create-nowaki` / `create-nowaki-app` 0.16.0. New apps get
`@nowaki-dev/runtime@^0.14.0` and `nowaki@^0.15.0`.

Jetstream 2: live islands work on every deploy adapter (per event over POST),
handlers see the request, `publish()` pushes server-side changes, islands can
share a room, and forms and inputs are live. Still open in v0.15: rooms that
survive a server restart, stale-state notifications, and a fan-out benchmark.

### Upgrade notes
- The deploy adapters now ship `live.js`, so live islands that were static on
  them become interactive (over POST). Pin a page to the old behavior with
  `<meta name="nowaki-live" content="ws">`, which never falls back to POST.
- Room state and `publish()` live in one server process: they don't reach
  other instances, and rooms start empty after a restart.
- On the adapters, set `NOWAKI_LIVE_SECRET` when more than one instance (or
  Worker isolate) can serve a request, or live events fail signature checks.
  The Cloudflare `wrangler.jsonc` now enables `nodejs_compat_populate_process_env`
  so Worker vars and secrets reach `process.env`.

### Added
- **Jetstream rooms:** `live.room(props)` names a room and `live.shared()` is
  its initial state; every island in the same room shares that state, handlers
  receive and return it, and a change re-renders every member (on any
  connection in the process). `data-nowaki-presence="<room>"` shows how many
  connections are in the room. Rooms are held in the server process's memory
  (single process, lost on restart); on the deploy adapters a room island
  renders and handles events, but other members aren't pushed. See `/poll` in
  `examples/hello` for the two-tab demo.
- **Jetstream form events:** `data-live-submit="handler"` on a `<form>` sends
  its fields as an object (no navigation); `data-live-input="handler"` sends a
  field's value while typing, debounced by `data-live-debounce` (ms, default
  150); `data-live-change="handler"` fires on commit. Checkboxes and radios
  send `{ value, checked }`. Children with `data-key` are matched by key when
  a patch is applied, so reordered or filtered rows keep their elements, and a
  focused field's value is never overwritten by a patch.
- **Jetstream live queries:** `live.subscribe` (topics, or a function of the
  state) and `live.load(state, { topic })` on an island, plus `publish(topic)`
  from `@nowaki-dev/runtime`: after server code changes data (an action, a
  server function, an API route), every subscribed island reloads and gets a
  pushed patch without a client event. Under `nowaki dev` / `nowaki start` it
  reaches connections in the same process; on the deploy adapters it is a no-op
  for now.
- **Jetstream request context:** live handlers can call `getContext()` to read
  the cookies and `authorization` / `accept-language` / `user-agent` headers of
  the WebSocket upgrade, and `live.authorize({ name, handler, state, payload })`
  runs before each handler (after the signature check); anything but `true`
  refuses the event with `{ type: "error", reason: "forbidden" }`. Cookies set
  after the socket opened are seen after the next reconnect.
- **Jetstream on the deploy adapters.** Live islands are now interactive on the
  node / bun / deno / vercel / cloudflare adapters: each event is a
  `POST /__nowaki/live-event` carrying the island's signed state, and the reply
  is the new HTML, state, and signature. `nowaki dev` / `start` keep the
  WebSocket and fall back to POST for any event sent while the socket isn't
  open. `<meta name="nowaki-live" content="post">` (or `"ws"`) in a page's
  `head` pins the transport. Presence is only available over the WebSocket.
  The route has the same CSRF gate as server functions (JSON,
  `x-nowaki-live: 1`, cross-site requests rejected) and a 64 KiB body cap.

### Changed
- The scaffolded `AGENTS.md` and `README.md` gain a security checklist
  (`serverFn`, middleware running before the CSRF check, `csrf = true` for
  cookie-authenticated APIs, and the production env vars).
- **Smaller client JS:** the build mangled names but never printed them, so
  client chunks kept their full local names. They are now mangled, annotation
  comments (`/* @__PURE__ */`) are dropped (legal comments stay), and an island
  chunk imports each shared chunk in one statement. On the counter benchmark,
  first-load JS goes from 9.29 to 8.69 KB gzip and the idle-loaded router from
  4.05 to 2.77 KB.
- **Faster `nowaki prerender`:** the temporary prod server and the
  `staticPaths` evaluation (two Node processes) now start together instead of
  one after the other, and up to 8 pages are requested at once (results are
  written in the original order). On an M2, a 10-page blog prerenders in
  119 ms instead of 157 ms and a 1000-page one in 488 ms instead of 675 ms;
  the output is unchanged.

### Fixed
- **Security:** on the node / bun / deno / vercel adapters, the action and
  server-function same-origin checks compare against `Host`, not a
  client-sent `x-forwarded-host`. `x-forwarded-host` is used only behind
  `NOWAKI_TRUST_PROXY=1`, on the Rust front's own sidecar hop (loopback
  `Host`), or on Vercel, whose edge sets it.
- **Builds are reproducible:** an island that hoists several app modules (for
  example two modules in an import cycle) got a different chunk, hash and
  manifest from one build to the next, because the modules' order followed
  hash-set iteration. They are now ordered by path.
- **Security:** `nowaki dev` / `nowaki start` no longer proxy
  `/__nowaki/live-render` (404). That endpoint is the sidecar's internal
  re-render call from `live.rs`, and it trusts its body; reached through the
  public port, a cross-site `text/plain` POST could run live handlers with a
  replayed signed state, and with the new request context it could claim any
  cookie and pass `live.authorize`. The sidecars also match the path exactly.
  (The replay part also shipped in 0.14.1.)
- A Jetstream event can only call the island's own `live.on` handlers, not
  inherited object methods such as `toString`.

## [0.14.1] — 2026-11-04 · security patch

Packages: `nowaki` / `nowaki-core` 0.14.1, `@nowaki-dev/runtime` 0.13.1
(`create-nowaki` is unchanged; new apps already get these through `^` ranges).

### Fixed
- **Security:** `nowaki dev` / `nowaki start` no longer proxy
  `/__nowaki/live-render` (404). That endpoint is the sidecar's internal
  re-render call from the Rust live session, and it trusts its body. Reached
  through the public port, a cross-site `text/plain` POST could run any live
  island handler on a signed state copied from a page, with no CSRF gate. The
  sidecars also match the path exactly.

## [0.14.0] — 2026-11-04 · "Gale" (and "Zephyr" complete)

Packages: `nowaki` / `nowaki-core` 0.14.0 (crates.io, npm), `@nowaki-dev/runtime`
0.13.0, `create-nowaki` / `create-nowaki-app` 0.15.0. New apps get
`@nowaki-dev/runtime@^0.13.0` and `nowaki@^0.14.0`.

### Upgrade notes
- Cross-site non-GET requests to page actions now get **403**. Behind a proxy
  that rewrites `Host`, forward the public host as `x-forwarded-host` (and set
  `NOWAKI_TRUST_PROXY=1` for `nowaki start`). `export const csrf = false` opts
  a route out.
- In production, a server function error other than `ServerFnError` reaches
  the client as a generic `Internal Server Error`. Throw `ServerFnError` for
  messages users should see.
- Live (Jetstream) signatures from earlier versions no longer verify; pages
  left open across the deploy start from fresh state after a reload. Set
  `NOWAKI_LIVE_SECRET` in production.
- Every response now carries default security headers, including
  `cross-origin-opener-policy: same-origin`; a popup flow that needs
  `window.opener` should send its own value (or `NOWAKI_SECURITY_HEADERS=off`).

### Added
- **`npm create nowaki` templates:** `.env.example`, a Security section in scaffolded
  `AGENTS.md`, and (basics template only) `routes/_404.tsx`, `routes/api/health.ts`,
  and a validated `"use server"` example in `actions/echo.ts`.
- **Content Security Policy (opt-in):** `NOWAKI_CSP=report-only` or `enforce`
  sends a policy limiting scripts and style elements to `'self'` plus a
  per-response nonce, which Nowaki adds to every `<script>` / `<style>` in HTML
  responses (`nowaki dev` / `start` while streaming, ISR hits included, and the
  adapters). Island CSS and client navigation re-stamp the nonce on styles they
  insert. `NOWAKI_CSP_REPORT_URI` adds a `report-uri`. A CDN that caches HTML
  reuses the cached nonce.
- **`serverFn(schema, impl)`** validates a server function's first argument
  with any [Standard Schema](https://standardschema.dev) library (zod, valibot,
  arktype) before `impl` runs; invalid input is a 400 with `data.issues`.
  `nowaki build` warns about `"use server"` exports that take arguments without
  it.
- **`ServerFnError(message, { status, data })`**: thrown from a server function,
  its status, message, and `data` reach the client, where the thrown `Error`
  carries `status` and `data`.
- **Default security headers** on every response from `nowaki dev`,
  `nowaki start` (ISR hits and static assets included), all deploy adapters,
  and the `_headers` file `nowaki prerender` writes:
  `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`,
  `referrer-policy: strict-origin-when-cross-origin`,
  `cross-origin-opener-policy: same-origin`, and
  `content-security-policy: frame-ancestors 'self'` when the app sends no CSP.
  A header the response already sets is kept; `NOWAKI_SECURITY_HEADERS=off`
  turns them off.

### Fixed
- **Security:** the cloudflare adapter fills a missing `Host` from the request
  URL, so the action and server-function same-origin checks compare against the
  real host; Web `Request`s may omit it, which made same-origin form posts
  fail and let a cross-origin RPC through. The server-function check now also
  rejects an `Origin` when there is no host to compare it with.
- Jetstream: a live connection no longer stalls while the sidecar re-renders.
  The render runs off the session loop (pings, presence, and new events keep
  flowing), one at a time per connection so each island's state stays in
  order, with up to 32 events queued behind it. A render that takes longer
  than `NOWAKI_LIVE_RENDER_TIMEOUT_MS` (default 10000) or fails is reported to
  the client as `{ type: "error", nid, reason }` (`timeout`, `render failed`,
  or `busy` when the queue is full) and dispatched as a `nowaki:live-error`
  window event; the island keeps its last HTML and state. Before, a hung
  sidecar call blocked the connection with no timeout.
- **Security:** the Rust front (`nowaki dev` / `nowaki start`) no longer passes
  client-sent `x-forwarded-*`, `forwarded`, `x-real-ip`, or internal
  `x-nowaki-*` headers to the Node sidecar. It sets `x-forwarded-host` from
  `Host` itself, so a client can't choose the host the server-function
  same-origin check compares against. Behind a reverse proxy that sets these
  headers, `NOWAKI_TRUST_PROXY=1` uses its `x-forwarded-host` /
  `x-forwarded-proto` (also for the WebSocket Origin check) and keeps
  `x-forwarded-for`.
- The cloudflare adapter renders live (Jetstream) islands with their initial
  state. It ignored `liveIslands`, so a page with a live island returned 500.

### Changed
- **Security:** live (Jetstream) state signatures include their issue time
  (`v1.<iat>.<mac>`) and are rejected after `NOWAKI_LIVE_MAX_AGE` seconds
  (default 86400), so a captured state can't be replayed forever; every patch
  is re-signed, so an active island doesn't expire. Signatures from earlier
  versions no longer verify (live islands on an open page re-render from the
  server after a reload). The key is created on first use, and production
  servers warn at startup when `NOWAKI_LIVE_SECRET` is unset.
- **Security:** in production, a server function error other than
  `ServerFnError` returns a generic `Internal Server Error` (500) and is logged;
  before, its message was sent to the client. Dev still shows the message.
  Request bodies over `NOWAKI_FN_BODY_LIMIT` (default 1 MiB) get 413, and calls
  with more than 16 arguments get 400.
- **Security:** page actions reject cross-site non-GET requests with 403: an
  `Origin` from another site or `null`, or `Sec-Fetch-Site: cross-site`.
  Same-origin form posts and requests without either header (curl,
  server-to-server) are unaffected. API routes log a one-time warning for now;
  `export const csrf = true` rejects there too, and `export const csrf = false`
  opts any route out. Behind a proxy that rewrites `Host`, forward the public
  host as `x-forwarded-host`.
- Docs: clearer SECURITY.md layout (audience map, defenses ↔ AGENTS invariants) and
  contributor pointers in CONTRIBUTING.md.

## [0.13.0] — 2026-11-03 · "Zephyr" (part 1)

Packages: `nowaki` / `nowaki-core` 0.13.0 (crates.io, npm), `@nowaki-dev/runtime`
0.12.0, `create-nowaki` / `create-nowaki-app` 0.14.0. New apps get
`@nowaki-dev/runtime@^0.12.0` and `nowaki@^0.13.0`.

### Added
- **SSG for dynamic routes:** `export const staticPaths` on a `[param]` or
  `[...rest]` route lists the params to prerender (an array, or a sync/async
  function returning one; typed as `StaticPaths`). `nowaki prerender` and the
  static adapter render one page per entry. Values that would escape the output
  directory (`..`, `/`, empty) are rejected.
- `nowaki prerender` writes `404.html` from `routes/_404.tsx`, which static
  hosts (Cloudflare Pages, Netlify, GitHub Pages) serve for unknown paths.

### Changed
- `@nowaki-dev/runtime` accepts **preact 11** (`peerDependencies.preact` is now
  `^10.25.0 || ^11.1.0`) and requires `preact-render-to-string` **6.8.2 or
  later**. preact 11 with an older `preact-render-to-string` renders every page
  to an empty string, so the peer floor now rules that combination out. New
  apps from `npm create nowaki` get `preact-render-to-string@^6.8.2`.
- Nowaki is now a personal open-source project: the license holder and package
  author are Tettu0530, and the repository is `github.com/Tettu0530/nowaki`.
  Security reports go through GitHub private vulnerability reporting.

### Fixed
- `nowaki start` serves `/_nowaki/*` only for build-output file names
  (`[A-Za-z0-9._-]`). The previous check split the path on `/` only, which on
  Windows would have let `\`, drive letters, and `..` reach files outside
  `dist/client`. No released version was reachable this way, because
  `nowaki start` didn't start on Windows before this release.
- React libraries now SSR: `react` / `react-dom` imports inside node_modules
  resolve to `preact/compat` on the server (a Node resolve hook in the dev and
  production sidecars and the node adapter), instead of loading real React and
  failing every hook call. The client alias table also maps
  `react-dom/client`, `react-dom/server`, `react/compiler-runtime`, and
  `scheduler` to their `preact/compat` counterparts, and
  `process.env.NODE_ENV` is defined for client code.
- Jetstream: a reconnect no longer resets live islands to their initial state.
  Patches now carry the signed state, the client stores it on the element, and
  re-joining resumes from it.
- `nowaki build` starts from empty `dist/client` and `dist/server` (and the
  cloudflare / static adapter outputs), so islands you deleted no longer ship.
  `nowaki prerender --out <dir>` replaces only `<dir>/_nowaki` (#18).
- Statically prerendered sites (`nowaki prerender`, the static adapter) include
  `__nowaki/boundaries` (served as JSON via `_headers`), so the SPA router's
  loading/error boundaries work and no longer 404 on static hosts (#19).
- Client navigation applies the target page's `<style>` / `<link>` / `<meta>`
  and `<html lang>` / `dir`, and drops the previous page's. The server marks
  each page's own head content (`<meta name="nowaki-head">` start/end) and the
  router swaps only that region, so styles injected at runtime by CSS-in-JS
  libraries survive navigation (#21).
- Assets imported only from server code (e.g. a font URL in a server-side style
  module) are emitted to `dist/client` with a content-hashed name. They used to
  be referenced as `/_nowaki/<name>` without being written, and without a hash
  despite the immutable cache header (#17).
- **Security:** production servers (`nowaki start` and the node / bun / deno /
  vercel / cloudflare adapters) no longer send stack traces to clients. When a
  route fails and the app's `_500` page also fails (or there is none), the
  response is a plain `Internal Server Error`; the error is still logged. Before,
  the full stack, including absolute file paths, was returned.
- Windows: `nowaki dev` / `nowaki build` / `nowaki start` work (verbatim `\\?\`
  paths, SSR loader file URLs, and `/@fs/` drive-letter URLs).
- `nowaki dev` / `nowaki start` kill their Node children on SIGTERM instead of
  leaving them orphaned.
- The node/bun/deno adapter deploy hint and `start` script work from
  `dist/server`.
- Islands that use `import * as` (or other forms scope hoisting can't
  concatenate) are emitted unbundled instead of losing the import and throwing
  `ReferenceError` in the browser (#24).
- Adapter outputs (node/bun/deno/vercel/cloudflare) no longer ship `live.js`.
  They have no `/__nowaki/live` endpoint, so Jetstream islands there render
  their initial SSR only (Jetstream runs on `nowaki dev` / `nowaki start`).
  The live client also stops reconnecting after 8 consecutive failures.
- The vercel adapter targets the `nodejs22.x` runtime (was `nodejs20.x`,
  deprecated and below the `>=22` engines floor).

## [0.12.1] — 2026-06-15 · security audit

Packages: `nowaki` / `nowaki-core` 0.12.1, `@nowaki-dev/runtime` 0.11.1.

### Security
- Arbitrary file reads are closed: `/__nowaki/ssr-module?path=`, the dev `.env`
  fallback, virtual-module paths, and transform error bodies. Every source read
  goes through one canonicalize-and-allow-root check.
- Server-function RPC requires `application/json`, an `x-nowaki-rpc` header, and
  a same-origin request (CSRF).
- `/__nowaki/live` and `/__nowaki/hmr` check `Origin` in dev and production
  (cross-site WebSocket hijacking).
- ISR learns which query, header, and body inputs a route reads (`Vary`) and
  folds them into the cache key, so one user's page is not served to another
  and query floods do not grow the cache without bound.
- Live-island initial state is HMAC-signed and verified on every event, so a
  client can't forge it.
- Client assets no longer contain absolute build-machine paths (CSS scope ids
  and source-map sources are root-relative).

## [0.12.0] — 2026-06-14 · types, lazy hydration, Vercel

Packages: `nowaki` / `nowaki-core` 0.12.0, `@nowaki-dev/runtime` 0.11.0,
`create-nowaki` / `create-nowaki-app` 0.13.0.

### Added
- **Lazy hydration:** `client:load` (default), `client:idle`, `client:visible`,
  `client:media="<query>"`, and `client:only` on an island's usage site control
  when it hydrates. The directives are typed on any component.
- **Typed routes:** `nowaki typegen` (also run by `dev` and `build`) writes
  `.nowaki/types.d.ts`. `@nowaki-dev/runtime/navigation` exports a typed
  `route(pattern, params)` and `<Link>`; unknown paths and wrong params are
  compile errors.
- **Image optimization:** imported PNGs are losslessly re-compressed and
  stripped of metadata at build time (pure Rust, kept only when smaller).
- **Vercel adapter:** `nowaki build --adapter vercel` writes
  `.vercel/output/` (Build Output API v3) with a self-contained Node function.
  Deploy with `vercel deploy --prebuilt`.

## [0.11.0] — 2026-06-13 · scaffold templates

### Added
- **Template selection** in `npm create nowaki` (Astro-style): `-t/--template
  <basics|minimal>` or an interactive menu (default `basics`). `basics` is the
  starter with an interactive island; `minimal` is a single zero-JS page.
- **Polished starter designs** — both templates ship a clean, brand-aligned page
  (cyan accent, 野分 wordmark, subtle gradient) styled via `<style>` in
  `export const head`, so it works on zero-JS pages too.

Scaffolder-only (`create-nowaki` / `create-nowaki-app`); the CLI stays at 0.10.0
and the runtime at 0.9.0.

## [0.10.0] — 2026-06-13 · DevEx

### Added
- **Interactive `npm create nowaki` wizard** (dependency-free) — prompts for
  project name, package manager (auto-detected), git init, and dependency
  install; sets the package name and tailors the next steps. Non-interactive
  runs (`-y`, CI, pipes) scaffold with defaults and never auto-install (use
  `--install` to opt in). Flags: `-y/--yes`, `--install`, `--no-install`,
  `--no-git`, `--pm`.
- **dev/start banners** — `nowaki dev` and `nowaki start` print a clean banner
  (version, Local URL, ready time, active features). `--host` exposes the server
  on the LAN and shows the Network URL; `nowaki dev --open` opens the browser.
  Color respects `NO_COLOR` and non-TTY.
- **Fuller scaffold** — new apps now include `tsconfig.json` (Preact JSX, bundler
  resolution, `.tsx` extensions, `react`→`preact/compat` paths), `nowaki-env.d.ts`
  (css/asset/virtual/`import.meta.env` ambient types), a `README.md`, and a
  `.gitignore`, so editors give correct IntelliSense out of the box.
- **`nowaki build` summary** — build time, client modules/islands/JS size, server
  modules, and output path.

### Changed
- Missing-dependency errors are now actionable and package-manager-agnostic.
- The runtime (`@nowaki-dev/runtime`) is unchanged and stays at 0.9.0.

## [0.9.1] — 2026-06-13 · scaffolder patch

### Added
- Scaffolded apps (`npm create nowaki`) now ship `AGENTS.md` + `CLAUDE.md` so AI
  coding agents know Nowaki's conventions (islands, loaders/actions, API routes,
  `"use server"`, Jetstream) out of the box. Only `create-nowaki` and
  `create-nowaki-app` move to 0.9.1; the runtime and CLI stay at 0.9.0.

## [0.9.0] — 2026-06-13 · "Beta" (v0.8–v0.9 band)

### Added
- **Server functions (`"use server"`)** — a module with a top-of-file
  `"use server"` directive becomes an RPC boundary. Its exports run only on the
  server; the client gets a tiny `fetch` proxy (implementation and server-only
  deps are stripped from the bundle). Dispatch is allowlisted by a stable
  `module#export` id (the client can't reach arbitrary exports); `getContext()`
  exposes the request's cookies/headers via AsyncLocalStorage. Works in dev,
  `nowaki start`, and on edge adapters.
- **Plugin virtual modules** — plugins gain `resolveId(source, importer)` and
  `load(id)` hooks for modules that don't exist on disk. Client imports bundle
  the generated source inline; SSR inlines it as a self-contained `data:` module.
  Only invoked when normal resolution fails — zero overhead otherwise.
- **Jetstream presence + connection scaling** — a shared hub broadcasts the live
  connection count (`{type:"presence",count}`, mirrored into
  `[data-nowaki-presence]`), pings/expires idle connections (heartbeat), and caps
  concurrent connections (`NOWAKI_LIVE_MAX`), degrading gracefully over the cap.
- **Head-to-head benchmarks** — `benchmarks/head-to-head.mjs` compares Nowaki,
  Next.js, and Astro on the same one-counter app (measuring only what's
  installed, never fabricating). A `bench-regression` CI job gates the
  deterministic client-JS size against `benchmarks/baseline.json`.
- **Documentation site** — `/docs` (built with Nowaki, zero client JS): Overview,
  Quickstart, Routing, Server functions, Jetstream, Plugins, Deploy, and a
  Migrate-from-Next.js guide.

### Notes
- State-preserving (prefresh) HMR remains a follow-up; island hot-swap already
  gives fast feedback. Scoped CSS for TSRX islands also remains on the roadmap.

## [0.6.0] — 2026-06-13 · "Jetstream"

### Added
- **Jetstream islands** — server-reactive islands (the flagship). Mark an island
  `export const live = { state, on }` and it ships **no component JavaScript**:
  state lives on the server (per WebSocket connection), `data-live` events go to
  the Rust server, which re-renders and pushes an HTML patch that a ~2 KB client
  runtime morphs in. Client islands (optimistic UI) coexist on the same page;
  static deploys serve the initial SSR and degrade gracefully.

## [0.5.0] — 2026-06-13 · "Typhoon" (complete)

### Added
- **TSRX bridge** — `.tsrx` files (TSRX statement-container syntax) compile to
  Preact via `@tsrx/preact` and run through the oxc pipeline, in dev and prod.
- **Rust production hot path** — `nowaki start` is a Rust (axum) front that
  serves static assets and assembles the HTML document (island wiring,
  modulepreload) in Rust, delegating only component rendering to a Node sidecar.

## [0.4.0] — 2026-06-13 · "Typhoon" (core)

### Added
- **Deploy adapters** — `nowaki build --adapter <node|static|bun|deno|cloudflare>`:
  a self-contained Node server, static (SSG), Bun/Deno, and a Cloudflare Workers
  (edge) worker.
- **Streaming SSR** — opt-in per route with `export const streaming = true`.
- **Plugin API** — `nowaki.config` `transform(code, id)` hooks (dev + build).

## [0.3.0] — 2026-06-13 · "Monsoon"

### Added
- **Production bundler** — true chunk bundling with scope hoisting, tree-shaking,
  a persistent disk cache, end-to-end source maps, CSS Modules, hashed asset
  imports, and cyclic-dependency handling.
- **Next.js migration** — `react` / `react-dom` alias to `preact/compat`, so
  React-style code and React libraries run unchanged on a single Preact instance.

## [0.2.0] — 2026-06-13 · "Squall"

### Added
- **Routing & data** — nested `_layout`s, `_middleware`, server `loader`s, form
  `action`s, API routes with method dispatch and streaming, `_404`/`_500`, a
  `LoaderContext` (cookies/headers/redirect/json/formData), and an
  island-to-island SPA router.
- **npm-only install** — the CLI ships as prebuilt native binaries via npm's
  optional dependencies; no Rust toolchain required.

## [0.1.0] — [0.1.1] — 2026-06-12 · "Gust" / "Breeze"

### Added
- Initial public alpha: `nowaki dev` / `build` / `start` / `prerender`, islands
  architecture with on-demand oxc transforms, a full-screen error overlay,
  code-frame diagnostics, island hot-swap HMR, `.env` (`PUBLIC_*` exposure), and
  global CSS import.
- Published to crates.io (`nowaki-core`, `nowaki`) and npm (`@nowaki-dev/runtime`,
  `create-nowaki`, `create-nowaki-app`).

[Unreleased]: https://github.com/Tettu0530/nowaki/compare/v0.15.0...HEAD
[0.15.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.15.0
[0.14.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.14.1
[0.14.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.14.0
[0.13.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.13.0
[0.12.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.1
[0.12.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.12.0
[0.6.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.6.0
[0.5.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.5.0
[0.4.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.4.0
[0.3.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.3.0
[0.2.0]: https://github.com/Tettu0530/nowaki/releases/tag/v0.2.0
[0.1.1]: https://github.com/Tettu0530/nowaki/releases/tag/v0.1.1
