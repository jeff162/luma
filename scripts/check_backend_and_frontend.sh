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
# it survives being tailed. Filter the file, never the stream.
#
# **A failed browser run's artifacts are copied out too**, to `data/check-logs/last-browser-failure/`.
# Playwright empties `frontend/test-results/` at the start of every run, so the screenshots, videos and
# traces of a failure are gone the moment anything re-runs the suite — which has already cost this repo
# the evidence for one intermittent. There is one copy, replaced only by the next failure, so a passing
# re-run never touches it.
#
# Retention: a failed run's logs and the browser copy are deleted once they are 30 days old, which is long
# enough to investigate a failure, and anything still open by then is named in
# `docs/transient-failures.md`. Passing runs are pruned to the last three. Loose files at the top of
# `data/check-logs/` are left alone; the only one this script writes is `00-README.md`, which describes
# the directory.
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

logs_dir="data/check-logs"
run_dir="$logs_dir/$(date +%Y%m%d-%H%M%S)-$$"
browser_copy="$logs_dir/last-browser-failure"
retention_days=30
mkdir -p "$run_dir"
# Anything in `frontend/test-results/` newer than this was written by this run, not left by an earlier one.
touch "$run_dir/.started"

# `data/` is gitignored, so the directory's description is written here, beside the policy it states.
cat > "$logs_dir/00-README.md" <<EOF
# check-logs

Written by \`scripts/check_backend_and_frontend.sh\`, the test gate. Each run's full output is kept in a
folder named by its start time.

- A failed run is marked with \`.failed\` and kept for $retention_days days as evidence; open intermittents are
  named in \`docs/transient-failures.md\`.
- Passing runs are pruned to the newest three.
- \`last-browser-failure/\` holds the screenshots, videos and traces of the latest failed browser run,
  replaced only by the next one and deleted after $retention_days days.
- Loose files are never pruned, so ad-hoc logs do not belong here.

This file is rewritten on every run.
EOF

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

# Failed runs and the browser copy past the retention window. A run is dated by its `.failed` marker and
# the copy by its `.copied` one, since a directory's own time moves whenever anything inside it changes.
find "$logs_dir" -mindepth 2 -maxdepth 2 \( -name .failed -o -name .copied \) -mtime +"$retention_days" \
  | while read -r marker; do rm -rf "$(dirname "$marker")"; done

if [[ "$rc" -ne 0 ]]; then
  # Marked so the passing-run prune leaves it alone, and named on the last line so the path survives a
  # `| tail`. This is the artifact to read *before* re-running anything.
  touch "$run_dir/.failed"
  # Only a run whose browser suite wrote something replaces the copy: a lint failure stops `npm run check`
  # before Playwright starts, and must not overwrite the evidence of an earlier browser failure.
  if [[ -n "$(find frontend/test-results -mindepth 1 -newer "$run_dir/.started" -print -quit 2>/dev/null)" ]]; then
    rm -rf "$browser_copy"
    cp -r frontend/test-results "$browser_copy"
    echo "$run_dir" > "$browser_copy/.copied"
    browser_note="  Browser screenshots, videos and traces: $browser_copy"
  fi
  echo
  echo "FAILED (exit $rc). Full output preserved — investigate this before re-running:"
  [[ -n "${browser_note:-}" ]] && echo "$browser_note"
  echo "  $run_dir"
else
  # Keep a few passing runs (a warning worth seeing can appear in one), then prune. Only run directories,
  # which are named by their start time; the browser copy is not one.
  # shellcheck disable=SC2012
  ls -1dt "$logs_dir"/[0-9]*/ 2>/dev/null | while read -r d; do
    [[ -e "$d/.failed" ]] && continue
    echo "$d"
  done | tail -n +4 | xargs -r rm -rf
  echo
  echo "Full output: $run_dir"
fi

exit "$rc"
