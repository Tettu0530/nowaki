# Public API surface snapshots

These files list what Nowaki promises to keep working across minor and patch releases.
`scripts/api-surface.mjs` generates them from the source, and CI fails when the
source and the files disagree, so every change to the public surface shows up as a
diff of this directory in review. How to update them: [CONTRIBUTING.md § API
snapshots](../CONTRIBUTING.md#api-snapshots).

| File | What it covers | Generated from |
| --- | --- | --- |
| `runtime.d.ts.txt` | `@nowaki-dev/runtime`: every declaration of each `exports` subpath (`.`, `./navigation`, `./content`, `./image`, `./env`, `./env/server`, `./session`), JSDoc stripped, interface members one per line | the `.d.ts` files, read with the TypeScript compiler API |
| `markdoc.d.ts.txt` | `@nowaki-dev/markdoc` (`.`, `./render`) | `packages/nowaki-markdoc/*.d.ts` |
| `template-types.d.ts.txt` | the ambient types every scaffolded app gets (`nowaki-env.d.ts`, `nowaki-jsx.d.ts`) | `packages/create-nowaki/templates/_shared` |
| `route-exports.txt` | route and island module exports the runtime reads, with their types, and the `client:*` directives | `mod.<name>` reads in `server/*.mjs`, AST reads in `nowaki-core` |
| `files.txt` | file conventions: `routes/` names and segments, `islands/`, `content/`, `public/`, `env.ts`, `session.ts`, `nowaki.config.*`, `.env` files | probes in `router.mjs`, `segments.mjs`, `nowaki-core`, the CLI |
| `config.txt` | `nowaki.config` keys, nested keys, font keys, plugin hooks | `site-config.mjs`, `plugin-host.mjs`, `fonts.rs` |
| `cli.txt` | `nowaki` commands, flags, defaults and possible values | clap, in a unit test in `crates/nowaki/src/main.rs` |
| `create-nowaki.txt` | `create-nowaki` flags and templates | `packages/create-nowaki/index.js` |
| `env.txt` | environment variables | every `NOWAKI_*` / `OTEL_*` / `CLOUDFLARE_*` name and `process.env` / `env::var` read |
| `http.txt` | `/__nowaki/*` endpoints, dev paths, the `/_nowaki/` prefix, `x-nowaki-*` headers, cookies | string scan of the CLI and runtime |
| `client.txt` | `nowaki:*` DOM events, `data-live*` / `data-nowaki-*` attributes | string scan of `packages/nowaki-runtime/client` |

## Format

```
# a comment
[stable ./navigation]
export function href(path: string, options?: HrefOptions): string;
NOWAKI_SITE  # text after two spaces and "# " is a comment
```

- `[status]` or `[status title]` starts a section. Only `[stable ...]` sections are
  covered by semver. The others are `[dev]` (dev server only), `[internal]` (may
  change in any release), `[external]` (standard names Nowaki reads but doesn't own)
  and `[ignored]` (scan matches that aren't this kind of surface).
- One entry per line. An entry's identity is its section header plus its text without
  the trailing comment, so rewording a comment never counts as a change.
- In `env.txt`, `http.txt`, `client.txt` and `route-exports.txt` the scan finds the
  names and a person decides their section. A new name lands in `[unclassified]` and
  the check fails until it is moved. The rest of the entry text (a type, a short
  description) is kept as written; the comment after it is regenerated.

## Not covered

These are internal even though they can be seen from outside, and are not listed in a
stable section: the runtime's `./client/*` and `./server/*` files (imported by the
code the CLI generates), wire protocols (`/__nowaki/fn`, `/__nowaki/live` and the other
internal endpoints, the `x-nowaki-*` request headers), generated markup
(`<nowaki-island>`, `<nowaki-live>`, `data-nowaki-*` attributes not listed as
stable), `window.__nowaki*` globals, the dev MCP tools and the dev toolbar UI, the text
of CLI output, and the `nowaki-core` crate (the CLI's engine, on its own 0.x line).
