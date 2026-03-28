#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
ENV_PATH="$ROOT_DIR/.env"
ENV_EXAMPLE_PATH="$ROOT_DIR/.env_example"
LOG_PATH="${FINTRACK_LOG_PATH:-}"
SYSTEM_PYTHON=""

if [[ -n "$LOG_PATH" ]]; then
  mkdir -p "$(dirname "$LOG_PATH")"
  exec > >(tee "$LOG_PATH") 2>&1
fi

if command -v python3 >/dev/null 2>&1; then
  SYSTEM_PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  SYSTEM_PYTHON="python"
else
  echo "Python was not found. Install Python 3.12+ and try again."
  exit 1
fi

if [[ ! -f "$ENV_PATH" && -f "$ENV_EXAMPLE_PATH" ]]; then
  cp "$ENV_EXAMPLE_PATH" "$ENV_PATH"
  echo "Created .env from .env_example"
fi

get_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2-
}

port_in_use() {
  local port="$1"
  "$SYSTEM_PYTHON" - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket()
sock.settimeout(0.5)
try:
    sock.connect(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

FRONTEND_PORT="$(get_env_value "$ENV_PATH" FRONTEND_PORT)"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

if port_in_use "$FRONTEND_PORT"; then
  echo "Frontend port $FRONTEND_PORT is already in use. Stop the running frontend before starting another one."
  exit 1
fi

cd "$FRONTEND_DIR"
echo "Checking/installing frontend dependencies. This can take a minute on first run..."
npm install
echo "Starting frontend"
exec npm run dev
