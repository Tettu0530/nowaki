# A docs site: Nowaki vs Astro

The v0.17 goal: a docs site from a typed content collection (Markdown and MDX), with responsive
images and a generated sitemap, built with no third-party Markdown or image code, measured next
to Astro. Every number comes from running these scripts.

## The site

`gen.mjs` writes the same site in both frameworks (`lib/templates.mjs`), with `n` entries from
`lib/content.mjs` (deterministic text, the same bytes in both):

| | Nowaki | Astro |
|---|---|---|
| collection | `content/config.ts`, `defineCollection` with a hand-written Standard Schema | `src/content.config.ts`, `glob()` loader and `astro:content`'s `z` |
| entries | `content/docs/*.md`, every 5th `*.mdx` | `src/content/docs/*.md`, every 5th `*.mdx` |
| MDX component | `components/Callout.tsx` (server-rendered) | `src/components/Callout.astro` |
| code fences (ts, bash, json) | highlighted at build time (syntect, built in) | highlighted at build time (Shiki, built in) |
| images (`![](../../assets/photo-k.jpg)`) | built in: `<picture>`, AVIF + JPEG, 4 widths | `astro:assets` with `image.layout: "constrained"`: `<img>`, WebP, 6 widths |
| sitemap | `site` in `nowaki.config.mjs` (built in) | `@astrojs/sitemap` |
| pages | `/`, `/docs/` (by `order`), `/docs/<slug>/` with an h2 table of contents | the same |
| output | `nowaki build --adapter static` → `dist/static` | `astro build` → `dist` |

Each entry has three sections, a list, a table, three code fences and one of four photos
(`assets/photo-1..4.jpg`, 1600×1000, about 250 KB each, made by `lib/photos.cjs` and converted
with macOS `sips`). The MDX entries also render the `<Callout>`. No page has an interactive
island, so first-load JS is expected to be 0 in both; the harness measures it anyway.

Each framework's default image output is kept as is: Nowaki writes AVIF plus the original
format, Astro writes WebP. That difference is part of the build time and the output size.

Nowaki is measured from this checkout, before a release: build it with
`cargo build --release -p nowaki` (or point `NOWAKI_BIN` at a binary). The app installs
`@nowaki-dev/runtime` from `packages/nowaki-runtime` as a `file:` dependency, which pnpm
copies (so `preact` resolves from the app). The copy is not refreshed by `pnpm install`, not
even with `--force`: after the runtime changes, delete `apps/nowaki/node_modules` and install
again. `run.mjs` refuses to measure when the installed copy differs from `packages/nowaki-runtime`.

## Metrics

| metric | definition |
|---|---|
| cold build | the static build with the output and every framework cache deleted first (Nowaki: `node_modules/.cache/nowaki`, `.nowaki`; Astro: `.astro`, `node_modules/.astro`, `node_modules/.vite`). 1 warm-up + `runs`; the warm-up is excluded. |
| warm build | the same build again with the caches kept, only the output deleted. Nowaki caches AVIF encodes and highlighted code; Astro caches optimized images and its content data store. |
| output | after the last build: HTML, images (AVIF / WebP / JPEG), CSS and JS bytes and files, and the page URLs in the sitemap |
| first-load JS / transfer | the output served by `../compare/lib/serve.mjs` and opened in headless Chromium (`../compare/lib/browser.mjs`): a Markdown entry, an MDX entry, and `/docs/` |

Sizes: 20, 100 and 500 entries. One process at a time; the framework order alternates per size.

## Run

```sh
cargo build --release -p nowaki
pnpm -C benchmarks/docs-site/apps/nowaki install
pnpm -C benchmarks/docs-site/apps/astro install
node benchmarks/docs-site/sweep.mjs --runs 5     # one framework at a time
node benchmarks/docs-site/summarize.mjs          # results/summary.json and summary.md
```

`DOCS_RESULTS=<dir>` writes results somewhere else (for trial runs).
