#!/usr/bin/env bash
# CI: Deploy adapters — self-contained node entry + static + streaming SSR
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
cd "$(dirname "$0")/../.."

# node adapter: build emits a self-contained server entry runnable WITHOUT the nowaki binary
./target/debug/nowaki build examples/hello --adapter node
test -f examples/hello/dist/server/index.mjs
test -f examples/hello/dist/server/package.json
PORT=3310 node examples/hello/dist/server/index.mjs &
NODE_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3310/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3310/ | grep -q "nowaki-island"   # SSR + island marker
curl -sf http://127.0.0.1:3310/api/hello | grep -q '"hello":"nowaki"'
# streaming SSR route (export const streaming = true) renders a complete document
curl -sf http://127.0.0.1:3310/stream | grep -q "Streaming SSR"
curl -sf http://127.0.0.1:3310/stream | grep -q "nowaki-island"
# ISR signal is universal: the node adapter emits the same Cache-Control,
# so the page gets stale-while-revalidate on any CDN/edge without the Rust front.
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr | grep -qi 'cache-control: public, s-maxage=2, stale-while-revalidate'
# adapters have no live transport: live islands render their initial SSR, and live.js isn't shipped
curl -sf http://127.0.0.1:3310/live | grep -q 'nowaki-live name="LiveCounter"'
! curl -sf http://127.0.0.1:3310/live | grep -qE '/_nowaki/live\.[0-9a-f]+\.js'
kill $NODE_PID
# the printed deploy command (`cd dist/server && ... && npm start`) works as written
grep -q '"start": "node index.mjs"' examples/hello/dist/server/package.json
(cd examples/hello/dist/server && PORT=3311 npm start --silent) &
NPM_PID=$!
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:3311/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3311/ | grep -q "nowaki-island"
kill $NPM_PID 2>/dev/null || true
pkill -f 'node index.mjs' 2>/dev/null || true
# static adapter: prerender to dist/static
./target/debug/nowaki build examples/hello --adapter static
test -f examples/hello/dist/static/index.html
test -f examples/hello/dist/static/about/index.html
# cloudflare (edge) adapter: generates a bundled fetch-handler worker + wrangler config
./target/debug/nowaki build examples/hello --adapter cloudflare
test -f examples/hello/dist/worker/index.js
test -f examples/hello/dist/worker/wrangler.jsonc
grep -q "createFetchHandler" examples/hello/dist/worker/index.js
grep -q '"binding": "ASSETS"' examples/hello/dist/worker/wrangler.jsonc
# vercel adapter: Build Output API v3 (.vercel/output): config + static + a
# self-contained Node serverless function. Run the function (Vercel's launcher
# invokes its default (req,res) handler) and confirm SSR + islands + API work.
./target/debug/nowaki build examples/hello --adapter vercel
test -f examples/hello/.vercel/output/config.json
grep -q '"version": 3' examples/hello/.vercel/output/config.json
test -f examples/hello/.vercel/output/functions/index.func/.vc-config.json
grep -q '"launcherType": "Nodejs"' examples/hello/.vercel/output/functions/index.func/.vc-config.json
test -d examples/hello/.vercel/output/static/_nowaki
# the function must NOT carry a nested preact (would double-instance and break hooks)
! test -d examples/hello/.vercel/output/functions/index.func/node_modules/@nowaki-dev/runtime/node_modules
( cd examples/hello/.vercel/output/functions/index.func \
  && node -e 'import("./index.mjs").then(m=>require("http").createServer(m.default).listen(3320))' & )
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3320/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3320/ | grep -q "nowaki-island"
curl -sf http://127.0.0.1:3320/api/hello | grep -q '"hello":"nowaki"'
curl -sf http://127.0.0.1:3320/nav | grep -q 'href="/blog/hello"'
