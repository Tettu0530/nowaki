# Nowaki Design Document

> A blazing-fast full-stack web framework built around a Rust toolchain

## 0. Context: why build this

Next.js feels slow for structural reasons.

| Next.js problem | Cause | Nowaki's answer |
|---|---|---|
| `next dev` starts slowly | JS-based initialization, building a huge internal graph | Rust binary starts instantly, transforms on demand |
| HMR gets heavy | Graph recomputation and a JS plugin pipeline | Millisecond-scale single-file re-transform with oxc + invalidation only |
| Page JS bloats | Every component is hydrated | **Islands**: zero JS outside explicitly marked "islands" |
| Builds are slow | webpack compatibility layer, JS optimization passes | oxc minifier, rayon parallelism, content-hash cache |

**Performance targets (MVP baseline)**: dev startup < 300ms / HMR update < 100ms / client JS for a page with one counter < 15KB (gzip).

## 1. Settled design decisions

1. UI runtime: **Preact** (3KB, ships as ESM, React-compatible hooks). Because it ships as ESM, there is no CJS prebundle step in dev, which keeps the bundler simple.
2. Authoring syntax: `.tsx` (oxc-native, fastest path) + **TSRX** (`.tsrx`, Phase 2). TSRX is a statement-based JSX successor syntax by the author of Ripple. Its compiler (`@tsrx/core`) is written in JS, so we compile to a Preact target through a Node compile bridge and feed the result into the oxc pipeline. It is alpha for now, so it is not in the MVP; only the plug-in point (TransformBridge) is reserved.
3. Rendering model: **Islands Architecture** (Astro/Fresh style). Pages are rendered to HTML on the server, and only components under the `islands/` directory are hydrated on the client.
4. Bundler foundation: **the oxc crates** (oxc_parser / oxc_transformer / oxc_codegen / oxc_minifier / oxc_resolver). The module graph, HMR, cache, and chunking strategy are our own. That is the core of the "bundler work", the same setup as Turbopack being built on SWC.
5. SSR execution: **Node sidecar**. Rust handles asset serving, transforms, and HMR, and delegates component rendering to a Node worker that Rust manages. The npm ecosystem works as is.

## 2. Overall architecture

```
┌────────────────────────── nowaki dev (Rust binary) ───────────────────────────┐
│                                                                               │
│  axum HTTP server (:3000)                                                     │
│  ├─ GET /__nowaki/hmr ............ WebSocket (HMR client connection)          │
│  ├─ GET /__nowaki/ssr-module ..... SSR-transformed modules (Node loader hook) │
│  ├─ GET /@modules/* ............ node_modules ESM (resolver + transform)      │
│  ├─ GET /*.tsx, /*.ts .......... on-demand transform of project files         │
│  └─ GET /* (everything else) ... reverse proxy to Node sidecar (SSR HTML)     │
│                                                                               │
│  nowaki-core (lib)                                                            │
│  ├─ Transformer: oxc parse → TS strip + JSX(automatic, preact) → codegen      │
│  ├─ Resolver: oxc_resolver (bare import → real file → /@modules/ URL)         │
│  ├─ ModuleCache: DashMap<(path, mode), (content_hash, output)>                │
│  └─ Watcher: notify → invalidate + HMR broadcast + bump SSR version           │
│                                                                               │
│  Sidecar Manager: spawns/monitors/restarts the Node child process             │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ HTTP (127.0.0.1:ephemeral)
┌───────────────────────────────────▼───────────────────────────────────────────┐
│  Node sidecar (packages/nowaki-runtime/server)                                │
│  ├─ Route scan: routes/ → URL patterns (index/[slug]/api)                     │
│  ├─ Run loader → render page with preact-render-to-string                     │
│  ├─ Island detection: options.vnode hook wraps island components in markers   │
│  └─ Loader hook: .tsx/.ts get transformed JS from /__nowaki/ssr-module        │
└───────────────────────────────────────────────────────────────────────────────┘

Browser: SSR HTML + <script type="module" src="/@nowaki-dev/client.js">
         → scan markers → dynamic import island modules → hydrate(props)
```

### Repository layout

```
nowaki/
├── Cargo.toml                  # workspace
├── crates/
│   ├── nowaki-core/              # bundler core (transform / resolve / graph / cache)
│   └── nowaki/                   # CLI binary (dev / build / start) + dev server + sidecar management
├── packages/
│   └── nowaki-runtime/           # npm: @nowaki-dev/runtime
│       ├── client/             #   islands hydration + HMR client
│       └── server/             #   SSR sidecar + Node loader hooks
├── examples/
│   └── hello/                  #   sample app (for verification)
│       ├── routes/index.tsx
│       └── islands/Counter.tsx
└── DESIGN.md
```

## 3. Rust bundler (nowaki-core) design

### 3.1 Transform pipeline

```
read source → content_hash via xxhash → cache HIT? → return
                                   ↓ MISS
oxc_parser (TSX) → oxc_transformer { strip TS types, JSX automatic (importSource: "preact") }
                 → rewrite imports (browser mode only)
                 → oxc_codegen (+ inline sourcemap)
                 → store in cache → return
```

- Two modes: `mode=browser` rewrites bare imports (`preact`, etc.) to `/@modules/...` URLs. `mode=ssr` leaves imports untouched (Node resolution handles them). The cache key is `(absolute path, mode)`, and the value carries a `content_hash` to detect changes.
- Bare import resolution: oxc_resolver resolves to a real file, which maps to `/@modules/<pkg>/<path relative to entry>`. ESM files inside node_modules go through the same pipeline too (preact/hooks has an internal bare import of `preact`, so rewriting must be recursive).
- Parallelism: state lives in a `DashMap`. Each HTTP handler runs the oxc transform (CPU-bound) via `tokio::task::spawn_blocking`.

### 3.2 HMR (MVP → future)

- Protocol: WebSocket with JSON messages `{type: "hot", islands, modules}` / `{type: "css", files}` / `{type: "page"}` / `{type: "reload"}` / `{type: "error", message}`.
- MVP: notify detects a change → invalidate the affected cache entry + increment the global `ssr_version` → broadcast `reload` (a full reload; SSR is fast, so it feels fast enough). Transform errors send `error` for the overlay.
- v0.19 (implemented): `dev.rs` walks reverse import edges from each change up to the island entries. An island-only chain gets new hot versions (`?t=<n>` on just those import URLs) and a `hot` message; the browser re-imports the islands, and `client/refresh.js` (oxc's React Refresh transform + a hand-written runtime on the public Preact API, not prefresh) swaps components in place with their state. Stylesheets get `css`. A chain reaching `routes/` gets `page` (a reload until pages re-render in place).

### 3.3 Production build (`nowaki build`): staged strategy

- Phase 1 (MVP+, implemented, `crates/nowaki-core/src/build.rs`): walks the graph in post-order DFS from the entries (islands runtime + each island), transforms each module + codegen minify + rewrites import specifiers to content-hashed filenames, and emits to `dist/client/` (unbundled ESM emit). Shared dependencies (preact, etc.) are deduped by path. Generates `manifest.json` (runtime + island name → hashed name). Because the DFS is post-order, a parent is finalized only after its dependencies' hashes are, so each content hash matches the final content. On the server side, `build_server` transforms routes/ and islands/ in SSR mode (rewriting relative `.tsx` imports to `.js`) and emits to `dist/server/`. For serving, `nowaki start` (`packages/nowaki-runtime/server/start.mjs`) serves static files under `/_nowaki/`, does prod SSR with the built routes in `dist/server`, and wires islands to the correct hashed client files through the manifest. **Known remaining work**: circular dependencies currently error, `modulepreload` manifest output, omitting the runtime on pages without islands.
- Phase 3: true chunk bundling with scope hoisting (per-island entry chunks + shared chunks). Parallel chunk codegen with rayon.

## 4. Framework conventions (the user's view)

### Routing (file-based)

| File | URL |
|---|---|
| `routes/index.tsx` | `/` |
| `routes/about.tsx` | `/about` |
| `routes/blog/[slug].tsx` | `/blog/:slug` |
| `routes/api/hello.ts` | `/api/hello` (exports a handler function) |

Files starting with `_` do not become URLs; they are convention files with the following roles.

| File | Role |
|---|---|
| `_layout.tsx` | Wraps pages under its directory (nestable, receives `children`) |
| `_middleware.ts` | Pre-processes requests under its directory (nestable, returning a `Response` short-circuits) |
| `_404.tsx` | Page for unmatched routes (status 404) |
| `_500.tsx` / `_error.tsx` | Page for when a loader/render throws (receives `{ error }`, status 500) |

### Data loading (Remix-style loader)

```tsx
// routes/index.tsx — runs only on the server
export const loader = async (ctx: LoaderContext) => {
  return { message: "Hello", time: Date.now() };
};

export default function Home({ data }: PageProps<typeof loader>) {
  return <main>
    <h1>{data.message}</h1>
    <Counter start={5} />   {/* islands/Counter.tsx → only this hydrates */}
  </main>;
}
```

### LoaderContext and action

Loaders, actions, middleware, and API handlers all receive the same `LoaderContext`. It has the request side (`url`, `params`, `method`, `headers`, `cookies`, `formData()` — urlencoded or multipart (`FormData` with `File` parts), `bodyJson()`) and response writers (`status()`, `setHeader()`, `setCookie()`, `redirect()`, `json()`, `html()`, `text()`). Oversized `Content-Length` on multipart is rejected with **413** at the Rust front (dev/start) before the sidecar reads the body; otherwise limits are enforced while buffering in the runtime (handlers may still run briefly before a **413**/`RequestBodyError` is mapped).

```tsx
// routes/todos.tsx: action runs on non-GET requests (form submissions, etc.)
export const loader = (ctx) => ({ todos: readTodos(ctx) });
export async function action(ctx) {
  const form = await ctx.formData();
  ctx.setCookie("todos", add(form.get("text")));
  return ctx.redirect("/todos"); // PRG
}
```

Besides `default`, API routes can branch on per-method exports such as `GET` / `POST`, and can return a web `Response` (including streaming) directly.

### Rendering and the client router

A `handler.mjs` shared by dev and prod handles "route matching → middleware → action → loader → layout composition → render → 404/500". Only the environment-specific parts (module loading, island resolution, document assembly) are injected.

The client router ships with the islands runtime. On pages with islands, it intercepts internal `<a>` clicks, fetches the destination HTML, swaps `<body>`, and re-hydrates only the new islands (with prefetch, scroll restoration, and popstate support). Zero-JS pages keep plain full navigation. The DOM swap mechanism will be shared with the future Jetstream (server-reactive islands).

### Islands

- Only components under `islands/` have client JS. Page bodies and loader code are never sent to the browser.
- Detection happens at runtime: the sidecar scans `islands/` to build a registry of "component → island name", and Preact's `options.vnode` hook wraps islands being rendered in `<nowaki-island data-island data-props>`. No AST rewriting is needed on the Rust side, which keeps the MVP simple.
- Props must be JSON-serializable (stated explicitly as the boundary contract).

## 5. SSR sidecar design

- Rust launches `node .../server/sidecar.mjs --port 0` and gets the address from `NOWAKI_SIDECAR_READY <port>` on stdout. It restarts automatically on crash.
- Running TSX for SSR: Node alone cannot interpret JSX, so a `module.registerHooks` load hook fetches `.tsx/.ts` as transformed ESM from the Rust dev server's `/__nowaki/ssr-module?path=...&v=<ssr_version>` (the vite-node approach; the goal is a single transformer, in Rust).
- Re-evaluation on HMR: the ESM cache cannot be invalidated, so route modules are dynamically imported with `?v=<ssr_version>`, and the resolve hook propagates the same version to relative imports. Old versions lingering in memory during dev is accepted (the same tradeoff as Vite).
- In production, loader hooks are not used; the built `dist/server/` runs directly.

## 6. TSRX integration (Phase 2)

- Rust detects `.tsrx` files and delegates them to a Node compile worker (parse with `@tsrx/core` → codegen to a Preact target). The output TS/JSX feeds into the oxc pipeline. The content_hash cache means one JS compile per edit.
- The API is in flux while alpha, so it is isolated behind a `TransformBridge` trait (`fn compile(path, source) -> Result<String>`) to keep it loosely coupled from the core.

## 7. Roadmap

> See [ROADMAP.md](./ROADMAP.md) for the full version, milestone definitions, and launch checklist. This section summarizes the phases.

- Phase 1 (MVP): the full dev experience from §2–§5 of this document. `nowaki dev`, oxc transform, /@modules/, Islands SSR, loader, live-reload HMR, sample app
- Phase 1.5: `nowaki build` (client hashed ESM + manifest / server SSR ESM), `nowaki start` (static serving + prod SSR, manifest-driven island hydration), and `create-nowaki` scaffolding are implemented. Remaining: error overlay, omitting the runtime on pages without islands, modulepreload
- Phase 2: TSRX bridge, expanded API routes, middleware, environment variables
- Phase 3: chunk bundling (scope hoisting), prefresh partial HMR, persistent disk cache, client router (SPA navigation between island pages)
- Phase 4: Bun/Deno sidecar support, Edge runtime builds, RSC-style server functions (`"use server"` RPC)
- Phase 5 (Jetstream): server-reactive islands. The Rust server pushes server-data-driven updates as HTML patches without adding client JS (persistent channel + morph runtime). Written separately from client islands via `export const live` / `export const on`. Nowaki's differentiator: fusing LiveView/Hotwire with JSX islands + Rust. See v0.6 in [ROADMAP.md](./ROADMAP.md) for details

## 8. Key dependencies

- Rust: oxc (umbrella, features: transformer/codegen/minifier), oxc_resolver, axum, tokio, tower-http, notify, dashmap, clap, xxhash-rust, serde/serde_json
- npm: preact, preact-render-to-string (no devDependencies, to keep the runtime thin)
