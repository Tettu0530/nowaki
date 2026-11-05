#!/usr/bin/env bash
# CI: Production build + scope hoisting + preload + serve
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."
# A request to a hung server must fail, not wait forever; and on Windows, where hangs have been
# seen, trace every command so the log shows where one stopped.
curl() { command curl --max-time 30 "$@"; }
if [ "${RUNNER_OS:-}" = Windows ]; then set -x; fi

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
grep -qE '"liveIslands": \[[^]]*"LiveCounter"' examples/hello/dist/client/manifest.json
! ls examples/hello/dist/client/LiveCounter.*.js >/dev/null 2>&1
ls examples/hello/dist/client/live.*.js >/dev/null 2>&1
test -f examples/hello/dist/server/islands/LiveCounter.js
# nowaki start (Rust front) serves the live island, assembled with live.js
rm -f examples/hello/.nowaki/live-rooms.json   # rooms start empty; the livetest votes in /poll
# No ISR warm-up here: the ISR checks below start from an empty cache (MISS → HIT → STALE).
NOWAKI_ISR_WARM=0 ./target/debug/nowaki start examples/hello --port 3300 &
START_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3300/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3300/ | grep -q "modulepreload"
# Pre-compressed assets and ISR pages: br / gzip by Accept-Encoding, weak ETag, 304 on a match.
ls examples/hello/dist/client/preact.*.js.br examples/hello/dist/client/preact.*.js.gz >/dev/null
ASSET=http://127.0.0.1:3300/_nowaki/$(basename "$(ls examples/hello/dist/client/preact.*.js | head -1)")
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, br' "$ASSET" | grep -qi '^content-encoding: br'
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' "$ASSET" | grep -qi '^content-encoding: gzip'
! curl -s -o /dev/null -D - "$ASSET" | grep -qi '^content-encoding'
ETAG=$(curl -s -o /dev/null -D - "$ASSET" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')
test "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$ASSET")" = 304
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
# ISR hits are compressed once and answer If-None-Match with 304.
curl -s -o /dev/null -D - -H 'Accept-Encoding: br' http://127.0.0.1:3300/isr | grep -qi '^content-encoding: br'
ISR_ETAG=$(curl -s -o /dev/null -D - http://127.0.0.1:3300/isr | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')
test "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ISR_ETAG" http://127.0.0.1:3300/isr)" = 304
curl -s --compressed http://127.0.0.1:3300/isr | grep -q '</html>'
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
# content collections: Markdown rendered at build time, headings with anchors, a TOC from them,
# and the docs list ordered by frontmatter
curl -sf http://127.0.0.1:3300/docs | grep -q 'href="/docs/intro">Introduction</a></li><li><a href="/docs/routing"'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<h2 id="why-content-collections"'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q 'href="#next-steps"'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<title>Introduction — Nowaki docs</title>'
# fenced code is highlighted at build time (inline styles, no client JS)
curl -sf http://127.0.0.1:3300/docs/routing | grep -q '<pre style="background-color:#ffffff;">'
curl -sf http://127.0.0.1:3300/docs/routing | grep -q '<span style="font-weight:bold;color:#a71d5d;">export'
# route / layout CSS (0.16.1): the layout's and the page's stylesheets are linked in the head and
# served as text/css; a plain .css import's default export is its text (inlined by /styled's head)
curl -sf http://127.0.0.1:3300/about | grep -qE '<link rel="stylesheet" href="/_nowaki/site\.[0-9a-f]+\.css"'
# public/ (copied to dist/public): as-is, ETag + 304, HEAD, dotfiles hidden except .well-known
test -f examples/hello/dist/public/robots.txt
! test -e examples/hello/dist/public/.hidden
curl -s -D - http://127.0.0.1:3300/robots.txt | grep -qi '^content-type: text/plain'
curl -s -D - -o /dev/null http://127.0.0.1:3300/robots.txt | grep -qi '^cache-control: public, no-cache'
curl -s -D - -o /dev/null http://127.0.0.1:3300/robots.txt | grep -qi '^x-content-type-options: nosniff'
curl -sf http://127.0.0.1:3300/raw.css | grep -q '^\.raw { color: red; }'
curl -sf "http://127.0.0.1:3300/media/hello%20world.txt" | grep -q 'hello from public'
curl -sf http://127.0.0.1:3300/.well-known/security.txt | grep -q 'Contact:'
! curl -sf http://127.0.0.1:3300/.hidden | grep -q 'never served'
PUB_ETAG=$(curl -s -D - -o /dev/null http://127.0.0.1:3300/robots.txt | tr -d '\r' | awk 'tolower($1)=="etag:" {print $2}')
test -n "$PUB_ETAG"
test "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $PUB_ETAG" http://127.0.0.1:3300/robots.txt)" = 304
test "$(curl -s -o /dev/null -w '%{http_code}' -I http://127.0.0.1:3300/robots.txt)" = 200
STYLED=$(curl -sf http://127.0.0.1:3300/styled)
echo "$STYLED" | grep -qE '<link rel="stylesheet" href="/_nowaki/styled\.[0-9a-f]+\.css"'
echo "$STYLED" | grep -q '<style>#styled-probe{color:rgb(1, 2, 3)}</style>'
SHEET=$(echo "$STYLED" | grep -oE '/_nowaki/styled\.[0-9a-f]+\.css' | head -1)
curl -s -D - -o /dev/null "http://127.0.0.1:3300$SHEET" | grep -qi '^content-type: text/css'
curl -sf "http://127.0.0.1:3300$SHEET" | grep -q 'rgb(4, 5, 6)'
# Streamed responses pass through as written: with 600 ms between two chunks, the first byte
# arrives long before the last (it used to wait for the whole body).
FB=$(curl -s -N -o /dev/null -w '%{time_starttransfer}' "http://127.0.0.1:3300/api/stream?delay=600")
awk -v t="$FB" 'BEGIN { exit !(t < 0.3) }'
test "$(curl -s 'http://127.0.0.1:3300/api/stream?delay=50' | tr -d '\n')" = "chunk1chunk2"
# streaming = "early": the shell goes out before the 300 ms loader; a loader error renders
# error.tsx in the page (status stays 200) and a loader redirect becomes location.replace (#112)
FB=$(curl -s -N -o /tmp/nowaki-early.html -w '%{time_starttransfer}' http://127.0.0.1:3300/stream-early)
awk -v t="$FB" 'BEGIN { exit !(t < 0.2) }'
grep -q 'data-testid="early"' /tmp/nowaki-early.html
grep -q '<title>Early streaming' /tmp/nowaki-early.html
test "$(curl -s -o /tmp/nowaki-early-fail.html -w '%{http_code}' 'http://127.0.0.1:3300/stream-early?fail=1')" = 200
grep -q "Couldn't display this page" /tmp/nowaki-early-fail.html
! grep -q 'the data source is down' /tmp/nowaki-early-fail.html   # no message in production
curl -s 'http://127.0.0.1:3300/stream-early?go=1' | grep -q 'location.replace("/about")'
# The build's first-load JS report matches the chunks each page actually references.
test -f examples/hello/dist/route-js.json
node scripts/route-js-e2e.mjs http://127.0.0.1:3300 examples/hello
# Windows has no SIGTERM for the sidecar, so rooms rely on the periodic write (every 2 s): wait for
# it there. Elsewhere `kill` is a SIGTERM, and the sidecar must write the rooms on its way out.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) sleep 3 ;; esac
kill $START_PID
bash scripts/ci/assert-no-orphans.sh $START_PID
# Rooms survive a restart: on SIGTERM the sidecar wrote them to .nowaki/live-rooms.json.
ROOMS=examples/hello/.nowaki/live-rooms.json
test -f "$ROOMS"
VOTES_A=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.rooms["poll:demo"].a))' "$ROOMS")
test "$VOTES_A" -ge 1

# CSP (opt-in): every script/style gets the response's nonce, ISR hits included.
NOWAKI_CSP=enforce ./target/debug/nowaki start examples/hello --port 3302 &
CSP_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3302/ >/dev/null && break; sleep 1; done
node scripts/csp-e2e.mjs http://127.0.0.1:3302
# (the restarted server renders the saved votes)
curl -sf http://127.0.0.1:3302/poll | grep -q "a: $VOTES_A "
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

# ISR warm-up (on by default): right after startup the ISR pages are already cached, so the
# first request is a HIT (or STALE), never a MISS. The internal URL list is not public.
./target/debug/nowaki start examples/hello --port 3304 > /tmp/nowaki-warm.log &
WARM_PID=$!
for i in $(seq 1 20); do grep -q 'ISR warm-up' /tmp/nowaki-warm.log && break; sleep 1; done
grep -q 'ISR warm-up: 3 of 3 pages cached' /tmp/nowaki-warm.log
FIRST=$(curl -s -o /dev/null -D - http://127.0.0.1:3304/vary | tr -d '\r' | sed -n 's/^[Xx]-[Nn]owaki-[Cc]ache: //p')
test "$FIRST" = HIT -o "$FIRST" = STALE
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3304/__nowaki/isr-urls)" = 404
kill $WARM_PID
bash scripts/ci/assert-no-orphans.sh $WARM_PID

# Expired live signatures: with a 3 s max age, an old page's events come back as "stale" (WS) / 409 (POST).
NOWAKI_LIVE_MAX_AGE=3 ./target/debug/nowaki start examples/hello --port 3303 &
STALE_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3303/ >/dev/null && break; sleep 1; done
node scripts/livetest.mjs http://127.0.0.1:3303 --expect-stale 3
kill $STALE_PID
bash scripts/ci/assert-no-orphans.sh $STALE_PID
