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
- Since 0.19.3, `nowaki` / `nowaki-core` (crates and the npm CLI),
  `@nowaki-dev/runtime` and `create-nowaki` / `create-nowaki-app` share one version
  and are released together (create-* had already published 0.19.2, so the shared
  version starts at 0.19.3). `@nowaki-dev/markdoc` keeps its own (0.1.x). The CLI
  refuses a runtime older than its own version.
- Every release has a matching `vX.Y.Z` tag and CHANGELOG entry.

## Distribution channels

Nowaki ships through two channels:

- **crates.io**: `nowaki` / `nowaki-core` (`cargo install nowaki`)
- **npm**: `nowaki` (wrapper for the prebuilt binaries) + 5× `@nowaki-dev/cli-<platform>`, `@nowaki-dev/runtime`, `@nowaki-dev/markdoc`, `create-nowaki`, `create-nowaki-app`

The npm CLI follows the esbuild/biome approach. Per-platform binaries ship as
`optionalDependencies`, and `packages/nowaki-cli/bin/nowaki.js` (a shim that
needs no postinstall) resolves and execs the right one at runtime.

## Prerequisites

Once, register **`NPM_TOKEN` in the repository Secrets** (an npm Automation
token with publish rights to the `@nowaki-dev` org and the unscoped `nowaki`).

## Bumping the version

For a CLI release, set all of the following to the same version:

1. `[workspace.package] version` in `Cargo.toml` (the crate version; `build-npm.mjs` reads it from here too)
2. The `nowaki-core` path-dependency version in `crates/nowaki/Cargo.toml`
3. `version` in `packages/nowaki-cli/package.json` and each `@nowaki-dev/cli-*` in its `optionalDependencies`
4. (If needed) `devDependencies.nowaki` and `dependencies["@nowaki-dev/runtime"]` in
   `packages/create-nowaki/templates/_shared/package.json`

Then run `pnpm install` so `pnpm-lock.yaml` matches (CI uses a frozen lockfile).

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

### npm runtime / markdoc / create-nowaki

Bump the version in each `package.json`, then manually run the
`Publish npm packages` workflow (`.github/workflows/publish-npm.yml`). Pick the
target with the `package` input; the default `all` covers runtime, markdoc,
create-nowaki, and create-nowaki-app. A package whose version is already on npm
is skipped with a notice (`scripts/ci/npm-publish-if-new.sh`), so `all` works
when only some packages were bumped. It uses the same `NPM_TOKEN` as release.yml.

Bump the CLI, runtime and create-* packages together, and point the scaffold
template's `@nowaki-dev/runtime` and `nowaki` dependencies at that version. The
CLI requires a runtime at least as new as itself, so publish both.

To publish by hand from your machine (while logged in to npm):

```bash
cd packages/nowaki-runtime && npm publish
cd packages/nowaki-markdoc && npm publish
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
