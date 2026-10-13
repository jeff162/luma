#!/bin/sh

# Installs the repository's pre-commit hook. Runs unattended from the frontend's `postinstall`, which
# is what shapes the rules below: it executes on a contributor's machine without being asked for, so it
# must never surprise them or fail the install that invoked it.
#
# - A checkout with no working git directory (a downloaded tarball, a sandbox, `--ignore-scripts`) is
#   not an error. There is nowhere to install to, and failing an `npm install` over a missing
#   convenience would be worse than the missing convenience.
# - A pre-commit hook this script did not write is left alone. Someone else's hook is their work; the
#   marker line is how a hook of ours is recognized across versions, and anything without it is
#   reported along with the manual command rather than overwritten.
# - `core.hooksPath` wins when set, because git ignores `.git/hooks` in that case and a hook installed
#   there would be silently dead.

MARKER="# installed by scripts/install-hooks.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/scripts/pre-commit.sh"

if ! command -v git >/dev/null 2>&1 || ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Git hooks: not a git checkout, skipping. Run scripts/install-hooks.sh if that changes."
  exit 0
fi

CONFIGURED="$(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null)"
if [ -n "$CONFIGURED" ]; then
  HOOKS_DIR="$CONFIGURED"
else
  HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null)"
fi
case "$HOOKS_DIR" in
  /*) ;;
  *) HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;;
esac

TARGET="$HOOKS_DIR/pre-commit"

# A hook installed by an earlier version of this script is a copy of the source with no marker, so an
# exact match counts as ours and is upgraded in place rather than reported as somebody else's work.
if [ -e "$TARGET" ] && ! grep -qF "$MARKER" "$TARGET" 2>/dev/null && ! cmp -s "$TARGET" "$SOURCE"; then
  echo "Git hooks: $TARGET exists and was not installed by this script — leaving it alone."
  echo "           To use the project's hook instead: cp $SOURCE $TARGET"
  exit 0
fi

# The marker sits on line two: a `#!` is only honored as the first line of the file.
if ! mkdir -p "$HOOKS_DIR" 2>/dev/null ||
   ! { head -n 1 "$SOURCE"; printf '%s\n' "$MARKER"; tail -n +2 "$SOURCE"; } > "$TARGET.tmp" 2>/dev/null ||
   ! mv "$TARGET.tmp" "$TARGET" 2>/dev/null; then
  echo "Git hooks: could not write $TARGET, skipping."
  rm -f "$TARGET.tmp"
  exit 0
fi

chmod +x "$TARGET" 2>/dev/null
echo "Git hooks: pre-commit installed at $TARGET."
exit 0
