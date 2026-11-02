#!/usr/bin/env bash
# CI: after a nowaki server got SIGTERM, its Node children (sidecar, plugin host) must be gone.
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
sleep 0.5
if pgrep -f 'nowaki-dev/runtime/server/' >/dev/null; then
  echo "orphaned Node children after SIGTERM:" >&2
  pgrep -fl 'nowaki-dev/runtime/server/' >&2
  exit 1
fi
