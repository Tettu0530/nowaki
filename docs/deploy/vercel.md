# Deploy to Vercel (vercel adapter)

The vercel adapter writes the [Build Output API v3](https://vercel.com/docs/build-output-api/v3)
layout: the client files and `public/` as static files, and one Node serverless function for
everything else.

## Build

```sh
npx nowaki build --adapter vercel
```

Output:

```
.vercel/output/
  config.json            routes: static files, nowaki.config redirects and headers, then the function
  static/                dist/client under _nowaki/, and public/ (both under basePath if set)
  functions/index.func/  the function (runtime nodejs22.x) with dist/server and its packages
```

## Deploy

```sh
npx vercel deploy --prebuilt          # preview
npx vercel deploy --prebuilt --prod   # production
```

Build locally or in CI with the project's environment variables available (an `env.ts` is
validated at build time), then upload the prebuilt output.

## Environment variables

Set them in the Vercel project (Settings, Environment Variables). The function reads them at
runtime.

| Variable | |
| --- | --- |
| `NOWAKI_SESSION_SECRET` | required if the app uses sessions |
| `NOWAKI_LIVE_SECRET` | required if the app has live islands: function instances don't share a random key, so without it live events are refused (503); pages still render |
| `NOWAKI_CSP`, `NOWAKI_SITE`, `NOWAKI_REVALIDATE_SECRET` | as on other servers |
| `NOWAKI_SECURITY_HEADERS=off` | set it at build time too: the headers for static files are written into `config.json` |
| `NOWAKI_SERVER_TIMING`, `NOWAKI_LOG`, `OTEL_*` | observability |
| your `env.ts` variables | at build time and at runtime (the function refuses to start without them) |

`NOWAKI_TRUST_PROXY` is not needed: on Vercel the platform's `x-forwarded-host` is used for the
same-origin checks.

## ISR and purging

An ISR page is sent with `Cache-Control: public, s-maxage=<n>, stale-while-revalidate`, so
Vercel's CDN caches it, and with `Vercel-Cache-Tag` listing its `tags` and its own path.

To purge on demand, add `@vercel/functions` to the app's dependencies:

```sh
npm install @vercel/functions
```

The build copies it into the function and says so (`@vercel/functions included`). Then
`revalidatePath` / `revalidateTag` call `dangerouslyDeleteByTag`, awaited up to 2 s before the
response. Without the package the tags are still sent (purge from the dashboard or the REST
API) and the first revalidate call warns. Call them inside the request: a call with no request
behind it does nothing, and one made after the response may be cut short when the function
suspends.

## What works

- Pages, loaders, actions, API and file routes, server functions, sessions, content
  collections, images and fonts (static files), nowaki.config routing (redirects and headers as
  platform routes; rewrites, basePath and trailingSlash in the function), i18n detection,
  `/__nowaki/health`, OpenTelemetry.
- **Live islands**: each event is a POST. `publish()` does nothing (warned once), there is no
  presence, and rooms don't push to other members.
- **CSP**: the function nonces each response, but a page cached by Vercel's CDN keeps the nonce
  it was rendered with, so its visitors share one.

## Edge cases

- **Packages in the function.** The function gets `@nowaki-dev/runtime`, `preact`,
  `preact-render-to-string` and, when installed, `@vercel/functions` with its dependencies. Other
  npm packages your server code imports (a database client, `zod` in `env.ts`) are not copied
  into it; check that the deployed function starts.
- A rewrite to a `public/` file works for a fixed destination only; the build warns about a
  rewrite to a pattern that covers public files.
- Vercel's limits on request size and function duration apply.

## See also

[Caching](../guides/caching.md#vercel), [Jetstream](../guides/jetstream.md#where-it-runs),
[Security](../guides/security.md#csp-and-caches).
