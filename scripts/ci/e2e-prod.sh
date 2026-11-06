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
# HEAD mirrors GET (status and headers, no body): assets, public/ files, pages
test "$(curl -s -I -o /dev/null -w '%{http_code}' "$ASSET")" = 200
curl -s -I "$ASSET" | grep -qi '^content-type: text/javascript'
test "$(curl -s -I "$ASSET" -o /dev/null -w '%{size_download}')" = 0
test "$(curl -s -I -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/raw.css)" = 200
test "$(curl -s -I -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/about)" = 200
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
SC_ISR=http://127.0.0.1:3300/isr-sets-cookie
curl -s -D - -o /dev/null "$SC_ISR" | grep -qi '^cache-control: private, no-cache'
! curl -s -D - -o /dev/null "$SC_ISR" | grep -qiE '^cache-control:.*(public|s-maxage)'
! curl -s -D - -o /dev/null "$SC_ISR" | grep -qiE '^x-nowaki-cache: (HIT|STALE)'
test "$(curl -s "$SC_ISR" | grep -o 'RENDER=[0-9]*')" != "$(curl -s "$SC_ISR" | grep -o 'RENDER=[0-9]*')"
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
# ?image + <Image> in the build: hashed AVIF / JPEG variants under /_nowaki/, served as images
G=$(curl -sf http://127.0.0.1:3300/gallery)
echo "$G" | grep -qE '<source type="image/avif" srcset="/_nowaki/hero-640\.[0-9a-f]+\.avif 640w, /_nowaki/hero-960\.[0-9a-f]+\.avif 960w, /_nowaki/hero-1200\.[0-9a-f]+\.avif 1200w"'
# alt="" renders as a bare `alt` (still an empty alt for screen readers)
echo "$G" | grep -q 'width="320" height="200" alt loading="lazy"'
AV=$(echo "$G" | grep -oE '/_nowaki/hero-640\.[0-9a-f]+\.avif' | head -1)
curl -s -D - -o /dev/null "http://127.0.0.1:3300$AV" | grep -qi '^content-type: image/avif'
curl -sf http://127.0.0.1:3300/docs/intro | grep -qE '<picture><source type="image/avif" srcset="/_nowaki/hero-640\.[0-9a-f]+\.avif'
# fonts: preload + stylesheet first in every page's head; the face and its sized fallback
FH=$(curl -sf http://127.0.0.1:3300/about)
echo "$FH" | grep -qE '<link rel="preload" href="/_nowaki/atkinson-hyperlegible-400-normal\.[0-9a-f]+\.ttf" as="font" type="font/ttf" crossorigin />'
FCSS=$(echo "$FH" | grep -oE '/_nowaki/fonts\.[0-9a-f]+\.css' | head -1)
curl -sf "http://127.0.0.1:3300$FCSS" | grep -q 'font-family: "Atkinson Hyperlegible Fallback";'
curl -sf "http://127.0.0.1:3300$FCSS" | grep -q 'size-adjust: '
curl -sf "http://127.0.0.1:3300$FCSS" | grep -q -- '--font-body: "Atkinson Hyperlegible", "Atkinson Hyperlegible Fallback", sans-serif;'
FT=$(echo "$FH" | grep -oE '/_nowaki/atkinson-hyperlegible-400-normal\.[0-9a-f]+\.ttf' | head -1)
curl -s -D - -o /dev/null "http://127.0.0.1:3300$FT" | grep -qi '^content-type: font/ttf'
# from porting an Astro site: a layout's head, CSS @import inlined, modules outside the
# conventional folders, and no SPA router on a page without islands (dev and prod alike)
curl -sf http://127.0.0.1:3300/about | grep -q '<meta name="x-layout-head" content="root" />'
curl -sf http://127.0.0.1:3300/about | grep -q '<p id="greeting">Hello from data/</p>'
! curl -sf http://127.0.0.1:3300/about | grep -q 'id="nowaki-runtime"'
SC=$(curl -sf http://127.0.0.1:3300/about | grep -oE '/_nowaki/site\.[0-9a-f]+\.css' | head -1)
curl -sf "http://127.0.0.1:3300$SC" | grep -q -- '--site-token: rgb(9, 8, 7)'
! curl -sf "http://127.0.0.1:3300$SC" | grep -q '@import'
# MDX: a .mdx page (ESM exports, expressions, GFM, an island) and an .mdx content entry
curl -sf http://127.0.0.1:3300/guide | grep -q '<title>Guide (MDX) — Nowaki</title>'
curl -sf http://127.0.0.1:3300/guide | grep -q '<h1 id="an-mdx-page">An MDX page</h1>'
curl -sf http://127.0.0.1:3300/guide | grep -q '1 + 1 = 2.</p>'
curl -sf http://127.0.0.1:3300/guide | grep -q '<th align="left">Feature</th>'
curl -sf http://127.0.0.1:3300/guide | grep -q '<nowaki-island name="Counter"'
curl -sf http://127.0.0.1:3300/docs/components | grep -q 'an expression (42), and highlighted code'
curl -sf http://127.0.0.1:3300/docs/components | grep -q 'client="visible"'
curl -sf http://127.0.0.1:3300/docs/components | grep -q '<pre style="background-color:#ffffff;"><code class="language-ts"><span'
curl -sf http://127.0.0.1:3300/docs/components | grep -q '<picture><source type="image/avif"'
curl -sf http://127.0.0.1:3300/docs | grep -q 'Components in MDX'
# ctx.url.origin is the browser's Host, not the sidecar's loopback address
curl -sf -H 'Host: app.example' "http://127.0.0.1:3300/api/echo" | grep -q '"origin":"http://app.example"'
# SEO: typed meta → head tags (absolute against nowaki.config `site`), generated sitemap.xml
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<link rel="canonical" href="https://hello.nowaki.dev/docs/intro" />'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<meta property="og:image" content="https://hello.nowaki.dev/og/intro.png" />'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<meta property="og:site_name" content="Nowaki demo" />'
curl -sf http://127.0.0.1:3300/docs/intro | grep -q '<script type="application/ld+json">{"@context":"https://schema.org"'
curl -sf http://127.0.0.1:3300/boom | grep -q '<meta name="robots" content="noindex, follow" />'
curl -s -D - -o /dev/null http://127.0.0.1:3300/sitemap.xml | grep -qi '^content-type: application/xml'
curl -sf http://127.0.0.1:3300/sitemap.xml | grep -q '<loc>https://hello.nowaki.dev/docs/intro</loc>'
! curl -sf http://127.0.0.1:3300/sitemap.xml | grep -qE '/boom<|/secret<|/api/|feed.xml'
curl -sf http://127.0.0.1:3300/robots.txt | grep -q 'User-agent'   # public/robots.txt wins over the generated one
curl -sf http://127.0.0.1:3300/feed.xml | grep -q '<link>https://hello.nowaki.dev/docs/intro</link>'
# page scripts: bundled to /_nowaki/stamp.<hash>.js with preloads for its chunks, counted in the
# route's first-load JS
curl -sf http://127.0.0.1:3300/scripted | grep -qE '<script type="module" src="/_nowaki/stamp\.[0-9a-f]+\.js" data-nowaki-script></script>'
curl -sf http://127.0.0.1:3300/scripted | grep -qE '<link rel="modulepreload" href="/_nowaki/stamp-label\.[0-9a-f]+\.js" />'
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const s=(r.routes??r).find((x)=>x.url==="/scripted"); if(!s||!s.chunks.some((c)=>c.startsWith("stamp."))) process.exit(1)' examples/hello/dist/route-js.json
# file routes: feed.xml.ts (static) and og/[card].png.ts (a param with a fixed extension, bytes)
curl -s -D - -o /dev/null http://127.0.0.1:3300/feed.xml | grep -qi '^content-type: application/xml'
curl -sf http://127.0.0.1:3300/feed.xml | grep -q '<rss version="2.0">'
curl -s -D - -o /dev/null http://127.0.0.1:3300/og/intro.png | grep -qi '^content-type: image/png'
curl -sf http://127.0.0.1:3300/og/intro.png | head -c 4 | od -An -c | grep -q 'P   N   G'
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/og/nope.png)" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/og/intro.jpg)" = 404
# htmlAttrs / bodyAttrs in the Rust-assembled document
curl -sf http://127.0.0.1:3300/styled | grep -q '<html lang="ja" data-sheet-rev="3" data-theme="paper" data-nowaki-attrs="data-sheet-rev data-theme">'
curl -sf http://127.0.0.1:3300/styled | grep -q '<body class="site styled-page" data-site="hello" data-quote="&quot;&lt;x&gt;&quot;" data-nowaki-attrs="class data-site data-quote">'
! curl -sf http://127.0.0.1:3300/styled | grep -q 'onload'
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
# (/isr-sets-cookie sets a cookie, so it is never cached)
grep -q 'ISR warm-up: 3 of 4 pages cached' /tmp/nowaki-warm.log
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

# SIGKILL can't stop the children, so they exit when their stdin pipe closes (exit-with-parent.mjs):
# nothing may linger with PID 1 as its parent.
./target/debug/nowaki start examples/hello --port 3305 &
KILL_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3305/ >/dev/null && break; sleep 1; done
kill -9 $KILL_PID
bash scripts/ci/assert-no-orphans.sh $KILL_PID
