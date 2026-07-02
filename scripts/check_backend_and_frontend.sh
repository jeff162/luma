#!/usr/bin/env bash
# Dev check runner: the backend test suite and the frontend lint, behind one allowlistable prefix so
# the venv path and the `cd frontend && npm` compound stay off the command line. This only *orchestrates*
# — backend testing lives in scripts/run_tests.sh (the single source of truth for venv discovery + test
# running), which this delegates to rather than re-implementing.
#
# stderr is folded into stdout *inside* the script (exec 2>&1 below) so a bare `... | tail` / `... | grep`
# captures everything, including unittest's summary (which it writes to stderr). This is a convenience,
# not an allowlist requirement — a command-line `2>&1` matches fine too, provided each pipeline segment
# (this script, tail, grep) is itself allowlisted.
#
# Usage:
#   ./scripts/check_backend_and_frontend.sh                 # backend suite + frontend lint
#   ./scripts/check_backend_and_frontend.sh backend [args]  # backend only ([args] forwarded to run_tests.sh -> unittest)
#   ./scripts/check_backend_and_frontend.sh frontend        # frontend lint only
set -uo pipefail
exec 2>&1
cd "$(dirname "$0")/.."

target="${1:-all}"
rc=0

if [[ "$target" == "backend" || "$target" == "all" ]]; then
  echo "== backend tests =="
  ./scripts/run_tests.sh "${@:2}" || rc=$?
fi

if [[ "$target" == "frontend" || "$target" == "all" ]]; then
  echo "== frontend lint =="
  ( cd frontend && npm run lint ) || rc=$?
fi

exit "$rc"
