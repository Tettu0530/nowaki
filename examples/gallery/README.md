# gallery: the v0.18 "Sirocco" and v0.19 "Bora" example

A small photo gallery that covers the v0.18 and v0.19 exit criteria with public APIs only.

v0.18:

1. A photo opens in a modal on client navigation and as a full page on reload
   (intercepting and parallel routes).
2. The app is served under a `basePath` in two locales, with a signed-in session, and
   refuses to start when a required environment variable is missing.

v0.19, on the posts (`/gallery/posts`, a post per photo with a caption):

3. Saving a caption (signed in) updates the post, and the next request for it is fresh on
   `nowaki start` and on a CDN adapter (Vercel, Cloudflare), while the other posts stay cached.
4. The post list to a post animates with View Transitions, and falls back to a plain client
   navigation without the API or under `prefers-reduced-motion: reduce`.
5. A request is one OpenTelemetry trace: route, middleware, loader, render.
6. In `nowaki dev`, editing the post's Likes island keeps its count, and the dev toolbar shows
   the page's islands and its first-load JS against the route's `budget`.

## Run it

```bash
pnpm install   # from the repo root (links @nowaki-dev/runtime)
GALLERY_ADMIN_PASSWORD=sirocco \
NOWAKI_SESSION_SECRET=change-me-to-32-or-more-random-characters \
  nowaki dev examples/gallery
```

Open <http://localhost:3000/gallery>. A browser that prefers Japanese is sent to
`/gallery/ja`. Sign in at `/gallery/login` with the password you set; then a post under
`/gallery/posts` takes a new caption.

`nowaki build examples/gallery` and `nowaki start examples/gallery` need the same two
variables. `PUBLIC_GALLERY_TITLE` is optional (default `Sirocco`).

## Where each criterion lives

| Criterion | Files |
| --- | --- |
| Modal on navigation, full page on reload | `routes/_layout.tsx` renders `slots.modal`. `routes/@modal/(.)photo/[id].tsx` intercepts `/photo/[id]` on a client navigation, and `routes/@modal/default.tsx` renders nothing otherwise. `routes/photo/[id].tsx` is the full page. The close button (`islands/CloseButton.tsx`) calls `history.back()`. |
| `basePath` | `basePath: "/gallery"` in `nowaki.config.mjs`. `<Link>`, `ctx.redirect`, assets, and the session cookie's `Path` get the base. `href()` from `@nowaki-dev/runtime/navigation` adds it (and the locale) to a plain `<form action>`. |
| Two locales | `i18n` in `nowaki.config.mjs`: English at `/gallery/...` and Japanese at `/gallery/ja/...`. `/gallery/en/x` redirects to `/gallery/x`. Strings come from the dictionary in `lib/i18n.ts`, keyed by `getLocale()`. `<Link href="/account">` stays in the current locale; `islands/LanguageSwitcher.tsx` uses `<Link locale>` to switch. Its click sets the `nowaki_locale` cookie, which `detect: true` follows over `Accept-Language`. The pages carry `hreflang` alternates (from `site`). |
| Signed-in session | `session.ts` sets the cookie name. `routes/login.tsx` checks the password from `env.ts`, then calls `ctx.session.regenerate()` and sets the user. `routes/(account)/_middleware.ts` guards the `(account)` route group (no URL segment) and sends visitors without a session to sign in. `routes/(account)/account.tsx` shows the user, and `routes/logout.tsx` calls `ctx.session.destroy()`. |
| Fails without a required variable | `env.ts` declares `GALLERY_ADMIN_PASSWORD` (required), `NOWAKI_SESSION_SECRET` (at least 32 characters), and `PUBLIC_GALLERY_TITLE` (with a default). `nowaki build` and `nowaki start` stop with the variable's name and never print its value. |

| Fresh after an edit (3) | `routes/posts/[id].tsx` is ISR (`revalidate = 3600`) with ``tags = ({ params }) => ["photos", `photo:${params.id}`]``; `routes/posts/index.tsx` has `tags = ["photos"]`. The caption form's `action` saves the caption (`lib/posts.ts`, in memory) and calls `revalidateTag("photo:<id>")` before its 303. That purges both locales of that post only: the `nowaki start` ISR store before the response, `Vercel-Cache-Tag` entries through `@vercel/functions` (add it to the app's dependencies), and on Cloudflare the zone purge by tag (`CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN`). `routes/posts/_middleware.ts` reads the session only on a POST, so the cached GET stays the same for everyone; a cross-site POST sees an empty session there and is sent to sign in, and the default origin check would refuse it before the action anyway. |
| View Transitions (4) | `<Link viewTransition>` on the list's cards and on the post's link back; ``transitionName(`photo-${id}`)`` on the thumbnail and on the post's photo, so one morphs into the other. The router skips the transition where `document.startViewTransition` is missing or the visitor prefers reduced motion. |
| One trace (5) | No app code: set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://127.0.0.1:4318`) on `nowaki start`. A post's request gives the Rust front's `GET /posts/[id]` span, its call to the renderer, and the renderer's `middleware /posts`, `loader` and `render` spans, in one trace. `NOWAKI_SERVER_TIMING=1` adds the same phases as `Server-Timing`, and `NOWAKI_LOG=json` an access log. |
| HMR and the toolbar (6) | `islands/Likes.tsx` holds a count in `useState`: edit its markup in `nowaki dev` and the count stays. The toolbar (bottom right in dev) lists the route, its layouts, the islands on the page (Likes, LanguageSwitcher), the JS estimate against `budget = { js: 12 }` in `routes/posts/[id].tsx`, and the ISR settings. |

The config `redirects` entry (`/photos/[id]` → `/photo/[id]`) and `headers` entry
(`x-robots-tag: noindex` on `/login`) are relative to the base. They match the path without
its locale, so `/ja/login` gets the header too, and `/ja/photos/1` redirects to `/ja/photo/1`.

The photos are tiny PNGs in `photos/`, imported with `?image` (`lib/photos.ts`) and
rendered with `<Image>` (AVIF plus PNG, with width and height).

## Static output

`nowaki build --adapter static` refuses this app: the account page reads `ctx.session`,
and a static file is the same for every visitor. A static host also can't negotiate
`Accept-Language` (the build warns about `i18n.detect`) or answer the router's modal
request. Without the session pages, the pages are written per locale and photo, and
`_redirects` / `_headers` carry the config rules and the `/gallery/en` redirect. The
router then falls back to the full photo page. The posts are written too (`staticPaths`), but
a static host has no action to save a caption, and `revalidateTag` has nothing to purge there.

## Tests

- `node scripts/gallery-e2e.mjs start dev node cloudflare vercel static env otel` checks over
  HTTP: the locales, hreflang, the redirects and the header, detection, the modal fragment,
  sign-in and sign-out, static output, and the missing-variable failures. For the posts: a
  cache HIT before the edit, a MISS with the new caption after it (both locales), the other
  posts and the list still HIT, on `nowaki start`, on the Cloudflare worker (a stand-in for
  `caches.default` and the zone purge API) and on the Vercel function (a fake
  `@vercel/functions` behind a stand-in CDN); and one trace from a local OTLP receiver.
- `node scripts/gallery-browser-test.mjs` runs the same flows in headless Chrome under
  `/gallery/ja`, the View Transition (a spy on `document.startViewTransition`) and its
  fallbacks, then `nowaki dev` on a copy of the app: the island edit that keeps its count, and
  the toolbar's islands, JS budget and ISR panels.
