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
