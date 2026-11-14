# Stability and versioning

This document says what Nowaki promises to keep working across releases from 1.0.0 on, what
counts as a breaking change, how features are deprecated, and which platforms are supported.
[SUPPORT.md](../SUPPORT.md) says which release lines get fixes and for how long.

Until 1.0.0 the 0.x rules in [CHANGELOG.md](../CHANGELOG.md) apply: a minor may break, a patch
does not. 0.20.0 is the last release that may break the public surface (see
[Road to 1.0](#road-to-10)).

## Packages and versions

| Package | Version line | Covered by this policy |
| --- | --- | --- |
| `nowaki` (npm wrapper, the five `@nowaki-dev/cli-*` platform packages, and the `nowaki` crate binary) | shared | Yes, as a CLI |
| `@nowaki-dev/runtime` | shared | Yes |
| `create-nowaki`, `create-nowaki-app` | shared | Yes: command-line flags, template names (`basics`, `minimal`) and the shape of the generated app |
| `@nowaki-dev/markdoc` | its own (1.0.0 at the Nowaki 1.0 release) | Yes, under its own semver |
| `nowaki-core` (crate) | its own 0.x | No: internal, see below |

- The packages on the shared line always have the same version and are released together.
  Use the same version of the CLI and `@nowaki-dev/runtime` in an app.
- The CLI refuses to run against a `@nowaki-dev/runtime` that is older than itself or of
  another major (on 0.x, another minor), since 0.20.0. Prereleases order as SemVer says
  (`1.0.0-rc.1` < `1.0.0-rc.2` < `1.0.0`), so a 1.0.0 CLI refuses a 1.0.0-rc runtime.
- `@nowaki-dev/markdoc` follows semver on its own line: a breaking change to it is a markdoc
  major, independent of Nowaki's.
- `nowaki-core` is the CLI's engine. It is published so that `cargo install nowaki` works, it
  is not a supported Rust API, and it has its own 0.x version line (`version` in
  `crates/nowaki-core/Cargo.toml`, no longer the workspace version): it was 0.19.3 with the
  shared 0.19.3, moves to 0.20.0 with Nowaki 0.20.0, and stays on 0.x when Nowaki goes to 1.0
  (a patch when its code changes, a minor when its API breaks). The `nowaki` crate pins it
  exactly (`version = "=X.Y.Z"`), so `cargo install nowaki` (which ignores Cargo.lock without
  `--locked`) always gets the nowaki-core it was built with. Do not depend on it directly.

## What is frozen

Everything public is frozen at 1.0. There is no "experimental" tier: a public feature is
either covered by semver or listed below as not covered. Frozen and covered by semver:

- **`@nowaki-dev/runtime` exports**: every name and type in the `.d.ts` files of the
  documented subpaths (`.`, `./navigation`, `./content`, `./image`, `./env`, `./env/server`,
  `./session`, `./config`, and any subpath added before 1.0). This includes Jetstream (`live`,
  `publish()`, rooms, `shared`, presence) and the plugin API.
- **Route and island module exports**: `default`, `loader`, `action`, the HTTP method exports
  of API routes, `meta`, `title`, `head`, `lang`, `htmlAttrs`, `bodyAttrs`, `revalidate`,
  `tags`, `streaming`, `csrf`, `budget`, `viewTransition`, `staticPaths`, `prerender`,
  `sitemap`, `scripts`, `live`, the `client:*` island directives, and the layout `slots` prop,
  with the types `PageModule`, `LayoutModule`, `ApiModule`, `MiddlewareModule` and `IslandModule`
  give them. API method exports are uppercase.
- **File conventions**: `routes/` file routing (`index`, `[param]`, `[...rest]`, extension
  file routes such as `feed.xml.ts`), `_layout`, `_middleware`, `_404`, `_500`, `loading`,
  `error`, `(group)`, `@slot` with `default`, the `(.)` / `(..)` / `(...)` intercepts,
  `islands/`, `content/` with `content/config.ts`, `public/`, `env.ts`, `session.ts`,
  `nowaki.config.mjs` / `.js`, `.tsrx` files, and the `.nowaki/types.d.ts` path. Other `_*`
  names under `routes/` are reserved.
- **`nowaki.config` keys**: `site`, `fonts`, `basePath`, `trailingSlash`, `redirects`,
  `rewrites`, `headers`, `i18n`, `images`, `plugins`, and their documented nested keys (any
  other key is an error, at every level), and the plugin hooks `name`, `transform`, `resolveId`
  and `load`.
- **CLI**: the commands `dev`, `build`, `start`, `prerender`, `upgrade`, `typegen`, their
  flags and defaults, `--version`, `--help`, and the exit code of a failed build (including a
  route over its `budget`).
- **Listen address**: every server (`nowaki dev`, `nowaki start`, the node / bun / deno
  adapters) listens on `PORT`, else 3000. `nowaki dev` and `nowaki start` take `--port`
  (wins over `PORT`) and `--host [addr]` (`--host` alone: all interfaces, `0.0.0.0`; wins over
  `NOWAKI_HOST`; default `127.0.0.1`).
- **Environment variables** that users set: `PORT`, `NOWAKI_HOST`, `NOWAKI_SITE`,
  `NOWAKI_TRUST_PROXY`, `NOWAKI_CSP`, `NOWAKI_CSP_REPORT_URI`, `NOWAKI_SECURITY_HEADERS`,
  `NOWAKI_SESSION_SECRET`, the `NOWAKI_LIVE_*` settings, `NOWAKI_REVALIDATE_SECRET`,
  `NOWAKI_ISR_MAX`, `NOWAKI_ISR_WARM`, the body limits (`NOWAKI_FN_BODY_LIMIT` and any added
  before 1.0), `NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, the standard `OTEL_*` variables Nowaki
  reads, and `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN` for the Cloudflare purge.
- **Endpoints**: `GET /__nowaki/health` and `POST /__nowaki/revalidate` (request and response
  shape). The `/_nowaki/` asset prefix is reserved; the file names under it are not covered.
- **Headers and cookies**: the default security headers, the cache headers Nowaki sets
  (including ISR `Vary` handling), `x-nowaki-cache: HIT | STALE | MISS` on `nowaki start`, the
  `nowaki_locale` cookie, and the session cookie's documented options.
- **Client events and attributes**: `nowaki:page-load`, `nowaki:action`, `nowaki:live-error`,
  `nowaki:live-stale`, `nowaki:presence`; `data-live`, `data-live-submit` / `-input` /
  `-change` / `-debounce`, `data-nowaki-transition`, `data-nowaki-error`, `data-nowaki-reset`,
  `data-nowaki-presence`; the `name` attribute of `<nowaki-slot>`.
- **Adapter deploy contract** for `node`, `static`, `bun`, `deno`, `cloudflare` and `vercel`:
  the output paths (`dist/server/index.mjs` and its start command, `dist/static` with
  `_redirects` / `_headers`, `dist/worker` with `wrangler.toml`, `.vercel/output`), the
  environment variables each reads, and `nowaki start` serving `dist/`.
- **Observability**: the JSON log line fields (`time`, `level`, `msg`, `source`, `trace_id`,
  `span_id`) and the documented OpenTelemetry span names and attributes. New fields and
  attributes may be added.
- **Typegen**: the augmentable interfaces (`NowakiRoutes`, `Collections`, `ServerEnv`) and the
  `client:*` JSX attribute types in the scaffold's `nowaki-jsx.d.ts`.

The checked-in snapshots under `api/` are the exact list. CI compares them with the
code; see "API snapshots" in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Not covered

These may change in any release. Do not build on them.

- `@nowaki-dev/runtime/client/*` and `@nowaki-dev/runtime/server/*`. They are exported for the
  code the CLI generates, not for apps.
- The wire protocols between the client, the Rust front and the sidecars: `/__nowaki/fn`,
  `/__nowaki/live`, `/__nowaki/live-event`, `/__nowaki/live-render` and the other internal
  `/__nowaki/*` paths, the `x-nowaki-*` request headers, and the HMR messages. They only need
  to match within one build.
- Generated markup beyond what is listed above: `<nowaki-island>`, `<nowaki-live>`, other
  `data-nowaki-*` attributes, `window.__nowaki*` globals, inline script contents, and the
  layout of `dist/` apart from the deploy contract.
- Error messages, log message text and the human-readable build report.
- Internal environment variables (the `*_READY` handshakes, `NOWAKI_RUST_PORT`,
  `NOWAKI_PRERENDER*` and the others listed as internal in `api/`).
- Dev-only tools: the dev MCP tools (`/__nowaki/mcp`), the dev toolbar UI and its data
  (`/__nowaki/devtools`), `nowaki:hmr` / `nowaki:toolbar*` events, and the dev conveniences
  `NOWAKI_TOOLBAR`, `NOWAKI_EDITOR`, `NOWAKI_HINTS`, `NOWAKI_IMAGES_REFRESH`. MCP tool names are
  kept within a major on a best-effort basis.
- The `nowaki-core` crate.
- `ctx.req`, the raw Node request object, where it exists.

## What counts as a breaking change

A change is breaking, and waits for the next major, when an app that worked on the previous
1.x release would stop working, stop type-checking, or behave differently without changing its
code. In particular:

- **Removing or renaming** anything in [What is frozen](#what-is-frozen): an export, a route
  export, a file convention, a config key, a CLI command or flag, an environment variable, a
  public endpoint, an event or an attribute.
- **Types.** A change to a `.d.ts` that makes code which type-checked against the previous
  release fail to type-check. Exception: a type that is corrected to match the documented
  runtime behavior. Such a fix lands in a minor and is called out in the CHANGELOG.
- **Defaults.** Changing a documented default: CSRF checks, the default security headers,
  cache headers and `Vary` learning, body size limits, the CLI's default port and host, the
  default adapter output.
- **HTML output.** Changing the documented elements, attributes and events above, or the
  document structure Nowaki emits from `meta`, `head`, `lang`, `htmlAttrs` and `bodyAttrs`.
  Other generated markup is not covered.
- **Headers.** Removing or changing a response header Nowaki documents, or the headers the
  adapters' `_headers` / `.vercel/output` / worker set.
- **CSP.** Changing the directives sent under `NOWAKI_CSP=report-only` / `enforce`, or which
  elements get the nonce (the scripts and styles Nowaki emits, and tags written with `nonce()`;
  never raw HTML), in a way that blocks content the previous release allowed.
- **Deploy contract.** Changing an adapter's output path, its start command, or the
  environment variables it reads.
- **Platforms.** Dropping a Preact major from the peer range, or raising the minimum
  TypeScript or Node version outside the rules under [Platforms](#platforms).

Not breaking:

- Additions: a new export, optional field, route export, config key, flag, environment
  variable or event. Each gets a CHANGELOG line.
- **Performance.** Speed and size are not part of the contract. A regression is a bug: it is
  fixed in a patch, and the CI perf and client-size gates exist to catch it before a release.
- Anything under [Not covered](#not-covered).

### Security exception

A change that closes a vulnerability, or tightens a default defense, may land in a minor (or
in a patch that ships with an advisory) even if it breaks some apps. It comes with an Upgrade
note in the CHANGELOG, an opt-out where one is safe, and a row in
[SECURITY.md](../SECURITY.md#defenses-enabled-by-default). This is how 0.14 through 0.19
handled new defaults (for example the API-route CSRF check in 0.19.3).

## Deprecation

A frozen feature is removed only in a major, after it has been deprecated in a 1.x minor:

1. It is marked `@deprecated` in the `.d.ts`, with what to use instead.
2. Using it logs one warning per route module (never per request), naming the file and the
   replacement.
3. The CHANGELOG lists it under a "Deprecated" heading in that minor.
4. It keeps working until the next major, which lists it under "Removed".

Deprecations land in minors, never in patches.

## Versioning

- **Patch** (`1.0.x`): bug fixes, security fixes, docs. No new public surface.
- **Minor** (`1.x.0`): additions, deprecations, security tightening under the exception above,
  raising the MSRV or dropping an end-of-life Node line.
- **Major** (`x.0.0`): breaking changes, each with an Upgrade note. A breaking change needs an
  accepted RFC ([rfcs/README.md](../rfcs/README.md)) and the `breaking` label on its PR.

Every release has a `vX.Y.Z` tag and a CHANGELOG entry.

## Platforms

- **Node.js**: every package declares `engines.node >=22`. Nowaki supports the Node LTS lines
  that are not end-of-life. CI runs Node 22, 24 and 26 on Linux and Node 22 on macOS and Windows.
  A Node line may be dropped in a minor once it reaches end-of-life (Node 22: 2027-04-30),
  announced in the CHANGELOG of the minor before.
- **Bun and Deno**: supported for the `bun` and `deno` adapters, at the current stable release
  CI installs.
- **Operating systems**: macOS (arm64, x64), Linux (x64, arm64, glibc) and Windows (x64), the
  five prebuilt CLI binaries. musl (Alpine) and Windows arm64 have no prebuilt binary
  (`cargo install nowaki` works there); adding one is an additive change. On Windows there is no
  SIGTERM for the sidecar, so Jetstream rooms (`NOWAKI_LIVE_ROOMS_FILE`) rely on the periodic
  write (every 2 s) rather than a final write at shutdown. CI runs the dev toolbar and most
  browser tests on Windows too; not the ones that drive Chrome over a CDP pipe (router,
  intercepting routes, the gallery), which Chrome on Windows doesn't read, nor the HMR test (on
  Windows an edit to a module an island imports reloads the page instead of updating the
  island).
- **Rust** (only for building from source or `cargo install nowaki`; npm users do not need
  Rust): the MSRV is 1.97, set in `Cargo.toml` (`rust-version`) and checked in CI. It may rise
  in a minor (the oxc upgrade usually drives it), never in a patch, and every rise is noted in
  the CHANGELOG.
- **Preact**: `^10.25.0 || ^11.1.0`, as declared in the runtime's `peerDependencies`. Dropping
  Preact 10 is a major change.
- **TypeScript**: the scaffold's type-check runs in CI with TypeScript 5.9.3. The minimum
  TypeScript version is raised only in a minor, with a CHANGELOG note.
- **Browsers**: Nowaki's own client code (islands, router, Jetstream, View Transitions) targets
  browsers in [Baseline](https://web.dev/baseline) "Widely available" at the time of a release,
  and falls back where a feature is missing (View Transitions are skipped where the browser has
  no `document.startViewTransition`). Nowaki does not down-level app code to an older target:
  island code ships with the syntax it was written in. Browser tests run in Chrome on Linux.

## Road to 1.0

1. **0.20.0** carries the last breaking changes and freezes the surface above. From then on CI
   fails on a change to the `api/` snapshots that removes or changes an entry, unless the PR
   has the `breaking` label and targets the next major.
2. **`1.0.0-rc.N`**: every shared package at the same release candidate, published on the npm
   `next` dist-tag (and as a crates.io prerelease). Only fixes, docs and performance work land.
3. The RC phase ends after at least 14 days with no change to the `api/` snapshots since the
   last RC, with real apps running on the RC and CI green on every OS. Any snapshot change cuts
   a new RC and restarts the 14 days.
4. **1.0.0** is then released. The 1.0 performance targets (ROADMAP.md) are measured on the
   last RC and reported in BENCHMARKS.md with their numbers; a missed target is reported, not a
   blocker.
