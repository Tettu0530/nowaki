# Contributing to Nowaki

Thanks for your interest in contributing. For anything larger than a small
fix, open an issue or a discussion before writing code, so we can agree on the
approach first. Changes to the public API go through an RFC
([Proposing a change to the public API](#proposing-a-change-to-the-public-api-rfcs)).

How the project is run is described in [GOVERNANCE.md](./GOVERNANCE.md); what
counts as the public API is in [docs/STABILITY.md](./docs/STABILITY.md).

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

## Proposing a change to the public API (RFCs)

A change to the frozen public surface (runtime exports, route exports, file
conventions, `nowaki.config` keys, CLI commands and flags, defaults, environment
variables users set; the list is in
[docs/STABILITY.md](./docs/STABILITY.md#what-is-frozen)) needs an accepted RFC
before its implementation PR is merged. An RFC is a pull request that adds
`rfcs/NNNN-name.md` from [the template](./rfcs/0000-template.md); it is accepted
after a 7-day final comment period. The steps are in
[rfcs/README.md](./rfcs/README.md).

Bug fixes, docs, tests, performance work and internal refactors don't need an
RFC.

## Breaking changes

A breaking change is one that makes an app that worked on the previous release
stop working, stop type-checking, or behave differently without changing its
code; [docs/STABILITY.md](./docs/STABILITY.md#what-counts-as-a-breaking-change)
has the full definition, including types, defaults, HTML output, headers and
CSP.

- 0.20.0 is the last release that may break the public surface. After it, a
  breaking change waits for the next major.
- A breaking PR needs an accepted RFC, the `breaking` label, and a CHANGELOG
  entry with an Upgrade note. Without the label, CI fails on a change that
  removes or changes an entry in the `api/` snapshots.
- Removing something goes through a deprecation in a minor first
  (`@deprecated` in the `.d.ts`, a warn-once at runtime, a "Deprecated"
  CHANGELOG section).
- Security fixes that tighten a default are the exception: they may land in a
  minor, with an Upgrade note and an opt-out where one is safe.

## Releases and cadence

- Patch releases ship when fixes are ready; there is no fixed schedule.
- Minor releases ship when a set of additions is ready, usually a roadmap
  milestone. Deprecations and MSRV rises land only in minors.
- Majors are rare, and each breaking change in one has an accepted RFC.
- Before 1.0.0, release candidates (`1.0.0-rc.N`) are published on the npm
  `next` dist-tag.
- Which versions get fixes is in [SUPPORT.md](./SUPPORT.md). Only the lead
  maintainer publishes; the steps are in [docs/RELEASING.md](./docs/RELEASING.md).

## Where to ask questions

- Questions and ideas: [GitHub Discussions](https://github.com/Tettu0530/nowaki/discussions)
- Bugs and feature requests: [GitHub Issues](https://github.com/Tettu0530/nowaki/issues)
- Support policy: [SUPPORT.md](./SUPPORT.md)
- Security issues: see [SECURITY.md](./SECURITY.md). Please do not open a public issue.
