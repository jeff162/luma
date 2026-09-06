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
# **Every run is also written whole to `data/check-logs/`, and that is not a convenience.** A suite with a
# known intermittent turns every run into a capture opportunity, and the interesting output of a failure is
# in the middle — so a reader who pipes this into `tail` or a filtering `grep` (which everyone does, since
# the normal question is just "did it pass?") throws away the only evidence that failure will ever produce.
# That has already cost this repo a reproduction of the intermittent 401 the auth middleware was
# instrumented for, twice. Piping is therefore made safe rather than forbidden: `tee` keeps the stream
# exactly as it was, the file holds everything regardless, and the path is printed on the **last** line so
# it survives being tailed. Filter the file, never the stream. A failing run's logs are kept until a later
# failure replaces them; passing runs are pruned to the last few.
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

run_dir="data/check-logs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$run_dir"

# Run one phase, streaming it as before while keeping the whole thing on disk. `PIPESTATUS[0]` is the
# phase's own exit code — without it every phase would report `tee`'s success instead.
phase() {
  local name="$1"; shift
  echo "== $name =="
  "$@" 2>&1 | tee "$run_dir/${name// /-}.log"
  return "${PIPESTATUS[0]}"
}

run_backend() { ./scripts/run_tests.sh "${@}"; }
run_frontend_lint() { ( cd frontend && npm run lint ); }
run_frontend_check() { ( cd frontend && npm run check ); }

if [[ "$target" == "backend" || "$target" == "all" ]]; then
  phase "backend" run_backend "${@:2}" || rc=$?
fi

if [[ "$target" == "lint" ]]; then
  phase "frontend-lint" run_frontend_lint || rc=$?
fi

if [[ "$target" == "frontend" || "$target" == "all" ]]; then
  phase "frontend-check" run_frontend_check || rc=$?
fi

if [[ "$rc" -ne 0 ]]; then
  # Marked so a later passing run's prune leaves it alone, and named on the last line so the path
  # survives a `| tail`. This is the artifact to read *before* re-running anything.
  touch "$run_dir/.failed"
  echo
  echo "FAILED (exit $rc). Full output preserved — investigate this before re-running:"
  echo "  $run_dir"
else
  # Keep a few passing runs (a warning worth seeing can appear in one), then prune. Failed runs are
  # never pruned: they are the whole point of writing these.
  # shellcheck disable=SC2012
  ls -1dt data/check-logs/*/ 2>/dev/null | while read -r d; do
    [[ -e "$d/.failed" ]] && continue
    echo "$d"
  done | tail -n +4 | xargs -r rm -rf
  echo
  echo "Full output: $run_dir"
fi

exit "$rc"
