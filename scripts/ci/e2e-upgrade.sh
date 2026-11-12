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
