#!/usr/bin/env bash
# CI: scaffold each create-nowaki template, install it against the workspace
# runtime, then build and serve it with the local CLI.
# Run from the repo root after `cargo build -p nowaki`.
set -e
trap 'echo "::error file=${BASH_SOURCE[0]},line=$LINENO::failed: $BASH_COMMAND" >&2' ERR
# A failed step exits here: stop the servers this script started, or they keep the ports.
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
NOWAKI="$ROOT/target/debug/nowaki"
WORK=$(mktemp -d)

node scripts/create-nowaki-test.mjs

# A packed tarball (not file:) so the app gets its own single copy of preact.
(cd packages/nowaki-runtime && npm pack --silent --pack-destination "$WORK" >/dev/null)
TARBALL=$(ls "$WORK"/nowaki-dev-runtime-*.tgz)

# Type-check the scaffolded app with skipLibCheck off, using the shipped tsconfig.json and
# type files plus a probe that imports a `?image` asset, a plain asset, a CSS module, reads
# import.meta.env, and passes attributes to <Image>. tsc comes from $TSC, else from `tsc` on
# PATH; in CI (CI=true) a pinned typescript is installed into the app. Skipped otherwise.
typecheck() {
  local app=$1 tsc=${TSC:-}
  if [ -z "$tsc" ] && command -v tsc >/dev/null 2>&1; then tsc=tsc; fi
  if [ -z "$tsc" ] && [ "${CI:-}" = true ]; then
    (cd "$app" && npm install --no-save --no-audit --no-fund --loglevel=error typescript@5.9.3)
    tsc="$app/node_modules/.bin/tsc"
  fi
  if [ -z "$tsc" ]; then
    echo "skip: type-check of $(basename "$app") (no tsc; set TSC=/path/to/tsc)"
    return 0
  fi
  mkdir -p "$app/components"
  printf 'x' > "$app/components/probe.png"
  printf '.box { color: red; }\n' > "$app/components/probe.module.css"
  cat > "$app/components/TypesProbe.tsx" <<'TSX'
import hero from "./probe.png?image";
import heroUrl from "./probe.png";
import styles from "./probe.module.css";
import { Image } from "@nowaki-dev/runtime/image";

const greeting: string | undefined = import.meta.env.PUBLIC_X;
const base: string = import.meta.env.BASE_URL;

export function TypesProbe() {
  return (
    <div class={styles.box} data-greeting={greeting} data-base={base}>
      <Image src={hero} alt="hero" class="hero" id="hero" fetchpriority="high" loading="eager" width={320} />
      <Image src={heroUrl} alt="" style={{ objectFit: "cover" }} onClick={(e) => e.currentTarget.alt} />
    </div>
  );
}

export const island = <TypesProbe client:visible client:media="(min-width: 768px)" />;

// @ts-expect-error: <Image> keeps the <img> attribute types, so an unknown one is rejected.
export const bad = <Image src={hero} alt="" notAnAttribute="x" />;
TSX
  printf '{ "extends": "./tsconfig.json", "compilerOptions": { "skipLibCheck": false } }\n' \
    > "$app/tsconfig.typecheck.json"
  (cd "$app" && "$tsc" --noEmit -p tsconfig.typecheck.json)
  rm -f "$app/components/TypesProbe.tsx" "$app/components/probe.png" \
    "$app/components/probe.module.css" "$app/tsconfig.typecheck.json"
}

port=3400
for t in basics minimal; do
  (cd "$WORK" && node "$ROOT/packages/create-nowaki/index.js" "app-$t" -t "$t" -y --no-git --no-install)
  APP="$WORK/app-$t"
  common="package.json AGENTS.md CLAUDE.md tsconfig.json nowaki-env.d.ts nowaki-jsx.d.ts .gitignore .env.example routes/index.tsx"
  if [ "$t" = basics ]; then
    for f in $common routes/_404.tsx routes/api/health.ts; do
      test -f "$APP/$f"
    done
  else
    for f in $common; do
      test -f "$APP/$f"
    done
  fi

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
  if [ "$t" = basics ]; then
    curl -sf "http://127.0.0.1:$port/api/health" | grep -q '"ok"'
    curl -sf "http://127.0.0.1:$port/" | grep -q 'nowaki-island name="Counter"'
  else
    ! curl -sf "http://127.0.0.1:$port/" | grep -q 'nowaki-island' || exit 1
  fi
  kill $PID
  port=$((port + 1))

  typecheck "$APP"
done
rm -rf "$WORK"
