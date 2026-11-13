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

Nowaki ships through three channels, all from one tag-driven workflow
(`.github/workflows/release.yml`):

- **crates.io**: `nowaki` and `nowaki-core` (`cargo install nowaki`). `nowaki-core` is
  the CLI's engine, not an API for other programs; `nowaki` depends on it with an
  exact `=` pin.
- **npm**: `nowaki` (a wrapper for the prebuilt binaries) + 5× `@nowaki-dev/cli-<platform>`,
  `@nowaki-dev/runtime`, `@nowaki-dev/markdoc`, `create-nowaki`, `create-nowaki-app`. Every
  package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- **GitHub Releases**: the five binaries (`nowaki-<platform>`, `nowaki-win32-x64.exe`) and
  `SHA256SUMS`, with [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
  for the binaries and the platform package tarballs.

The npm CLI follows the esbuild/biome approach. Per-platform binaries ship as
`optionalDependencies`, and `packages/nowaki-cli/bin/nowaki.js` (a shim that
needs no postinstall) resolves and execs the right one at runtime.

## Release checklist

1. **Bump** on a branch (see [Bumping the version](#bumping-the-version)), move the
   CHANGELOG `## [Unreleased]` entries under `## [X.Y.Z] — YYYY-MM-DD · …`, run
   `pnpm install` and `cargo build`, then:

   ```bash
   node scripts/release-check.mjs vX.Y.Z --new-tag
   ```

2. **PR.** The `Release check` workflow runs the same check (with `--new-tag` when the PR
   changes the version), the release tooling tests and `actionlint`. Wait for CI to be green.
3. **Merge** into `main` (or `release/N.x` for a backport, see [Backports](#backports)).
4. **Tag** the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Watch** the `Release` run (`gh run watch`). It stops before publishing anything if
   the version check fails; if a later job fails, fix the cause and
   [re-run it](#re-running-a-release): everything already published is skipped.
6. **Verify** (see [Verifying a release](#verifying-a-release)): `npm view nowaki dist-tags`,
   `cargo search nowaki`, the GitHub Release page, and `npm create nowaki@<dist-tag>` on a
   clean machine.
7. **Announce** (maintainer).

Pushing a release tag is what publishes, so only maintainers push `v*` tags (see
GOVERNANCE.md for who that is); the npm and crates.io owners are the same people.

## Bumping the version

Every package except `@nowaki-dev/markdoc` shares one version. `release-check.mjs` checks
all of these against the tag:

1. `[workspace.package] version` in `Cargo.toml` (the `nowaki` crate and, through
   `scripts/build-npm.mjs`, the `@nowaki-dev/cli-*` packages)
2. `version` in `packages/nowaki-cli/package.json` and each `@nowaki-dev/cli-*` in its
   `optionalDependencies`
3. `version` in `packages/nowaki-runtime`, `packages/create-nowaki` and
   `packages/create-nowaki-app`, and create-nowaki-app's `create-nowaki` dependency (`^X.Y.Z`)
4. `dependencies["@nowaki-dev/runtime"]` and `devDependencies.nowaki` in
   `packages/create-nowaki/templates/_shared/package.json` (`^X.Y.Z`): what a new app installs
5. A `## [X.Y.Z]` section in `CHANGELOG.md` (the GitHub Release body; a quoted codename in
   the heading, `· "Bora": …`, becomes the release title)
6. `Cargo.lock` and `pnpm-lock.yaml` in sync (run `cargo build` and `pnpm install`)
7. The `api/` surface snapshots current, once `scripts/api-surface.mjs` exists

Two packages have their own version:

- **`nowaki-core`** may be on its own line (`version` in `crates/nowaki-core/Cargo.toml`).
  The check requires the `nowaki-core` requirement in `crates/nowaki/Cargo.toml` to name
  that version, and warns unless it is an exact `=X.Y.Z` pin (a caret would let
  `cargo install nowaki` pick a newer nowaki-core). Bump it whenever its code changed;
  the workflow publishes it only if that version is not on crates.io yet.
- **`@nowaki-dev/markdoc`** follows its own SemVer. Bump `packages/nowaki-markdoc/package.json`
  when it changed; it ships with the next release tag and is skipped when its version is
  already on npm.

## Release candidates and dist-tags

- `vX.Y.Z-rc.N` (only `-rc.N`; `-alpha` / `-beta` tags are refused) publishes every npm
  package to the `next` dist-tag, never `latest`, and makes the GitHub Release a
  prerelease. Users try it with `npm create nowaki@next`, or
  `npm i nowaki@next @nowaki-dev/runtime@next` in an app.
- `vX.Y.Z` publishes to `latest`.
- A release of an older major (a `1.x` patch after `2.0.0`) publishes to `v1-lts` and is not
  marked as the latest GitHub Release. A release older than `latest` on the same major is
  refused: minors don't break, so fixes go to the newest minor.

The dist-tag is computed per package from its own version (`scripts/release-check.mjs
dist-tag`), so a stable markdoc in an RC release still goes to `latest`. crates.io has no
dist-tags: `cargo install nowaki` skips prereleases unless `--version 1.0.0-rc.1` is given.

## What the workflow does

`release.yml` runs on a pushed `vX.Y.Z` / `vX.Y.Z-rc.N` tag:

| Job | What it does |
| --- | --- |
| Version check | `release-check.mjs <tag>`; the tag must be on `main` or a `release/*` branch; picks the dist-tag. Nothing else runs if it fails. |
| Build (×5) | `cargo build --release --locked` per platform (`cross` for linux-arm64), assembles `@nowaki-dev/cli-<key>` |
| Checksums and attestations | `SHA256SUMS` for the binaries; `actions/attest` build provenance for the binaries and platform tarballs |
| Publish npm packages | runtime → markdoc → 5 platform packages → `nowaki` wrapper → create-nowaki → create-nowaki-app, each with `--provenance` and its dist-tag, skipping versions already on npm (`scripts/ci/npm-publish-if-new.sh`) |
| Publish crates | `nowaki-core` (if its version is not on crates.io), then `nowaki` (if not) |
| GitHub Release | created from the CHANGELOG section with the binaries and `SHA256SUMS` (`--prerelease` for an RC); an existing release only gets its assets replaced |

The runtime goes out before the CLI because the CLI refuses a runtime older than itself;
the scaffolders go last because a new app installs both.

Publishing jobs get `id-token: write` (OIDC for trusted publishing, provenance and
attestations) and the release job `contents: write`; everything else is read-only. Third-party
actions are pinned by commit SHA. No PR workflow sees a publishing secret.

### Dry runs

- Every Monday the workflow runs on `main` as a dry run (builds, `npm publish --dry-run`,
  `cargo publish --dry-run`; no attestations, no release). A version already on npm is
  checked with `npm pack --dry-run`, since npm refuses even a dry-run publish over it.
- By hand: `gh workflow run release.yml` (dry run of `main`), or
  `gh workflow run release.yml -f tag=vX.Y.Z` (dry run of that tag; `dry_run` defaults to true).

A dry run never receives `NPM_TOKEN` or `CARGO_REGISTRY_TOKEN`.

### Re-running a release

If a run failed after publishing part of a release (a registry outage, a missing
token), fix the cause, then either re-run the failed jobs from the run page or start a
fresh run for the tag:

```bash
gh workflow run release.yml -f tag=vX.Y.Z -f dry_run=false
```

It checks out the tag, publishes only what is missing on npm and crates.io, and creates
the GitHub Release (or replaces its assets).

## One-time setup

The workflow works today with tokens; trusted publishing (OIDC) replaces them once it is
configured on the registries. Both may be active during the switch.

### Tokens (until trusted publishing is configured)

- `NPM_TOKEN` (exists): an npm granular token with publish rights to the `@nowaki-dev`
  scope and `nowaki`, `create-nowaki`, `create-nowaki-app`.
- `CARGO_REGISTRY_TOKEN` (**add it before the first automated release** unless crates.io
  trusted publishing is set up first): a crates.io API token with the `publish-update`
  scope for `nowaki` and `nowaki-core`, from <https://crates.io/settings/tokens>, stored with
  `gh secret set CARGO_REGISTRY_TOKEN`.

### Tag protection

Add a repository ruleset for tags matching `v*` (Settings → Rules → Rulesets → New tag
ruleset) that restricts creation, update and deletion to maintainers, so only they can
start a release.

### npm trusted publishing

Requirements ([npm docs](https://docs.npmjs.com/trusted-publishers)): npm 11.5.1+ and
Node 22.14+ in the workflow (the publish job uses Node 24 and checks the npm version),
GitHub-hosted runners, `id-token: write`. Provenance is then generated automatically; the
workflow also passes `--provenance`, which keeps it on the token path too.

Each of the 10 packages needs a trusted publisher (all of them already exist on npm):

`nowaki`, `@nowaki-dev/cli-darwin-arm64`, `@nowaki-dev/cli-darwin-x64`,
`@nowaki-dev/cli-linux-x64-gnu`, `@nowaki-dev/cli-linux-arm64-gnu`, `@nowaki-dev/cli-win32-x64`,
`@nowaki-dev/runtime`, `@nowaki-dev/markdoc`, `create-nowaki`, `create-nowaki-app`

On npmjs.com, for each package: **Settings → Trusted publishing → GitHub Actions**, with

- Organization or user: `Tettu0530`
- Repository: `nowaki`
- Workflow filename: `release.yml`
- Environment name: leave empty

Or from a terminal with npm 11.15.0+ ([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)),
logged in as an owner:

```bash
for p in nowaki @nowaki-dev/cli-darwin-arm64 @nowaki-dev/cli-darwin-x64 \
  @nowaki-dev/cli-linux-x64-gnu @nowaki-dev/cli-linux-arm64-gnu @nowaki-dev/cli-win32-x64 \
  @nowaki-dev/runtime @nowaki-dev/markdoc create-nowaki create-nowaki-app; do
  npm trust github "$p" --file release.yml --repo Tettu0530/nowaki --allow-publish
done
```

npm doesn't validate the configuration when it is saved, and a new configuration expires
if it hasn't published within 2 days, so set it up shortly before a release. After a
release has gone out through OIDC (`npm view <pkg>@<version> dist.attestations` shows the
provenance), choose **Settings → Publishing access → Require two-factor authentication and
disallow tokens** for each package, then delete the `NPM_TOKEN` secret. Trusted publishing
keeps working with tokens disallowed.

### crates.io trusted publishing

Requirements ([crates.io docs](https://crates.io/docs/trusted-publishing)): the crate is
already published (both are), you are an owner, `id-token: write`. The workflow gets a
30-minute token from [`rust-lang/crates-io-auth-action`](https://github.com/rust-lang/crates-io-auth-action).

1. For `nowaki` and for `nowaki-core` on crates.io: **Settings → Trusted Publishing → Add →
   GitHub**, with repository owner `Tettu0530`, repository name `nowaki`, workflow filename
   `release.yml`, environment empty.
2. Turn it on in the workflow (the auth step fails for a crate without a configuration, so it
   is opt-in): `gh variable set CRATES_IO_TRUSTED_PUBLISHING --body true`.
3. After a release has published through it, delete the `CARGO_REGISTRY_TOKEN` secret and
   revoke the token on crates.io.

If a GitHub environment (for example `release` with required reviewers) is added later, add
`environment: release` to the `npm` and `crates` jobs and the same environment name to
every trusted publisher; they must match.

## Verifying a release

```bash
npm view nowaki dist-tags                                # latest / next
npm view @nowaki-dev/runtime@X.Y.Z dist.attestations     # provenance
npm audit signatures                                     # in an app: signatures and provenance
cargo search nowaki --limit 2
gh release download vX.Y.Z -p nowaki-linux-x64-gnu -p SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify nowaki-linux-x64-gnu --repo Tettu0530/nowaki
```

## Backports

After 2.0, fixes for 1.x land on `release/1.x` (cherry-picked from `main`), are bumped there
as usual and tagged from that branch (`v1.4.2`). The version check accepts a tag on `main` or
any `release/*` branch, and an older major goes to the `v1-lts` dist-tag.

## Manual fallback

If the workflow can't be used (GitHub Actions down, a broken runner image), publish from a
maintainer machine in the workflow's order. These uploads have no provenance or
attestations, so prefer re-running the workflow when possible. The platform packages come
from `node scripts/build-npm.mjs <key>` on a host of each platform, or from the `cli-<key>`
artifacts of a dry run (`npm-<key>.tgz`, unpacked into `packages/nowaki-cli/npm/`).

```bash
node scripts/release-check.mjs vX.Y.Z
(cd packages/nowaki-runtime && bash ../../scripts/ci/npm-publish-if-new.sh)
(cd packages/nowaki-markdoc && bash ../../scripts/ci/npm-publish-if-new.sh)
for key in darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu win32-x64; do
  (cd "packages/nowaki-cli/npm/$key" && bash ../../../../scripts/ci/npm-publish-if-new.sh)
done
(cd packages/nowaki-cli && bash ../../scripts/ci/npm-publish-if-new.sh)
(cd packages/create-nowaki && bash ../../scripts/ci/npm-publish-if-new.sh)
(cd packages/create-nowaki-app && bash ../../scripts/ci/npm-publish-if-new.sh)
cargo publish -p nowaki-core    # only if this nowaki-core version is not on crates.io
cargo publish -p nowaki
node scripts/release-check.mjs notes vX.Y.Z > notes.md
gh release create vX.Y.Z --verify-tag --notes-file notes.md \
  --title "$(node scripts/release-check.mjs title vX.Y.Z)"   # add --prerelease for an RC
```

`npm-publish-if-new.sh` picks the dist-tag and skips published versions here too
(`NPM_DRY_RUN=1` to try it). Once tokens are disallowed on a package, publishing from a
machine needs an owner account with 2FA.

## Local verification

You can assemble any target locally to check it. Only a target whose key
matches the host can actually run.

```bash
node scripts/build-npm.mjs darwin-arm64   # e.g. Apple Silicon
# Output: packages/nowaki-cli/npm/darwin-arm64/{package.json, bin/nowaki}
```

On every PR, the `npm CLI wrapper (smoke)` job in `ci.yml` assembles the host
package and checks that `nowaki --version` works through the wrapper shim. The release
tooling has its own tests: `node scripts/release-check-test.mjs`.
