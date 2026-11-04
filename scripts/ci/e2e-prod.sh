#!/usr/bin/env bash
# CI: Production build + scope hoisting + preload + serve
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."

# stdout stays in the log; stderr is captured for the unvalidated-server-function warning.
{ BUILD_ERR=$(./target/debug/nowaki build examples/hello 2>&1 1>&3 3>&-); } 3>&1
echo "$BUILD_ERR" >&2
# actions/todos.ts#addTodoForm takes input without serverFn(schema, impl); addTodo is wrapped.
echo "$BUILD_ERR" | grep -q 'take unvalidated input: actions/todos.ts#addTodoForm\.'
test -f examples/hello/dist/client/manifest.json
grep -q '"preload"' examples/hello/dist/client/manifest.json
# asset optimization: the sub-optimal source photo.png (~256 KB, stored zlib)
# is losslessly re-compressed to a fraction of its size in dist/client.
PHOTO=$(ls examples/hello/dist/client/photo.*.png | head -1)
test "$(wc -c < "$PHOTO")" -lt "$(wc -c < examples/hello/photo.png)"
test "$(wc -c < "$PHOTO")" -lt 50000   # 256 KB → a few KB
# scope hoisting: the cyclic lib modules are concatenated into the Cycle
# island chunk, not emitted as separate files, and the chunk has no
# internal ./cycle- import (the cycle is resolved within one scope).
! ls examples/hello/dist/client/cycle-a.*.js >/dev/null 2>&1
CY=$(ls examples/hello/dist/client/Cycle.*.js | head -1)
! grep -q './cycle-' "$CY"
# v0.6 Jetstream build: the live island ships NO client component JS (only live.js),
# is listed in the manifest, and is still built as a server module for rendering.
grep -q '"liveIslands": \["LiveCounter", "LiveTicks", "LiveTodos"\]' examples/hello/dist/client/manifest.json
! ls examples/hello/dist/client/LiveCounter.*.js >/dev/null 2>&1
ls examples/hello/dist/client/live.*.js >/dev/null 2>&1
test -f examples/hello/dist/server/islands/LiveCounter.js
# nowaki start (Rust front) serves the live island, assembled with live.js
./target/debug/nowaki start examples/hello --port 3300 &
START_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3300/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3300/ | grep -q "modulepreload"
curl -sf http://127.0.0.1:3300/ | grep -q '<code>a→b</code>'
# CSS Modules: prod SSR must use the same scoped class names as dev (css_scope_id).
PROD_BADGE=$(curl -sf http://127.0.0.1:3300/ | grep -oE 'badge_[0-9a-f]{8}' | head -1)
test -n "$PROD_BADGE"
if test -f /tmp/nowaki-css-module-badge-class; then
  test "$PROD_BADGE" = "$(cat /tmp/nowaki-css-module-badge-class)"
fi
! curl -sf http://127.0.0.1:3300/ | grep -qE '/Users/|/home/[^/]+/'
# lazy SPA router: runtime script carries data-router, and the router chunk is
# NOT eagerly preloaded (it loads on idle, keeping first-load JS small).
curl -sf http://127.0.0.1:3300/ | grep -q 'id="nowaki-runtime"[^>]*data-router='
! curl -s http://127.0.0.1:3300/ | grep -qE 'modulepreload[^>]*/router\.[0-9a-f]+\.js'
curl -sf http://127.0.0.1:3300/live | grep -q 'nowaki-live name="LiveCounter"'
curl -sf http://127.0.0.1:3300/live | grep -q 'live\.'  # live.js script
# v0.8 server functions in production: allowlist written, no impl leaked to
# the client, and the Rust front proxies /__nowaki/fn to the renderer.
test -f examples/hello/dist/server/functions.json
grep -q '"export": "addTodo"' examples/hello/dist/server/functions.json
! grep -rl 'nowaki-server-only-secret' examples/hello/dist/client >/dev/null 2>&1
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -d '{"id":"6c90d7dc921a9a3f","args":[]}' http://127.0.0.1:3300/__nowaki/fn | grep -q 'learn nowaki'
# v0.9 virtual modules: SSR inlines the plugin-generated module (data:)
curl -sf http://127.0.0.1:3300/virtual | grep -q 'VIRTUAL_OK · nowaki-plugin'
# ISR (export const revalidate=2): the Rust front caches assembled HTML and
# regenerates it in the background once stale. Cold hit MISSes & populates;
# the next is a HIT with the same render number; after the 2s window a STALE
# response is served (old HTML) while a fresh render runs in the background;
# the following hit is fresh (render number incremented).
ISR=http://127.0.0.1:3300/isr
chit() { curl -s -D - -o /tmp/isr.html "$ISR" | grep -i '^x-nowaki-cache:' | tr -d '\r' | awk '{print $2}'; }
rnum() { grep -o 'isr-renders">[0-9]*' /tmp/isr.html | grep -o '[0-9]*'; }
# Each step logs the cache status, render number, and time, so a failure shows what was served.
T0=$(date +%s)
isr() { S=$(chit); N=$(rnum); echo "ISR $1: status=$S render=$N (R1=${R1:-?}, +$(( $(date +%s) - T0 ))s)"; }
isr miss; test "$S" = "MISS"; R1=$N
curl -s -D - -o /dev/null "$ISR" | grep -qi 'cache-control: public, s-maxage=2, stale-while-revalidate'
isr hit; test "$S" = "HIT"; test "$N" = "$R1"
sleep 3
isr stale; test "$S" = "STALE"; test "$N" = "$R1"   # stale HTML served immediately
sleep 1                                            # let background revalidation finish
isr regenerated; test "$S" = "HIT"; test "$N" -gt "$R1"
# a cookie-setting response is per-user and must never be ISR-cached
test -z "$(curl -s -D - -o /dev/null "$ISR" | grep -i '^set-cookie:')"
# loading/error boundaries are served through the Rust front too
curl -sf http://127.0.0.1:3300/__nowaki/boundaries | grep -q 'data-nowaki-reset'
# v0.9 Jetstream presence + connection scaling: WS join->presence,
# event->patch round-trip, presence rises/falls across two connections.
node scripts/livetest.mjs http://127.0.0.1:3300
# --- application-security regressions (prod): no absolute build-machine path
# leaks into client assets (#9), and ISR keys isolate per-header (no cross-user
# leak) and collapse unused-query floods (#6/#7).
! grep -rl "$HOME" examples/hello/dist/client
node scripts/security-e2e.mjs prod http://127.0.0.1:3300
kill $START_PID
bash scripts/ci/assert-no-orphans.sh $START_PID

# CSP (opt-in): every script/style gets the response's nonce, ISR hits included.
NOWAKI_CSP=enforce ./target/debug/nowaki start examples/hello --port 3302 &
CSP_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3302/ >/dev/null && break; sleep 1; done
node scripts/csp-e2e.mjs http://127.0.0.1:3302
kill $CSP_PID
bash scripts/ci/assert-no-orphans.sh $CSP_PID

# Jetstream render timeout: with a 150 ms limit, the 400 ms `slow` handler is reported as an error
# and the connection keeps working.
NOWAKI_LIVE_RENDER_TIMEOUT_MS=150 ./target/debug/nowaki start examples/hello --port 3301 &
TIMEOUT_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3301/ >/dev/null && break; sleep 1; done
node scripts/livetest.mjs http://127.0.0.1:3301 --expect-timeout
kill $TIMEOUT_PID
bash scripts/ci/assert-no-orphans.sh $TIMEOUT_PID
