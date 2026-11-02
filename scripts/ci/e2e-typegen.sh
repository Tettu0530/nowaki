#!/usr/bin/env bash
# CI: Typed routes — typegen writes .nowaki/types.d.ts
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
cd "$(dirname "$0")/../.."

./target/debug/nowaki typegen examples/hello | grep -q 'typegen'
test -f examples/hello/.nowaki/types.d.ts
grep -q '"/blog/\[slug\]": { slug: string }' examples/hello/.nowaki/types.d.ts
grep -q '"/files/\[\.\.\.path\]": { path: string\[\] }' examples/hello/.nowaki/types.d.ts
# API routes and convention files are NOT navigable → excluded
! grep -q '"/api/' examples/hello/.nowaki/types.d.ts
! grep -q '_404\|_layout\|loading\|error' examples/hello/.nowaki/types.d.ts
