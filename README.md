<div align="center">

# Nowaki (野分)

A full-stack web framework built around a Rust toolchain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](./ROADMAP.md#where-we-are)

Zero client JS by default. The dev server is a Rust binary that starts instantly. Designed as an answer to the structural slowness of Next.js.

</div>

---

## What is Nowaki?

Nowaki (野分, an archaic Japanese word for a typhoon) is a full-stack framework designed from the ground up around the structural causes of Next.js's slowness. The bundler, transforms, and dev server are written in Rust on top of [oxc](https://oxc.rs), and rendering uses the Islands Architecture. A page's client JS is limited to its "islands".

| Next.js pain point | Nowaki's answer |
|---|---|
| `next dev` starts slowly | A Rust binary starts instantly and transforms on demand (about 90ms to start the example app) |
| HMR is heavy | oxc re-transforms a single file in milliseconds |
| Page JS bloats | With Islands, there is zero client JS outside the islands you mark explicitly |
| Builds are slow | oxc minifier plus a content-hash cache |

> [!WARNING]
> **Status: alpha.** The design is settling, but the API may change without notice. Production use is not yet recommended.

## Features

- An on-demand transform pipeline in Rust, built on oxc (parser / transformer / codegen / resolver).
- Islands Architecture: zero client JS by default; only components under `islands/` are hydrated.
- File-based routing and Remix-style `loader`s.
- Use the npm ecosystem as is. SSR is delegated to a Rust-managed Node sidecar (Preact).

## Quick start

You need Node.js 22+ and pnpm (npm and yarn work too). Rust is not required: the CLI fetches a prebuilt native binary from npm.

```bash
# Create a new app
npm create nowaki@latest my-app
cd my-app

pnpm install   # fetches the nowaki CLI (native binary) + runtime
pnpm dev       # → http://127.0.0.1:3000
```

A scaffolded app comes with these npm scripts:

```bash
pnpm dev         # Dev server (HMR + Islands)
pnpm build       # Production build (client + server)
pnpm start       # Serve the built app
pnpm prerender   # Static site generation (SSG)
```

To install the CLI directly, use `npm i -g nowaki`; to install from source, use `cargo install nowaki`.

<details>
<summary>Developing in this repository (for contributors)</summary>

Prerequisites: Rust (stable), Node.js >= 22, pnpm

```bash
git clone https://github.com/nowaki-dev/nowaki
cd nowaki
pnpm install
cargo build -p nowaki

# Start the dev server on the example app
./target/debug/nowaki dev examples/hello
# → http://127.0.0.1:3000

# Production build (client: content-hashed ESM + manifest / server: ESM for SSR)
./target/debug/nowaki build examples/hello
# → output in examples/hello/dist/{client,server}/

# Serve the built app in production mode
./target/debug/nowaki start examples/hello --port 3000
# → http://127.0.0.1:3000 (static serving + prod SSR, no HMR)
```

</details>

## What it looks like

```tsx
// routes/index.tsx — the loader runs only on the server
import Counter from "../islands/Counter.tsx";

export const loader = async () => {
  return { message: "Welcome to Nowaki" };
};

export default function Home({ data }) {
  return (
    <main>
      <h1>{data.message}</h1>
      <Counter start={5} />   {/* only this island is hydrated on the client */}
    </main>
  );
}
```

The page body and `loader` code never reach the browser. Only the JS for `islands/Counter.tsx` is shipped.

## Project layout

```
crates/nowaki-core       Bundler core (transform / resolve / cache)
crates/nowaki            CLI + dev server (axum) + HMR + sidecar management
packages/nowaki-runtime  @nowaki-dev/runtime (islands client / SSR sidecar / Node loader hooks)
examples/hello           Example app
```

See [DESIGN.md](./DESIGN.md) for design details and architecture diagrams, and [ROADMAP.md](./ROADMAP.md) for what's planned.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md). While Nowaki is in alpha, it's best to discuss your approach in an issue before writing code.

## License

[MIT](./LICENSE) © 2026 [VorEdge](https://voredge.com)

<sub>Built and maintained by VorEdge. "Nowaki" (野分) is an archaic Japanese word for a typhoon.</sub>
