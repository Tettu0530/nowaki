#!/usr/bin/env bash
# CI: `nowaki upgrade` without network access: the CLI flags, the guard against a non-Nowaki
# package.json, and the `--to` readiness report.
# Needs `cargo build -p nowaki` and `pnpm install`; run as `bash scripts/ci/e2e-upgrade.sh`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."

./target/debug/nowaki --help | grep -q upgrade
./target/debug/nowaki upgrade --help | grep -q -- '--to'
# a non-Nowaki package.json is rejected without touching the network
TMP=$(mktemp -d); echo '{"name":"x","dependencies":{}}' > "$TMP/package.json"
! ./target/debug/nowaki upgrade "$TMP" 2>/dev/null || exit 1
rm -rf "$TMP"
# --to a newer major: a read-only readiness report with file:line; nothing is installed while
# something must change (exit 1), and --check never installs
TMP=$(mktemp -d); echo '{"dependencies":{"@nowaki-dev/runtime":"^0.19.3"}}' > "$TMP/package.json"
mkdir -p "$TMP/routes"; echo 'export default () => null;' > "$TMP/routes/_error.tsx"
! ./target/debug/nowaki upgrade "$TMP" --to 1.0.0 > "$TMP/report.txt" 2>&1 || exit 1
grep -q 'routes/_error.tsx:1' "$TMP/report.txt"
grep -q 'nothing was installed' "$TMP/report.txt"
! test -e "$TMP/node_modules" || exit 1
mv "$TMP/routes/_error.tsx" "$TMP/routes/_500.tsx"
./target/debug/nowaki upgrade "$TMP" --to 1.0.0 --check | grep -q 'nothing must change'
! test -e "$TMP/node_modules" || exit 1
rm -rf "$TMP"
# An app from before 0.19.3 (CLI and runtime released at different versions): the version
# mismatch is "fixed by this upgrade", not a blocker, and both packages are installed at the
# target, the CLI staying in devDependencies. A fake npm on PATH records the installs (no network).
TMP=$(mktemp -d); mkdir -p "$TMP/bin" "$TMP/app/node_modules/nowaki" "$TMP/app/node_modules/@nowaki-dev/runtime"
printf '#!/bin/sh\necho "$*" >> "%s/npm.log"\n' "$TMP" > "$TMP/bin/npm"; chmod +x "$TMP/bin/npm"
# Windows: the CLI runs npm as `npm.cmd` (the shim npm installs there), so add one that calls
# the same script.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) printf '@echo off\r\nbash "%%~dp0npm" %%*\r\n' > "$TMP/bin/npm.cmd" ;; esac
echo '{"dependencies":{"@nowaki-dev/runtime":"^0.17.2"},"devDependencies":{"nowaki":"^0.18.2"}}' > "$TMP/app/package.json"
echo '{"name":"nowaki","version":"0.18.2"}' > "$TMP/app/node_modules/nowaki/package.json"
echo '{"name":"@nowaki-dev/runtime","version":"0.17.2"}' > "$TMP/app/node_modules/@nowaki-dev/runtime/package.json"
NOWAKI=$PWD/target/debug/nowaki
PATH="$TMP/bin:$PATH" "$NOWAKI" upgrade "$TMP/app" --to 0.20.0 --check > "$TMP/check.txt"
grep -q 'Fixed by `nowaki upgrade --to 0.20.0`' "$TMP/check.txt"
grep -q 'nothing must change' "$TMP/check.txt"
! test -e "$TMP/npm.log" || exit 1
for TO in 0.20.0 1.0.0-rc.1 next; do
  rm -f "$TMP/npm.log"
  PATH="$TMP/bin:$PATH" "$NOWAKI" upgrade "$TMP/app" --to "$TO" > "$TMP/out.txt"
  [ "$TO" = next ] || grep -q 'Fixed by this upgrade' "$TMP/out.txt"
  grep -qx "install @nowaki-dev/runtime@$TO" "$TMP/npm.log"
  grep -qx "install -D nowaki@$TO" "$TMP/npm.log"
done
rm -rf "$TMP"
