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
nowaki upgrade [dir]      # Update nowaki + @nowaki-dev/runtime (--to <version>, --check)
```

`nowaki dev` and `nowaki start` listen on `--port`, else `PORT`, else 3000, and on
`--host <addr>`, else `NOWAKI_HOST`, else `127.0.0.1`. `--host` alone listens on all
interfaces (`0.0.0.0`). Put the directory before a bare `--host`
(`nowaki dev my-app --host`): a word right after it is read as the address.

`nowaki upgrade --to <version>` for a newer major (from 0.20.0 on) first prints a
read-only readiness report: what in the app must change (with `file:line` and the fix)
and heuristics to review. It installs nothing while something must change;
`--check` only prints the report (exit code 1 when something must change).

Scaffold a new app with `npm create nowaki@latest my-app`.

### Content collections

Each directory under `content/` is a collection of Markdown / MDX files (YAML frontmatter
between `---` lines, or TOML between `+++` lines) or JSON / YAML data files. Declare it with a
schema (any Standard Schema library):

```ts
// content/config.ts
import { defineCollection } from "@nowaki-dev/runtime/content";
import * as v from "valibot";

export const docs = defineCollection({ schema: v.object({ title: v.string(), order: v.number() }) });
```

```tsx
// routes/docs/[slug].tsx
import { getCollection, getEntry } from "@nowaki-dev/runtime/content";

export const staticPaths = async () => (await getCollection("docs")).map((d) => ({ slug: d.slug }));
export const loader = ({ params }) => getEntry("docs", params.slug);
```

An entry has `slug`, `file`, `data` (the validated frontmatter), and, for Markdown, `html`
(rendered at build time in Rust, with heading anchors) and `headings` (for a table of
contents). An entry that fails its schema fails the build with the file and field. Dates
arrive as strings, YAML and TOML alike (`2026-11-05`, `2026-11-05T10:00:00Z`); coerce them in
the schema if you want `Date`s.

```md
+++
title = "Hello"
date = 2026-11-05
tags = ["intro"]
+++

# Hello
```

TOML frontmatter starts only on a first line of exactly `+++`. Its values map like YAML's:
tables become objects and datetimes ISO 8601 strings (a space between date and time becomes
`T`). A TOML syntax error fails the build with the file and line (`content/blog/x.md:3: …`).

### First-load JS per route

`nowaki build` (and `nowaki prerender`) prints the gzip size of the JS each page route loads
first: the islands runtime and the islands the page can render, through its layouts and
components, plus the live runtime for live islands. The lazy SPA router chunk is not counted.
The same data goes to `dist/route-js.json`.

A route can set a budget in KB. The build **fails** when the route goes over it:

```tsx
export const budget = { js: 12 };   // at most 12 KB of gzip JS on first load
export const budget = { js: 0 };    // a content page: no client JS at all
```

The value must be a number literal. An unreadable `budget` fails the build instead of being
ignored.

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
and executes it. On Unix, the wrapper **replaces itself** with the native binary
(`process.execve`), so long-running commands like `nowaki start` do not keep an
extra Node process resident. Windows and older Node versions fall back to
`spawnSync`. There is no `postinstall` step, so it works with
`--ignore-scripts` too.

Prefer building from source? `cargo install nowaki` also works.

## License

MIT
