#!/usr/bin/env bash
# Publishes the package in the current directory unless its version is already on npm,
# so `publish-npm.yml -f package=all` works when only some packages were bumped.
# Extra arguments go to npm publish (`--dry-run` to try it locally).
set -euo pipefail
name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "::notice::$name@$version is already on npm, skipped"
  exit 0
fi
npm publish --access public "$@"
