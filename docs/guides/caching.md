# Caching: ISR, tags and revalidation

A page that exports `revalidate` is cached (incremental static regeneration). A cached copy is
served for that many seconds, then served stale while one background render replaces it.
`export const tags` labels the copies, and `revalidatePath()` / `revalidateTag()` purge them on
demand, so the response after a write already shows fresh content.

## Cache a page

```tsx
// routes/posts/index.tsx
import type { PageModule } from "@nowaki-dev/runtime";

export const revalidate: PageModule["revalidate"] = 3600; // seconds
export const tags = ["posts"];

export async function loader() {
  return { posts: await db.posts() }; // your data layer
}
```

The page is sent with `Cache-Control: public, s-maxage=3600, stale-while-revalidate`. What
holds the cached copy depends on the server (see [Per server](#per-server)).

### What can be cached

Nowaki records what a render reads and keys the cache by it, so cached pages can't leak across
visitors:

- A header the render reads (`ctx.get("accept-language")`) becomes part of the key. The query
  string is part of the key only when the render reads it; an unread query is dropped, so it
  can't grow the cache.
- **A page that reads the session or cookies is never shared** between visitors. On Cloudflare,
  reading `authorization` has the same effect.
- A response that sets a cookie is sent as `private, no-cache` instead, on every server.
- A `streaming = "early"` page is never cached (its loaders run after the headers are sent),
  and neither are intercepting-route fragments.
- Only status 200 responses are stored.
- Reading `ctx.req` (the raw Node request) makes the page uncacheable.

Don't put per-user data on an ISR page. Read per-user data in an island (a server function or a
live island) or on a page without `revalidate`.

## Tags

`export const tags` is an array, or a function of the render's `{ params, data }`:

```tsx
// routes/posts/[id].tsx
export const revalidate = 3600;
export const tags = ({ params }: { params: { id: string } }) => ["posts", `post:${params.id}`];
```

A tag is 1 to 256 characters without whitespace, commas or control characters, at most 64 per
page. Invalid tags are dropped with a warning.

## Purge on demand

Call `revalidatePath(path)` or `revalidateTag(tag)` from a page action, an API route, a server
function or a live handler after data changes:

```tsx
// routes/posts/[id].tsx
import { revalidateTag } from "@nowaki-dev/runtime";
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function action(ctx: LoaderContext) {
  const id = String(ctx.params.id);
  const caption = String((await ctx.formData()).get("caption") ?? "").trim();
  await db.setCaption(id, caption);
  revalidateTag(`post:${id}`); // this post, in every locale
  return ctx.redirect(`/posts/${id}`, 303);
}
```

- **`revalidatePath(path)`** takes a route path as in `<Link href>` (no basePath, no locale
  prefix) and purges every cached form of it: each query and `Vary` variant, each locale, the
  basePath form, and both trailing-slash forms under `trailingSlash: "ignore"`. It throws a
  `TypeError` for a path that isn't root-relative or is over 2048 characters.
- **`revalidateTag(tag)`** purges every page carrying the tag. It throws a `TypeError` for an
  invalid tag.
- A purge deletes the entries; the next request renders fresh (a MISS) and waits for it.
- Called inside a request, the purge happens before that response is sent, so a redirect after
  an action already shows the new content. Called outside one (a timer, a queue consumer), it
  reaches the cache shortly after.
- A rewritten URL is cached under the browser's path, so purge it with a tag.

Working examples: `examples/gallery/routes/posts/[id].tsx`, `examples/hello/routes/isr-tagged.tsx`.

## Per server

| Server | Cached by | Purge |
| --- | --- | --- |
| `nowaki start` | the Rust front, in memory, per process | deleted before the response is sent |
| vercel adapter | Vercel's CDN (ISR pages send `Vercel-Cache-Tag`) | `dangerouslyDeleteByTag` from `@vercel/functions`, awaited up to 2 s |
| cloudflare adapter | the Worker, in the Cache API of each data center | the local data center's entry; with `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`, a zone purge by tag for every data center, awaited up to 2 s |
| node / bun / deno adapters | whatever CDN is in front (`s-maxage`) | none: a no-op, warned once; purge that CDN through its API |
| static output | files | none: a no-op, warned once |
| `nowaki dev` | nothing | calls are only recorded (the dev toolbar shows them) |

### `nowaki start`

- Responses carry `x-nowaki-cache: HIT`, `STALE` or `MISS`.
- The cache is in memory, per host, with at most `NOWAKI_ISR_MAX` entries (default 1024).
- Right after startup, every ISR page is rendered once in the background as an anonymous visit
  would be, so the first visitor gets a cached page. `NOWAKI_ISR_WARM=0` turns that off.
- Each instance has its own cache. With several instances, fan a purge out with the revalidate
  endpoint (below).

### Vercel

Add `@vercel/functions` to the app's dependencies; the build copies it into the function, and
the build log says whether it was found. Without it, the tags are still sent (purge from the
dashboard or the REST API) and the first revalidate call warns. Make the call inside the
request: `@vercel/functions` purges through the invocation's context, so a call with no request
behind it does nothing. Tags over 256 bytes are sent as a hash.

### Cloudflare

The Worker stores eligible pages in the Cache API of the data center that served them (custom
domains only: not on workers.dev, in the dashboard editor or previews). It shows
`x-nowaki-cache` like `nowaki start`. `revalidatePath` deletes the local entry. For a global
purge, set `CLOUDFLARE_ZONE_ID` (a var) and `CLOUDFLARE_API_TOKEN` (a secret, with the Cache
Purge permission) on the Worker. Without them, and on workers.dev, `revalidateTag` clears nothing
(warned once). Tags are case-insensitive on Cloudflare and capped at 240 characters (longer ones
are hashed). The zone purge API is rate limited per account; a rejected purge is warned once.

## Purge every instance: `POST /__nowaki/revalidate`

Set `NOWAKI_REVALIDATE_SECRET` and send each `nowaki start` instance:

```sh
curl -X POST https://app.example.com/__nowaki/revalidate \
  -H "Authorization: Bearer $NOWAKI_REVALIDATE_SECRET" \
  -H "content-type: application/json" \
  -d '{"paths":["/blog"],"tags":["posts"]}'
```

- The endpoint answers 404 while the variable is unset or blank, 401 for a wrong secret (compared
  in constant time), 415 without `application/json`, 413 over 64 KiB, and 400 for an empty or
  invalid list. At most 256 paths and tags together.
- It is also served by the adapters, under the same rules, and purges what that server can
  purge.
- Use it from a CMS webhook, a deploy hook, or the instance that handled a write.

## Caching and CSP

Under `NOWAKI_CSP`, `nowaki start` and the Cloudflare Worker keep a marker in the cached copy and
give every response its own nonce. A CDN that caches HTML (Vercel's, or one in front of the node
adapter) caches the nonce too, so visitors of a cached copy share it. See
[Security](./security.md#content-security-policy).

## Reference

- [Runtime API](../reference/runtime.md) (`revalidatePath`, `revalidateTag`, `RouteTags`,
  `Revalidate`)
- [Route module exports](../reference/route-exports.md) (`revalidate`, `tags`)
- [Endpoints](../reference/endpoints.md) (`POST /__nowaki/revalidate`)
- [Headers](../reference/headers.md) (`x-nowaki-cache`)
