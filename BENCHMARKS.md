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
| TTFB (`nowaki start`, `/`) | ~50 ms |

This is the number behind the landing page's "dev ready in about 90 ms": a real
content app boots in well under 100 ms.

## `examples/hello` — kitchen sink (many islands, `.tsrx`, a config plugin, a Jetstream island)

| metric | value |
|---|---|
| dev server ready (cold) | ~670 ms |
| dev server ready (warm cache) | ~160 ms |
| production build | ~130 ms |
| shipped client JS (gzip, per file) | ~18 KB |
| TTFB (`nowaki start`, `/`) | ~45 ms |

The kitchen-sink app is slower to boot because it also starts the Node **plugin
host** (it has a config plugin and `.tsrx` islands compiled by `@tsrx/preact`).
That overhead only applies to apps that use plugins or TSRX — a plain app pays
none of it (see the nowaki.dev site above).

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
| live query (`publish`) | 1000 | 34.3 ms | **63.2 ms** | 72.7 ms | 59.5 ms | 76.3 ms | 0 |
| rooms (`vote`) | 999 | 37.6 ms | **67.5 ms** | 73.6 ms | 65.7 ms | 77.4 ms | 0 |

Measured 2026-11-04 on an Apple M2 (8 cores, 16 GB), macOS 26 (darwin 25.6.0), Node 24.14.0,
Nowaki 0.15.0 built from `main` at `0fba471` (`cargo build --release`); 150 rounds and
149,850+ deliveries per scenario, none missed. Raw sets: `benchmarks/results/live-fanout.jsonl`.

The client is one Node process on the same machine, so the time it takes to handle 1000
messages is part of each number. Deliveries spread evenly from ~0 to ~65 ms, which looks like
the patches are rendered or sent one connection after another; rooms (one shared state) take
as long as the live query, so a render per shared state rather than per connection may be
the next thing to look at.

Reproduce (raise the file-descriptor limit in both shells; macOS defaults to 256):

```bash
cargo build --release -p nowaki
ulimit -n 8192
./target/release/nowaki build examples/hello
./target/release/nowaki start examples/hello --port 8250 &
node benchmarks/live-fanout.mjs http://127.0.0.1:8250 --conns 1000 --rounds 50 --scenario both
```

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
