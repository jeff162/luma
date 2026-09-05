#!/usr/bin/env bash
# Dev check runner: the whole local gate behind one allowlistable prefix, so the venv path and the
# `cd frontend && npm` compound stay off the command line. This only *orchestrates* — backend testing
# lives in scripts/run_tests.sh (the single source of truth for venv discovery + test running) and the
# frontend half in `npm run check`, both of which this delegates to rather than re-implementing.
#
# The default target runs everything, browser suite included, because a check nobody runs protects
# nothing: the Playwright specs are the only lane that exercises the app as a user meets it, and left
# behind an opt-in flag they rot. `lint` stays as the fast escape hatch for a tight edit loop.
#
# stderr is folded into stdout *inside* the script (exec 2>&1 below) so a bare `... | tail` / `... | grep`
# captures everything, including unittest's summary (which it writes to stderr). This is a convenience,
# not an allowlist requirement — a command-line `2>&1` matches fine too, provided each pipeline segment
# (this script, tail, grep) is itself allowlisted.
#
# Usage:
#   ./scripts/check_backend_and_frontend.sh                 # everything: backend suite + frontend check
#   ./scripts/check_backend_and_frontend.sh backend [args]  # backend only ([args] forwarded to run_tests.sh -> pytest)
#   ./scripts/check_backend_and_frontend.sh frontend        # frontend check: lint + vitest + browser suite
#   ./scripts/check_backend_and_frontend.sh lint            # frontend lint only (seconds, no browser)
set -uo pipefail
exec 2>&1
cd "$(dirname "$0")/.."

target="${1:-all}"
rc=0

if [[ "$target" == "backend" || "$target" == "all" ]]; then
  echo "== backend tests =="
  ./scripts/run_tests.sh "${@:2}" || rc=$?
fi

if [[ "$target" == "lint" ]]; then
  echo "== frontend lint =="
  ( cd frontend && npm run lint ) || rc=$?
fi

if [[ "$target" == "frontend" || "$target" == "all" ]]; then
  echo "== frontend check (lint + vitest + browser suite) =="
  ( cd frontend && npm run check ) || rc=$?
fi

exit "$rc"
