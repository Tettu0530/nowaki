// Descriptions scripts/gen-reference.mjs puts next to the names it reads from api/*.txt, for the
// surfaces whose source has no doc comment to take them from (environment variables, endpoints,
// cookies, client events and attributes, file conventions, create-nowaki flags).
//
// Keys are entry texts as they appear in the api/ snapshot (without the "  # ..." comment). The
// generator fails when a [stable] (or [dev], for env vars) entry has no description here, and when
// a key here matches no entry, so a renamed or new name can't reach docs/reference/ undescribed.
// Text is Markdown; keep it plain and factual.

/** Environment variables (api/env.txt). `group` orders env-vars.md; `default` is shown as written. */
export const ENV_GROUPS = [
  ["server", "Listening and the site URL"],
  ["security", "Security"],
  ["session", "Sessions"],
  ["live", "Jetstream (live islands)"],
  ["cache", "ISR cache and revalidation"],
  ["limits", "Request body limits"],
  ["obs", "Logs, Server-Timing and tracing"],
  ["otel", "OpenTelemetry"],
  ["cloudflare", "Cloudflare adapter"],
  ["dev", "Dev server and build conveniences (not covered by semver)"],
];

export const ENV = {
  PORT: {
    group: "server",
    default: "`3000`",
    text: "Port every server listens on: `nowaki dev`, `nowaki start`, and the node / bun / deno adapter output (`dist/server/index.mjs`). `--port` wins over it.",
  },
  NOWAKI_HOST: {
    group: "server",
    default: "`127.0.0.1` (`nowaki dev`, `nowaki start`); `0.0.0.0` (node / bun / deno adapter output)",
    text: "Address to listen on. `--host <addr>` wins over it; `--host` alone listens on all interfaces (`0.0.0.0`).",
  },
  NOWAKI_SITE: {
    group: "server",
    default: "nowaki.config `site`",
    text: "The site's absolute URL (`https://example.com`), used for canonical and Open Graph links, `sitemap.xml`, `robots.txt` and `ctx.site`. Wins over `site` in nowaki.config at runtime, on every server and adapter.",
  },
  NOWAKI_TRUST_PROXY: {
    group: "server",
    default: "unset (off)",
    text: "`1` / `true` / `yes`: trust the `x-forwarded-host` / `x-forwarded-proto` / `x-forwarded-for` headers a reverse proxy sets, for the same-origin (CSRF) checks and the request URL. Set it only behind a proxy that overwrites those headers. Read by `nowaki start` and the node / bun / deno adapter output.",
  },
  NOWAKI_CSP: {
    group: "security",
    default: "unset (off)",
    text: "`report-only` sends `Content-Security-Policy-Report-Only`, `enforce` sends `Content-Security-Policy`, both with a nonce that is new for every response, on the scripts and styles Nowaki emits and on tags written with `nonce()`. See [headers.md](headers.md#content-security-policy).",
  },
  NOWAKI_CSP_REPORT_URI: {
    group: "security",
    default: "unset",
    text: "Adds `report-uri <value>` to the `NOWAKI_CSP` policy.",
  },
  NOWAKI_SECURITY_HEADERS: {
    group: "security",
    default: "on",
    text: "`off` (or `0` / `false` / `no`) removes the [default security headers](headers.md#default-security-headers).",
  },
  NOWAKI_SESSION_SECRET: {
    group: "session",
    default: "none; `nowaki dev` generates `.nowaki/session-secret`",
    text: "Key material for `ctx.session` cookies: at least 32 characters. Several values, comma-separated, rotate keys (the first encrypts or signs new cookies, every one is accepted). Production refuses to use a session without it.",
  },
  NOWAKI_LIVE_SECRET: {
    group: "live",
    default: "a random key per process (warned)",
    text: "Key that signs live island state. Set it in production so signatures stay valid across processes, instances and restarts.",
  },
  NOWAKI_LIVE_MAX_AGE: {
    group: "live",
    default: "`86400` (24 h)",
    text: "Seconds a signed live state stays valid. An older page gets `nowaki:live-stale` and reloads.",
  },
  NOWAKI_LIVE_MAX: {
    group: "live",
    default: "`10000`",
    text: "Most live (WebSocket) connections one server accepts at once; more get an `at capacity` error.",
  },
  NOWAKI_LIVE_ROOMS_FILE: {
    group: "live",
    default: "`.nowaki/live-rooms.json`",
    text: "File (relative to the app root) where `nowaki start` saves room state (`live.room` / `shared`) and loads it from on the next start; `off` disables it.",
  },
  NOWAKI_LIVE_RENDER_TIMEOUT_MS: {
    group: "live",
    default: "`10000`",
    text: "Milliseconds one live island render may take before the event fails.",
  },
  NOWAKI_REVALIDATE_SECRET: {
    group: "cache",
    default: "unset (endpoint off)",
    text: "Enables [`POST /__nowaki/revalidate`](endpoints.md#post-__nowakirevalidate), which purges ISR pages by path or tag with `Authorization: Bearer <secret>`. The endpoint answers 404 while it is unset.",
  },
  NOWAKI_ISR_MAX: {
    group: "cache",
    default: "`1024`",
    text: "Most entries the `nowaki start` ISR cache holds per process.",
  },
  NOWAKI_ISR_WARM: {
    group: "cache",
    default: "on",
    text: "`0` / `off` / `false` / `no` stops `nowaki start` from rendering every ISR page once in the background at startup.",
  },
  NOWAKI_FN_BODY_LIMIT: {
    group: "limits",
    default: "`1048576` (1 MiB)",
    text: "Largest server function (`/__nowaki/fn`) request body, in bytes; a larger one gets 413.",
  },
  NOWAKI_FORM_BODY_LIMIT: {
    group: "limits",
    default: "`10485760` (10 MiB)",
    text: "Largest body `ctx.formData()`, `ctx.bodyText()` and `ctx.bodyJson()` read, in bytes; a larger one gets 413 before user code runs.",
  },
  NOWAKI_SERVER_TIMING: {
    group: "obs",
    default: "off in production, on in `nowaki dev`",
    text: "`1` / `true` / `yes` / `on` adds a `Server-Timing` header to responses.",
  },
  NOWAKI_LOG: {
    group: "obs",
    default: "plain text on stderr",
    text: "`json` writes one JSON object per log line, with the fields `time`, `level`, `msg`, `source`, `trace_id` and `span_id`.",
  },
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    group: "otel",
    default: "unset (tracing off)",
    text: "OTLP/HTTP collector base URL; traces go to `<endpoint>/v1/traces`. Tracing is on when this or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. The Rust front needs a plain `http://` URL (a local collector).",
  },
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: {
    group: "otel",
    default: "unset",
    text: "Full traces URL; wins over `OTEL_EXPORTER_OTLP_ENDPOINT`.",
  },
  OTEL_EXPORTER_OTLP_HEADERS: {
    group: "otel",
    default: "unset",
    text: "Headers sent to the collector, as `k1=v1,k2=v2` (values percent-decoded).",
  },
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: {
    group: "otel",
    default: "unset",
    text: "Like `OTEL_EXPORTER_OTLP_HEADERS`, for traces; wins over it.",
  },
  OTEL_SERVICE_NAME: {
    group: "otel",
    default: "`nowaki`",
    text: "The `service.name` of exported spans.",
  },
  OTEL_SDK_DISABLED: {
    group: "otel",
    default: "unset",
    text: "`true` turns tracing off even with an endpoint set.",
  },
  OTEL_TRACES_SAMPLER: {
    group: "otel",
    default: "`parentbased_always_on`",
    text: "`always_on`, `always_off`, `traceidratio`, `parentbased_always_on`, `parentbased_always_off` or `parentbased_traceidratio`. An unknown name is the default.",
  },
  OTEL_TRACES_SAMPLER_ARG: {
    group: "otel",
    default: "`1`",
    text: "The ratio (0 to 1) for the `traceidratio` samplers.",
  },
  OTEL_BSP_SCHEDULE_DELAY: {
    group: "otel",
    default: "`5000`",
    text: "Milliseconds between span exports.",
  },
  OTEL_BSP_MAX_EXPORT_BATCH_SIZE: {
    group: "otel",
    default: "`512`",
    text: "Most spans in one export.",
  },
  OTEL_BSP_MAX_QUEUE_SIZE: {
    group: "otel",
    default: "`2048`",
    text: "Most spans waiting for export; more are dropped.",
  },
  CLOUDFLARE_ZONE_ID: {
    group: "cloudflare",
    default: "unset",
    text: "With `CLOUDFLARE_API_TOKEN`, set on the Worker: `revalidatePath` / `revalidateTag` purge the zone by tag, in every data center. Without them only the local data center's cache is purged by path, and tags purge nothing.",
  },
  CLOUDFLARE_API_TOKEN: {
    group: "cloudflare",
    default: "unset",
    text: "API token with the Cache Purge permission, for the zone purge (see `CLOUDFLARE_ZONE_ID`). Set it as a Worker secret.",
  },
  NOWAKI_TOOLBAR: {
    group: "dev",
    default: "on",
    text: "`0` / `off` / `false` keeps the dev toolbar out of pages under `nowaki dev` (same as `--no-toolbar`).",
  },
  NOWAKI_EDITOR: {
    group: "dev",
    default: "`vscode`",
    text: "Where the dev toolbar's source links open: `vscode`, `code`, `vscode-insiders`, `cursor`, `windsurf`, `zed`, or a URL template with `{file}` (and optionally `{line}`, `{column}`).",
  },
  NOWAKI_HINTS: {
    group: "dev",
    default: "on",
    text: "`0` / `off` / `false` hides the \"could be live\" hints in the `nowaki build` report and the dev tools.",
  },
  NOWAKI_IMAGES_REFRESH: {
    group: "dev",
    default: "off",
    text: "`1` fetches remote `<Image>` sources again instead of using the cached copies.",
  },
  NOWAKI_DEV_ALLOWED_HOSTS: {
    group: "dev",
    default: "unset",
    text: "When `nowaki dev` listens beyond loopback: extra `Host` names it answers (comma-separated; `*` for any). IP addresses, `localhost`, `*.localhost` and `*.local` are always accepted.",
  },
};

/** Stable entries of api/http.txt. */
export const HTTP = {
  "/__nowaki/health":
    "Liveness check of `nowaki start` and the node / bun / deno adapter output (also `HEAD`): `200` with `{\"status\":\"ok\"}`. `nowaki start` answers `503` when its renderer doesn't respond. Never cached (`Cache-Control: no-store`).",
  "/__nowaki/revalidate":
    "Purges ISR pages on the server that receives it, as `revalidatePath` / `revalidateTag` do. Off (404) unless `NOWAKI_REVALIDATE_SECRET` is set. The request needs `Authorization: Bearer <secret>` (else 401), `Content-Type: application/json` (else 415) and a body `{ \"paths\": [\"/blog\"], \"tags\": [\"posts\"] }` with 1 to 256 entries in all (else 400; an invalid path or tag is a 400 too). The answer is `200` with `{ \"revalidated\": { \"paths\": [...], \"tags\": [...] } }`. Send it to every `nowaki start` instance to purge them all.",
  "/_nowaki/":
    "Prefix of the built client assets (scripts, styles, fonts, images), under `basePath` when one is set. Reserved: don't put routes or `public/` files there. The file names under it are not covered by semver.",
  nowaki_locale:
    "The visitor's locale choice with `i18n.detect`: set by `setLocale()` (and a `<Link locale>` click in an island) with `Path` = basePath, one year, `SameSite=Lax`. A request to the site's root follows it before `Accept-Language`.",
  nowaki_session:
    "The default `ctx.session` cookie name (`cookieName` in session.ts changes it). `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, `Path` = basePath. Encrypted (cookie store) or a signed id (with a `store`).",
  "x-nowaki-cache":
    "Response header of `nowaki start` on ISR pages: `HIT` (served from the cache), `STALE` (served from the cache while a re-render runs) or `MISS` (rendered for this request).",
};

/** Stable entries of api/client.txt. */
export const CLIENT = {
  "nowaki:page-load":
    "Dispatched on `document` after the client router has swapped in a new page and hydrated its islands (not on the first, full page load). `detail`: `{ url, timing }`, plus `slot` (the slot name) when only an intercepting slot was replaced.",
  "nowaki:action":
    "Dispatched (bubbling) on a `<form action={serverFn}>` after the server function answered. `detail`: `{ id, ok, result, error }`.",
  "nowaki:live-error":
    "Dispatched on `window` when a live island event was not applied (the island keeps its last HTML). `detail`: `{ nid, reason }`; `reason` is a short string such as `stale`, `busy` or `forbidden`.",
  "nowaki:live-stale":
    "Dispatched on `window` (cancelable) when a live island's signed state is older than `NOWAKI_LIVE_MAX_AGE`. The page reloads unless a listener calls `preventDefault()`. `detail`: `{ nid }`.",
  "nowaki:presence":
    "Dispatched on `window` when the number of live connections changes. `detail`: `{ count, room }` (`room` is set for a room island's members).",
  "data-live":
    "Inside a live island: a click on the element sends the event named by the value to the island's `live.on` handler, with the element's `value` (if any) as the payload.",
  "data-live-submit":
    "On a `<form>` inside a live island: submitting it sends the named event with the form's fields as an object, without navigating.",
  "data-live-input": "Inside a live island: sends the named event while the user types (debounced, see `data-live-debounce`), with the field's value.",
  "data-live-change":
    "Inside a live island: sends the named event when the field's value is committed (blur, select, checkbox). Checkboxes and radios send `{ value, checked }`, other fields their value.",
  "data-live-debounce": "Milliseconds `data-live-input` waits after the last keystroke. Default `150`.",
  "data-nowaki-transition":
    "On an `<a>` or an element around links: client navigations from those links run as View Transitions. `<Link viewTransition>` renders it.",
  "data-nowaki-error": "In `error.tsx`: the element the client router writes the failed navigation's error message into.",
  "data-nowaki-reset": "In `error.tsx`: a click on this element retries the failed navigation.",
  "data-nowaki-presence":
    "An element whose text the live runtime keeps set to the number of live connections: `\"\"` counts every connection, a room id counts that room's members.",
};

/** Stable entries of api/files.txt. */
export const FILES = {
  "routes/ file extensions: .tsx .ts .jsx .js .mdx": "Files under `routes/` with these extensions are routes. The path under `routes/` is the URL path.",
  "routes/**/index": "`index` is the URL of its directory: `routes/blog/index.tsx` is `/blog`.",
  "routes/api/** (API routes)": "Modules under `routes/api/` are API routes: they export request-method handlers ([ApiModule](runtime.md#apimodule)) instead of a page.",
  "routes/**/<name>.<ext>.ts (file routes, e.g. feed.xml.ts)":
    "A file route: a module whose name has a second extension serves that file (`routes/feed.xml.ts` is `/feed.xml`). It exports handlers like an API route.",
  "[...rest] (catch-all segment)": "A catch-all segment: matches one or more path segments; the param is a `string[]`.",
  "[param].<ext> (param with a fixed extension)": "A param followed by a fixed extension, for file routes: `routes/og/[card].png.ts` matches `/og/home.png` with `card = \"home\"`.",
  "[param]": "A dynamic segment: matches one path segment; the param is a `string`.",
  "routes/**/_layout": "Wraps every page in its directory and below ([LayoutModule](runtime.md#layoutmodule)). Layouts nest.",
  "routes/**/_middleware": "Runs before every request whose URL is under its directory (in a route group: the routes inside the group) ([MiddlewareModule](runtime.md#middlewaremodule)). Middleware nests, outermost first.",
  "routes/**/loading": "A client loading boundary ([LoadingComponent](runtime.md#loadingcomponent)), shown when a client navigation under its directory takes over 150 ms. It takes the URL `loading` in that directory.",
  "routes/**/error": "A client error boundary ([ErrorPageProps](runtime.md#errorpageprops)), shown when a client navigation under its directory fails. It takes the URL `error` in that directory.",
  "routes/**/_404": "The page rendered, with status 404, for a URL no route matches. One per app: `routes/_404.tsx`.",
  "routes/**/_500": "The page rendered, with status 500, when rendering a route fails. One per app: `routes/_500.tsx`.",
  "routes/**/default (slot fallback, @slot/default only)": "In a slot directory (`@modal/default.tsx`): what the slot renders when no file in it matches the URL.",
  "routes/**/_* (other names reserved)": "Other names starting with `_` are reserved and not routed.",
  "routes/**/(group)/": "A route group: the directory organizes files (and can hold its own `_layout` / `_middleware`) without adding a URL segment.",
  "routes/**/@slot/": "A parallel route slot: rendered next to the page into the layout's `slots` prop ([LayoutProps](runtime.md#layoutprops)).",
  "(.)x (..)x (...)x intercepting segments inside a slot":
    "Intercepting routes, inside a slot: on client navigation, `(.)x` takes over the URL `x` at the same level, `(..)x` one level up, `(...)x` from the root, and renders into the slot instead of a full page load.",
  "islands/": "Island components: each module's default export hydrates in the browser where a page renders it ([IslandModule](runtime.md#islandmodule)).",
  "content/ with content/config.ts | content/config.js | content/config.mjs | content/config.mts":
    "Content collections, declared in `content/config.ts` with `defineCollection` ([runtime-content.md](runtime-content.md)).",
  "content/<collection>/":
    "The entries of a collection: `.md` / `.mdx` (and `.mdoc` with `@nowaki-dev/markdoc`) with YAML or TOML frontmatter, or `.json` / `.yaml` data files. With i18n, a first-level directory named after a locale holds that locale's entries.",
  "public/": "Files served as they are, at the site's root (under `basePath`).",
  "env.ts | env.mts | env.js | env.mjs": "The app's environment variables, declared with `defineEnv` ([runtime-env.md](runtime-env.md)) and validated at build time and at startup.",
  "session.ts | session.mts | session.js | session.mjs": "Session options: `export default defineSession(...)` ([runtime-session.md](runtime-session.md)).",
  "nowaki.config.mjs | nowaki.config.js": "The app's configuration: `export default defineConfig(...)` ([config.md](config.md)).",
  ".env | .env.local (.env.local wins over .env; loaded into process.env, never overriding it)":
    "Environment files in the app root, loaded into `process.env` by the servers. `.env.local` wins over `.env`; a variable already in the environment wins over both.",
  ".nowaki/types.d.ts (typegen output)": "Generated by `nowaki typegen` (and `nowaki dev`): the app's routes, collections and env types. The rest of `.nowaki/` is internal.",
  "source extensions: .ts .tsx .js .jsx .mjs .tsrx .mdx .mdoc": "Extensions Nowaki compiles in app source (`.mdoc` needs `@nowaki-dev/markdoc`, `.tsrx` needs `@tsrx/preact`).",
  ".tsrx (compiled with the app's @tsrx/preact)": "TSRX components, compiled with the app's own `@tsrx/preact`.",
};

/** create-nowaki flags (api/create-nowaki.txt [stable flags]). */
export const CREATE_FLAGS = {
  "<dir>": "The directory to create (must be missing or empty). Asked for on a terminal; `nowaki-app` otherwise.",
  "--template <value>": "The template: see the list below. Default `basics`.",
  "-t <value>": "Short for `--template`.",
  "--pm <value>": "The package manager to install with (`npm`, `pnpm`, `yarn`, `bun`). Default: the one that ran the command, else npm.",
  "--yes": "No prompts: every question takes its default.",
  "-y": "Short for `--yes`.",
  "--install": "Install dependencies even without prompts (they are skipped by default then).",
  "--no-install": "Don't install dependencies.",
  "--no-git": "Don't offer to initialize a git repository.",
};
