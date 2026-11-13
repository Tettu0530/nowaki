#!/usr/bin/env bash
# Publishes the package in the current directory unless its version is already on npm, so a
# re-run of release.yml (or a manual run) skips what is already out.
#
# The dist-tag comes from the version (scripts/release-check.mjs dist-tag): a prerelease goes to
# `next`, a release to `latest`, a release of an older major to `v<major>-lts`.
# On GitHub Actions it adds --provenance (needs `id-token: write`). With trusted publishing set up
# on npmjs.com, npm authenticates through OIDC; otherwise it uses NODE_AUTH_TOKEN.
#
# NPM_DRY_RUN=1 runs `npm publish --dry-run` instead (`npm pack --dry-run` when the version is
# already on npm, since npm refuses even a dry-run publish over an existing version).
# Extra arguments go to npm publish.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
dry_run="${NPM_DRY_RUN:-}"

if npm view "$name@$version" version >/dev/null 2>&1; then
  if [ -n "$dry_run" ]; then
    echo "::notice::$name@$version is already on npm; dry run packs it only"
    npm pack --dry-run
  else
    echo "::notice::$name@$version is already on npm, skipped"
  fi
  exit 0
fi

latest=$(npm view "$name" dist-tags.latest 2>/dev/null || true)
tag=$(node "$here/../release-check.mjs" dist-tag "$version" --latest "$latest")

args=(publish --access public --tag "$tag")
if [ -n "$dry_run" ]; then
  args+=(--dry-run)
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  args+=(--provenance)
fi
echo "npm ${args[*]} $* ($name@$version, npm latest: ${latest:-none})"
npm "${args[@]}" "$@"
