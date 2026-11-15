# Dev experience: HMR, the toolbar, MCP and upgrades

`nowaki dev` serves the app with on-demand transforms, keeps island state across edits, shows a
toolbar with what serves the page on screen, and exposes the same data to coding agents over
MCP. `nowaki upgrade` moves an app to a new release and lists what must change first.

## `nowaki dev`

```sh
npx nowaki dev                 # http://localhost:3000
npx nowaki dev --port 4000     # or PORT=4000
npx nowaki dev --open          # open the browser
npx nowaki dev my-app --host   # listen on every interface (directory first)
```

- It listens on `127.0.0.1:3000` by default. `--port` wins over `PORT`; `--host [addr]` wins over
  `NOWAKI_HOST`. `--host` alone means all interfaces (`0.0.0.0`). Put the app directory before
  `--host`: a word right after it is read as the address.
- Under `--host`, the dev server answers IP addresses, `localhost`, `*.localhost` and `*.local`
  names. To open it through another name (a tunnel, an `/etc/hosts` alias), list it in
  `NOWAKI_DEV_ALLOWED_HOSTS` (comma-separated, `*` for any).
- nowaki.config, `env.ts`, `.env` and `.env.local` are read at startup; after a change it prints
  `[nowaki] <file> changed; restart nowaki dev to apply it`.
- A render error shows an error page with the stack; it reloads once the file is fixed.
- `nowaki dev` is a development tool, not a production server. Use `nowaki start` or an adapter.

## HMR and Fast Refresh

- **Islands** keep their state: editing an island, or a module only islands import, swaps the
  components in place. Hook state survives; adding or removing a hook remounts that component.
  Only the edited modules and their importers up to the island reload, so shared stores keep one
  instance.
- **Live islands** are re-rendered on the server with the state they hold.
- **Routes, layouts and server-only modules** (`lib/db.ts` imported only by routes): the page is
  re-rendered and morphed in place. Text, the head (route CSS, `head`) and `<html>` / `<body>`
  attributes update; islands whose props didn't change keep their element and state; the scroll
  position stays. An open intercepting-route modal stays open.
- **CSS** updates without a reload: island stylesheets in place, linked route and layout
  stylesheets once the new one has loaded. A CSS Module whose class names changed re-imports its
  islands.
- A response that isn't a 200 page (a syntax error shows the error page) falls back to a reload.
- `nowaki:hmr` is dispatched after each update.

HMR is dev-only; builds contain none of it. On Windows, an edit to a module an island imports
reloads the page instead of updating the island in place.

## Dev toolbar

Pages served by `nowaki dev` get a collapsible toolbar in the bottom-left corner, in a Shadow
DOM root. It shows, for the page on screen:

- the matched route file, its layouts and middleware,
- the Server-Timing of the last load (also after a client navigation or an HMR update),
- the islands, with their kind (client or live), hydration state and strategy, size, and the
  "could be live" hint,
- the first-load JS against the page's `budget` (a dev estimate, next to the last `nowaki build`
  figure when `dist/` has one),
- ISR settings (`revalidate`, `tags`) and the revalidate calls made in dev,
- Jetstream connections and rooms,
- recent errors, with links that open the file in your editor.

Editor links follow `NOWAKI_EDITOR`: `vscode` (default), `cursor`, `zed`, `windsurf`, `idea`, or a
URL template with `{file}`, `{line}` and `{column}`. The server never starts an editor itself.

Turn the toolbar off with `nowaki dev --no-toolbar` or `NOWAKI_TOOLBAR=0`, or per browser with
its close button. It works under `NOWAKI_CSP=enforce`. From another machine under `--host`, its
data endpoint answers 403 and the toolbar hides itself.

## MCP for coding agents

While `nowaki dev` runs, `http://127.0.0.1:3000/__nowaki/mcp` is a read-only MCP endpoint
(Streamable HTTP). Add it to an agent, for example Claude Code:

```sh
claude mcp add --transport http nowaki http://127.0.0.1:3000/__nowaki/mcp
```

| Tool | Returns |
| --- | --- |
| `routes` | the route table and the island registry |
| `module_graph` | a module's imports and importers |
| `recent_errors` | the latest dev errors, with stacks |
| `dev_config` | the dev server's settings, and the recent revalidate calls |
| `page` | what serves a URL: route, layouts, middleware, islands with sizes and hints, first-load JS, ISR settings |
| `live` | Jetstream connections, the cap, rooms with member counts |

The endpoint answers only loopback clients (a loopback peer, `Host` and `Origin`), also under
`--host`, and only `nowaki dev` serves it. Tool names are kept within a major on a best-effort
basis; the endpoint is not covered by semver.

## Types

`nowaki dev` and `nowaki build` write `.nowaki/types.d.ts`: the routes (for `<Link>` and
`route()`), the content collections and the `env.ts` variables. `nowaki typegen` writes it on
demand, for a type-check in CI before a build:

```sh
npx nowaki typegen && npx tsc --noEmit
```

The scaffold's `tsconfig.json` includes it, with `nowaki-env.d.ts` (asset, `?image` and
`import.meta.env` types) and `nowaki-jsx.d.ts` (the `client:*` directives).

## Upgrading: `nowaki upgrade`

```sh
npx nowaki upgrade                    # to the latest release
npx nowaki upgrade --to 1.0.0         # to a version, or a dist-tag (--to next)
npx nowaki upgrade --to 1.0.0 --check # only print the readiness report
```

`nowaki upgrade` updates the `nowaki` CLI and `@nowaki-dev/runtime` together (they must have the
same version). For a target on a newer major (on 0.x, a newer minor), it first prints a
readiness report: what in the app must change, with `file:line` and the fix, and heuristics to
review. While something must change, it installs nothing. `--check` only prints the report and
exits with 1 when something must change, which suits CI.

The report covers, among others: `_error.*` route files, `export const middleware`,
`export const config` in nowaki.config, lowercase API method exports, unknown top-level config
keys, `--host <dir>` in package.json scripts, a CLI / runtime version mismatch, a Node older than
22, and, as things to review, `ctx.formData()` used as `URLSearchParams`, API routes that may
need `csrf = false`, and `PORT` set in the shell or a `.env` file.

`nowaki upgrade` doesn't copy template files (`nowaki-env.d.ts`, `nowaki-jsx.d.ts`); compare
them with a fresh `npm create nowaki` app. The upgrade guide is
[docs/upgrade-to-1.0.md](../upgrade-to-1.0.md).

## Reference

- [CLI](../reference/cli.md) (`dev`, `typegen`, `upgrade` and their flags)
- [Environment variables](../reference/env-vars.md) (`NOWAKI_TOOLBAR`, `NOWAKI_EDITOR`,
  `NOWAKI_HINTS`, `NOWAKI_DEV_ALLOWED_HOSTS`, `NOWAKI_IMAGES_REFRESH`)
