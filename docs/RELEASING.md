# Releasing

## Versioning policy

Nowaki follows [SemVer](https://semver.org/). During **0.x alpha**, however:

- **minor (0.x.0)** may include new features and breaking changes. Breaking
  changes must always be called out in [CHANGELOG.md](../CHANGELOG.md) with
  migration notes.
- **patch (0.x.y)** is bug fixes only. No breaking changes.
- Once the public API (CLI commands, authoring conventions, the public exports
  of `@nowaki-dev/runtime`) is mostly settled, we go to **1.0.0**; from then on
  breaking changes happen only in a major.
- All crate and npm packages share the same version (released from the same commit).
- Every release has a matching `vX.Y.Z` tag and CHANGELOG entry.

## Distribution channels

Nowaki ships through two channels:

- **crates.io**: `nowaki` / `nowaki-core` (`cargo install nowaki`)
- **npm**: `nowaki` (wrapper for the prebuilt binaries) + 5× `@nowaki-dev/cli-<platform>`, `@nowaki-dev/runtime`, `create-nowaki`

The npm CLI follows the esbuild/biome approach. Per-platform binaries ship as
`optionalDependencies`, and `packages/nowaki-cli/bin/nowaki.js` (a shim that
needs no postinstall) resolves and execs the right one at runtime.

## Prerequisites

Once, register **`NPM_TOKEN` in the repository Secrets** (an npm Automation
token with publish rights to the `@nowaki-dev` org and the unscoped `nowaki`).

## Bumping the version

Set all of the following to the same version:

1. `[workspace.package] version` in `Cargo.toml` (the crate version; `build-npm.mjs` reads it from here too)
2. `version` in `packages/nowaki-cli/package.json` and each `@nowaki-dev/cli-*` in its `optionalDependencies`
3. (If needed) `devDependencies.nowaki` in `packages/create-nowaki/template/package.json`

## Publishing

### crates.io

```bash
cargo publish -p nowaki-core
cargo publish -p nowaki
```

### npm CLI (automated)

Pushing a version tag makes the release CI (`.github/workflows/release.yml`)
build all 5 platforms and publish every package.

```bash
git tag v0.1.2
git push origin v0.1.2
```

- `build` job: builds each target, packages it with
  `node scripts/build-npm.mjs <key> --no-build`, and publishes `@nowaki-dev/cli-<key>`.
- `publish-wrapper` job: publishes the `nowaki` wrapper after all builds finish.
- A manual run (workflow_dispatch) with `dry_run=true` only runs the builds.

### npm runtime / create-nowaki

Bump the version in each `package.json`, then manually run the
`Publish npm packages` workflow (`.github/workflows/publish-npm.yml`). Pick the
target with the `package` input; the default `all` covers runtime,
create-nowaki, and create-nowaki-app. It uses the same `NPM_TOKEN` as release.yml.

Note: `@nowaki-dev/runtime` shares its version with the CLI, since both are
released from the same commit. Bump the scaffold template's
`@nowaki-dev/runtime` dependency to match.

To publish by hand from your machine (while logged in to npm):

```bash
cd packages/nowaki-runtime && npm publish
cd packages/create-nowaki   && npm publish
cd packages/create-nowaki-app && npm publish
```

## Local verification

You can assemble any target locally to check it. Only a target whose key
matches the host can actually run.

```bash
node scripts/build-npm.mjs darwin-arm64   # e.g. Apple Silicon
# Output: packages/nowaki-cli/npm/darwin-arm64/{package.json, bin/nowaki}
```

On every PR, the `npm CLI wrapper (smoke)` job in `ci.yml` assembles the host
package and checks that `nowaki --version` works through the wrapper shim.
