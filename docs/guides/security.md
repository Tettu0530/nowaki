# Security: CSP, CSRF, headers and proxies

Nowaki turns several defenses on by default (a same-origin check on writes, security headers,
signed live state, generic production errors) and offers others as opt-ins (a CSP with a
per-response nonce). This guide covers what an app author configures. The threat model, trust
boundaries and the full list of defaults are in [SECURITY.md](../../SECURITY.md).

## Cross-site writes (CSRF)

Page actions and API / file routes reject cross-site POST, PUT, PATCH and DELETE requests with
`403 Forbidden`, before the action or handler runs. A request counts as cross-site when its
`Origin` is another host or `null`, or when it has `Sec-Fetch-Site: cross-site` and no
`Origin`. The same check runs on `nowaki dev`, `nowaki start` and every adapter.

- GET, HEAD and OPTIONS are never checked, and page actions never run for them. Keep reads
  free of side effects.
- Requests with neither header (curl, server-to-server calls, most native apps) pass. Don't rely
  on the check to authenticate them.
- `_middleware` runs **before** the check. On a cross-site write it sees an empty, read-only
  `ctx.session`. Don't change data in middleware.
- Server functions and Jetstream POST events have their own gate (a JSON body, a custom header,
  and the same `Origin` check).

### Opting a route out: `csrf = false`

A webhook, a payment or OAuth callback, or an API for a frontend on another origin must accept
cross-site writes. Export `csrf = false` and authenticate the caller with something other than
cookies (a signature header, a shared secret, a bearer token):

```ts
// routes/api/webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@nowaki-dev/runtime/env/server";
import type { LoaderContext } from "@nowaki-dev/runtime";

export const csrf = false;

export async function POST(ctx: LoaderContext) {
  const body = await ctx.bodyText();
  const expected = createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex");
  const got = ctx.get("x-signature") ?? "";
  if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return ctx.text("bad signature", { status: 401 });
  }
  return ctx.json({ ok: true });
}
```

`csrf = false` also gives the route the visitor's real session on cross-site requests; that is
why it must not trust cookies. `export const csrf = true` is the default and changes nothing.

### Behind a proxy

The check compares `Origin` with the host the server sees. A proxy that rewrites `Host` makes
same-origin posts look cross-site (403). Either keep `Host` in the proxy, or forward the public
host as `x-forwarded-host` and set `NOWAKI_TRUST_PROXY=1` (see [Proxies](#proxies-and-nowaki_trust_proxy)).

## Default security headers

Every server adds these unless the response already sets them:

| Header | Value |
| --- | --- |
| `x-content-type-options` | `nosniff` |
| `x-frame-options` | `SAMEORIGIN` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `cross-origin-opener-policy` | `same-origin` |
| `content-security-policy` | `frame-ancestors 'self'` (only when the app sends no CSP) |

- A header the route sets, or a nowaki.config `headers` rule for the path, replaces the default
  of the same name. An OAuth popup that needs `window.opener` can send
  `cross-origin-opener-policy: same-origin-allow-popups`.
- `NOWAKI_SECURITY_HEADERS=off` removes them all. On the Vercel adapter, set it at build time
  too: the headers for static files are written into the route config.
- Static output gets them in `_headers`.

## Content Security Policy

`NOWAKI_CSP` turns on a strict policy with a nonce that is new for every response:

| Value | Sends |
| --- | --- |
| `report-only` | `Content-Security-Policy-Report-Only` |
| `enforce` | `Content-Security-Policy` |

```
default-src 'self'; script-src 'self' 'nonce-…'; style-src-elem 'self' 'nonce-…';
style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'self'
```

`NOWAKI_CSP_REPORT_URI` adds a `report-uri`. A response that sets its own
`content-security-policy` is left alone.

**Start with `report-only`.** Under `enforce`, these are blocked: inline event handlers
(`onclick="..."` in raw HTML), `javascript:` URLs, scripts and styles from other origins,
images from other origins, and inline `<script>` / `<style>` without the nonce. Inline `style`
attributes, class names and same-origin files keep working, and so does everything Nowaki itself
emits (the islands runtime, `live.js`, page scripts, the View Transition style, dev's HMR
client and toolbar).

### Inline scripts and styles: `nonce()`

The nonce goes only on the tags Nowaki emits and on tags the app writes with `nonce()`:

```tsx
import { nonce } from "@nowaki-dev/runtime";

export default function Page() {
  return (
    <main>
      <style nonce={nonce()}>{`.hero { color: rebeccapurple; }`}</style>
      <h1 class="hero">Hello</h1>
    </main>
  );
}
```

- Call it while a request renders: in a page, layout, `meta()`, loader, action, middleware or
  API route (including `ctx.html()` markup). It returns `""` with `NOWAKI_CSP` off.
- A static `export const head` string is evaluated once, so it can't carry a nonce. Return the
  tag from `meta()` instead:

  ```tsx
  export const meta = () => ({ head: `<style nonce="${nonce()}">.x{color:red}</style>` });
  ```

- `nonce()` is server-only: don't import it in an island.
- Static output (`nowaki prerender`) has no per-response nonce, so `nonce()` returns `""`
  there. Set a static site's CSP in `public/_headers` yourself, with hashes or `'self'` only.

### Raw HTML gets no nonce

An inline `<script>` / `<style>` that reaches the page as raw HTML gets no nonce and is blocked
under `enforce`: a `head` string, `dangerouslySetInnerHTML`, Markdown, MDX or Markdoc output,
CMS content, a `public/` HTML file. A `nonce="..."` written into such HTML stays wrong. This is
what makes `enforce` contain HTML injection, also after a client navigation. Raw HTML is still
HTML (it can add links and forms, and load same-origin scripts), so sanitize user content
anyway.

To fix a blocked inline tag, put `nonce={nonce()}` on it, or move the code to a file
(`export const scripts`, a CSS import, a file in `public/`). Content that relied on an inline
`<style>` should use classes or `style` attributes.

Working example: `examples/hello/routes/raw-html.tsx` (what is blocked and what isn't),
`examples/hello/routes/loading.tsx` and `isr.tsx` (`nonce()`).

### CSP and caches

`nowaki start` and the Cloudflare Worker give every cached ISR response its own nonce. A CDN that
caches HTML (`s-maxage` on Vercel, or one in front of the node adapter) caches the nonce too, so
visitors of a cached copy share it.

## Proxies and `NOWAKI_TRUST_PROXY`

By default Nowaki ignores `x-forwarded-host`, `x-forwarded-proto` and `x-forwarded-for` from
clients: anyone can send them. The host for the same-origin checks and `ctx.url` comes from
`Host`, and `ctx.url` is `http` unless a trusted proxy says otherwise.

Behind a reverse proxy that sets those headers itself, set `NOWAKI_TRUST_PROXY=1`. Then:

- the first `x-forwarded-host` / `x-forwarded-proto` value is used for `ctx.url` and the
  same-origin checks (actions, API routes, server functions, the live socket),
- on `nowaki start`, the client's `x-forwarded-for` is passed through to the app.

Leave it unset when clients reach the server directly, or a client can choose the host those
checks compare against. This applies to `nowaki start` and to the node, bun and deno adapters,
also when the proxy is on the same machine and connects to `localhost`. On Vercel, the platform's
`x-forwarded-host` is used. Set `site` in nowaki.config for canonical URLs that don't depend on
the request.

Proxy setups are in [Deploy: `nowaki start`](../deploy/self-hosted.md#behind-a-reverse-proxy).

## Secrets

- Only `PUBLIC_*` variables (and `MODE`) reach client code. Declare the rest in `env.ts` and read
  them from `@nowaki-dev/runtime/env/server`, which fails the build if client code imports it.
  See [Sessions and env](./sessions-and-env.md).
- Island props and loader data rendered into the page are visible in its source.
- Set `NOWAKI_SESSION_SECRET` when the app uses sessions, `NOWAKI_LIVE_SECRET` when it has live
  islands, and `NOWAKI_REVALIDATE_SECRET` only if you use the revalidate endpoint. Use long
  random values, and the same ones on every instance.

## Endpoints you write are public

- Every `"use server"` export and API route can be called by anyone. Validate the input
  (`serverFn(schema, impl)` for server functions) and authorize with `getContext()` / `ctx`.
- Only a `ServerFnError`'s message reaches the client; other errors are a generic 500 in
  production. `_500` pages get an empty `error.message` in production.
- Jetstream handlers receive payloads from the browser; validate them, and guard events with
  `live.authorize`.
- `File.name` from `ctx.formData()` is untrusted.

## `nowaki dev` is not for production

Serve production traffic with `nowaki start` or an adapter's output. `nowaki dev` listens on
127.0.0.1 by default. With `--host` it is reachable from the network and answers only IP
addresses, `localhost`, `*.localhost` and `*.local` names (others get 403, unless listed in
`NOWAKI_DEV_ALLOWED_HOSTS`). Its MCP endpoint and toolbar data stay loopback-only.

## Reference

- [SECURITY.md](../../SECURITY.md): reporting, trust boundaries, defenses enabled by default
- [Headers](../reference/headers.md) (security headers, CSP)
- [Environment variables](../reference/env-vars.md) (`NOWAKI_CSP`, `NOWAKI_CSP_REPORT_URI`,
  `NOWAKI_SECURITY_HEADERS`, `NOWAKI_TRUST_PROXY`, the secrets)
- [Runtime API](../reference/runtime.md) (`nonce`, `Csrf`)
