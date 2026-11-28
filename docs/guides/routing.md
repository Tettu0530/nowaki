# Routing

Every file under `routes/` is a route. Its path below `routes/` is its URL. Pages are
components that render to HTML on the server; API routes and file routes return data. This
guide covers the file conventions: dynamic segments, route groups, file routes, the special
files, typed links, and parallel and intercepting routes.

For redirects, rewrites, response headers, `basePath`, `trailingSlash` and locales, see
[Routing config](./routing-config.md). For layouts and middleware, see
[Layouts and middleware](./layouts-and-middleware.md).

## Pages

A page is a module under `routes/` whose default export is a component.

```tsx
// routes/about.tsx  →  /about
export const title = "About";

export default function About() {
  return <h1>About</h1>;
}
```

| File | URL |
| --- | --- |
| `routes/index.tsx` | `/` |
| `routes/about.tsx` | `/about` |
| `routes/blog/index.tsx` | `/blog` |
| `routes/blog/[slug].tsx` | `/blog/hello`, `/blog/nowaki` |
| `routes/files/[...path].tsx` | `/files/a`, `/files/a/b/c` |
| `routes/guide.mdx` | `/guide` (an MDX page) |

Route files can be `.tsx`, `.ts`, `.jsx`, `.js` or `.mdx`. Relative imports need their file
extension (`import Counter from "../islands/Counter.tsx"`): the server build runs as plain ESM
and does not guess extensions.

A page renders to HTML and ships no JavaScript of its own. Only the islands it renders
hydrate (see [Islands](./islands.md)).

## Dynamic segments

`[name]` matches one path segment; `[...name]` matches one or more. The values arrive as
`params`, in the page props and in `ctx.params` of loaders and actions. A catch-all value is an
array.

```tsx
// routes/files/[...path].tsx: /files/a/b/c → params.path = ["a", "b", "c"]
export default function Files({ params }: { params: { path: string[] } }) {
  return <p>{params.path.join(" / ")}</p>;
}
```

Working examples: `examples/hello/routes/blog/[slug].tsx` and
`examples/hello/routes/files/[...path].tsx`.

A dynamic page is rendered on request. To write it to static HTML with `nowaki prerender` or
the static adapter, list its params in `staticPaths` (an array, or a function that may be
async):

```tsx
export const staticPaths = [{ slug: "hello" }, { slug: "nowaki" }];
```

With `i18n`, a `staticPaths` function runs once per locale and receives `{ locale }`.
`export const prerender = false` leaves a page out of static output.

## Route groups

A directory named `(name)` groups files without adding a URL segment. Use it to give a set of
pages their own `_layout` or `_middleware` without changing their URLs.

```
routes/
  (marketing)/
    _layout.tsx      wraps /pricing, not /about
    _middleware.ts   runs for /pricing
    pricing.tsx      → /pricing
  about.tsx          → /about
```

- A group's `_layout`, `loading` and `error` apply to the files inside it.
- A group's `_middleware` runs for the routes whose files are inside the group. It does not
  run for 404s, since no file matched. Middleware outside groups matches by URL.
- Two files that serve the same URL because of groups (`(a)/about.tsx` and `(b)/about.tsx`)
  fail the build and show an error in dev.
- Group names starting with `.` (`(.)`, `(..)`) are reserved for intercepting routes.

Working examples: `examples/hello/routes/(marketing)/` and
`examples/gallery/routes/(account)/`.

## API routes

Files under `routes/api/` are API routes. They export one handler per HTTP method, in
uppercase, or a `default` handler for every method without its own export. A method with no
handler gets 405.

```ts
// routes/api/echo.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export function GET(ctx: LoaderContext) {
  return ctx.json({ q: ctx.url.searchParams.get("q") });
}

export async function POST(ctx: LoaderContext) {
  return ctx.json({ received: await ctx.bodyJson() });
}
```

What a handler can return, and the CSRF rule for `POST` / `PUT` / `PATCH` / `DELETE`, are in
[Data: API routes](./data.md#api-routes).

## File routes

A route whose last segment has a file extension returns a file instead of a page:
`routes/feed.xml.ts` serves `/feed.xml`, and `routes/og/[card].png.ts` serves `/og/intro.png`
(a param followed by a fixed extension). Like an API route, it exports `GET` (or `default`).

```ts
// routes/feed.xml.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function GET({ site, url }: LoaderContext) {
  const origin = site?.origin ?? url.origin;
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Feed</title><link>${origin}/</link></channel></rss>
`;
}
```

- A returned string, `Uint8Array` or `ArrayBuffer` is the body, with the content type of the
  extension (`.xml` → `application/xml`, `.png` → `image/png`). A `Response` is sent as it is;
  other objects are JSON.
- The static adapter writes file routes to their own path. Dynamic ones are written from
  `staticPaths`; `export const prerender = false` skips one.
- File routes get no typegen entry, page budget or route CSS, and the client router leaves
  links to them to the browser.
- A page file's name can't end in a dot followed by letters or digits (`v1.2.tsx`): name it
  `v1.2/index.tsx` instead.

Working examples: `examples/hello/routes/feed.xml.ts`, `examples/hello/routes/og/[card].png.ts`.

## Special files

| File | What it is |
| --- | --- |
| `_layout.tsx` | Wraps the pages in its directory and below. See [Layouts and middleware](./layouts-and-middleware.md). |
| `_middleware.ts` | Runs before the requests under its directory. Same guide. |
| `_404.tsx` | The page for unmatched URLs (status 404). |
| `_500.tsx` | The page for a loader or render that throws (status 500). It receives `{ error, url }`; in production `error.message` is empty and the error is logged instead. |
| `loading.tsx` | Shown while a client navigation takes longer than 150 ms. |
| `error.tsx` | Shown when a client navigation fails. Mark the message element `data-nowaki-error` and the retry button `data-nowaki-reset`. |
| `default.tsx` | The fallback of a parallel-route slot (only inside `@slot/`). |

`loading.tsx` and `error.tsx` nest by directory and are server components, not islands. They
take the URLs `/loading` and `/error` in their directory. Other names starting with `_` are
reserved. `_error.tsx` is not a convention: it fails the build with a message to rename it to
`_500.tsx`.

```tsx
// routes/error.tsx
export default function ErrorBoundary() {
  return (
    <main>
      <h1>Couldn't display this page</h1>
      <p data-nowaki-error />
      <button type="button" data-nowaki-reset>Retry</button>
    </main>
  );
}
```

Working examples: `examples/hello/routes/_404.tsx`, `_500.tsx`, `loading.tsx`, `error.tsx`.

## Client navigation

On a page with at least one island, the client router takes over same-origin links: it fetches
the next page and swaps the body, keeping the islands runtime loaded. Pages without islands
load no router; their links are plain page loads.

- The router loads when a link is hovered, focused or touched, so a visitor who never navigates
  never downloads it. `<Link prefetch>` (or `<a data-nowaki-prefetch>`) also loads it when that
  link is in the viewport, and fetches the page then. Other links stay on hover and touch.
  Save-Data or a 2g connection skips the viewport fetch. A page with no islands still has no
  router.
- Visited pages stay in a Router Cache for 30 seconds (`<meta name="nowaki-router-cache"
  content="0">` turns it off, another number sets the seconds).
- `data-no-router` on a link (or `<Link data-no-router>`) makes a click a full page load.
- Links to files (`/feed.xml`), other origins, and responses that aren't HTML go to the
  browser.
- After each navigation, `nowaki:page-load` is dispatched on `document`.

## Typed links

`nowaki dev` and `nowaki build` write `.nowaki/types.d.ts` with the app's routes (`nowaki
typegen` writes it on demand). With it, `<Link>` and `route()` from
`@nowaki-dev/runtime/navigation` check paths and params at compile time.

```tsx
import { Link, route } from "@nowaki-dev/runtime/navigation";

<Link href="/about">About</Link>;                              // a static route, checked
<Link href={route("/blog/[slug]", { slug: "hello" })}>Post</Link>; // params typed
```

An unknown path, a missing param or a wrong key is a type error. Until `.nowaki/types.d.ts`
exists, any path and params are accepted (unchecked): run `nowaki typegen` before `tsc` in CI
to check them. `<Link>` also adds the
`basePath` and the current locale; for URLs it doesn't build (a form `action`, `fetch`), use
`href()` from the same module. See [Routing config](./routing-config.md#links-under-a-base-path).

## Parallel routes

A directory named `@name` is a slot of the `_layout` in its parent directory. The layout gets
what the slot renders as `slots.name`:

- the slot's file matching the URL below the layout's directory
  (`@modal/photo/[id].tsx` for `/photo/42`), with its own loader and params,
- else the slot's `default.tsx`,
- else `null`.

```tsx
// routes/photos/_layout.tsx
import type { LayoutProps } from "@nowaki-dev/runtime";

export default function PhotosLayout({ children, slots }: LayoutProps) {
  return (
    <div>
      {children}
      {slots.modal}
    </div>
  );
}
```

The slot renders inside `<nowaki-slot name="modal" style="display:contents">`. Its CSS and page
scripts are linked with the page's; it adds no `meta`. Slot files are never routes of their
own, and files starting with `_` inside a slot are ignored.

Working example: `examples/hello/routes/photos/` (`_layout.tsx`, `@modal/[id].tsx`,
`@modal/default.tsx`).

## Intercepting routes

A file in a slot whose path has a `(.)`, `(..)` or `(...)` segment takes over that URL on a
client navigation from a page the slot is on. The classic use is a modal: clicking a photo in a
grid opens it over the grid, and a reload of the same URL shows the full photo page.

```
routes/
  _layout.tsx               renders {slots.modal}
  index.tsx                 the grid, links to /photo/1
  photo/[id].tsx            the full page (direct visit, reload)
  @modal/
    default.tsx             returns null
    (.)photo/[id].tsx       the modal (client navigation from the grid)
```

- The marker counts URL segments from the slot's directory: `(.)` the same level, `(..)` one
  up, `(...)` the root. Groups and slots don't count.
- The router fetches only the intercepting file (with its loader, CSS and page scripts), swaps
  it into the slot and changes the URL. The rest of the page and its island state stay.
- Back restores the slot as it was; forward reopens it. Close a modal with `history.back()`
  (from an island).
- A slot with intercepting files always renders its `<nowaki-slot>`, empty when it has nothing
  to show, so always render `slots.name` in the layout: that is where the fragment goes.
- The fragment response is `private, no-store` and never cached by ISR.

Working examples: `examples/gallery/routes/@modal/(.)photo/[id].tsx` (with
`islands/CloseButton.tsx`) and `examples/hello/routes/photos/@modal/(.)[id].tsx`.

## Reference

- [File conventions](../reference/file-conventions.md)
- [Route module exports](../reference/route-exports.md)
- [Runtime API](../reference/runtime.md) (`Link`, `route`, `href`, `LayoutProps`)
- [Client events and attributes](../reference/client-events.md)
