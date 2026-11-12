# AGENTS.md — building this Nowaki app

Guidance for AI coding agents (Claude Code, Codex, Gemini, Cursor, Copilot, Grok,
Kimi, …) working in this app. Nowaki is a full-stack framework with a Rust
toolchain: pages render to HTML on the server, and only the components under
`islands/` ship JavaScript and hydrate. Full docs: <https://nowaki.dev/docs>.

## Commands

```bash
npm run dev        # nowaki dev   — dev server with hot reload (http://localhost:3000)
npm run build      # nowaki build — production build (dist/client + dist/server)
npm run start      # nowaki start — serve the production build
npm run prerender  # nowaki prerender — static export
npx nowaki upgrade # update nowaki (CLI) + @nowaki-dev/runtime to latest
```

While `npm run dev` runs, the dev server also serves a read-only MCP endpoint
(loopback only) at `http://127.0.0.1:3000/__nowaki/mcp`, with the tools `routes`,
`module_graph`, `recent_errors`, and `dev_config`. Add it to Claude Code with
`claude mcp add --transport http nowaki http://127.0.0.1:3000/__nowaki/mcp`.
After an edit or a failing request, check `recent_errors` first.

## Project layout

```
routes/      file-based routes (pages + API). _layout.tsx, _middleware.ts,
             _404.tsx, _500.tsx, [slug].tsx, api/*.ts
             (name)/ = route group: no URL segment, its own _layout /
             _middleware for the files inside it (group middleware skips 404s)
             @name/ = parallel route slot: the parent dir's _layout gets
             `slots.name` (the @name file matching the URL, else
             @name/default.tsx, else null). @name/(.)photo/[id].tsx =
             intercepting route: client navigation to /photo/1 shows it in
             the slot (a modal); a reload renders routes/photo/[id].tsx.
             Close it with history.back()
islands/     interactive components — THE ONLY things that ship JS and hydrate
components/  shared server components (no client JS)
lib/         shared server code
actions/     "use server" RPC modules (optional)
content/     content collections (optional), declared in content/config.ts
public/      files served as-is at their own path (favicon.ico, robots.txt)
nowaki.config.mjs   site, fonts, images, routing rules, i18n, plugins (optional)
env.ts       typed env schema (optional)
session.ts   ctx.session options (optional)
```

## Rules — follow these when generating code

1. **Preact, not React.** Import hooks from `preact/hooks`
   (`import { useState } from "preact/hooks"`). `react`, `react-dom`, and
   `react/jsx-runtime` are aliased to `preact/compat`, so many React libraries
   work, but write Preact.
2. **Interactivity lives in `islands/`.** A component with `useState`, event
   handlers, effects, etc. must be a file under `islands/`. A route or component
   that imports an island stays server-HTML; only the island hydrates. Don't put
   `onClick`/hooks in route or `components/` files.
3. **Use explicit file extensions in relative imports**:
   `import Counter from "../islands/Counter.tsx"` (not `"../islands/Counter"`).
4. **Routes** are components with an optional server-only `loader` and `action`.
   Optional types come from `@nowaki-dev/runtime` — `PageProps<typeof loader>`
   infers the page's `data`, `LoaderContext` types `params`/cookies/headers:
   ```tsx
   // routes/blog/[slug].tsx
   import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";
   export const loader = async ({ params }: LoaderContext) => ({ post: await db.post(params.slug) }); // server-only
   export async function action(ctx: LoaderContext) {  // runs on non-GET requests
     const form = await ctx.formData();            // FormData; String(form.get("x") ?? "") for text
     return ctx.redirect("/blog");                 // Post/Redirect/Get
   }
   export default function Post({ data }: PageProps<typeof loader>) { return <article><h1>{data.post.title}</h1></article>; }
   ```
   A catch-all segment `routes/files/[...path].tsx` matches `/files/a/b/c`;
   `params.path` is the array `["a","b","c"]`. Add `export const revalidate = 60`
   (seconds) to a route for ISR: the HTML is cached and regenerated in the
   background when stale (don't put per-user data on an ISR page).
5. **API routes** are `routes/api/*.ts` with per-method exports; return a value
   (JSON-encoded) or a `Response`:
   ```ts
   export const GET = (ctx) => ctx.json({ ok: true });
   export const POST = async (ctx) => ctx.json({ got: await ctx.bodyJson() });
   ```
6. **Islands** are default-exported components:
   ```tsx
   // islands/Counter.tsx
   import { useState } from "preact/hooks";
   export default function Counter({ start = 0 }) {
     const [n, setN] = useState(start);
     return <button onClick={() => setN(n + 1)}>count: {n}</button>;
   }
   ```
   **Lazy hydration** (Astro-style `client:*` directives) controls *when* an
   island hydrates — add a directive where you use it:
   ```tsx
   <Counter client:load />              // default — hydrate on load
   <Counter client:idle />              // hydrate on requestIdleCallback
   <Counter client:visible />           // hydrate when scrolled into view
   <Chart client:media="(min-width: 768px)" />  // hydrate when the query matches
   <Map client:only />                  // skip SSR, render only on the client
   ```
   Prefer `client:visible` / `client:idle` for below-the-fold or non-critical
   islands to cut work on first load. The directives are typed (no prop leaks).
7. **Server functions** — a module with a top-of-file `"use server"` directive
   becomes RPC; the client gets a tiny fetch proxy, the implementation stays on
   the server. Validate the input with `serverFn(schema, impl)` (any Standard
   Schema library: zod, valibot, arktype); `nowaki build` warns about exports that
   take arguments without it. Read auth via `getContext()`, and throw
   `ServerFnError` for messages the client may see (other errors are a generic
   500 in production):
   ```ts
   // actions/todos.ts
   "use server";
   import { z } from "zod";
   import { getContext, serverFn, ServerFnError } from "@nowaki-dev/runtime";
   export const addTodo = serverFn(z.string().min(1).max(200), async (text) => {
     if (!getContext()?.cookies?.user) throw new ServerFnError("Sign in first", { status: 401 });
     /* runs on the server with a validated string */
   });
   ```
   The **basics** template includes `actions/echo.ts` as a minimal validated example.
   Call it from an island like a normal async function:
   `import { addTodo } from "../actions/todos.ts";`
8. **Jetstream islands** (server-reactive, zero client JS) — give an island
   `export const live = { state, on }`; buttons use `data-live="handler"` instead
   of `onClick`. State lives on the server; the server pushes HTML patches.
   Forms use `data-live-submit="handler"` (gets the fields as an object), inputs
   `data-live-input` (debounced; `data-live-debounce="ms"`) or `data-live-change`;
   give list rows `data-key`. Read the request with `getContext()` and guard
   events with `live.authorize`; `live.subscribe` + `live.load` + `publish(topic)`
   push server-side changes. `live.room(props)` + `live.shared()` share one state
   between everyone in a room (`data-nowaki-presence="<room>"` shows who's there).
   Rooms, `publish`, and presence live in one server process (`nowaki start`);
   on the deploy adapters live islands work per event over POST, without push.
9. **Loading / error UI** (client navigation) — `routes/loading.tsx` renders
   while a navigation is in flight; `routes/error.tsx` (props `{ error, reset }`,
   type `ErrorPageProps`) renders if it fails. Both nest by directory. In
   `error.tsx`, mark the message element `data-nowaki-error` and the retry button
   `data-nowaki-reset`. Visited pages are kept in a ~30s Router Cache, so
   back/forward is instant. These are server components, not islands.
10. **Typed navigation** — `dev`/`build` generate `.nowaki/types.d.ts` from your
    routes (run `nowaki typegen` to refresh manually). Build links type-safely
    from `@nowaki-dev/runtime/navigation`:
    ```tsx
    import { route, Link } from "@nowaki-dev/runtime/navigation";
    <Link href="/about">About</Link>                       // static path, checked
    <a href={route("/blog/[slug]", { slug })}>Post</a>      // dynamic, params typed
    ```
    Unknown paths, missing params, and wrong param keys are compile errors.
11. **Markdoc (optional)** — [Markdoc](https://markdoc.dev) via the official
    `@nowaki-dev/markdoc` plugin (`npm install @nowaki-dev/markdoc`). Register it
    in `nowaki.config.mjs` and import `.mdoc` files from routes; they are not
    routes themselves. Upstream docs: `packages/nowaki-markdoc/README.md`.
    ```js
    // nowaki.config.mjs
    import { markdoc } from "@nowaki-dev/markdoc";
    export default {
      plugins: [markdoc({ components: "./markdoc/components.tsx", tags: { /* … */ } })],
    };
    ```
12. **Content collections** — each directory under `content/` is a collection of
    `.md` / `.mdx` (or `type: "data"`: `.json` / `.yaml`) files, declared as a
    named export of `content/config.ts` with a Standard Schema for the frontmatter.
    Entries have `data`, `slug`, and `html` (Markdown) or `render()` (MDX):
    ```ts
    // content/config.ts
    import { z } from "zod";
    import { defineCollection } from "@nowaki-dev/runtime/content";
    export const blog = defineCollection({ schema: z.object({ title: z.string() }) });
    // in a loader
    import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
    const posts = await getCollection("blog");
    ```
    Add `export const staticPaths = [{ slug: "hello" }]` (or a function) to a
    dynamic route to prerender it.
13. **Images and SEO** — `import hero from "../assets/hero.jpg?image"` +
    `<Image src={hero} alt="…" />` from `@nowaki-dev/runtime/image` (srcset, AVIF,
    width/height from the file, lazy by default). Remote images need
    `images.remotePatterns` in nowaki.config. Page metadata is
    `export const meta = { title, description, openGraph, … }` (or a function of
    `{ data, params, url }`); a layout's `meta` applies to the pages under it. Set
    `site` in nowaki.config for absolute URLs and the generated `/sitemap.xml` and
    `/robots.txt`.
14. **Routing config** in `nowaki.config.mjs` (sources use the route syntax),
    applied by `nowaki dev`, `nowaki start`, and every adapter:
    ```js
    export default {
      site: "https://example.com",
      basePath: "/docs",                  // everything lives under /docs
      trailingSlash: "never",             // or "always" / "ignore" (default)
      redirects: [{ source: "/old/[slug]", destination: "/blog/[slug]", permanent: true }],
      rewrites: [{ source: "/p/[slug]", destination: "/blog/[slug]" }],
      headers: [{ source: "/api/[...rest]", headers: { "cache-control": "no-store" } }],
      i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true },
    };
    ```
    Under `basePath`, `<Link>` and `ctx.redirect` add the base; rules are relative
    to it. With `i18n`, non-default locales get a prefix (`/ja/about`; `detect`
    sends a first visit to `/` by `Accept-Language`), rules match the path
    without it, and `getLocale()` / `ctx.locale` give the locale.
    `<Link href="/about">` keeps the current locale; `<Link locale="ja">` switches
    it. For URLs `<Link>` doesn't build (form actions, `fetch`), use `href("/x")`
    from `@nowaki-dev/runtime/navigation`, which adds the locale and base the same
    way. Don't concatenate `import.meta.env.BASE_URL` by hand. `nowaki dev`
    reads nowaki.config at startup: restart it after a change.
15. **Sessions** — `ctx.session` (and `getContext().session`) is an encrypted
    cookie: `await ctx.session.get("userId")`, `set`, `delete`. Call
    `await ctx.session.regenerate()` on sign-in and `destroy()` on sign-out.
    Options go in `session.ts` (`export default defineSession({ maxAge })` from
    `@nowaki-dev/runtime/session`).
    Reading it makes the page vary by cookie, so ISR no longer shares one cached copy.

## Security

- **`nowaki dev` is for local development.** Do not expose it to untrusted networks.
  Use `nowaki start` or a deploy adapter output in production.
- **Secrets stay server-side.** Only `PUBLIC_*` (and `MODE`) reach the browser. Copy
  `.env.example` to `.env` and keep database URLs, API keys, and tokens unprefixed.
  To validate them, declare them in `env.ts` at the app root with `defineEnv({ server,
  public })` from `@nowaki-dev/runtime/env` and a Standard Schema per variable; the
  build fails on a missing or invalid one. Read server values with
  `import { env } from "@nowaki-dev/runtime/env/server"` in loaders, actions, and server
  functions (never in islands: that fails the build).
- **Server functions and API routes are public endpoints.** Validate and bound every
  argument; authorize with `getContext()` (cookies/headers) before mutating data.
  Use `serverFn(schema, impl)` for `"use server"` exports that take arguments (see
  `actions/echo.ts` in the **basics** template).
- **Cross-site writes.** Page `action`s reject cross-site non-GET requests by default.
  **`routes/_middleware.ts` runs before that check** — do not perform sensitive
  mutations in middleware unless you validate the caller yourself. API routes log a
  warning and still accept cross-site POSTs unless you `export const csrf = true` on
  the route (recommended for cookie-authenticated APIs).
- **Production checklist** (when you deploy): set `NOWAKI_SESSION_SECRET` (at
  least 32 characters) if the app uses `ctx.session`; set `NOWAKI_LIVE_SECRET` if
  the app uses Jetstream live islands; try `NOWAKI_CSP=report-only` before `enforce`; behind
  a reverse proxy on `nowaki start`, set `NOWAKI_TRUST_PROXY=1` and forward the public
  host as `x-forwarded-host`. See the upstream [SECURITY.md](https://github.com/Tettu0530/nowaki/blob/main/SECURITY.md).
- **Do not embed secrets** in client islands, loaders returned to the page, or static
  prerender output. ISR pages must not include per-user secrets.

## Don't

- Don't add a build tool (Vite/webpack/Babel) or a `tsconfig` paths setup — the
  Rust toolchain handles transform/resolve/bundle.
- Don't import React directly hoping for React internals; it's Preact under the hood.
- Don't put interactive components outside `islands/`.
- Don't read secrets on the client. Only `PUBLIC_*` env vars reach the browser;
  everything else is server-only (loaders, actions, server functions).
