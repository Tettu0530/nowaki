# Migrating from Astro

This guide moves a static Astro site to Nowaki. It was written while porting a real one: a
personal portfolio with seven sections, GSAP and Lenis motion, an inline theme script,
`<html>` attributes, self-hosted fonts, and OG images rendered with resvg. The port's static
output matched the Astro build element by element. Its OG images were byte-identical.

The short version: pages and components become Preact TSX, `<script>` becomes
`export const scripts`, endpoints become file routes, and most of the rest maps one to one.

## 1. Set up

1. Replace `astro` with Nowaki's runtime and Preact:
   ```sh
   npm remove astro @astrojs/check
   npm install @nowaki-dev/runtime preact preact-render-to-string
   npm install -D nowaki
   ```
2. Copy `tsconfig.json`, `nowaki-env.d.ts`, and `nowaki-jsx.d.ts` from a fresh app
   (`npm create nowaki`). They teach the type checker CSS, asset, `?image`, and `.mdx` imports,
   `import.meta.env`, and the `client:*` directives.
3. Scripts: `nowaki dev`, `nowaki build --adapter static` (without `--adapter`, the build
   targets the Node server), and `nowaki start` to preview a server build.
4. Move `site` from `astro.config.mjs` to `nowaki.config.mjs`:
   ```js
   export default { site: "https://example.com" };
   ```

## 2. Move the files

| Astro | Nowaki |
|---|---|
| `src/pages/index.astro` | `routes/index.tsx` |
| `src/pages/about.astro` | `routes/about.tsx` (served at `/about/` in static output, like Astro) |
| `src/layouts/Layout.astro` | `routes/_layout.tsx` (wraps every page; nest one per folder) |
| `src/components/*`, `src/sections/*`, `src/lib/*`, `src/data/*` | anywhere at the app root: `components/`, `lib/`, `data/`, … (what routes import is compiled) |
| `src/scripts/*`, `src/motion/*` | anywhere; they're bundled for the browser through page scripts (step 6) |
| `public/` | `public/` (served as-is, unchanged) |

Add explicit extensions to relative imports (`import x from "./x.ts"`). Node runs the server
build as plain ESM, which doesn't guess extensions.

## 3. Components: `.astro` → `.tsx`

| Astro | Nowaki (Preact) |
|---|---|
| frontmatter (`---`) | the function body; module-level constants can stay at the top |
| `Astro.props` | the component's props (`class` works as a prop name in Preact) |
| `<slot />` | `children` |
| named slots | props that take JSX |
| `class:list={[a, { b: cond }]}` | a small helper (below) |
| `set:html={html}` | `dangerouslySetInnerHTML={{ __html: html }}` |
| `{cond && <X />}`, `{list.map(...)}` | the same |
| dynamic tag `<Tag>` from a prop | `const Tag = as; <Tag … />` |

```ts
// class:list. Returns undefined when empty, so the attribute is left out, as Astro does.
export const cx = (...n: unknown[]) =>
  [...new Set(n.flat(9).filter((x): x is string => typeof x === "string" && x !== ""))].join(" ") ||
  undefined;
```

**Whitespace.** Astro turns a line break between two elements into a space; JSX drops it. Where
the space matters (inline text, `inline-block` boxes), put it back:

```tsx
<span class="num">{v}</span>{" "}<span class="unit">{u}</span>
```

This was the largest visual difference in the port: one widget shrank from 240 px to 162 px
until the spaces came back.

## 4. Styles

- **Global CSS**: import it from the layout (`import "../styles/base.css";`). It's linked as
  a stylesheet on every page under that layout. `@import` inside CSS works, both relative and
  from packages (`@import "lenis/dist/lenis.css";`): the build inlines it.
- **A component's `<style>`**: move it to a sibling `.css` file and import it from the
  component. It becomes global, like `<style is:global>`. Two things to check after the move:
  - Astro's scoping added one attribute to every selector. Without it, a rule can lose to a
    global one it used to beat. Raise its specificity where that happens.
  - Scoped rules that targeted elements rendered by a child component never matched in Astro.
    As global CSS they suddenly apply. Delete them.
  - `:global(.x)` → `.x`.
- **CSS Modules** (`x.module.css`, `import s from "./x.module.css"`, `class={s.card}`) scope
  like Astro does. They fit when nothing else (scripts, other components) selects those
  classes by name.
- **`define:vars` in `<style>`**: pass a `style={{ "--x": value }}` on the element instead.

## 5. The document: `<html>`, `<head>`, metadata

```tsx
// routes/_layout.tsx
import "../styles/tokens.css";
import "../styles/base.css";

export const htmlAttrs = { lang: "ja", "data-sheet-rev": "2026.08" }; // <html …>
export const bodyAttrs = { class: "site" };                           // <body …>
// Tags every page under this layout gets (favicon, theme-color, an inline boot script):
export const head = `<link rel="icon" href="/favicon.png" />
<script>document.documentElement.dataset.theme = localStorage.theme ?? "light"</script>`;
// Defaults for the pages' metadata:
export const meta = { openGraph: { siteName: "My site" }, twitter: { site: "@me" } };

export default function Layout({ children }: { children: unknown }) {
  return <div class="page">{children}</div>;
}
```

```tsx
// routes/index.tsx
export const title = "Home";
export const meta = {
  description: "What this site is about.",
  canonical: true, // this page's URL on `site`
  openGraph: { image: { url: "/og/index.png", width: 1200, height: 630, alt: "…" } },
  twitter: { card: "summary_large_image" },
};
```

- With `site` set, `sitemap.xml` and `robots.txt` are generated unless `public/` or a route
  has them. `export const sitemap = false` leaves a page out.
- `<script is:inline>` in the head → the layout's (or a route's) `head` string, as above.
- `<script is:inline define:vars={{ data }}>` in the body → a script element with the values
  serialized (escape `<`, so data can't close the element):
  ```tsx
  <script dangerouslySetInnerHTML={{ __html: `const data = ${JSON.stringify(data).replaceAll("<", "\\u003c")};` }} />
  ```

## 6. Scripts

A bundled `<script>` (the default in Astro) becomes a page script:

```tsx
// routes/_layout.tsx (or one route)
export const scripts = ["../scripts/main.ts"];
```

- It's bundled like an island: npm imports work (GSAP and its plugins, Lenis), and shared code
  becomes shared chunks. There is no `vite.optimizeDeps`.
- It loads as `<script type="module">` with preloads, and counts toward the page's first-load
  JS and its `budget`.
- It runs once. If the site also has islands, Nowaki's client router takes over link clicks on
  those pages, and a script that sets up the DOM should also listen for
  `document.addEventListener("nowaki:page-load", setup)`. Pages without islands navigate with
  full loads, as in Astro.

Interactive Preact components belong in `islands/` instead; they hydrate on their own
(`client:visible`, `client:idle`, …).

## 7. Endpoints → file routes

```ts
// routes/og/[card].png.ts → /og/index.png, /og/about.png
import { cards, renderCard } from "../../lib/og.ts";

export const staticPaths = () => cards.map((c) => ({ card: c.slug }));

export async function GET({ params, site, url }: { params: { card: string }; site?: URL; url: URL }) {
  const card = cards.find((c) => c.slug === params.card);
  if (!card) return new Response("not found", { status: 404 });
  return renderCard(card, (site ?? url).host); // a Uint8Array → image/png (from the extension)
}
```

- `getStaticPaths` returns `{ params, props }`; `staticPaths` returns params only, so look the
  data up from the params in `GET`.
- Return a string or bytes, typed by the route's extension (`.png`, `.xml`, `.json`, …), or a
  `Response`. `Astro.site` → `ctx.site`.
- Native packages (resvg, harfbuzz) run unchanged: file routes run in Node at build time.

## 8. Images and fonts

- `<Image>` from `astro:assets` → `<Image>` from `@nowaki-dev/runtime/image`, with
  `import hero from "./hero.jpg?image"`. It renders AVIF plus the original format at several
  widths, with the file's own width and height. Local images in Markdown and MDX go through
  the same pipeline.
- Fonts: list them in `nowaki.config.mjs`. Google fonts are downloaded at build time; local
  files are copied. Each family gets a size-adjusted fallback (from `.ttf` / `.otf` metrics)
  and a `--font-…` variable:
  ```js
  fonts: [
    { family: "Inter", provider: "google", weights: [400, 700], subsets: ["latin"] },
    { family: "Geist Variable", src: "./fonts/geist.woff2", weight: "100 900" },
    { family: "Noto Sans JP", src: "./fonts/noto-jp.woff2", preload: false }, // large: no preload
  ]
  ```
  `preload` is on by default; turn it off for large CJK files. Local fonts aren't subset, so
  keep a subsetting step if the site has one.

## 9. Build and compare

```sh
nowaki build --adapter static   # → dist/static
```

Compare with the Astro `dist/`. A file list diff catches missing pages and assets. For layout,
load both builds in a browser at a couple of widths and compare element boxes. That is how the
whitespace and specificity differences above were found. New in the output: `sitemap.xml`,
`robots.txt` (with `site`), and `_headers` (security headers for hosts that read it).

A page that fails to render (a server error) fails the build, rather than leaving a hole in the
static output.
