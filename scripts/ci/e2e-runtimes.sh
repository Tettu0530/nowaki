#!/usr/bin/env bash
# CI: run the bun / deno / cloudflare adapter output on its real runtime.
# Usage: scripts/ci/e2e-runtimes.sh <bun|deno|cloudflare>
# Run from the repo root after `cargo build -p nowaki` and `pnpm install`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/../.."
target=$1
APP=examples/hello
port=3500

case "$target" in
  bun)
    ./target/debug/nowaki build $APP --adapter bun
    (cd $APP && PORT=$port bun dist/server/index.mjs) &
    ;;
  deno)
    ./target/debug/nowaki build $APP --adapter deno
    (cd $APP && PORT=$port deno run -A dist/server/index.mjs) &
    ;;
  cloudflare)
    ./target/debug/nowaki build $APP --adapter cloudflare
    (cd $APP/dist/worker && npx --yes wrangler@4 dev --port $port --ip 127.0.0.1 --show-interactive-dev-session=false) &
    ;;
  *)
    echo "unknown runtime: $target" >&2
    exit 2
    ;;
esac
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

B=http://127.0.0.1:$port
for i in $(seq 1 90); do curl -sf $B/ >/dev/null && break; sleep 1; done
curl -sf $B/ | grep -q "nowaki-island"
curl -sf $B/api/hello | grep -q '"hello":"nowaki"'
curl -s -D - -o /dev/null $B/ | grep -qi '^x-content-type-options: nosniff'
curl -sf $B/blog/hello | grep -q "Post: hello"
# live islands render their initial state, and a POST /__nowaki/live-event applies an event
curl -sf $B/live | grep -q 'live: 0'
LIVE_SIG=$(curl -sf $B/live | grep -oE 'sig="v1\.[^"]+"' | head -1 | cut -d'"' -f2)
curl -sf -XPOST -H 'content-type: application/json' -H 'x-nowaki-live: 1' \
  -d "{\"name\":\"LiveCounter\",\"state\":{\"count\":0},\"sig\":\"$LIVE_SIG\",\"handler\":\"inc\"}" \
  $B/__nowaki/live-event | grep -qE 'live: (<!-- -->)?1'
test "$(curl -s -o /dev/null -w '%{http_code}' $B/nope)" = "404"
curl -sf -XPOST -H 'content-type: application/json' -d '{"a":1}' $B/api/echo | grep -q '"received":{"a":1}'
echo "runtime e2e ($target): OK"
