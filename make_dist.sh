#!/usr/bin/env bash

# make_dist.sh — Package FinTrack source files for distribution
#
# Run this from inside your installed FinTrack directory:
#   bash make_dist.sh
#
# Or point it at a different install:
#   bash make_dist.sh /path/to/fintrack
#
# Output: fintrack-dist-YYYYMMDD.zip in the current working directory.
# The zip contains only the files needed to build and run FinTrack —
# no database, no node_modules, no __pycache__, no .env secrets.

set -euo pipefail

# ── Resolve source directory ──────────────────────────────────────────────────
SRC="${1:-$(pwd)}"
SRC="$(cd "$SRC" && pwd)"   # canonicalize

# Verify it looks like a FinTrack install
if [[ ! -f "$SRC/docker-compose.yml" || ! -d "$SRC/backend" || ! -d "$SRC/frontend" ]]; then
  echo "ERROR: '$SRC' doesn't look like a FinTrack directory."
  echo "       Expected: docker-compose.yml, backend/, frontend/"
  exit 1
fi

# ── Output filename ───────────────────────────────────────────────────────────
DATESTAMP="$(date +%Y%m%d)"
OUT="$(pwd)/fintrack-dist-${DATESTAMP}.zip"

# If a zip for today already exists, add a counter suffix
COUNTER=1
while [[ -f "$OUT" ]]; do
  OUT="$(pwd)/fintrack-dist-${DATESTAMP}-${COUNTER}.zip"
  (( COUNTER++ ))
done

# ── Files/dirs to include ─────────────────────────────────────────────────────
INCLUDE=(
  "docker-compose.yml"
  "README.md"
  "CHANGELOG.md"
  "CONTRIBUTING.md"
  "LICENSE"
  ".env_example"
  "make_dist.bat"
  "make_dist.sh"
  "make_dist.ps1"
  "docs/"
  "backend/main.py"
  "backend/runtime_config.py"
  "backend/requirements.txt"
  "backend/pyproject.toml"
  "backend/.python-version"
  "backend/Dockerfile"
  "backend/db/"
  "backend/routers/"
  "backend/services/"
  "frontend/index.html"
  "frontend/vite.config.js"
  "frontend/package.json"
  "frontend/package-lock.json"
  "frontend/.nvmrc"
  "frontend/nginx.conf"
  "frontend/Dockerfile"
  "frontend/src/"
  "scripts/"
)

# ── Patterns to exclude ───────────────────────────────────────────────────────
EXCLUDE=(
  # Runtime / generated
  "*/__pycache__/*"
  "*/.pytest_cache/*"
  "*/node_modules/*"
  "*/dist/*"
  "*/build/*"
  "*/*.pyc"
  "*/*.pyo"
  # Data & secrets
  "*/data/*"
  "*/fintrack.db"
  "*/control.db"
  "*/fintrack-data.db"
  "*/fintrack-control.db"
  "*/.env"
  "*/.env.*"
  "*/*.log"
  "*/credentials.json"
  # Editor / OS noise
  "*/.DS_Store"
  "*/.idea/*"
  "*/.vscode/*"
  "*/Thumbs.db"
  # Git internals
  "*/.git/*"
  "*/.gitignore"
)

# ── Build exclude flags for zip ───────────────────────────────────────────────
EXCLUDE_FLAGS=()
for pattern in "${EXCLUDE[@]}"; do
  EXCLUDE_FLAGS+=("--exclude" "$pattern")
done

# ── Create the zip ────────────────────────────────────────────────────────────
echo "Packaging FinTrack from: $SRC"
echo "Output:                  $OUT"
echo

cd "$SRC"

PATHS=()
for item in "${INCLUDE[@]}"; do
  if [[ -e "$item" ]]; then
    PATHS+=("$item")
  else
    echo "  WARN: '$item' not found — skipping"
  fi
done

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "ERROR: No source files found in '$SRC'"
  exit 1
fi

zip -r "$OUT" "${PATHS[@]}" "${EXCLUDE_FLAGS[@]}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "Done. Contents:"
zip -sf "$OUT" | head -60
FILE_COUNT="$(zip -sf "$OUT" | grep -c '^\s' || true)"
SIZE="$(du -sh "$OUT" | cut -f1)"
echo
echo "  Files: ~${FILE_COUNT}   Size: ${SIZE}"
echo "  → $OUT"
