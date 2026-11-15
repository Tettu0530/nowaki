# Upgrading to 1.0

This guide takes an app from any 0.x release to 1.0. The breaking changes are listed by the
release that made them, oldest first, each with code before and after and with what
`nowaki upgrade --check` reports for it. It covers 0.17 through 0.20 in detail; changes from
0.14 to 0.16 are summarized, and anything older is in [CHANGELOG.md](../CHANGELOG.md).

**1.0.0 itself breaks nothing.** 0.20.0 was the API freeze: it carried the last breaking
changes, and from then on the public surface listed in [STABILITY.md](./STABILITY.md) changes
only additively. An app that runs on 0.20.x runs on 1.0.0 once both packages are updated.

## Checklist

1. Use Node 22 or newer (`node --version`), and allow only supported lines in
   `engines.node` (`">=22"`).
2. Run the 0.20 readiness report in the app directory. Use the 0.20 CLI even if the app has an
   older one installed:
   ```sh
   npx nowaki@0.20.0 upgrade --check --to 0.20.0
   ```
   It prints what must change, with `file:line` and the fix, then heuristics to review. It
   writes nothing. The exit code is 1 while something must change.
3. Fix every "Must change" item, and review every "Check" item. Then work through the
   sections below for your starting version: some changes can't be found by reading files and
   are marked "Not flagged".
4. Update the CLI and the runtime together, to the same version:
   ```sh
   npx nowaki@0.20.0 upgrade --to 0.20.0
   ```
   `nowaki upgrade --to <version>` runs the same report first and installs nothing while
   something must change.

   **Apps from before 0.19.3.** Until 0.19.3 the CLI (`nowaki`) and the runtime
   (`@nowaki-dev/runtime`) were released at different versions, so an older app has two
   different versions installed, for example `nowaki 0.18.2` and `@nowaki-dev/runtime 0.17.2`.
   You don't need to fix this by hand. The readiness report lists it under "Fixed by this
   upgrade" (with `--check`: "Fixed by `nowaki upgrade --to <version>`"), and it doesn't stop
   the upgrade. `nowaki upgrade --to <version>` installs both packages at that version, keeping
   each in the dependency section it was in. The CLI usually stays in `devDependencies`. After
   the upgrade both report the same version. Only the items under "Must change" need your
   changes before you upgrade.
   Either way, keep both at the same version: since 0.20.0 the CLI refuses a runtime of another
   version line.
5. Copy `nowaki-env.d.ts` and `nowaki-jsx.d.ts` from a new app (`npm create nowaki@latest`)
   if the app is from before 0.18.0, and list both in `tsconfig.json` `include`.
6. Build and run it: `nowaki build`, then `nowaki start` (or your adapter), and try the pages
   that post forms, call API routes from the browser, or use inline scripts under
   `NOWAKI_CSP`.
7. When 1.0.0 is out, `npx nowaki upgrade --to 1.0.0`. To try a release candidate first,
   `npx nowaki upgrade --to next` (see [Release candidates](#release-candidates)).

## What `nowaki upgrade --check` reports

The report is part of the CLI since 0.20.0 (`crates/nowaki/src/readiness.rs`). It reads the
app's files and runs `node --version` and `rustc --version`; it never changes the app.

| Level | Finding | Since |
| --- | --- | --- |
| Must change | a route file named `_error.*` | 0.20.0 |
| Must change | `export const middleware` in a `_middleware` file | 0.20.0 |
| Must change | `export const config` in `nowaki.config` | 0.20.0 |
| Must change | a lowercase method export (`get`, `post`, ...) in an API or file route | 0.20.0 |
| Must change | an unknown top-level `nowaki.config` key, with a "did you mean" hint | 0.20.0 |
| Must change | `--host <dir>` in a package.json script | 0.20.0 |
| Must change | the installed `nowaki` and `@nowaki-dev/runtime` differ | 0.20.0 |
| Must change | Node older than 22 | 0.20.0 |
| Check | a `ctx.formData()` result used as `URLSearchParams` | 0.20.0 |
| Check | `PORT` set in the shell or in `.env` / `.env.local` / `.env.development` / `.env.production` | 0.20.0 |
| Check | an API route with a write handler and no `export const csrf` (apps on a runtime older than 0.19.3) | 0.19.3 |
| Check | `engines.node` that allows Node older than 22 | 0.20.0 |
| Check | `rustc` older than the MSRV (only for `cargo install nowaki`) | 0.19.3 |

Output for an app with two things to fix looks like this:

```text
Readiness for 0.20.0 (read-only: nothing is changed)
  app        /home/me/blog
  current    @nowaki-dev/runtime 0.18.1 (installed)
  report by  nowaki 0.20.0 (this CLI)

  Must change: 2
    routes/_error.tsx:1  `_error` is no longer the 500 page (0.20.0 removed the alias; `error.tsx` is the client navigation boundary)
      → Rename it to `routes/_500.tsx`.
    nowaki.config.mjs:4  unknown top-level key `basepath` (ignored before 0.20.0, an error since)
      → Did you mean `basePath`? Remove it or rename it; the keys are site, fonts, basePath, trailingSlash, redirects, rewrites, headers, i18n, images, plugins.
```

The report is a reading of source text, not a type check. The "Check" items are heuristics
and can be wrong either way; the changes marked "Not flagged" below are behavior it can't see.

## 0.14 to 0.16 (summary)

If the app is older than 0.17, these are the changes to know about. The CHANGELOG entries
have the details.

- **0.14.0.** Cross-site POST / PUT / PATCH / DELETE to page actions get 403 (opt out per
  route with `export const csrf = false`). A server function error other than `ServerFnError`
  reaches the client as a generic `Internal Server Error` in production. Every response
  carries default security headers, including `cross-origin-opener-policy: same-origin`.
  Set `NOWAKI_LIVE_SECRET` in production.
- **0.15.0.** Live islands work on the deploy adapters over POST; with more than one instance
  or Worker isolate, set `NOWAKI_LIVE_SECRET`.
- **0.16.0.** `nowaki start` renders every ISR page once at startup (`NOWAKI_ISR_WARM=0` turns
  it off), stops its Node process with SIGTERM, and writes Jetstream rooms to
  `.nowaki/live-rooms.json`. `nowaki build` writes `.br` / `.gz` files into `dist/client`. A
  route with `export const budget` fails the build when it goes over.
- **0.16.1.** CSS that routes, layouts and their components import is linked on the page. A
  workaround that imported the same CSS from an island loads it twice and can be removed.

Not flagged by the report.

## 0.17

0.17.0 added content collections, `<Image>`, `meta`, fonts, `public/` and file routes, and
broke nothing. 0.17.1 changed request handling:

- **`ctx.url.origin` on `nowaki start` / `nowaki dev` is the browser's origin**, not the
  sidecar's `http://127.0.0.1:<port>`. It is `https` only behind a trusted proxy
  (`NOWAKI_TRUST_PROXY=1`). Set `site` in nowaki.config for fixed canonical and `og:url` links.
- **The `nowaki start` ISR cache is keyed per host.**
- **A response that sets a cookie and asks for `public` / `s-maxage` is sent as
  `private, no-cache`.**
- **Built asset names with characters outside `[A-Za-z0-9._-]` change** (they returned 404
  before).
- **`nowaki prerender --out` refuses a path that is, contains or is inside the build.**

Not flagged. Look for code that builds absolute links from `ctx.url.origin`:

```ts
// Before: on nowaki start this was http://127.0.0.1:<sidecar port>
const link = new URL("/reset?token=" + token, ctx.url.origin);
// After: use the configured site for links that leave the request (mail, feeds)
const link = new URL("/reset?token=" + token, ctx.site ?? ctx.url.origin);
```

## 0.18

### 0.18.0

- **Type files.** `nowaki-env.d.ts` is ambient again (CSS, asset and `?image` imports
  type-check) and the Preact JSX additions moved to `nowaki-jsx.d.ts`. Copy both from a new app
  and add them to `tsconfig.json`:
  ```json
  { "include": ["nowaki-env.d.ts", "nowaki-jsx.d.ts", ".nowaki/types.d.ts", "**/*.ts", "**/*.tsx"] }
  ```
  `nowaki upgrade` doesn't copy template files. Not flagged; `tsc` reports it.
- **Nested `nowaki.config` keys are validated.** A typo inside `redirects`, `rewrites`,
  `headers`, `i18n` or `images` fails `nowaki dev` / `build`. (Top-level keys followed in
  0.20.0.) Not flagged; the build names the key.
- **Layouts receive a `slots` prop** (an empty object when they own no `@slot` directory).
- **`staticPaths` receives an argument**: `{ locale }` with `i18n`, `{}` otherwise.
  ```ts
  // A function that took no argument still works; one that used its first parameter
  // for something else must change.
  export const staticPaths = ({ locale }: { locale?: string }) => paths(locale);
  ```
- **Two route files with the same URL shape are an error** when one of them is in a
  `(group)`. Not flagged; the build names both files.
- **A page that reads `ctx.session` can't be prerendered**, and in production `ctx.session`
  needs `NOWAKI_SESSION_SECRET` (32 characters or more). Not flagged.

### 0.18.1

With `i18n` configured:

- **Config rules match the path without the locale prefix.** A `/login` rule now also applies
  to `/ja/login`, and a redirect keeps the request's locale. Add `locale: false` to a rule to
  match the full path, as before:
  ```js
  // Before (0.18.0): matched only /login
  redirects: [{ source: "/login", destination: "/signin" }],
  // After: matches /login and /ja/login. To keep the old behavior:
  redirects: [{ source: "/login", destination: "/signin", locale: false }],
  ```
- **`<Link href="/x">` keeps the current locale** (`/ja/x` on a Japanese page). Pass
  `locale={false}` for the href as written:
  ```tsx
  <Link href="/en-only-page" locale={false}>Docs</Link>
  ```

Apps without `i18n` are unaffected. Not flagged.

### 0.18.2

- **The CLI refuses an `@nowaki-dev/runtime` older than 0.17.1** instead of silently ignoring
  nowaki.config. Update both packages together (0.19.3 and 0.20.0 tightened this further).

## 0.19.3

0.19.3 is the first release with one shared version for the CLI, the runtime and the
scaffolder (0.19.0 to 0.19.2 were skipped by the CLI and runtime).

- **The CLI refuses a runtime older than itself.** Install the same version of `nowaki` and
  `@nowaki-dev/runtime`. Flagged (Must) when the installed versions differ.
- **API routes reject cross-site writes by default (CSRF).** A POST / PUT / PATCH / DELETE to
  `routes/api/**` or a file route whose `Origin` is another site (or `null`), or that has
  `Sec-Fetch-Site: cross-site` without `Origin`, gets 403 before the handler runs. Requests
  with neither header (curl, server-to-server calls) are unaffected. A route that browsers on
  other sites must reach opts out and authenticates another way:
  ```ts
  // routes/api/webhook.ts
  export const csrf = false; // accepted from any origin: check a signature instead of cookies

  export async function POST(ctx) {
    const body = await ctx.bodyText();
    if (!verifySignature(body, ctx.get("x-signature"))) return ctx.text("bad signature", { status: 401 });
    // ...
  }
  ```
  Flagged as a Check for each API route with a write handler and no `export const csrf`, when
  the app's runtime is older than 0.19.3. Behind a proxy that rewrites `Host`, forward the
  public host as `x-forwarded-host` and set `NOWAKI_TRUST_PROXY=1`, or same-origin calls are
  rejected too.
- **Building from source needs Rust 1.97** (`cargo install nowaki`). The npm packages are
  unaffected. Flagged as a Check when `rustc` is older.

## 0.20.0 (the API freeze)

### `nowaki dev` and `nowaki start` read `PORT`

Without `--port` they listen on `PORT`, else 3000, as the node / bun / deno adapters already
did. An invalid `PORT` is an error.

```sh
# Before: always 3000 unless --port
PORT=8080 nowaki start   # listened on 3000
# After
PORT=8080 nowaki start   # listens on 8080; pass --port 3000 if PORT is meant for something else
```

Flagged as a Check when `PORT` is set in the shell or in a `.env*` file.

### `--host` takes an optional address

`--host` alone still listens on `0.0.0.0`; `--host 10.0.0.5` listens on that address. The flag
wins over `NOWAKI_HOST`, which `nowaki dev` now reads too (default `127.0.0.1`). A word after
`--host` is read as the address, so put the directory first:

```sh
# Before: --host, then the app directory
nowaki dev --host my-app
# After: the directory first (my-app would now be read as the address)
nowaki dev my-app --host
```

Flagged (Must) for package.json
scripts; the CLI also stops with this hint when the value is a directory.

### The CLI refuses a runtime of another version line

On 0.x a minor counts as a major: CLI 0.20.x refuses runtime 0.21.0 as well as 0.19.3. Release
candidates order as SemVer says, so CLI 1.0.0 refuses a `1.0.0-rc.N` runtime. Flagged (Must)
when the installed versions differ.

### `ctx.formData()` always returns `FormData`

Urlencoded bodies used to return `URLSearchParams`; both urlencoded and multipart bodies now
return `FormData`, as `Request.formData()` does. `form.get()` is `string | File | null`.

```ts
// Before
export async function action(ctx) {
  const form = await ctx.formData();
  const q = form.get("q").trim();
  return ctx.redirect("/search?" + form.toString());
}

// After
export async function action(ctx) {
  const form = await ctx.formData();
  const q = String(form.get("q") ?? "").trim();
  const query = new URLSearchParams([...form].filter(([, v]) => typeof v === "string") as [string, string][]);
  return ctx.redirect("/search?" + query.toString());
}
```

`Object.fromEntries(form)` and `form.getAll()` work as before. File uploads now arrive as
`File` parts; treat `File.name` as untrusted. Flagged as a Check where a result is used with
`.toString()`, `.sort()`, `.size`, `String(form)`, `${form}`, `new URLSearchParams(form)`, or
`form.get(...)` chained into a string method.

### Body limits

`NOWAKI_FORM_BODY_LIMIT` (default 10 MiB) now applies to `formData()`, `bodyText()` and
`bodyJson()` on every runtime. A JSON API route that receives larger bodies needs a higher
limit. Not flagged.

### Unknown top-level `nowaki.config` keys are an error

They used to be ignored. The keys are `site`, `fonts`, `basePath`, `trailingSlash`,
`redirects`, `rewrites`, `headers`, `i18n`, `images` and `plugins`; `plugins` must be an
array. Keep your own settings in a named export (it isn't read), and type the config with
`defineConfig`:

```js
// Before
export default {
  basepath: "/app",          // typo, silently ignored
  analyticsId: "UA-1",       // app setting kept in the config object
};

// After
import { defineConfig } from "@nowaki-dev/runtime/config";
export const analyticsId = "UA-1";
export default defineConfig({ basePath: "/app" });
```

Flagged (Must), with a "did you mean" hint, for `export default { ... }`,
`export default defineConfig({ ... })` and `export default name` with `const name = { ... }`.
A config built another way is checked when `nowaki dev` / `build` reads it.

### `fonts` entries are validated

A Google font is `{ family, provider: "google", weights?, styles?, subsets? }`; a local font is
`{ family, src, weight?, style? }` or `{ family, src: [{ path, weight?, style? }] }`. Keys of
the other kind are an error naming the right key:

```js
// Before: `weights` on a local font was ignored
{ family: "Brand", src: "./fonts/brand.woff2", weights: [400, 700] }
// After: one entry per file
{ family: "Brand", src: [{ path: "./fonts/brand-400.woff2", weight: 400 }, { path: "./fonts/brand-700.woff2", weight: 700 }] }
```

Not flagged; `nowaki build` names the key.

### Removed aliases

All four are flagged (Must) with `file:line`.

```text
routes/_error.tsx                 → routes/_500.tsx
```

```ts
// routes/_middleware.ts
// Before
export const middleware = async (ctx) => { /* ... */ };
// After
export default async function middleware(ctx) { /* ... */ }
```

```js
// nowaki.config.mjs
// Before
export const config = { site: "https://example.com" };
// After
export default { site: "https://example.com" };
```

```ts
// routes/api/items.ts
// Before
export function get(ctx) { /* ... */ }
// After
export function GET(ctx) { /* ... */ }
```

`error.tsx` (the client navigation boundary) is unchanged; only the `_error` name for the
server error page went away.

### Root i18n helpers have the `/navigation` types

`getLocale`, `href`, `localePath` and `setLocale` from `@nowaki-dev/runtime` are typed like
the ones in `/navigation`. Code that assigned the result to `string` still compiles. Not
flagged.

### `setServerEnv` is no longer exported

It was an undeclared internal of `@nowaki-dev/runtime/env/server`. Apps never needed it; `env`
is filled before app code runs. Not flagged.

### `@nowaki-dev/markdoc` 0.2.0 peers on the runtime

Install `@nowaki-dev/markdoc@0.2` with runtime 0.20. Not flagged.

### Production `_500` pages get an empty `error.message`

The message can name files, queries or secrets. The error is still logged; dev keeps the
stack. A `_500` page that branched on the message should use `url` or
log instead. Not flagged.

### Proxy headers on loopback

The node, bun and deno adapters no longer trust `x-forwarded-host` / `x-forwarded-proto` when
`Host` is a loopback name. Behind nginx on the same machine (`proxy_pass
http://localhost:3000`), set `NOWAKI_TRUST_PROXY=1` or forward `Host` itself; otherwise
`ctx.url` names the loopback host and same-origin POSTs are rejected. `nowaki start` and
`nowaki dev` are unaffected. Not flagged.

### `nowaki dev` refuses public host names

With `--host`, `nowaki dev` answers IP addresses, `localhost`, `*.localhost` and `*.local`
names. To reach it through a tunnel or another name, list it in `NOWAKI_DEV_ALLOWED_HOSTS`
(comma-separated, `*` for any). Its HMR and live WebSockets accept only its own origin. `/@fs/`
refuses more credential files and never widens to the home directory. Dev only; not flagged.

### CSP nonce only on tags Nowaki emits

Under `NOWAKI_CSP`, the nonce used to go on every `<script>` / `<style>` in the HTML. Now it
goes on Nowaki's own tags and on tags that carry `nonce()`. An inline script or style the app
writes as raw HTML (a `head` string, `dangerouslySetInnerHTML`, Markdown / MDX / Markdoc
output, `ctx.html()` markup, a `public/` HTML file) is blocked under `enforce` and reported
under `report-only`.

```tsx
// Before: a static head string; its <script> got the nonce
export const head = `<script>document.documentElement.dataset.theme = localStorage.theme ?? "light"</script>`;

// After: return the tag from meta() with nonce(), evaluated per request
import { nonce } from "@nowaki-dev/runtime";
export const meta = () => ({
  head: `<script nonce="${nonce()}">document.documentElement.dataset.theme = localStorage.theme ?? "light"</script>`,
});
```

```tsx
// In JSX
<style nonce={nonce()}>{css}</style>
```

`nonce()` is server-only: don't import it in an island. Moving the code to a file (`export const
scripts`, a CSS import, `public/`) also works. Static output (`nowaki prerender`, the static
adapter) is written without a nonce; set a static site's CSP in `_headers`. Not flagged: run
with `NOWAKI_CSP=report-only` and read the reports before switching to `enforce`.

### `.env.local` overrides `.env` on the server too

The server used to keep the `.env` value of a key both files set, while `import.meta.env.PUBLIC_*`
took the `.env.local` one. Both now read `.env`, then `.env.local` over it, then the real
environment over both. `nowaki dev` / `build` / `start` / `prerender` read the `NOWAKI_*`
settings from these files too; `PORT` and `NOWAKI_HOST` still come only from the environment.
Not flagged: check keys set in both files.

## 1.0.0

1.0.0 adds no breaking change beyond 0.20.0. Once the app runs on 0.20.x:

```sh
npx nowaki upgrade --to 1.0.0
```

The readiness report runs first (1.0 is a new version line) and should report nothing. After
1.0.0, breaking changes wait for 2.0.0 and go through a deprecation in a 1.x minor first; see
[STABILITY.md](./STABILITY.md) and [SUPPORT.md](../SUPPORT.md).

## Release candidates

Between 0.20.0 and 1.0.0, Nowaki ships `1.0.0-rc.N` releases. Every shared package
(`nowaki`, `@nowaki-dev/runtime`, `create-nowaki`, `create-nowaki-app`) is published at the
same release candidate on the npm `next` dist-tag, and as a crates.io prerelease. Only fixes,
docs and performance work land between candidates, and the API snapshots in `api/` don't
change.

```sh
npx nowaki upgrade --to next          # the latest release candidate
npx nowaki upgrade --to 1.0.0-rc.1    # a specific one
npm create nowaki@next my-app         # a new app on the release candidate
cargo install nowaki --version 1.0.0-rc.1
```

`nowaki upgrade` without `--to` goes back to `latest`. The candidate phase ends after at least
14 days without an API snapshot change since the last candidate; then 1.0.0 is published on
`latest`. A 1.0.0 CLI refuses a `1.0.0-rc.N` runtime, so update both packages when moving from
a candidate to 1.0.0. Problems found on a candidate are best reported as GitHub issues while
the window is open.
