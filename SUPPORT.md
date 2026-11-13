# Support

## Getting help

- **Questions, ideas, "how do I ...":** [GitHub Discussions](https://github.com/Tettu0530/nowaki/discussions).
- **Bugs:** [GitHub Issues](https://github.com/Tettu0530/nowaki/issues/new/choose), with the
  output of `npx nowaki --version`, the `@nowaki-dev/runtime` version, the adapter, the OS and
  the Node version. Say whether it worked in an earlier release.
- **Security vulnerabilities:** report them privately, as described in
  [SECURITY.md](./SECURITY.md#reporting-a-vulnerability). Do not open a public issue.
- **The nowaki.dev website:** [Tettu0530/nowaki-site](https://github.com/Tettu0530/nowaki-site/issues).

Nowaki is maintained by volunteers ([MAINTAINERS.md](./MAINTAINERS.md)). There is no paid
support and no response-time guarantee beyond the security acknowledgement in SECURITY.md.

## Supported versions

| Release line | Bug fixes | Security fixes |
| --- | --- | --- |
| Latest 0.x release (0.19.3 today), until 1.0.0 | Yes | Yes |
| Older 0.x releases | No | No |
| From 1.0.0: the latest 1.y minor | Yes | Yes |
| Older 1.y minors | No: upgrade to the latest 1.y | No: upgrade to the latest 1.y |
| 1.x after 2.0.0 is released | No | Yes, for 6 months after 2.0.0 |
| `1.0.0-rc.N` release candidates | Until 1.0.0 | Until 1.0.0 |

- Fixes land on `main` and ship in the next release of the latest 1.y line. Minors do not
  break ([docs/STABILITY.md](./docs/STABILITY.md)), so older minors do not get backports.
- When 2.0.0 ships, 1.x keeps getting security fixes for 6 months, from a `release/1.x`
  branch. After that, 1.x is end-of-life.
- The same rules apply to `@nowaki-dev/markdoc` on its own version line.
- `main` is not a release; it gets every fix first.

## Platforms

Supported Node.js, Bun, Deno, Rust (MSRV), Preact, TypeScript and browser versions are listed
in [docs/STABILITY.md § Platforms](./docs/STABILITY.md#platforms). In short: Node LTS lines
that are not end-of-life (`>=22` today, tested on 22 and 24); an end-of-life Node line may be
dropped in a minor, announced one minor ahead.

## Deploy adapters

These `nowaki build --adapter` targets are supported, and CI builds and runs each one:

| Adapter | Output | Tested in CI |
| --- | --- | --- |
| `node` | `dist/server/index.mjs` | `scripts/ci/e2e-adapters.sh` |
| `static` | `dist/static` (`nowaki prerender`) | `scripts/ci/e2e-adapters.sh` |
| `bun` | `dist/server/index.mjs`, run with Bun | `scripts/ci/e2e-runtimes.sh bun` |
| `deno` | `dist/server/index.mjs`, run with Deno | `scripts/ci/e2e-runtimes.sh deno` |
| `cloudflare` | `dist/worker` (Wrangler) | `scripts/ci/e2e-runtimes.sh cloudflare` |
| `vercel` | `.vercel/output` (Build Output API v3) | `scripts/ci/e2e-adapters.sh` |

"Supported" means a bug in the adapter's output is fixed like any other bug, and the output
follows the deploy contract in [docs/STABILITY.md](./docs/STABILITY.md#what-is-frozen). It does
not cover the hosting platform itself (its limits, pricing or outages). Other hosts (Netlify,
for example) have no adapter; the `node` or `static` output may work there, but it is not
tested.

`nowaki dev` is a development tool and is not supported for serving production traffic. Use
`nowaki start` or an adapter's output.
