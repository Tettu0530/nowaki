#!/usr/bin/env bash
# CI: Deploy adapters — self-contained node entry + static + streaming SSR
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."
# A request to a hung server must fail, not wait forever; and on Windows, where hangs have been
# seen, trace every command so the log shows where one stopped.
curl() { command curl --max-time 30 "$@"; }
if [ "${RUNNER_OS:-}" = Windows ]; then set -x; fi

# node adapter: build emits a self-contained server entry runnable WITHOUT the nowaki binary
./target/debug/nowaki build examples/hello --adapter node
test -f examples/hello/dist/server/index.mjs
test -f examples/hello/dist/server/package.json
PORT=3310 node examples/hello/dist/server/index.mjs &
NODE_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3310/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3310/ | grep -q "nowaki-island"   # SSR + island marker
# streaming = "early": the shell goes out before the 300 ms loader; a loader error renders
# error.tsx in the page (status stays 200) and a loader redirect becomes location.replace (#112)
FB=$(curl -s -N -o /tmp/nowaki-early.html -w '%{time_starttransfer}' http://127.0.0.1:3310/stream-early)
awk -v t="$FB" 'BEGIN { exit !(t < 0.2) }'
grep -q 'data-testid="early"' /tmp/nowaki-early.html
grep -q '<title>Early streaming' /tmp/nowaki-early.html
test "$(curl -s -o /tmp/nowaki-early-fail.html -w '%{http_code}' 'http://127.0.0.1:3310/stream-early?fail=1')" = 200
grep -q "Couldn't display this page" /tmp/nowaki-early-fail.html
! grep -q 'the data source is down' /tmp/nowaki-early-fail.html   # no message in production
curl -s 'http://127.0.0.1:3310/stream-early?go=1' | grep -q 'location.replace("/about")'
curl -sf http://127.0.0.1:3310/api/hello | grep -q '"hello":"nowaki"'
# default security headers on the node adapter (pages and static assets)
curl -s -D - -o /dev/null http://127.0.0.1:3310/ | grep -qi '^x-content-type-options: nosniff'
curl -s -D - -o /dev/null http://127.0.0.1:3310/ | grep -qi "^content-security-policy: frame-ancestors 'self'"
# streaming SSR route (export const streaming = true) renders a complete document
curl -sf http://127.0.0.1:3310/stream | grep -q "Streaming SSR"
curl -sf http://127.0.0.1:3310/stream | grep -q "nowaki-island"
# ISR signal is universal: the node adapter emits the same Cache-Control,
# so the page gets stale-while-revalidate on any CDN/edge without the Rust front.
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr | grep -qi 'cache-control: public, s-maxage=2, stale-while-revalidate'
# live islands on adapters: live.js ships in POST mode, and POST /__nowaki/live-event applies an
# event (signed state in, `live: 1` + a new signature out) behind the RPC-style CSRF gate
curl -sf http://127.0.0.1:3310/live | grep -q 'nowaki-live name="LiveCounter"'
curl -sf http://127.0.0.1:3310/live | grep -qE '/_nowaki/live\.[0-9a-f]+\.js" data-live-transport="post"'
LIVE_SIG=$(curl -sf http://127.0.0.1:3310/live | grep -oE 'sig="v1\.[^"]+"' | head -1 | cut -d'"' -f2)
LIVE_EV="{\"name\":\"LiveCounter\",\"state\":{\"count\":0},\"sig\":\"$LIVE_SIG\",\"handler\":\"inc\"}"
LIVE_OUT=$(curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-live: 1' -H 'origin: http://127.0.0.1:3310' -d "$LIVE_EV" http://127.0.0.1:3310/__nowaki/live-event)
echo "$LIVE_OUT" | grep -qE 'live: (<!-- -->)?1'
echo "$LIVE_OUT" | grep -qE '"sig":"v1\.[^"]+"'
test "$(echo "$LIVE_OUT" | grep -cF "$LIVE_SIG")" = 0
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'content-type: application/json' -H 'x-nowaki-live: 1' -H 'origin: http://evil.test' -d "$LIVE_EV" http://127.0.0.1:3310/__nowaki/live-event)" = "403"
kill $NODE_PID
# CSP on the node adapter (report-only): nonce on every script/style
NOWAKI_CSP=report-only PORT=3312 node examples/hello/dist/server/index.mjs &
CSPN_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3312/ >/dev/null && break; sleep 1; done
node scripts/csp-e2e.mjs http://127.0.0.1:3312 --report-only
kill $CSPN_PID

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
# dynamic routes listed by `export const staticPaths` (including a catch-all), and 404.html
grep -q 'Post: hello' examples/hello/dist/static/blog/hello/index.html
grep -q 'Post: nowaki' examples/hello/dist/static/blog/nowaki/index.html
grep -q 'docs / intro (2)' examples/hello/dist/static/files/docs/intro/index.html
grep -q 'Page not found' examples/hello/dist/static/404.html
# content collections: staticPaths from getCollection, one page per entry
grep -q '<h2 id="why-content-collections"' examples/hello/dist/static/docs/intro/index.html
test -f examples/hello/dist/static/docs/routing/index.html
# live islands on a static host: their first HTML, but no live.js (no server for its events), and
# the build says which pages they are on (#93)
grep -q 'nowaki-live name="LiveCounter"' examples/hello/dist/static/live/index.html
! grep -q '/_nowaki/live\.' examples/hello/dist/static/live/index.html
! grep -q '/_nowaki/live\.' examples/hello/dist/static/poll/index.html
# the SPA router's boundaries fetch is answered by a static file (no 404 on static hosts)
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(b.loading)||!Array.isArray(b.error)||!b.loading.length) process.exit(1)' examples/hello/dist/static/__nowaki/boundaries
grep -q '/__nowaki/boundaries' examples/hello/dist/static/_headers
grep -qi 'x-content-type-options: nosniff' examples/hello/dist/static/_headers
# cloudflare (edge) adapter: generates a bundled fetch-handler worker + wrangler config
./target/debug/nowaki build examples/hello --adapter cloudflare
# the worker's fetch handler, called directly in Node (web.mjs end to end, no wrangler)
node scripts/edge-handler-test.mjs examples/hello/dist/worker
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
grep -q '"x-content-type-options": "nosniff"' examples/hello/.vercel/output/config.json
test -f examples/hello/.vercel/output/functions/index.func/.vc-config.json
grep -q '"launcherType": "Nodejs"' examples/hello/.vercel/output/functions/index.func/.vc-config.json
test -d examples/hello/.vercel/output/static/_nowaki
# the function must NOT carry a nested preact (would double-instance and break hooks)
! test -d examples/hello/.vercel/output/functions/index.func/node_modules/@nowaki-dev/runtime/node_modules
# Started with its PID kept, so it is stopped below (a subshell left it running after the script).
(cd examples/hello/.vercel/output/functions/index.func \
  && exec node -e 'import("./index.mjs").then(m=>require("http").createServer(m.default).listen(3320))') &
VERCEL_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3320/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3320/ | grep -q "nowaki-island"
curl -sf http://127.0.0.1:3320/api/hello | grep -q '"hello":"nowaki"'
curl -sf http://127.0.0.1:3320/docs/intro | grep -q '<h2 id="why-content-collections"'   # content on vercel
curl -sf http://127.0.0.1:3320/nav | grep -q 'href="/blog/hello"'
kill $VERCEL_PID
