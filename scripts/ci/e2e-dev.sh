#!/usr/bin/env bash
# CI: Start dev server and verify SSR, islands, API, and v0.3 routing
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."
# A request to a hung server must fail, not wait forever; and on Windows, where hangs have been
# seen, trace every command so the log shows where one stopped.
curl() { command curl --max-time 30 "$@"; }
if [ "${RUNNER_OS:-}" = Windows ]; then set -x; fi

# PORT overrides 3000 for local runs where that port is taken.
PORT=${PORT:-3000}
./target/debug/nowaki dev examples/hello --port "$PORT" &
SERVER_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break
  sleep 1
done
B=http://127.0.0.1:$PORT
status() { echo "$(curl -s -o /dev/null -w '%{http_code}' "$@")"; }

# SSR + islands + transform. The eager runtime is islands.js; the SPA router
# is lazy-loaded via the data-router attribute (kept out of first-load JS).
curl -sf $B/ | grep -q "nowaki-island"
curl -sf $B/ | grep -q 'id="nowaki-runtime"'
# CSS Modules (Badge on /): root-relative scope id → stable badge_<8 hex> in SSR HTML.
BADGE_CLASS=$(curl -sf $B/ | grep -oE 'badge_[0-9a-f]{8}' | head -1)
test -n "$BADGE_CLASS"
echo "$BADGE_CLASS" > /tmp/nowaki-css-module-badge-class
! curl -sf $B/ | grep -qE '/Users/|/home/[^/]+/'
curl -sf $B/ | grep -q 'data-router=.*client/router.js'
curl -sf "$B/islands/Counter.tsx" | grep -q "jsx-runtime"

# layouts (root + nested) and dynamic param
curl -sf $B/ | grep -q 'href="/todos"'
curl -sf $B/blog/hello | grep -q "blog section"
curl -sf $B/blog/hello | grep -q "Post: hello"
curl -sf $B/blog/hello | grep -q 'href="/about"'

# catch-all routes ([...path]): /files/a/b/c binds the rest as an array,
# /files (no trailing segment) does not match.
curl -sf $B/files/a/b/c | grep -q 'a / b / c (3)'
test "$(status $B/files)" = "404"
# async/dynamic metadata: export function meta() computes <title> from params
curl -sf $B/files/a/b/c | grep -q '<title>files/a/b/c'

# middleware: header + auth redirect
curl -s -D - -o /dev/null $B/ | grep -qi "x-nowaki-mw: 1"
test "$(status $B/secret)" = "302"
test "$(status "$B/secret?key=ok")" = "200"

# 404 / 500 conventions
test "$(status $B/nope)" = "404"
curl -s $B/nope | grep -q "Page not found"
test "$(status "$B/boom?boom=1")" = "500"

# API: legacy default, method dispatch, 405, streaming
curl -sf $B/api/hello | grep -q '"hello":"nowaki"'
# content collections in dev: a new Markdown file shows up without a restart, and a broken
# frontmatter is reported instead of stopping the server
curl -sf $B/docs/intro | grep -q '<h2 id="why-content-collections"'
printf -- '---\ntitle: Added in dev\norder: 9\n---\n\n## Fresh heading\n' > examples/hello/content/docs/e2e-added.md
for i in $(seq 1 20); do curl -s $B/docs/e2e-added | grep -q 'id="fresh-heading"' && break; sleep 0.5; done
curl -s $B/docs/e2e-added | grep -q 'id="fresh-heading"'
printf -- '---\norder: 9\n---\nno title\n' > examples/hello/content/docs/e2e-added.md
for i in $(seq 1 20); do curl -s $B/docs | grep -q 'title: is required' && break; sleep 0.5; done
curl -s $B/docs | grep -q 'content/docs/e2e-added.md: title: is required'
rm examples/hello/content/docs/e2e-added.md
for i in $(seq 1 20); do curl -sf $B/docs >/dev/null && break; sleep 0.5; done
curl -sf $B/docs | grep -q 'href="/docs/intro"'
# route / layout CSS in dev: linked from the dev server, which serves only .css under the app
# ?image + <Image>: AVIF then JPEG, sizes from the file, lazy by default; Markdown images too
curl -sf $B/gallery | grep -q '<picture><source type="image/avif" srcset="/__nowaki/image?f=/hero.jpg&amp;w=640&amp;fmt=avif'
curl -sf $B/gallery | grep -q 'width="1200" height="750" alt="A gradient" loading="eager"'
curl -s -D - -o /dev/null "$B/__nowaki/image?f=/hero.jpg&w=640&fmt=avif" | grep -qi '^content-type: image/avif'
curl -s -D - -o /dev/null "$B/__nowaki/image?f=/hero.jpg&w=640&fmt=orig" | grep -qi '^content-type: image/jpeg'
test "$(curl -s -o /dev/null -w '%{http_code}' "$B/__nowaki/image?f=/package.json&w=10&fmt=orig")" = 403
curl -sf $B/docs/intro | grep -q '<picture><source type="image/avif" srcset="/__nowaki/image?f=/hero.jpg'
# SEO: typed meta → head tags (absolute against nowaki.config `site`), generated sitemap.xml
curl -sf $B/docs/intro | grep -q '<link rel="canonical" href="https://hello.nowaki.dev/docs/intro" />'
curl -sf $B/docs/intro | grep -q '<meta property="og:image" content="https://hello.nowaki.dev/og/intro.png" />'
curl -sf $B/docs/intro | grep -q '<meta property="og:site_name" content="Nowaki demo" />'
curl -sf $B/docs/intro | grep -q '<script type="application/ld+json">{"@context":"https://schema.org"'
curl -sf $B/boom | grep -q '<meta name="robots" content="noindex, follow" />'
curl -s -D - -o /dev/null $B/sitemap.xml | grep -qi '^content-type: application/xml'
curl -sf $B/sitemap.xml | grep -q '<loc>https://hello.nowaki.dev/docs/intro</loc>'
! curl -sf $B/sitemap.xml | grep -qE '/boom<|/secret<|/api/|feed.xml'
curl -sf $B/robots.txt | grep -q 'User-agent'   # public/robots.txt wins over the generated one
curl -sf $B/feed.xml | grep -q '<link>https://hello.nowaki.dev/docs/intro</link>'
node scripts/seo-unit-test.mjs
# page scripts: a module <script> per listed module, served as JS (dev: its own URL)
curl -sf $B/scripted | grep -q '<script type="module" src="/scripts/stamp.ts" data-nowaki-script></script>'
curl -s -D - -o /dev/null $B/scripts/stamp.ts | grep -qi '^content-type: text/javascript'
# file routes: feed.xml.ts (static) and og/[card].png.ts (a param with a fixed extension, bytes)
curl -s -D - -o /dev/null $B/feed.xml | grep -qi '^content-type: application/xml'
curl -sf $B/feed.xml | grep -q '<rss version="2.0">'
curl -s -D - -o /dev/null $B/og/intro.png | grep -qi '^content-type: image/png'
curl -sf $B/og/intro.png | head -c 4 | od -An -c | grep -q 'P   N   G'
test "$(curl -s -o /dev/null -w '%{http_code}' $B/og/nope.png)" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' $B/og/intro.jpg)" = 404
# htmlAttrs / bodyAttrs: route over layout, class joined, on* dropped, values escaped
curl -sf $B/styled | grep -q '<html lang="ja" data-sheet-rev="3" data-theme="paper" data-nowaki-attrs="data-sheet-rev data-theme">'
curl -sf $B/styled | grep -q '<body class="site styled-page" data-site="hello" data-quote="&quot;&lt;x&gt;&quot;" data-nowaki-attrs="class data-site data-quote">'
! curl -sf $B/styled | grep -q 'onload'
curl -sf $B/about | grep -q '<body class="site" data-site="hello" data-nowaki-attrs="class data-site">'
# public/: files at their own path, as-is (a .css stays CSS), dotfiles hidden except .well-known
curl -s -D - $B/robots.txt | grep -qi '^content-type: text/plain'
curl -sf $B/robots.txt | grep -q 'User-agent: \*'
curl -s -D - $B/raw.css | grep -qi '^content-type: text/css'
curl -sf $B/raw.css | grep -q '^\.raw { color: red; }'
curl -sf "$B/media/hello%20world.txt" | grep -q 'hello from public'
curl -sf $B/.well-known/security.txt | grep -q 'Contact:'
! curl -sf $B/.hidden | grep -q 'never served'
! curl -sf $B/.private/secret.txt | grep -q 'never served'
! curl -sf $B/public/robots.txt | grep -q 'User-agent'
curl -sf $B/styled | grep -q '<link rel="stylesheet" href="/__nowaki/css?f=routes/styled.css"'
curl -sf $B/styled | grep -q '<style>#styled-probe{color:rgb(1, 2, 3)}</style>'
curl -s -D - "$B/__nowaki/css?f=routes/styled.css" | grep -qi '^content-type: text/css'
test "$(curl -s -o /dev/null -w '%{http_code}' "$B/__nowaki/css?f=routes/styled.tsx")" = 403
# outside routes/: 403, or 404 where the path doesn't exist (Windows has no /etc/hosts)
test "$(curl -s -o /dev/null -w '%{http_code}' "$B/__nowaki/route-css?file=/etc/hosts")" != 200
curl -sf "$B/api/echo?q=hi" | grep -q '"q":"hi"'
curl -sf -X POST -H 'content-type: application/json' -d '{"a":1}' $B/api/echo | grep -q '"received":{"a":1}'
test "$(status -X DELETE $B/api/echo)" = "405"
test "$(curl -s $B/api/stream | tr -d '\n')" = "chunk1chunk2"
# the dev proxy streams too: the first chunk doesn't wait for the 600 ms gap
FB=$(curl -s -N -o /dev/null -w '%{time_starttransfer}' "$B/api/stream?delay=600")
awk -v t="$FB" 'BEGIN { exit !(t < 0.3) }'

# action (form submission) via cookie PRG
CJ=$(mktemp)
test "$(status -c $CJ -X POST -d 'text=ci-todo' $B/todos)" = "302"
curl -s -b $CJ $B/todos | grep -q "ci-todo"

# v0.4 bundler features (rendered on the home page)
curl -sf $B/ | grep -q 'class="badge_'          # CSS Modules scoped class
curl -sf $B/ | grep -q 'src="/logo.svg"'        # asset import URL
curl -sf $B/ | grep -q '<code>a→b</code>'       # cyclic dependency resolves
curl -sf "$B/islands/Counter.tsx" | grep -q 'sourceMappingURL=data'  # dev source map

# v0.5 plugin transform hook (nowaki.config.mjs rewrites a token before oxc)
curl -sf $B/plugin | grep -q 'transformed-by-plugin'
! curl -sf $B/plugin | grep -q '__PLUGIN_MARK__'

# v0.5 TSRX: a .tsrx island compiled to Preact via @tsrx/preact, SSR + island wrap
curl -sf $B/tsrx | grep -q 'nowaki-island name="TsrxCounter"'
curl -sf $B/tsrx | grep -q 'tsrx: 5'

# v0.6 Jetstream: server-reactive island SSRs as <nowaki-live> with initial state,
# loads live.js, and coexists with a client island on the same page
curl -sf $B/live | grep -q 'nowaki-live name="LiveCounter"'
curl -sf $B/live | grep -q 'live: 0'
curl -sf $B/live | grep -q 'client/live.js'
curl -sf $B/live | grep -q 'nowaki-island name="Counter"'

# v0.8 server functions: "use server" RPC. The browser gets a fetch proxy
# (no impl/secret); POST /__nowaki/fn runs the real function server-side,
# and getContext() reads the request cookie. Unknown id is rejected.
curl -sf "$B/actions/todos.ts" | grep -q '__nowakiCall'
! curl -sf "$B/actions/todos.ts" | grep -q 'nowaki-server-only-secret'
curl -sf "$B/__nowaki/server-functions" | grep -q '"export":"listTodos"'
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -d '{"id":"6c90d7dc921a9a3f","args":[]}' $B/__nowaki/fn | grep -q 'learn nowaki'
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -H 'cookie: user=alice' -d '{"id":"781de5a7f5ba2469","args":[]}' $B/__nowaki/fn | grep -q 'alice'
test "$(status -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -d '{"id":"deadbeefdeadbeef","args":[]}' $B/__nowaki/fn)" = "404"
# (RPC CSRF gate — missing header / cross-origin — is covered by security-e2e.mjs below.)
curl -sf $B/server-fn | grep -q 'nowaki-island name="ServerTodos"'

# server fn as a <form action>: the islands runtime intercepts the submit and
# posts the form to the fn. Here we exercise the server side (addTodoForm) and
# confirm the runtime ships the form interceptor.
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -d '{"id":"5591e6fc8d31a200","args":[{"text":"ci-form-action"}]}' $B/__nowaki/fn >/dev/null
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-rpc: 1' -d '{"id":"6c90d7dc921a9a3f","args":[]}' $B/__nowaki/fn | grep -q 'ci-form-action'
curl -sf "$B/server-fn" | grep -q 'fa-form'

# v0.9 virtual modules: a plugin resolveId/load provides virtual:build-info,
# imported by an island. SSR renders it (inlined as a data: module) and the
# island's browser JS loads the generated source from a /__nowaki_virtual__/ URL.
curl -sf $B/virtual | grep -q 'VIRTUAL_OK · nowaki-plugin'
curl -sf $B/virtual | grep -q 'nowaki-island name="VirtualBadge"'

# lazy hydration (Astro-style client:* directives): the island wrapper sets a
# `client` attribute and the directive is NOT serialized into the island props.
# client:only renders no SSR content (hydrates client-side only).
# typed navigation: <Link href> renders an <a href>, route() builds dynamic
# hrefs (encoded params, catch-all joined with /).
curl -sf $B/nav | grep -q '<a href="/about" data-testid="link-about">'
curl -sf $B/nav | grep -q 'href="/blog/hello" data-testid="link-blog"'
curl -sf $B/nav | grep -q 'href="/files/docs/intro" data-testid="link-files"'

curl -sf $B/lazy | grep -q 'name="Counter"[^>]*client="idle"'
# the directive is stripped from the serialized props (props has only start)
curl -sf $B/lazy | grep -q 'props="{&quot;start&quot;:100}"[^>]*client="visible"'
curl -sf $B/lazy | grep -q 'name="ClientOnly"[^>]*client="only"></nowaki-island>'
# client:load is the default → first Counter has no client attribute
curl -sf $B/lazy | grep -q 'name="Counter" src="[^"]*" props="{&quot;start&quot;:0}" style="display:contents">'

# loading/error boundaries: the client router fetches /__nowaki/boundaries
# for the SSR'd loading + error UIs (nwk-pulse = loading skeleton,
# data-nowaki-reset = error retry). They are conventions, not routes, so
# /loading and /error are 404. (DOM behavior is covered by router-browser-test.)
curl -sf $B/__nowaki/boundaries | grep -q 'nwk-pulse'
curl -sf $B/__nowaki/boundaries | grep -q 'data-nowaki-reset'
test "$(status $B/loading)" = "404"
test "$(status $B/error)" = "404"
curl -sf "$B/slow?ms=0" | grep -q 'data-testid="slow"'

# --- application-security regressions (guards for the multi-round audit fixes):
# arbitrary file read (@fs / ssr-module / .env / virtual ..), RPC CSRF,
# CSWSH (WS Origin), and live state forgery. A sentinel .env proves file-read
# denial without leaking; it is removed right after.
printf 'DATABASE_URL=postgres://u:supersecretpw@db/prod\nSESSION_SECRET=ci-do-not-leak\n' > examples/hello/.env
node scripts/security-e2e.mjs dev "$B" "$(pwd)/examples/hello"
rm -f examples/hello/.env

# dev MCP endpoint (/__nowaki/mcp): tools + loopback/Host/Origin gate
node scripts/mcp-e2e.mjs "$B"

kill $SERVER_PID
bash scripts/ci/assert-no-orphans.sh $SERVER_PID
