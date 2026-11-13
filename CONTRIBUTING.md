# Contributing to Nowaki

Thanks for your interest in contributing. Nowaki is in alpha and the
architecture is still settling, so opening an issue to discuss your idea
before writing code is the best way to avoid wasted effort.

## Development setup

Prerequisites:

- Rust (stable); `rustup` recommended
- Node.js >= 22
- pnpm

```bash
git clone https://github.com/Tettu0530/nowaki
cd nowaki
pnpm install
cargo build -p nowaki

# Run the example app
./target/debug/nowaki dev examples/hello
# → http://127.0.0.1:3000
```

## Repository layout

| Path | What it is |
|---|---|
| `crates/nowaki-core` | Bundler core: oxc-based transform pipeline, resolver, module cache |
| `crates/nowaki` | CLI binary: dev server (axum), HMR, sidecar management |
| `packages/nowaki-runtime` | `@nowaki-dev/runtime`: islands hydration client, SSR sidecar, Node loader hooks |
| `examples/hello` | Example app used for end-to-end verification |
| `DESIGN.md` | Architecture and roadmap |

## Before you submit

- Security-sensitive changes (dev/start, sidecars, Jetstream, server functions,
  ISR, static serving): follow [AGENTS.md § Security invariants](./AGENTS.md#security-invariants)
  and update [SECURITY.md](./SECURITY.md) when a default defense changes.
- `cargo fmt` and `cargo clippy --workspace` must pass with no warnings.
- Verify the example app still works: start `nowaki dev examples/hello` and
  check that the page renders, the counter island hydrates, and editing
  `routes/index.tsx` triggers a reload.
- Keep PRs focused: one logical change per PR.
- Keep PRs under 2,000 changed lines (additions + deletions; lockfiles don't count).
  The `PR size` check enforces this; split larger work into a stack of PRs.
- Every PR needs a maintainer approval and a green `CI OK` check before it can merge.

## API snapshots

[`api/`](./api/README.md) lists the public surface: runtime types, route exports,
file conventions, config keys, CLI flags, env vars, endpoints, client events. CI (`API
surface snapshots`) regenerates it and fails when it differs from what is checked in.
When your change touches the public surface:

1. Run `node scripts/api-surface.mjs`. It rewrites `api/*.txt`, and `api/cli.txt`
   through `NOWAKI_UPDATE_SNAPSHOTS=1 cargo test -p nowaki --bin nowaki cli_surface`
   (`--no-cargo` skips that step).
2. If it reports `[unclassified]` names (a new env var, endpoint, header, event or
   route export), move each line in `api/env.txt`, `http.txt`, `client.txt` or
   `route-exports.txt` to `[stable]`, `[dev]`, `[internal]`, `[external]` or
   `[ignored]`. Anything not `[stable]` is not covered by semver.
3. Review the diff and commit it with the change. Added stable entries get a
   CHANGELOG line.
4. `node scripts/api-surface.mjs --check --base origin/main` shows locally what CI
   reports on the PR: stable entries added, and stable entries removed or changed.

A removed or changed `[stable]` entry is a breaking change. From the API freeze
(0.20.0) on, CI fails on one unless the PR has the `breaking` label, which is for
changes aimed at the next major. A maintainer adds the label; then re-run the job,
which reads the labels through the API, so this works for PRs from forks too. Before
0.20.0 the check only lists them. `node scripts/api-surface-test.mjs` tests the
script itself.

## Commit messages and sign-off

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). Sign off each commit with `git commit -s`, which adds:

```
Signed-off-by: Your Name <you@example.com>
```

## Where to ask questions

- Bugs and feature requests: [GitHub Issues](https://github.com/Tettu0530/nowaki/issues)
- Security issues: see [SECURITY.md](./SECURITY.md). Please do not open a public issue.
