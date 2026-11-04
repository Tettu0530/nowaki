# nowaki

The Nowaki CLI: a Rust-powered bundler, dev server, and static-site generator for the [Nowaki](https://nowaki.dev) web framework.

This package ships a small Node wrapper that runs a prebuilt native binary for your platform. No Rust toolchain required.

## Install

Per project (recommended):

```bash
npm install --save-dev nowaki
# or: pnpm add -D nowaki
```

Globally:

```bash
npm install -g nowaki
nowaki --version
```

## Usage

```bash
nowaki dev [dir]          # Dev server (HMR + Islands hydration)
nowaki build [dir]        # Production build (client + server)
nowaki start [dir]        # Serve the built app
nowaki prerender [dir]    # Static site generation (SSG)
```

Scaffold a new app with `npm create nowaki@latest my-app`.

### MCP for coding agents

While `nowaki dev` runs, it serves a read-only [MCP](https://modelcontextprotocol.io)
endpoint at `http://127.0.0.1:<port>/__nowaki/mcp`; the startup banner prints it.
Add it to Claude Code with:

```bash
claude mcp add --transport http nowaki http://127.0.0.1:3000/__nowaki/mcp
```

Tools:

- `routes`: the route table in match order (pattern, file, page/API, exports such as `revalidate` and `csrf`), plus layouts, middleware, and boundaries
- `module_graph`: what a file imports and which files import it, and the islands with their `live` flag
- `recent_errors`: the last 50 build, SSR, live, and HMR errors, with time, file, and stack
- `dev_config`: port, `--host`, plugins, `NOWAKI_*` flags, and Jetstream connections and rooms

The endpoint answers only requests from this machine (loopback peer, `Host`, and
`Origin`), even with `--host`. `nowaki start` and the deploy adapters don't serve it.

## How it works

The native binary is distributed as platform-specific optional dependencies
(`@nowaki-dev/cli-darwin-arm64`, `@nowaki-dev/cli-linux-x64-gnu`, …). npm/pnpm
installs only the one matching your `os`/`cpu`/`libc`, and this wrapper resolves
and executes it. There is no `postinstall` step, so it works with
`--ignore-scripts` too.

Prefer building from source? `cargo install nowaki` also works.

## License

MIT
