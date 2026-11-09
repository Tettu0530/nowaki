# Benchmarks

Honest, reproducible numbers — measured with the **release** binary on the apps
in this repo. Two harnesses: `bench.mjs` (Nowaki's own numbers) and
`head-to-head.mjs` (a like-for-like comparison against Next.js and Astro on the
same app). We measure what's actually installed and never fabricate a number.

Reproduce:

```bash
cargo build --release -p nowaki
git clone https://github.com/Tettu0530/nowaki-site ../nowaki-site && (cd ../nowaki-site && pnpm install)
node benchmarks/bench.mjs ../nowaki-site  # a clean content-first app
node benchmarks/bench.mjs examples/hello  # a kitchen-sink app
node benchmarks/head-to-head.mjs          # Nowaki vs Next vs Astro (same counter app)
```

## Five frameworks at several sizes

[`benchmarks/compare`](./benchmarks/compare/README.md) builds the same blog in Nowaki, Astro,
SvelteKit, Next.js and Nuxt at 1–1000 pages and 1–10 islands, and reports each framework's fixed
cost and its cost per page and per island: dev first response, static and server builds, and
first-load JS / total transfer in the browser. The static comparison times `nowaki prerender`,
since `nowaki build` alone writes no HTML.

First-load JS is what a page fetches when it is opened, without touching it. Since 0.17, Nowaki
loads its client router when a link is hovered or touched, not when the page goes idle, so the
router (about 3 KB gzip) is no longer part of that figure; with 0.17.3 Nowaki's `/` is 8.67 KB
against Astro's 9.90 KB (10 pages, 1 counter island plus the theme toggle).

## Head-to-head: Nowaki vs Next.js vs Astro

> **Known issues with this table.** Its build column times `nowaki build`, which writes no
> HTML, against Astro and Next.js builds that prerender `/`; with prerendering, Nowaki's build of
> this app takes about 200 ms, not 20 ms. Its first-load JS for Astro sums every `.js` file in
> the output, including a Preact signals chunk the page never loads, and leaves out inline
> scripts. Measured in the browser, Astro ships less JavaScript than Nowaki. Use
> [`benchmarks/compare`](./benchmarks/compare/README.md) for the comparison; this table stays
> because the weekly job still prints it.

The same minimal app — one server-rendered page with a single interactive
counter island (Preact for Nowaki *and* Astro, so the UI library is equal) —
built and booted on one machine. Versions: Next.js 16.4, Astro 7.4, Nowaki at
the commit measured.

| framework | dev ready (cold) | production build | first-load JS (raw) | first-load JS (gzip) |
|---|---|---|---|---|
| **Nowaki** | **82 ms** | **20 ms** | **20.3 KB** | **9.1 KB** |
| Astro | 1119 ms | 721 ms | 24.1 KB | 10.4 KB |
| Next.js | 261 ms | 2087 ms | 446.7 KB | 132.0 KB |

*First-load JS* is the JavaScript `/` fetches on load, measured the same way for
all three: Nowaki's eager chunks (its idle-loaded SPA router is excluded, as in
the CI size gate), Astro's island JS, and the `<script src>` chunks in Next's
prerendered `/` (`noModule` polyfills excluded). *gzip* is what's transferred.

Reading it: Nowaki builds ~35× faster than Astro and ~100× faster than Next,
starts dev ~3× faster than Next and ~14× faster than Astro, and ships about
the same small client payload as Astro (both are islands frameworks) — roughly
**14× less than Next's app-router baseline** (gzip). The apps live in
`benchmarks/apps/{nowaki,next,astro}-counter`; install the peers and re-run
`head-to-head.mjs` to reproduce on your machine.

> The numbers move run-to-run and machine-to-machine; the *orders of magnitude*
> are the point, not the third digit. The harness skips any framework whose
> toolchain isn't installed rather than guessing.

A CI job (`bench-regression`) also gates the deterministic part — the gzipped
client JS of `nowaki-counter` — against `benchmarks/baseline.json`, failing the
build if a change inflates the bundle by more than 12 %.

Timings get a separate CI job, the performance regression gate (`perf`,
[`benchmarks/ci-perf.mjs`](./benchmarks/ci-perf.mjs)). It runs on pull requests
that touch `crates/` or the runtime, and builds three binaries in one job: the PR
(head), its base, and the latest `v*` release tag reachable from base. Each side
is measured in alternating rounds on the same runner (3 rounds; 3 more if
anything is over the limit). Every side measures the same fixed app,
`benchmarks/ci-perf-app` from the PR, with its own binary and runtime;
`examples/hello` is not used because it grows with e2e coverage. The metrics are
`nowaki build` time, `nowaki dev` startup, and `nowaki start` req/s and TTFB on
two pages: a plain `/about` and `/posts/[slug]`. The second page has nested
layouts, a loader, page `meta`, and layout and route CSS, so per-request work in
the runtime shows up there. The app sticks to features that every release it is
compared with supports. Head fails against base beyond −15% req/s,
+25% TTFB or +25% build/dev time. Against the release, the limits are −10% req/s
and +20% TTFB, so a series of small regressions that each pass against base
still fails before the next release. Run it locally with
`node benchmarks/ci-perf.mjs --base <checkout> --head <checkout> --release <checkout>`.

## [nowaki.dev](https://github.com/Tettu0530/nowaki-site) — 2 pages, no plugins (typical content-first app)

| metric | value |
|---|---|
| dev server ready (cold) | ~70 ms |
| dev server ready (warm cache) | ~90 ms |
| production build | ~15 ms |
| shipped client JS (gzip, per file) | ~14 KB |
| first response after start (`nowaki start`, `/`, one cold request) | ~50 ms |

This is the number behind the landing page's "dev ready in about 90 ms": a real
content app boots in well under 100 ms.

## `examples/hello` — kitchen sink (many islands, `.tsrx`, a config plugin, a Jetstream island)

| metric | value |
|---|---|
| dev server ready (cold) | ~670 ms |
| dev server ready (warm cache) | ~160 ms |
| production build | ~130 ms |
| shipped client JS (gzip, per file) | ~18 KB |
| first response after start (`nowaki start`, `/`, one cold request) | ~45 ms |

The kitchen-sink app is slower to boot because it also starts the Node **plugin
host** (it has a config plugin and `.tsrx` islands compiled by `@tsrx/preact`).
That overhead only applies to apps that use plugins or TSRX — a plain app pays
none of it (see the nowaki.dev site above).

## Production servers — TTFB and throughput

From [`benchmarks/compare`](./benchmarks/compare/README.md#production-servers) (`prod.mjs`): the
100-page blog's server build on each framework's own Node server, one process each, 5 runs
(fresh server, 3 s warm-up at the measured load). The blog has a nav, global CSS and a
theme-toggle island on every page, a search island, a sortable-table island, a validated form
and a JSON API route (see the compare README). TTFB is 300 sequential GETs of post pages over one
keep-alive connection; req/s is `oha` with 50 connections for 10 s. Pages are rendered per
request unless the row says ISR.

| server | TTFB p50 | TTFB p99 | post pages req/s | `/` req/s | `/api/search` req/s | idle RSS |
|---|---|---|---|---|---|---|
| **Nowaki 0.17.3** | **0.22 ms** | **0.99 ms** | **9,615** | **16,153** | **29,534** | 301 MB |
| Nowaki 0.17.3, `NOWAKI_CSP=enforce` | 0.20 ms | 0.69 ms | 9,933 | 16,685 | 29,542 | 299 MB |
| SvelteKit 3.1.1 | 0.23 ms | 0.91 ms | 6,348 | 4,623 | 20,963 | 333 MB |
| Astro 7.4.5 | 0.31 ms | 1.39 ms | 5,390 | 7,176 | 13,346 | 343 MB |
| Nuxt 4.6.4 | 0.65 ms | 4.93 ms | 1,877 | 2,055 | 30,937 | 335 MB |
| Next.js 16.4.5 | 1.07 ms | 2.85 ms | 1,118 | 1,256 | 6,597 | 435 MB |
| Nowaki 0.17.3, ISR on post pages | 0.08 ms | 0.25 ms | 137,011 | 15,903 ¹ | 31,135 ¹ | 128 MB |
| Nuxt 4.6.4, ISR (`swr`) | 0.11 ms | 0.32 ms | 18,239 | 2,114 ¹ | 32,883 ¹ | 272 MB |
| Next.js 16.4.5, ISR | 0.29 ms | 1.15 ms | 5,026 | 1,322 ¹ | 6,758 ¹ | 396 MB |

¹ `/` and `/api/search` are rendered per request in the ISR runs too; only post pages are cached.

Measured on an Apple M2, Node 24.14.0, `oha` 1.16.0 on the same machine (above roughly 100k
req/s the figure is likely bounded by `oha` and loopback): Nowaki 0.17.3 / runtime 0.16.3 from npm
on 2026-11-09, the other frameworks on 2026-11-08.

**A regression in 0.17.0–0.17.2, fixed in 0.17.3.** Uncached post pages fell from about 10,000
req/s to about 8,300, measured back to back on this blog (`oha -c 50`, 3 interleaved rounds, one
run per pairing per round):

| CLI / runtime | post pages req/s | note |
|---|---|---|
| 0.16.3 / 0.15.3 | 9,988–10,284 | |
| 0.17.0 / 0.16.0 | 8,093–8,290 | |
| 0.17.1 / 0.16.1 | 8,113–8,433 | |
| 0.17.2 / 0.16.2 | 8,410–8,448 | |
| 0.17.2 / **0.15.3** | 10,208–10,350 | new CLI, old runtime: fast |
| 0.16.3 / **0.16.2** | 8,386–9,043 | old CLI, new runtime: slow |

So it came with runtime 0.16.0: from then on, each request rebuilt the page's layout chain,
module URLs and asset lookups. #162 computes them once per file; 0.17.3 (runtime 0.16.3) serves
9,615 post pages/s and 16,153 for `/`, back at 0.16.1's 9,830 and 16,746.

On the earlier, counters-only blog, Nowaki 0.15.0 served 4,183 post pages/s at a TTFB p50 of
0.41 ms and 0.16.0 served 10,424 at 0.20 ms; 0.16.0 includes #101, which stopped calling
`import()` on every request (a CPU profile had put 52% of the time in the ESM loader hooks).
Full tables, ISR details and raw runs: `benchmarks/compare/results/`.

## Jetstream fan-out — 1000 connections

How long one change on the server takes to reach every subscribed connection, on
`nowaki start` (the adapters run Jetstream over POST and have no push).
[`benchmarks/live-fanout.mjs`](./benchmarks/live-fanout.mjs) opens 1000 WebSocket connections
to `examples/hello`, joins each one, then repeats one change 50 times (after 3 warm-up rounds):

- **live query:** every connection joins `LiveTicks` (`live.subscribe: ["ticks"]`); one
  `POST /api/tick` (which calls `publish("ticks")`) → each connection's first patch.
- **rooms:** every connection joins `LivePoll` on `/poll` (room `poll:demo`); connection 0
  votes → the first patch on each of the other 999.

t0 is taken just before the change is sent. Every patch in a round must carry the same new
value (`ticks: N`, `a: N`), so a late patch from an earlier round is never counted.
*Delivery* is the latency of each single patch, all rounds pooled; *everyone* is, per round,
the latency of the last patch. The table is the median of 3 sets (server restarted for each):

| scenario | receivers | delivery p50 | **delivery p95** | delivery p99 | everyone p50 | everyone p95 | missed |
|---|---|---|---|---|---|---|---|
| live query (`publish`) | 1000 | 18.7 ms | **29.9 ms** | 32.8 ms | 27.8 ms | 33.4 ms | 0 |
| rooms (`vote`) | 999 | 18.7 ms | **30.1 ms** | 33.9 ms | 26.7 ms | 34.1 ms | 0 |

Measured 2026-11-05 on an Apple M2 (8 cores, 16 GB), macOS 26 (darwin 25.6.0), Node 24.14.0,
Nowaki 0.16.1 built from the `v0.16.1` tag (`5f71061`, `cargo build --release`); 150 rounds
and 149,850+ deliveries per scenario, none missed. 0.16.0 (`dffe887`) gave a delivery p95 of
27.0 / 29.5 ms on the same benchmark, within the spread of the sets. Raw sets (each row tagged
with its Nowaki version and commit): `benchmarks/results/live-fanout.jsonl`.

The same benchmark on 0.15.0 (`0fba471`, 2026-11-04) gave a delivery p95 of 63.2 ms (live query)
and 67.5 ms (rooms), everyone p50 59.5 / 65.7 ms. In 0.15.0 each session sent its own render
to the Node renderer on every publish, so 1000 renders ran one after another (#97); 0.16.0
renders once per publish (#114).

The client is one Node process on the same machine, so the time it takes to handle 1000
messages is part of each number.

Reproduce (raise the file-descriptor limit in both shells; macOS defaults to 256):

```bash
cargo build --release -p nowaki
ulimit -n 8192
./target/release/nowaki build examples/hello
./target/release/nowaki start examples/hello --port 8250 &
node benchmarks/live-fanout.mjs http://127.0.0.1:8250 --conns 1000 --rounds 50 --scenario both
```

## Docs site — Nowaki vs Astro

[`benchmarks/docs-site`](./benchmarks/docs-site/README.md) builds the same docs site in both:
a typed content collection of Markdown and MDX entries (every 5th is MDX and renders a
`<Callout>`), three highlighted code fences per entry, one of four local photos per entry
(1600×1000 JPEG, about 250 KB each), a generated sitemap, and static output. Nowaki uses only
its built-ins (a hand-written Standard Schema, no third-party Markdown or image code); Astro
uses `@astrojs/mdx`, `@astrojs/sitemap`, `astro:assets` (`image.layout: "constrained"`) and
Shiki. *Cold* deletes the output and every framework cache first; *warm* keeps the caches and
deletes only the output. Median [p25–p75] of 5 runs after a warm-up:

| entries | Nowaki cold | Nowaki warm | Astro cold | Astro warm |
|---|---|---|---|---|
| 20 | 2,295 [2,285–2,307] ms | **239** [235–243] ms | **1,618** [1,616–1,620] ms | 1,004 [1,002–1,010] ms |
| 100 | 4,032 [3,915–4,848] ms | **312** [306–317] ms | **1,860** [1,855–1,881] ms | 1,157 [1,155–1,181] ms |
| 500 | 6,005 [5,626–6,553] ms | **502** [493–503] ms | **2,847** [2,842–2,848] ms | 1,852 [1,845–1,857] ms |

Without a cache Nowaki is slower: AVIF takes much longer to encode than WebP, and Nowaki uses no
C codecs, so it cannot use sharp / libwebp. With its cache it is faster at every size (3.7–4.2×).

The first measurement of this benchmark (`1fcc2ae`) had a higher cost per entry: the warm build
at 500 entries took 2,603 ms (now 502 ms), and the cold medians fit 11.1 ms per entry (4.8 ms
on `70f9e0a`, 6.8 ms on 0.17.2, where the cold runs at 100 and 500 entries spread widely;
Astro 2.5 ms). The cause was that every Markdown image reference decoded the whole JPEG
to read its size, so the four photos were decoded 500 times; #146 reads the size from the file
header and processes each image once per build (#147 fixed a deadlock in that change).

| output (100 entries) | Nowaki | Astro |
|---|---|---|
| images | 966 KB: AVIF 54 KB (16 files) + JPEG fallback 912 KB (16 files); `<picture>`, 4 widths | 297 KB: WebP (48 files); `<img srcset>`, 6 widths |
| HTML (all pages) | 838 KB | 912 KB |
| CSS / JS files | 1.4 KB / 22.8 KB ¹ | 0 / 0 (CSS inlined) |
| sitemap URLs | 102 | 102 |
| first-load JS: Markdown entry / MDX entry / `/docs/` | 0 / 0 / 0 KB | 0 / 0 / 0 KB |

¹ Includes chunks no page loads (the client router and island runtime are emitted even when no
page has an island).

Browsers that take AVIF get the 54 KB set; the JPEG files are the fallback for the rest. Astro
inlines its small CSS into each page (`<style>`), so it has no CSS file. Measured 2026-11-08
(UTC) on an Apple M2, Node 24.14.0: Nowaki 0.17.2 built from the `v0.17.2` tag (`30e087c`),
Astro 7.4.5. 0.17.3 changed only the runtime's request path, not the build. Raw runs:
`benchmarks/docs-site/results/`.

## Methodology

- **Machine/run dependent.** Numbers are representative of one machine; treat
  them as orders of magnitude, not guarantees. Re-run locally for your setup.
- **dev server ready** = wall time from spawning `nowaki dev` to the
  `dev server ready` line on stdout. *cold* clears `node_modules/.cache/nowaki`
  first; *warm* is the second run (persistent disk cache hot).
- **production build** = wall time of `nowaki build` (cold cache).
- **shipped client JS** = sum of the gzipped size of each `dist/client/*.js`
  chunk (i.e. bytes actually transferred per file). This is more conservative
  than gzipping all chunks as one stream; the landing page quotes the combined
  figure, which is ~1–2 KB smaller.
- **TTFB** = time to the first byte of `GET /` from `nowaki start` (the Rust
  front), after the server reports ready.
