#!/usr/bin/env bash
# Run the backend test suite. With no arguments, discovers and runs everything under
# backend/tests/. Pass any arguments to filter:
#
#   scripts/run_tests.sh                                          # everything
#   scripts/run_tests.sh backend.tests.test_suspect_duplicates    # one module
#   scripts/run_tests.sh backend.tests.test_suspect_duplicates.SuspectDuplicateTests.test_resolve_invalid_action
#   scripts/run_tests.sh -v                                       # verbose listing of every test
#
# The runner is **pytest**, which is what CI runs (.github/workflows/release.yml). It used to be
# `python -m unittest`, and the two do not collect the same tests: unittest finds `TestCase` classes
# only, while pytest finds those *plus* plain `def test_` functions. Six modules are written in the
# plain-function style, so 50-odd tests ran in CI and never locally — a test suite that passes on the
# developer's machine while a different set decides the build. pytest collects a strict superset, so
# moving the local runner onto it closed the gap without changing a single test.
#
# Dotted arguments are still accepted, because they were the documented way to name a test and there is
# no reason to make everyone relearn it: a module path goes to pytest as `--pyargs`, and a
# module.Class.test path is rewritten into the `file.py::Class::test` node id pytest expects. Anything
# starting with `-`, or already naming a path, is passed straight through.

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

# The full run goes parallel; a filtered run does not. Spawning twenty workers to execute one test is
# slower than executing it, and the whole point of naming a test is a fast answer. `-n auto` takes the
# suite from minutes to well under one — safe because each xdist worker is its own *process*, which is
# the isolation the suite already relies on: module-level state (`CONTROL_DB_PATH`, the conftest schema
# template cache) is per-process, and every test builds its own temp database inside that.
if [[ $# -eq 0 ]]; then
  exec "$VENV_PYTHON" -m pytest backend/tests -n auto
fi

# Translate each dotted test path into what pytest understands. The split point is the longest dotted
# prefix that is an actual module file; whatever follows it is the class/method selector.
args=()
for arg in "$@"; do
  if [[ "$arg" == -* || "$arg" == */* || "$arg" != *.* ]]; then
    args+=("$arg")
    continue
  fi
  path="${arg//./\/}"
  selector=""
  while [[ -n "$path" && ! -f "$path.py" ]]; do
    selector="${path##*/}${selector:+::$selector}"
    [[ "$path" == */* ]] || { path=""; break; }
    path="${path%/*}"
  done
  if [[ -z "$path" ]]; then
    args+=("$arg")            # not a module we can resolve — let pytest report it
  elif [[ -z "$selector" ]]; then
    args+=("--pyargs" "$arg")
  else
    args+=("$path.py::$selector")
  fi
done

exec "$VENV_PYTHON" -m pytest "${args[@]}"
