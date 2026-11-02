#!/usr/bin/env bash
# Prerenders the nowaki.dev landing page to static files.
# Output: site/public/  (deployable as-is to static hosts like Cloudflare Pages)
#   /        -> public/index.html
#   /ja      -> public/ja/index.html
#   /_nowaki -> public/_nowaki/*   (content-hashed client assets)
# Requires: `nowaki` on PATH (cargo install nowaki or the repo's
#           target/debug/nowaki), and `pnpm install` already run in site.
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8799}"
NOWAKI="${NOWAKI:-nowaki}"

cd "$SITE_DIR"

echo "[prerender] build"
"$NOWAKI" build .

echo "[prerender] start (port $PORT)"
"$NOWAKI" start . --port "$PORT" >/tmp/nowaki-prerender.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "[prerender] render pages -> public/"
rm -rf public
mkdir -p public/ja public/_nowaki
curl -sf "http://127.0.0.1:$PORT/" -o public/index.html
curl -sf "http://127.0.0.1:$PORT/ja" -o public/ja/index.html
cp -R dist/client/. public/_nowaki/

# Cloudflare Pages: long-lived immutable caching for hashed assets
cat > public/_headers <<'HEADERS'
/_nowaki/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

echo "[prerender] done -> $SITE_DIR/public"
