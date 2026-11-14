#!/usr/bin/env bash
# CI: nowaki upgrade — command surface + non-app guard (no network)
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
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
