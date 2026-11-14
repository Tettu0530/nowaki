#!/usr/bin/env bash
# CI: builds examples/hello with each deploy adapter and checks the output: the node adapter's
# server over HTTP (ports 3310-3312), static output on disk, the cloudflare worker called in Node,
# and the vercel function over HTTP (3320). Then runs rules-e2e.mjs, i18n-e2e.mjs and
# gallery-e2e.mjs on the adapters.
# Needs `cargo build -p nowaki` and `pnpm install`; run as `bash scripts/ci/e2e-adapters.sh`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
# A failed step exits here: stop the servers this script started, or they keep the ports.
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
cd "$(dirname "$0")/../.."
# A request to a hung server must fail, not wait forever; and on Windows, where hangs have been
# seen, trace every command so the log shows where one stopped.
curl() { command curl --max-time 30 "$@"; }
if [ "${RUNNER_OS:-}" = Windows ]; then set -x; fi
# ctx.session (routes/api/session.ts) needs a secret in production.
export NOWAKI_SESSION_SECRET="${NOWAKI_SESSION_SECRET:-e2e-session-secret-0123456789abcdef}"

# node adapter: build emits a self-contained server entry runnable WITHOUT the nowaki binary
./target/debug/nowaki build examples/hello --adapter node
test -f examples/hello/dist/server/index.mjs
test -f examples/hello/dist/server/package.json
PORT=3310 node examples/hello/dist/server/index.mjs &
NODE_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3310/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3310/ | grep -q "nowaki-island"   # SSR + island marker
# HMR and the dev toolbar are dev-only: no trace of them in a production page
! curl -sf http://127.0.0.1:3310/ | grep -qE 'hmr\.js|toolbar\.js|refresh\.js|data-toolbar|__nowaki/(hmr|devtools)' || exit 1
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3310/__nowaki/devtools?url=/)" = 404
# ISR cache headers reach the CDN directly here: a cookie-dependent page is private, a
# header-dependent one names the header in Vary, one that reads nothing stays public
curl -s -D - -o /dev/null -H 'cookie: user=alice' http://127.0.0.1:3310/isr-cookie | grep -qi '^cache-control: private'
! curl -s -D - -o /dev/null -H 'cookie: user=alice' http://127.0.0.1:3310/isr-cookie | grep -qi '^cache-control:.*s-maxage' || exit 1
curl -s -D - -o /dev/null -H 'accept-language: de' http://127.0.0.1:3310/vary | grep -qi '^vary:.*accept-language'
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr | grep -qi '^cache-control: public, s-maxage='
# no CDN tag header off the vercel adapter (nothing here could purge by it)
! curl -s -D - -o /dev/null http://127.0.0.1:3310/isr-tagged | grep -qi '^vercel-cache-tag:' || exit 1
# an ISR page that sets a cookie is per-user: never shared-cacheable next to Set-Cookie
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr-sets-cookie | grep -qi '^set-cookie: visited=1'
curl -s -D - -o /dev/null http://127.0.0.1:3310/isr-sets-cookie | grep -qi '^cache-control: private, no-cache'
! curl -s -D - -o /dev/null http://127.0.0.1:3310/isr-sets-cookie | grep -qiE '^cache-control:.*(public|s-maxage)' || exit 1
# route and layout CSS is linked in the head
curl -sf http://127.0.0.1:3310/styled | grep -qE '<link rel="stylesheet" href="/_nowaki/styled\.[0-9a-f]+\.css"'
curl -sf http://127.0.0.1:3310/about | grep -qE '<link rel="stylesheet" href="/_nowaki/site\.[0-9a-f]+\.css"'
# `export const viewTransition` through the node adapter's document (document.mjs prodDocument)
curl -sf http://127.0.0.1:3310/vt | grep -q '<meta name="nowaki-view-transition" content="1" />'
! curl -s http://127.0.0.1:3310/about | grep -qE 'nowaki-view-transition|@view-transition' || exit 1
# streaming = "early": the shell goes out before the 300 ms loader; a loader error renders
# error.tsx in the page (status stays 200) and a loader redirect becomes location.replace (#112)
FB=$(curl -s -N -o /tmp/nowaki-early.html -w '%{time_starttransfer}' http://127.0.0.1:3310/stream-early)
awk -v t="$FB" 'BEGIN { exit !(t < 0.2) }'
grep -q 'data-testid="early"' /tmp/nowaki-early.html
grep -q '<title>Early streaming' /tmp/nowaki-early.html
test "$(curl -s -o /tmp/nowaki-early-fail.html -w '%{http_code}' 'http://127.0.0.1:3310/stream-early?fail=1')" = 200
grep -q "Couldn't display this page" /tmp/nowaki-early-fail.html
! grep -q 'the data source is down' /tmp/nowaki-early-fail.html || exit 1  # no message in production
curl -s 'http://127.0.0.1:3310/stream-early?go=1' | grep -q 'location.replace("/about")'
curl -sf http://127.0.0.1:3310/api/hello | grep -q '"hello":"nowaki"'
# no internal x-nowaki-* response header, no Set-Cookie on a shared-cacheable response (node)
node scripts/security-e2e.mjs headers http://127.0.0.1:3310 "node adapter"
# /__nowaki/health is answered before routing, never cached; no Server-Timing unless asked for
test "$(curl -sf http://127.0.0.1:3310/__nowaki/health)" = '{"status":"ok"}'
curl -s -D - -o /dev/null http://127.0.0.1:3310/__nowaki/health | grep -qi '^cache-control: no-store'
! curl -s -D - -o /dev/null http://127.0.0.1:3310/ | grep -qi '^server-timing:' || exit 1
# sessions on the node adapter: session.ts compiled to dist/server/session.js, the cookie round-trips
test -f examples/hello/dist/server/session.js
SESSION_COOKIE=$(curl -s -D - -o /dev/null -XPOST -H 'origin: http://127.0.0.1:3310' -d 'op=login&user=node' http://127.0.0.1:3310/api/session | tr -d '\r' | awk 'tolower($1)=="set-cookie:" {print $2}' | cut -d';' -f1)
echo "$SESSION_COOKIE" | grep -q '^hello_session=v1\.'
curl -sf -H "cookie: $SESSION_COOKIE" http://127.0.0.1:3310/api/session | grep -q '"user":"node"'
# API routes reject cross-site writes by default: the session is untouched, `csrf = false` opts out
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://evil.test' -H "cookie: $SESSION_COOKIE" -d 'op=inc' http://127.0.0.1:3310/api/session)" = 403
curl -sf -H "cookie: $SESSION_COOKIE" http://127.0.0.1:3310/api/session | grep -q '"user":"node","n":0'
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://127.0.0.1:3310' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3310/api/echo)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'sec-fetch-site: cross-site' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3310/api/echo)" = 403
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://evil.test' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3310/api/webhook)" = 200
# typed env on the node adapter: env.ts validated at startup, read by the loader
curl -sf http://127.0.0.1:3310/env | grep -q 'token length 15'
curl -sf http://127.0.0.1:3310/env | grep -q 'id="env-badge">Hello from env.ts x4<'
# file routes: feed.xml.ts (static) and og/[card].png.ts (a param with a fixed extension, bytes)
curl -s -D - -o /dev/null http://127.0.0.1:3310/feed.xml | grep -qi '^content-type: application/xml'
curl -sf http://127.0.0.1:3310/feed.xml | grep -q '<rss version="2.0">'
curl -s -D - -o /dev/null http://127.0.0.1:3310/og/intro.png | grep -qi '^content-type: image/png'
curl -sf http://127.0.0.1:3310/og/intro.png | head -c 4 | od -An -c | grep -q 'P   N   G'
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3310/og/nope.png)" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3310/og/intro.jpg)" = 404
# route groups on the node adapter
curl -sf http://127.0.0.1:3310/pricing | grep -q '<div data-group="marketing"><main'
curl -s -D - -o /dev/null http://127.0.0.1:3310/pricing | grep -qi '^x-route-group: marketing'
# parallel routes on the node adapter
curl -sf http://127.0.0.1:3310/photos/1 | grep -q '<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/photos/@modal" data-nowaki-intercepts="[^"]*"><aside id="photo-modal"'
curl -sf -H 'x-nowaki-intercept: /photos/@modal' http://127.0.0.1:3310/photos/1 | grep -q '<aside id="photo-intercepted">intercepted 1</aside>$'
curl -sf http://127.0.0.1:3310/photos | grep -q '<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/photos/@modal" data-nowaki-intercepts="[^"]*"><p id="modal-default">'
# fonts on the node adapter (dist/server/fonts.json)
curl -sf http://127.0.0.1:3310/about | grep -qE '<link rel="stylesheet" href="/_nowaki/fonts\.[0-9a-f]+\.css" />'
# MDX entries render from their compiled module on the node adapter
curl -sf http://127.0.0.1:3310/docs/components | grep -q 'an expression (42), and highlighted code'
# Markdoc on the node adapter: the .mdoc page and entry are compiled modules
curl -sf http://127.0.0.1:3310/markdoc | grep -q 'class="callout callout-tip"'
curl -sf http://127.0.0.1:3310/docs/markdoc | grep -q 'class="callout callout-warning"'
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
! curl -sf http://127.0.0.1:3310/.hidden | grep -q 'never served' || exit 1
test "$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $(curl -s -D - -o /dev/null http://127.0.0.1:3310/robots.txt | tr -d '\r' | awk 'tolower($1)=="etag:" {print $2}')" http://127.0.0.1:3310/robots.txt)" = 304
# default security headers on the node adapter (pages and static assets)
curl -s -D - -o /dev/null http://127.0.0.1:3310/ | grep -qi '^x-content-type-options: nosniff'
curl -s -D - -o /dev/null http://127.0.0.1:3310/ | grep -qi "^content-security-policy: frame-ancestors 'self'"
# streaming SSR route (export const streaming = true) renders a complete document
curl -sf http://127.0.0.1:3310/stream | grep -q "Streaming SSR"
curl -sf http://127.0.0.1:3310/stream | grep -q "nowaki-island"
# a streamed shell can't see its live islands: live.js comes with it, in POST mode
curl -sf http://127.0.0.1:3310/stream | grep -qE '/_nowaki/live\.[0-9a-f]+\.js" data-live-transport="post"'
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
# CSP on the node adapter (report-only): the nonce on Nowaki's scripts/styles and nonce() tags only
# (with NOWAKI_SERVER_TIMING=1 on the same run: the handler's phases on the node adapter)
NOWAKI_CSP=report-only NOWAKI_SERVER_TIMING=1 PORT=3312 node examples/hello/dist/server/index.mjs &
CSPN_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3312/ >/dev/null && break; sleep 1; done
node scripts/csp-e2e.mjs http://127.0.0.1:3312 --report-only
node scripts/security-e2e.mjs headers http://127.0.0.1:3312 "node adapter, NOWAKI_CSP"
curl -s -D - -o /dev/null http://127.0.0.1:3312/ | tr -d '\r' | grep -qiE '^server-timing: mw;dur=[0-9.]+, loader;dur=[0-9.]+, render;dur=[0-9.]+$'
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
# no HMR or dev toolbar in static output
! grep -rlE 'hmr\.js|toolbar\.js|refresh\.js|data-toolbar|__nowaki/(hmr|devtools)' --include='*.html' examples/hello/dist/static || exit 1
# View Transitions in static output: the opted route has the @view-transition style (full loads
# between opted pages transition with no server and no JS), the others don't.
grep -q '@view-transition{navigation:auto}' examples/hello/dist/static/vt/index.html
grep -q '<meta name="nowaki-view-transition" content="1" />' examples/hello/dist/static/vt/detail/index.html
! grep -qE 'nowaki-view-transition|@view-transition' examples/hello/dist/static/about/index.html || exit 1
grep -q '<div data-group="marketing"><main' examples/hello/dist/static/pricing/index.html
! test -e 'examples/hello/dist/static/(marketing)' || exit 1
# parallel routes in static output: slots render into the pages; slot files are not pages
grep -q '<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/photos/@modal" data-nowaki-intercepts="[^"]*"><p id="modal-default">' examples/hello/dist/static/photos/index.html
grep -q '<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/photos/@modal" data-nowaki-intercepts="[^"]*"><aside id="photo-modal"' examples/hello/dist/static/photos/1/index.html
! test -e 'examples/hello/dist/static/photos/@modal' || exit 1
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
! grep -q '/_nowaki/live\.' examples/hello/dist/static/live/index.html || exit 1
! grep -q '/_nowaki/live\.' examples/hello/dist/static/poll/index.html || exit 1
! grep -q '/_nowaki/live\.' examples/hello/dist/static/stream/index.html || exit 1
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
# Markdoc in the static output: the page (an island inside it) and the entry
grep -q '<h1 id="a-markdoc-page">A Markdoc page</h1>' examples/hello/dist/static/markdoc/index.html
grep -q '<nowaki-island name="Counter"' examples/hello/dist/static/markdoc/index.html
grep -q 'class="callout callout-warning"' examples/hello/dist/static/docs/markdoc/index.html
# SEO in the static output: sitemap.xml generated against the site (page URLs end in /, as the
# page is docs/intro/index.html), public/robots.txt kept
grep -q '<loc>https://hello.nowaki.dev/docs/intro/</loc>' examples/hello/dist/static/sitemap.xml
! grep -qE '/boom<|/secret<' examples/hello/dist/static/sitemap.xml || exit 1
grep -q 'User-agent: \*' examples/hello/dist/static/robots.txt
grep -q '<link rel="canonical" href="https://hello.nowaki.dev/docs/intro/" />' examples/hello/dist/static/docs/intro/index.html
# file routes are written to their own path (not feed.xml/index.html), bytes intact
grep -q '<rss version="2.0">' examples/hello/dist/static/feed.xml
head -c 4 examples/hello/dist/static/og/intro.png | od -An -c | grep -q 'P   N   G'
test -f examples/hello/dist/static/og/routing.png
! test -e examples/hello/dist/static/feed.xml/index.html || exit 1
grep -q '<html lang="ja" data-sheet-rev="3"' examples/hello/dist/static/styled/index.html
grep -q '<body class="site styled-page"' examples/hello/dist/static/styled/index.html
# public/ files at their own path in the static output, dotfiles left out
grep -q 'User-agent' examples/hello/dist/static/robots.txt
grep -q 'hello from public' "examples/hello/dist/static/media/hello world.txt"
# nowaki.config redirects and rewrites become _redirects rules
grep -qx '/old-docs/\* /:splat 308' examples/hello/dist/static/_redirects
grep -qx '/p/:slug /blog/:slug 200' examples/hello/dist/static/_redirects
# nowaki.config headers become extra rules in _headers (after security defaults)
grep -q '/docs/\*' examples/hello/dist/static/_headers
grep -qi 'x-hello-routing: config' examples/hello/dist/static/_headers
grep -q '/api/\*' examples/hello/dist/static/_headers
grep -qi 'cache-control: no-store' examples/hello/dist/static/_headers
test -f examples/hello/dist/static/.well-known/security.txt
! test -e examples/hello/dist/static/.hidden || exit 1
# cloudflare (edge) adapter: generates a bundled fetch-handler worker + wrangler config
./target/debug/nowaki build examples/hello --adapter cloudflare
# the worker's fetch handler, called directly in Node (web.mjs end to end, no wrangler)
node scripts/edge-handler-test.mjs examples/hello/dist/worker
# no internal x-nowaki-* response header, no Set-Cookie on a shared-cacheable response (worker)
node scripts/security-e2e.mjs headers-worker examples/hello/dist/worker
# no HMR or dev toolbar in the worker's pages
node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then(async ({ default: w }) => {
  const env = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  for (const p of ["/", "/live"]) {
    const t = await (await w.fetch(new Request("https://app.example" + p), env, { waitUntil() {} })).text();
    if (!t.includes("<nowaki-") || /hmr\.js|toolbar\.js|refresh\.js|data-toolbar|__nowaki\/(hmr|devtools)/.test(t)) { console.error("dev tooling in worker page " + p); process.exit(1); }
  }
})' examples/hello/dist/worker/index.js
test -f examples/hello/dist/worker/index.js
test -f examples/hello/dist/worker/wrangler.jsonc
grep -q "createFetchHandler" examples/hello/dist/worker/index.js
grep -q '"binding": "ASSETS"' examples/hello/dist/worker/wrangler.jsonc
# one Assets directory: dist/client under _nowaki/, public/ at the top
grep -q '"directory": "./assets"' examples/hello/dist/worker/wrangler.jsonc
ls examples/hello/dist/worker/assets/_nowaki/manifest.json >/dev/null
grep -q 'User-agent' examples/hello/dist/worker/assets/robots.txt
! test -e examples/hello/dist/worker/assets/.hidden || exit 1
# vercel adapter: Build Output API v3 (.vercel/output): config, static files and a
# self-contained Node serverless function. The function's default (req, res) handler (what
# Vercel's launcher calls) is served on 3320 for the checks below.
./target/debug/nowaki build examples/hello --adapter vercel
test -f examples/hello/.vercel/output/config.json
grep -q '"version": 3' examples/hello/.vercel/output/config.json
grep -q '"x-content-type-options": "nosniff"' examples/hello/.vercel/output/config.json
test -f examples/hello/.vercel/output/functions/index.func/.vc-config.json
grep -q '"launcherType": "Nodejs"' examples/hello/.vercel/output/functions/index.func/.vc-config.json
test -d examples/hello/.vercel/output/static/_nowaki
# public/ files are static files at their own path, with the security headers by exact-path route
grep -q 'User-agent' examples/hello/.vercel/output/static/robots.txt
! test -e examples/hello/.vercel/output/static/.hidden || exit 1
grep -q 'media/hello%20world' examples/hello/.vercel/output/config.json
# the function must not carry a nested preact (a second instance breaks hooks)
! test -d examples/hello/.vercel/output/functions/index.func/node_modules/@nowaki-dev/runtime/node_modules || exit 1
# `exec` makes $! the PID of node itself, so the kill below stops it.
(cd examples/hello/.vercel/output/functions/index.func \
  && exec node -e 'import("./index.mjs").then(m=>require("http").createServer(m.default).listen(3320))') &
VERCEL_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3320/ >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3320/ | grep -q "nowaki-island"
curl -sf http://127.0.0.1:3320/api/hello | grep -q '"hello":"nowaki"'
node scripts/security-e2e.mjs headers http://127.0.0.1:3320 "vercel function"
# API CSRF default on the vercel function: cross-site POST 403, same-origin 200, `csrf = false` 200
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://evil.test' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3320/api/echo)" = 403
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://127.0.0.1:3320' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3320/api/echo)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' -XPOST -H 'origin: http://evil.test' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3320/api/webhook)" = 200
curl -sf http://127.0.0.1:3320/docs/intro | grep -q '<h2 id="why-content-collections"'   # content on vercel
curl -sf http://127.0.0.1:3320/nav | grep -q 'href="/blog/hello"'
# CDN purge: ISR pages carry Vercel-Cache-Tag (their tags + their path), other pages none
curl -s -D - -o /dev/null http://127.0.0.1:3320/isr-tagged | grep -qiE '^vercel-cache-tag: t:isr-demo,p:/isr-tagged[[:space:]]*$'
curl -s -D - -o /dev/null http://127.0.0.1:3320/isr | grep -qiE '^vercel-cache-tag: p:/isr[[:space:]]*$'
! curl -s -D - -o /dev/null http://127.0.0.1:3320/about | grep -qi '^vercel-cache-tag:' || exit 1
# revalidateTag in an action without @vercel/functions installed: a warned no-op, the redirect stands
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'origin: http://127.0.0.1:3320' -d kind=tag http://127.0.0.1:3320/isr-tagged | grep -q '^303$'
kill $VERCEL_PID
# nowaki.config redirects / rewrites / headers / basePath / trailingSlash on the node, cloudflare,
# vercel and static adapters (a generated app; the servers listen on 3313 and 3314)
node scripts/rules-e2e.mjs node cloudflare vercel static --port 3313
# nowaki.config i18n on the node and cloudflare adapters and in static output (listens on 3315,
# 3316 for i18n + basePath + trailingSlash "never" + a slot, and 3317 for locale detection)
node scripts/i18n-e2e.mjs node cloudflare static --port 3315
# examples/gallery on the node adapter (3331), the cloudflare worker (with a stand-in Cache API
# and zone purge: an edited post is fresh on the next request), the vercel function behind a
# stand-in CDN with a fake @vercel/functions (also 3331, after the node server stopped), and
# what static output can serve of it
node scripts/gallery-e2e.mjs node cloudflare vercel static --port 3331
