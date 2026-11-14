#!/usr/bin/env bash
# CI: `nowaki typegen examples/hello` writes .nowaki/types.d.ts with one entry per navigable page.
# Needs `cargo build -p nowaki` and `pnpm install`; run as `bash scripts/ci/e2e-typegen.sh`.
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
# API routes and convention files are not navigable, so they are left out
! grep -q '"/api/' examples/hello/.nowaki/types.d.ts || exit 1
! grep -q '_404\|_layout\|loading\|error' examples/hello/.nowaki/types.d.ts || exit 1
