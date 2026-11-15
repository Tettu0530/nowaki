# Layouts and middleware

A `_layout` wraps the pages in its directory and below. A `_middleware` runs before the
requests under its directory. Both nest: `routes/_layout.tsx` wraps everything,
`routes/blog/_layout.tsx` wraps the blog inside it.

## Layouts

```tsx
// routes/_layout.tsx
import "../styles/site.css";
import type { LayoutProps } from "@nowaki-dev/runtime";
import { Link } from "@nowaki-dev/runtime/navigation";

export const meta = { openGraph: { siteName: "Example" } };

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="shell">
      <header>
        <Link href="/">Home</Link> <Link href="/about">About</Link>
      </header>
      {children}
    </div>
  );
}
```

- A layout receives `{ children, data, params, url, slots }`. `children` is the page or the
  next layout down; `slots` holds the [parallel routes](./routing.md#parallel-routes) of its
  directory (an empty object when there are none).
- Nowaki writes `<html>`, `<head>` and `<body>` itself. A layout renders what goes inside
  `<body>`. To set attributes on `<html>` or `<body>`, export `htmlAttrs` / `bodyAttrs`
  (see [SEO and metadata](./seo.md#html-and-body-attributes)).
- CSS a layout imports is linked on every page under it.
- A layout can export `loader` (its result is the layout's `data`), `meta` (defaults for the
  pages under it), `title`, `head`, `lang`, `htmlAttrs`, `bodyAttrs` and `scripts`. The type of
  each is in `LayoutModule`.
- A layout's `head` goes into every page under it, before the page's own.
- Layouts apply by where the route file is: `routes/blog/_layout.tsx` wraps the files inside
  `routes/blog/`, not a sibling `routes/blog.tsx`.

```tsx
// routes/blog/_layout.tsx: a layout with its own loader
import type { LayoutProps, LoaderContext } from "@nowaki-dev/runtime";

export async function loader(ctx: LoaderContext) {
  return { categories: await db.categories() }; // your data layer
}

type Data = Awaited<ReturnType<typeof loader>>;

export default function BlogLayout({ children, data }: LayoutProps<Data>) {
  return (
    <div class="blog">
      <nav>{data.categories.map((c) => <a href={`/blog/category/${c.slug}`}>{c.name}</a>)}</nav>
      {children}
    </div>
  );
}
```

A layout is a server component: hooks and event handlers in it do nothing in the browser. Put
interactive parts in [islands](./islands.md) and render them from the layout.

Working examples: `examples/hello/routes/_layout.tsx`, `examples/hello/routes/blog/_layout.tsx`,
`examples/gallery/routes/_layout.tsx`.

## Middleware

A `_middleware` module's default export runs before every request under its directory: pages,
API routes, file routes and 404s. It gets the request's `ctx`.

```ts
// routes/admin/_middleware.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export default async function requireAdmin(ctx: LoaderContext) {
  const user = await ctx.session.get<{ role: string }>("user");
  if (user?.role !== "admin") return ctx.redirect("/login");
  ctx.state.user = user; // for the loaders and handlers after it
}
```

- Return a response (`ctx.redirect`, `ctx.json`, `ctx.text`, `ctx.html`, or a `Response`) to
  answer the request there. Return nothing to go on to the route.
- `ctx.state` carries values to the loaders, actions and API handlers that run after it.
- `ctx.setHeader` and `ctx.setCookie` add to the final response.
- Nested middleware runs from the outside in: `routes/_middleware.ts`, then
  `routes/admin/_middleware.ts`.
- Middleware outside route groups matches by URL. A `[param]` directory matches any one segment
  (`routes/org/[org]/_middleware.ts` runs for `/org/acme/settings`), and a literal directory
  matches the percent-decoded segment, so `/%61dmin/x` still runs `routes/admin/_middleware.ts`.
- Middleware inside a [route group](./routing.md#route-groups) runs for the routes whose files
  are inside the group, so it doesn't run for 404s.
- Only `export default` is read. A module with only `export const middleware` fails the
  requests it covers with an error saying so.

### Middleware runs before the CSRF check

The same-origin check on actions and API routes runs after middleware. A cross-site POST
therefore reaches your middleware, with an empty, read-only `ctx.session`. Don't change data in
middleware based on such a request: do writes in actions, API routes or server functions, which
the check protects. See [Security](./security.md#cross-site-writes-csrf).

### Reading the session keeps pages per-user

Reading `ctx.session` or a cookie in middleware makes the response vary by it, which turns ISR
off for that page. If a section is public to read and protected to write, check the session only
for writes, as `examples/gallery/routes/posts/_middleware.ts` does:

```ts
export default async function editorsOnly(ctx: LoaderContext) {
  if (ctx.method === "GET" || ctx.method === "HEAD") return; // reads stay cacheable
  const user = await ctx.session.get<string>("user");
  if (!user) return ctx.redirect("/login", 303);
  ctx.state.user = user;
}
```

Working examples: `examples/hello/routes/_middleware.ts`,
`examples/gallery/routes/(account)/_middleware.ts`, `examples/gallery/routes/posts/_middleware.ts`.

## Reference

- [Route module exports](../reference/route-exports.md) (`LayoutModule`, `MiddlewareModule`)
- [Runtime API](../reference/runtime.md) (`LayoutProps`, `LoaderContext`, `Middleware`)
- [File conventions](../reference/file-conventions.md)
