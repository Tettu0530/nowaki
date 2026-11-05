# Five frameworks, one blog, at several sizes

A head-to-head of Nowaki, Astro, SvelteKit, Next.js and Nuxt on the same blog app, generated at
several sizes so the numbers show both each framework's **fixed cost** (what an almost empty app
pays) and its **marginal cost** (what each extra page or island adds). The older one-page counter
comparison (`../head-to-head.mjs`) measures mostly fixed cost.

Every number comes from running these scripts; nothing is typed by hand, and results that do not
favor Nowaki are reported the same way as those that do.

## The app

`gen.mjs` writes the same blog in each framework's own idiom (`lib/templates.mjs`):

| route | what it exercises |
|---|---|
| `/` | root layout, server-side data (latest 10 posts), `islands` interactive counters |
| `/posts` | list of every post |
| `/posts/[slug]` | dynamic route, nested layout, Markdown rendered on the server with `marked` |

The posts come from `lib/content.mjs`: deterministic text (about 1.5 KB of Markdown each), the same
bytes in every app. Each island is a separate module (a counter with its own step), so a bundler
cannot merge them; it sets `data-hydrated` once mounted, and the harness checks that every island
did hydrate.

| app | framework | UI | how data is read |
|---|---|---|---|
| `apps/nowaki` | Nowaki 0.16.0 (runtime 0.15.0, released together) | Preact islands | route `loader` |
| `apps/astro` | Astro 7.4.5 | Preact islands (`client:load`) | frontmatter |
| `apps/sveltekit` | SvelteKit 3.1.1 | Svelte 5 | `+page.server.js` `load` |
| `apps/next` | Next.js 16.4.5 | React 19 client components | async server components |
| `apps/nuxt` | Nuxt 4.6.4 | Vue 3 | `server/api` routes + `useFetch` |

Astro uses Preact so the island library is the same as Nowaki's. SvelteKit, Next.js and Nuxt
hydrate the way they do by default (the whole page, or every client component); that difference
is part of what is measured, not something to normalize away.

Each app has two build modes, written by `gen.mjs --mode`:

- **static** — every page prerendered to HTML: Nowaki `nowaki prerender`, Astro static output,
  SvelteKit `adapter-static` + `prerender = true`, Next.js `output: "export"`, Nuxt `nuxt generate`.
- **server** — a Node server that renders per request, no prerendering: Nowaki `nowaki build`,
  Astro `@astrojs/node`, SvelteKit `adapter-node`, Next.js `force-dynamic`, Nuxt `nuxt build`.

`nowaki build` writes no HTML, so it is only comparable with the other server builds. The static
comparison uses `nowaki prerender` (build, then start a temporary server and render every route).

## Sizes

`sweep.mjs` runs `pages × islands` = `1×1`, `10×1`, `100×1`, `1000×1` and `10×10`.
The pages axis is the number of posts (dynamic route entries); the islands axis is the number of
islands on `/`. `summarize.mjs` fits `ms ≈ fixed + perPage × pages` over the islands = 1 sizes,
and `perIsland = (ms at 10 islands − ms at 1) / 9` at 10 pages.

## Metrics

| metric | definition |
|---|---|
| dev ready | spawn of the dev server → its own ready line. Kept for reference only: Nowaki and Vite print it before compiling anything, Nuxt after its first build, so it does not mean the same thing everywhere. |
| dev first response | spawn → `GET /` returns 200 with the home page's marker (connection errors and 503s are retried every 25 ms). The first page actually rendered. |
| dev second route | right after that, `GET` of a post page until it returns 200 with its marker (one more route compiled on demand). |
| static build | wall time of the static build, output and framework caches deleted first. |
| server build | wall time of the server build, output and framework caches deleted first. |
| first-load JS | the static output served by `lib/serve.mjs` (one plain server for all five), opened in headless Chromium with the cache disabled until the network has been quiet for 2 s. Every JavaScript response plus every inline script the page executes (JSON and import maps excluded), each gzipped at zlib's default level. Measured on `/` and on a post page. |
| total transfer | the same page load, every response body gzipped: document, scripts, styles, data (`fetch`), prefetches. |
| idle JS | the part of first-load JS that the framework loads only once the page is idle (Nowaki's client router). Included in first-load JS. |

Things the browser numbers include on purpose, because they are each framework's default:
Next.js `<Link>` prefetches the posts in view (the `/` request count); Nuxt fetches `_payload.json`
files; SvelteKit loads its client router on every page; Nowaki loads its router on pages that have
islands.

Not compared here: Jetstream (it has no counterpart in the other frameworks, and runs live only
under `nowaki dev` / `nowaki start`), image optimization (each framework's image pipeline would
dominate build time), HMR and Web Vitals.

## Production servers

`prod.mjs` builds the server mode at 100 pages and starts each framework's own Node server:
`nowaki start`, `@astrojs/node` standalone, SvelteKit `adapter-node`, `next start`, Nuxt's
`.output/server/index.mjs`, all with `NODE_ENV=production`, one process each (no clustering).
Each of 5 runs starts the server fresh, warms it up for 3 s at the measured load, then records:

| metric | definition |
|---|---|
| start | spawn → `GET /` returns 200 with the home marker |
| TTFB / total | 300 sequential GETs over one keep-alive connection, cycling through 90 posts; headers received / body received, p50 and p99 |
| req/s | `oha` with 50 connections for 10 s: post pages (90 URLs from a file, one picked per request) and `/` separately; successful responses per second. Any error other than requests cut off at the deadline fails the run |
| idle / peak RSS | the server's whole process tree, after the warm-up / sampled every 100 ms during the post-page load |

Pages are rendered per request: nothing is cached. `--isr` instead runs the post pages under the
framework's own ISR, revalidated every 60 s: `export const revalidate = 60` in Nowaki and Next.js
(Next.js also needs `generateStaticParams` returning `[]`, or the route stays dynamic), and
`routeRules: { "/posts/**": { swr: 60 } }` in Nuxt (its `isr` rule targets hosting providers).
The harness checked each one serves from cache (`x-nowaki-cache: HIT`, `x-nextjs-cache: HIT`, a
stable `last-modified` in Nuxt). Astro and SvelteKit have no built-in ISR and run without it.

Notes:
- Nowaki's Rust binary is started directly. The npm `nowaki` command is a Node shim that
  `spawnSync`s the binary and stays resident (about 45 MB); no other framework has such a
  launcher, but an app started with `npx nowaki start` pays it.
- Nowaki 0.15.0 served 4,183 uncached post pages/s here; 0.16.0 serves 10,424. An earlier
  version of this note put the 0.15.0 gap down to the Rust → Node proxy hop; that was not
  measured, and it was wrong. Measured in #90: `examples/hello` `/about` was about as fast
  through `nowaki start` (6,056 req/s), on the Node sidecar directly (6,492) and on the node
  adapter (6,180), and a CPU profile spent 52% of its time in the ESM loader hooks, from an
  `import()` on every request. 0.16.0 includes #101, which removed that. ISR hits are served by
  the Rust front alone.
- 0.16.0 renders ISR pages right after `nowaki start`, so ISR runs hit the cache from the first
  request, and compresses responses; `oha` sends no `Accept-Encoding`, so req/s is measured on
  uncompressed bodies for every framework.
- The load generator runs on the same machine. Above roughly 100k req/s (Nowaki's ISR hits) the
  number is likely bounded by `oha` and the loopback, not the server.

## Rules

- **One process at a time.** `sweep.mjs` runs `run.mjs` for one framework after another; nothing
  is measured in parallel. The framework order rotates from one size to the next.
- **Repeats.** Each measurement runs 1 + 10 times. The first run is recorded with `warmup: true`
  (cold OS file cache) and excluded; the summary shows the median and the interquartile range of
  the other 10, and every run is kept in `results/*.jsonl`.
- **Cold caches.** Build output and framework caches (`fw.caches` in `lib/frameworks.mjs`) are
  deleted before every dev run and every build. The OS file cache is left warm by the warm-up run.
- **Pinned versions.** Exact versions in each `package.json`, committed lockfiles, installed with
  `--frozen-lockfile`. Each result row records the framework version, Node, the machine and the
  commit of this harness. Telemetry is off everywhere; Nuxt devtools are disabled (the default
  turns them on in dev).
- **Machine.** On power, Low Power Mode off, other heavy work stopped, ideally under
  `caffeinate -i`. When ranges overlap, read it as "no measurable difference".

## Results

The latest tables are in [`results/summary.md`](./results/summary.md) (and `results/summary.json`
for the site); every run is in `results/runs.jsonl` and `results/browser.jsonl`.

The 2026-11-04 rows record the harness as `0e830db+dirty`: the dirty check counted the
uncommitted `results/` directory itself; the measuring code was `0e830db` unchanged. The `1×1`
series of Nowaki, Astro and SvelteKit were measured again after the sweep because another job
was busy on the machine during their first series; the summary uses the latest series.

## Run

```sh
# once per app
for fw in nowaki astro sveltekit next nuxt; do pnpm -C benchmarks/compare/apps/$fw install --frozen-lockfile; done

# one framework at one size
node benchmarks/compare/run.mjs nowaki --pages 100 --islands 1 --runs 10

# the whole matrix (about 1.5 h on an M2), then the tables
caffeinate -i node benchmarks/compare/sweep.mjs
node benchmarks/compare/summarize.mjs   # writes results/summary.json and results/summary.md

# production servers (needs oha: brew install oha), one framework at a time
for fw in nowaki astro sveltekit next nuxt; do node benchmarks/compare/prod.mjs $fw --runs 5; done
for fw in nowaki next nuxt; do node benchmarks/compare/prod.mjs $fw --runs 5 --isr; done
node benchmarks/compare/prod.mjs nowaki --runs 5 --label nowaki+csp --env NOWAKI_CSP=enforce
```

`gen.mjs` can also be run on its own to read the generated code:
`node benchmarks/compare/gen.mjs next --pages 10 --islands 2 --mode static` (the sources are not
committed; only each app's `package.json`, `pnpm-workspace.yaml` and lockfile are).

The browser step needs Chromium: `CHROME=/path/to/chrome`, or a Playwright headless shell.
`COMPARE_RESULTS=<dir>` writes results somewhere else (for trial runs).
