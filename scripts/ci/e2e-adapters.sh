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
# ISR cache headers reach the CDN directly here (0.16.2): a cookie-dependent page is private, a
# header-dependent one names the header in Vary, one that reads nothing stays public
curl -s -D - -o /dev/null -H 'cookie: user=alice' http://127.0.0.1:3310/isr-cookie | grep -qi '^cache-control: private'
! curl -s -D - -o /dev/null -H 'cookie: user=alice' http://127.0.0.1:3310/isr-cookie | grep -qi '^cache-control:.*s-maxage'
curl -s -D - -o /dev/null -H 'accept-language: de' http://127.0.0.1:3310/vary | grep -qi '^vary:.*accept-language'
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr | grep -qi '^cache-control: public, s-maxage='
# route / layout CSS: linked in the head, served as text/css (0.16.1)
curl -sf http://127.0.0.1:3310/styled | grep -qE '<link rel="stylesheet" href="/_nowaki/styled\.[0-9a-f]+\.css"'
curl -sf http://127.0.0.1:3310/about | grep -qE '<link rel="stylesheet" href="/_nowaki/site\.[0-9a-f]+\.css"'
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
# file routes: feed.xml.ts (static) and og/[card].png.ts (a param with a fixed extension, bytes)
curl -s -D - -o /dev/null http://127.0.0.1:3310/feed.xml | grep -qi '^content-type: application/xml'
curl -sf http://127.0.0.1:3310/feed.xml | grep -q '<rss version="2.0">'
curl -s -D - -o /dev/null http://127.0.0.1:3310/og/intro.png | grep -qi '^content-type: image/png'
curl -sf http://127.0.0.1:3310/og/intro.png | head -c 4 | od -An -c | grep -q 'P   N   G'
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3310/og/nope.png)" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3310/og/intro.jpg)" = 404
# fonts on the node adapter (dist/server/fonts.json)
curl -sf http://127.0.0.1:3310/about | grep -qE '<link rel="stylesheet" href="/_nowaki/fonts\.[0-9a-f]+\.css" />'
# MDX entries render from their compiled module on the node adapter
curl -sf http://127.0.0.1:3310/docs/components | grep -q 'an expression (42), and highlighted code'
# the node adapter reads the site from dist/server/site.json
curl -sf http://127.0.0.1:3310/sitemap.xml | grep -q '<loc>https://hello.nowaki.dev/</loc>'
curl -sf http://127.0.0.1:3310/docs/intro | grep -q 'og:url" content="https://hello.nowaki.dev/docs/intro"'
# htmlAttrs / bodyAttrs on the node adapter (document.mjs)
curl -sf http://127.0.0.1:3310/styled | grep -q '<html lang="ja" data-sheet-rev="3" data-theme="paper" data-nowaki-attrs="data-sheet-rev data-theme">'
curl -sf http://127.0.0.1:3310/styled | grep -q '<body class="site styled-page" data-site="hello"'
# public/ on the node adapter (dist/server reads ../public)
curl -s -D - http://127.0.0.1:3310/robots.txt | grep -qi '^content-type: text/plain'
curl -sf http://127.0.0.1:3310/raw.css | grep -q '^\.raw { color: red; }'
curl -sf "http://127.0.0.1:3310/media/hello%20world.txt" | grep -q 'hello from public'
! curl -sf http://127.0.0.1:3310/.hidden | grep -q 'never served'
test "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $(curl -s -D - -o /dev/null http://127.0.0.1:3310/robots.txt | tr -d '\r' | awk 'tolower($1)=="etag:" {print $2}')" http://127.0.0.1:3310/robots.txt)" = 304
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
grep -qE '<link rel="stylesheet" href="/_nowaki/styled\.[0-9a-f]+\.css"' examples/hello/dist/static/styled/index.html
ls examples/hello/dist/static/_nowaki/styled.*.css >/dev/null
# live islands on a static host: their first HTML, but no live.js (no server for its events), and
# the build says which pages they are on (#93)
grep -q 'nowaki-live name="LiveCounter"' examples/hello/dist/static/live/index.html
! grep -q '/_nowaki/live\.' examples/hello/dist/static/live/index.html
! grep -q '/_nowaki/live\.' examples/hello/dist/static/poll/index.html
# the SPA router's boundaries fetch is answered by a static file (no 404 on static hosts)
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(b.loading)||!Array.isArray(b.error)||!b.loading.length) process.exit(1)' examples/hello/dist/static/__nowaki/boundaries
grep -q '/__nowaki/boundaries' examples/hello/dist/static/_headers
grep -qi 'x-content-type-options: nosniff' examples/hello/dist/static/_headers
# images in the static output: the gallery's variants and the Markdown entry's picture
grep -qE '<source type="image/avif" srcset="/_nowaki/hero-640\.[0-9a-f]+\.avif' examples/hello/dist/static/gallery/index.html
grep -qE '<picture><source type="image/avif"' examples/hello/dist/static/docs/intro/index.html
ls examples/hello/dist/static/_nowaki/hero-640.*.avif >/dev/null
# fonts in the static output: the stylesheet and face under _nowaki/
grep -qE '<link rel="preload" href="/_nowaki/atkinson-hyperlegible-400-normal\.[0-9a-f]+\.ttf"' examples/hello/dist/static/about/index.html
ls examples/hello/dist/static/_nowaki/fonts.*.css >/dev/null
grep -q '<p id="greeting">Hello from data/</p>' examples/hello/dist/static/about/index.html
# MDX in the static output: the page and the entry (an island inside it)
grep -q '<h1 id="an-mdx-page">An MDX page</h1>' examples/hello/dist/static/guide/index.html
grep -q '<nowaki-island name="Counter"' examples/hello/dist/static/docs/components/index.html
# SEO in the static output: sitemap.xml generated against the site, public/robots.txt kept
grep -q '<loc>https://hello.nowaki.dev/docs/intro</loc>' examples/hello/dist/static/sitemap.xml
! grep -qE '/boom<|/secret<' examples/hello/dist/static/sitemap.xml
grep -q 'User-agent: \*' examples/hello/dist/static/robots.txt
grep -q '<link rel="canonical" href="https://hello.nowaki.dev/docs/intro" />' examples/hello/dist/static/docs/intro/index.html
# file routes are written to their own path (not feed.xml/index.html), bytes intact
grep -q '<rss version="2.0">' examples/hello/dist/static/feed.xml
head -c 4 examples/hello/dist/static/og/intro.png | od -An -c | grep -q 'P   N   G'
test -f examples/hello/dist/static/og/routing.png
! test -e examples/hello/dist/static/feed.xml/index.html
grep -q '<html lang="ja" data-sheet-rev="3"' examples/hello/dist/static/styled/index.html
grep -q '<body class="site styled-page"' examples/hello/dist/static/styled/index.html
# public/ files at their own path in the static output, dotfiles left out
grep -q 'User-agent' examples/hello/dist/static/robots.txt
grep -q 'hello from public' "examples/hello/dist/static/media/hello world.txt"
test -f examples/hello/dist/static/.well-known/security.txt
! test -e examples/hello/dist/static/.hidden
# cloudflare (edge) adapter: generates a bundled fetch-handler worker + wrangler config
./target/debug/nowaki build examples/hello --adapter cloudflare
# the worker's fetch handler, called directly in Node (web.mjs end to end, no wrangler)
node scripts/edge-handler-test.mjs examples/hello/dist/worker
test -f examples/hello/dist/worker/index.js
test -f examples/hello/dist/worker/wrangler.jsonc
grep -q "createFetchHandler" examples/hello/dist/worker/index.js
grep -q '"binding": "ASSETS"' examples/hello/dist/worker/wrangler.jsonc
# one Assets directory: dist/client under _nowaki/, public/ at the top
grep -q '"directory": "./assets"' examples/hello/dist/worker/wrangler.jsonc
ls examples/hello/dist/worker/assets/_nowaki/manifest.json >/dev/null
grep -q 'User-agent' examples/hello/dist/worker/assets/robots.txt
! test -e examples/hello/dist/worker/assets/.hidden
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
# public/ files are static files at their own path, with the security headers by exact-path route
grep -q 'User-agent' examples/hello/.vercel/output/static/robots.txt
! test -e examples/hello/.vercel/output/static/.hidden
grep -q 'media/hello%20world' examples/hello/.vercel/output/config.json
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
