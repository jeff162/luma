#!/bin/sh

# Launch an ISOLATED backend for Playwright E2E: a throwaway, freshly-seeded SQLite stack on its own
# port so browser tests never touch the developer's real luma-data.db. The DB locations are
# env-driven (backend/db/database.py, db/control_database.py), and an empty control DB puts the app in
# local/no-auth mode routing to the temp data DB — the same isolation the _api_client.py unit harness
# uses. main.py's lifespan runs init_db()/init_control_db() on startup, so the temp DB comes up seeded
# (default categories + rules). The temp dir is wiped each launch for a clean slate.
# Port comes from the Playwright config (E2E_BACKEND_PORT) so there is a single source of truth.

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT_DIR/backend/.e2e-tmp"
PORT="${E2E_BACKEND_PORT:-8099}"

rm -rf "$E2E_DIR"
mkdir -p "$E2E_DIR"

# main.py loads its .env with override=True, so a repo .env's DATA_DIR would otherwise clobber any env
# vars we export here. Instead we hand main.py an ISOLATED env file (via LUMA_ENV_FILE) whose throwaway
# data directory wins, fully isolating every DB from the real data.
cat > "$E2E_DIR/.env" <<EOF
DATA_DIR=$E2E_DIR
SESSION_SECRET=e2e-playwright-secret
EOF

cd "$ROOT_DIR"
# DB_PATH / CONTROL_DB_PATH are per-file overrides that outrank DATA_DIR, so a stale one exported in the
# caller's shell would silently point this "isolated" stack at real data. Clear them explicitly.
exec env -u DB_PATH -u CONTROL_DB_PATH \
  LUMA_ENV_FILE="$E2E_DIR/.env" \
  "$ROOT_DIR/backend/venv/bin/python" -m uvicorn backend.main:app --host 127.0.0.1 --port "$PORT"
