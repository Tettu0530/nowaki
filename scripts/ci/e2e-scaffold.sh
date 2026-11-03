#!/usr/bin/env bash
# CI: scaffold each create-nowaki template, install it against the workspace
# runtime, then build and serve it with the local CLI.
# Run from the repo root after `cargo build -p nowaki`.
set -e
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
NOWAKI="$ROOT/target/debug/nowaki"
WORK=$(mktemp -d)

node scripts/create-nowaki-test.mjs

# A packed tarball (not file:) so the app gets its own single copy of preact.
(cd packages/nowaki-runtime && npm pack --silent --pack-destination "$WORK" >/dev/null)
TARBALL=$(ls "$WORK"/nowaki-dev-runtime-*.tgz)

port=3400
for t in basics minimal; do
  (cd "$WORK" && node "$ROOT/packages/create-nowaki/index.js" "app-$t" -t "$t" -y --no-git --no-install)
  APP="$WORK/app-$t"
  for f in package.json AGENTS.md CLAUDE.md tsconfig.json nowaki-env.d.ts .gitignore .env.example routes/index.tsx routes/_404.tsx routes/api/health.ts; do
    test -f "$APP/$f"
  done

  # The CLI under test is the local build, so drop the published `nowaki` devDependency.
  node -e '
    const fs = require("fs");
    const [file, tarball] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.dependencies["@nowaki-dev/runtime"] = "file:" + tarball;
    delete pkg.devDependencies;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$APP/package.json" "$TARBALL"
  (cd "$APP" && npm install --no-audit --no-fund --loglevel=error)

  "$NOWAKI" build "$APP"
  "$NOWAKI" start "$APP" --port $port &
  PID=$!
  for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$port/" >/dev/null && break; sleep 1; done
  curl -sf "http://127.0.0.1:$port/" | grep -q '🌀'
  curl -sf "http://127.0.0.1:$port/api/health" | grep -q '"ok"'
  if [ "$t" = basics ]; then
    curl -sf "http://127.0.0.1:$port/" | grep -q 'nowaki-island name="Counter"'
  else
    ! curl -sf "http://127.0.0.1:$port/" | grep -q 'nowaki-island'
  fi
  kill $PID
  port=$((port + 1))
done
rm -rf "$WORK"
