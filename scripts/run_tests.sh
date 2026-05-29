#!/usr/bin/env bash
# Run the backend test suite. With no arguments, discovers and runs everything under
# backend/tests/. Pass any arguments to filter — they're forwarded straight to
# `python -m unittest`, so e.g.:
#
#   scripts/run_tests.sh                                          # everything
#   scripts/run_tests.sh backend.tests.test_suspect_duplicates    # one module
#   scripts/run_tests.sh backend.tests.test_suspect_duplicates.SuspectDuplicateTests.test_resolve_invalid_action
#   scripts/run_tests.sh -v                                       # verbose listing of every test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$ROOT_DIR/backend/venv/bin/python"

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Backend venv not found at $VENV_PYTHON"
  echo "Run scripts/start_backend.sh once to bootstrap the venv, then try again."
  exit 1
fi

cd "$ROOT_DIR"

if [[ $# -eq 0 ]]; then
  exec "$VENV_PYTHON" -m unittest discover -s backend/tests -p "test_*.py"
fi

exec "$VENV_PYTHON" -m unittest "$@"
