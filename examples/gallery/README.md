# gallery: the v0.18 "Sirocco" example

A small photo gallery that covers the v0.18 exit criteria with public APIs only:

1. A photo opens in a modal on client navigation and as a full page on reload
   (intercepting and parallel routes).
2. The app is served under a `basePath` in two locales, with a signed-in session, and
   refuses to start when a required environment variable is missing.

## Run it

```bash
pnpm install   # from the repo root (links @nowaki-dev/runtime)
GALLERY_ADMIN_PASSWORD=sirocco \
NOWAKI_SESSION_SECRET=change-me-to-32-or-more-random-characters \
  nowaki dev examples/gallery
```

Open <http://localhost:3000/gallery>. A browser that prefers Japanese is sent to
`/gallery/ja`. Sign in at `/gallery/login` with the password you set.

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
router then falls back to the full photo page.

## Tests

- `node scripts/gallery-e2e.mjs start dev node cloudflare static env` checks over HTTP:
  the locales, hreflang, the redirects and the header, detection, the modal fragment,
  sign-in and sign-out, static output, and the missing-variable failures.
- `node scripts/gallery-browser-test.mjs` runs the same flows in headless Chrome under
  `/gallery/ja`.
