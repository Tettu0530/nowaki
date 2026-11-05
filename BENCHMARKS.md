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
| **Nowaki 0.16.1** | **0.20 ms** | **0.61 ms** | **9,830** | **16,746** | **32,910** | 299 MB |
| Nowaki 0.16.1, `NOWAKI_CSP=enforce` | 0.21 ms | 0.56 ms | 9,442 | 16,245 | 30,676 | 300 MB |
| SvelteKit 3.1.1 | 0.23 ms | 0.81 ms | 6,763 | 4,682 | 22,739 | 340 MB |
| Astro 7.4.5 | 0.30 ms | 1.02 ms | 5,395 | 7,065 | 14,091 | 341 MB |
| Nuxt 4.6.4 | 0.63 ms | 5.15 ms | 1,947 | 2,079 | 31,106 | 367 MB |
| Next.js 16.4.5 | 1.02 ms | 2.43 ms | 1,197 | 1,385 | 6,925 | 438 MB |
| Nowaki 0.16.1, ISR on post pages | 0.08 ms | 0.28 ms | 140,390 | 15,331 ¹ | 29,404 ¹ | 127 MB |
| Nuxt 4.6.4, ISR (`swr`) | 0.11 ms | 0.33 ms | 18,179 | 2,044 ¹ | 33,358 ¹ | 280 MB |
| Next.js 16.4.5, ISR | 0.29 ms | 1.22 ms | 4,824 | 1,245 ¹ | 6,665 ¹ | 375 MB |

¹ `/` and `/api/search` are rendered per request in the ISR runs too; only post pages are cached.

Measured 2026-11-05, Apple M2, Node 24.14.0, `oha` 1.16.0 on the same machine (above roughly
100k req/s the figure is likely bounded by `oha` and loopback). Nowaki is 0.16.1 / runtime 0.15.1
from npm. The Nowaki ISR row was measured again on its own: the first series had the uncached
`/` and `/api/search` about a third below the uncached run, which did not reproduce (the run
likely overlapped other load on the machine), and ISR does not change the uncached path.

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
| 20 | 2,096 [2,090–2,127] ms | **334** [324–360] ms | **1,671** [1,658–1,680] ms | 1,058 [1,039–1,132] ms |
| 100 | 5,217 [4,882–5,235] ms | **724** [723–730] ms | **1,965** [1,933–2,040] ms | 1,311 [1,235–1,516] ms |
| 500 | 8,232 [7,751–8,306] ms | 2,603 [2,602–2,635] ms | **3,284** [3,186–3,287] ms | **1,996** [1,965–2,013] ms |

Without a cache Nowaki is slower: AVIF takes much longer to encode than WebP, and Nowaki uses no
C codecs, so it cannot use sharp / libwebp. With its cache it is faster up to 100 entries, and
slower at 500. Its cost per entry is higher than Astro's (least squares over the cold medians:
11.1 ms per entry vs 3.3 ms). Taking caches away one at a time at 500 entries: without the
image cache the build takes about 3.8 s longer, without the highlight cache about 1.8 s longer
(1,500 code fences), and with both caches the build (bundling and content, before rendering any
page) already takes 2.4 s of the 2.7–3.0 s; the cause of that last part has not been measured.

| output (100 entries) | Nowaki | Astro |
|---|---|---|
| images | 966 KB: AVIF 54 KB (16 files) + JPEG fallback 912 KB (16 files); `<picture>`, 4 widths | 297 KB: WebP (48 files); `<img srcset>`, 6 widths |
| HTML (all pages) | 838 KB | 912 KB |
| CSS / JS files | 1.4 KB / 21.1 KB ¹ | 0 / 0 (CSS inlined) |
| sitemap URLs | 102 | 102 |
| first-load JS: Markdown entry / MDX entry / `/docs/` | 0 / 0 / 0 KB | 0 / 0 / 0 KB |

¹ Includes chunks no page loads (the client router and island runtime are emitted even when no
page has an island).

Browsers that take AVIF get the 54 KB set; the JPEG files are the fallback for the rest. Astro
inlines its small CSS into each page (`<style>`), so it has no CSS file. Measured 2026-11-05
(UTC) on an Apple M2, Node 24.14.0: Nowaki built from `main` at `1fcc2ae` (0.16.2 + #143),
Astro 7.4.5. Raw runs: `benchmarks/docs-site/results/`.

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
