#!/usr/bin/env bash
# CI: Typed routes — typegen writes .nowaki/types.d.ts
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."

./target/debug/nowaki typegen examples/hello | grep -q 'typegen'
test -f examples/hello/.nowaki/types.d.ts
grep -q '"/blog/\[slug\]": { slug: string }' examples/hello/.nowaki/types.d.ts
grep -q '"/files/\[\.\.\.path\]": { path: string\[\] }' examples/hello/.nowaki/types.d.ts
# a route group adds no URL segment
grep -q '"/pricing": {}' examples/hello/.nowaki/types.d.ts
! grep -q '(marketing)' examples/hello/.nowaki/types.d.ts || exit 1
# parallel-route slot files and intercepting routes are not pages
grep -q '"/photos/\[id\]": { id: string }' examples/hello/.nowaki/types.d.ts
! grep -q '@modal\|(\.)' examples/hello/.nowaki/types.d.ts || exit 1
# API routes and convention files are NOT navigable → excluded
! grep -q '"/api/' examples/hello/.nowaki/types.d.ts || exit 1
! grep -q '_404\|_layout\|loading\|error' examples/hello/.nowaki/types.d.ts || exit 1
