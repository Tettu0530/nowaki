#!/usr/bin/env bash
# CI: waits for a nowaki server that was sent SIGTERM (or SIGKILL) to exit, then checks that its
# Node children (sidecar, plugin host) are gone too. On SIGKILL the children exit by themselves
# when their stdin pipe closes. Called from e2e-dev.sh and e2e-prod.sh.
# Usage: scripts/ci/assert-no-orphans.sh <pid-of-nowaki>
set -e
pid=$1
command -v pgrep >/dev/null || exit 0 # Windows runners: no POSIX signals to test
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  echo "nowaki ($pid) still running after SIGTERM" >&2
  exit 1
fi
# Only this checkout's example app, so other Nowaki apps running on the machine don't count.
pattern="$(cd "$(dirname "$0")/../.." && pwd)/examples/hello/node_modules/@nowaki-dev/runtime/server/"
for _ in $(seq 1 12); do
  pgrep -f "$pattern" >/dev/null || break
  sleep 0.25
done
if pgrep -f "$pattern" >/dev/null; then
  echo "orphaned Node children after SIGTERM:" >&2
  pgrep -fl "$pattern" >&2
  exit 1
fi
