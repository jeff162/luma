#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
ENV_PATH="$ROOT_DIR/.env"
ENV_EXAMPLE_PATH="$ROOT_DIR/.env_example"
VENV_DIR="$BACKEND_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
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

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [[ -f "$file" ]] && grep -Eq "^${key}=" "$file"; then
    "$SYSTEM_PYTHON" - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines()
updated = False
for i, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[i] = f"{key}={value}"
        updated = True
        break
if not updated:
    if lines and lines[-1] != "":
        lines.append("")
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  else
    [[ -f "$file" ]] || : > "$file"
    if [[ -s "$file" ]]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

generate_session_secret() {
  "$SYSTEM_PYTHON" - <<'PY'
import base64
import secrets
print(base64.urlsafe_b64encode(secrets.token_bytes(36)).decode().rstrip('='))
PY
}

generate_app_master_key() {
  "$SYSTEM_PYTHON" - <<'PY'
import base64
import secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
}

default_session_cookie_name() {
  "$SYSTEM_PYTHON" - "$ROOT_DIR" <<'PY'
from pathlib import Path
import sys

name = Path(sys.argv[1]).name.lower()
sanitized = ''.join(ch if ch.isalnum() else '_' for ch in name).strip('_') or 'fintrack'
print(f"{sanitized}_session")
PY
}

invalid_session_secret() {
  local value="${1:-}"
  [[ -z "${value// }" || "$value" == "change_me_to_a_long_random_value" || "$value" == "dev-session-secret-change-me" ]]
}

if [[ ! -f "$ENV_PATH" && -f "$ENV_EXAMPLE_PATH" ]]; then
  cp "$ENV_EXAMPLE_PATH" "$ENV_PATH"
  echo "Created .env from .env_example"
fi

if [[ -f "$ENV_PATH" ]]; then
  if [[ -z "$SYSTEM_PYTHON" ]]; then
    echo "Python was not found. Install Python 3.12+ and try again."
    exit 1
  fi
  SESSION_SECRET_VALUE="$(get_env_value "$ENV_PATH" SESSION_SECRET)"
  APP_MASTER_KEY_VALUE="$(get_env_value "$ENV_PATH" APP_MASTER_KEY)"
  SESSION_COOKIE_NAME_VALUE="$(get_env_value "$ENV_PATH" SESSION_COOKIE_NAME)"
  UPDATED_ENV=0

  if invalid_session_secret "$SESSION_SECRET_VALUE"; then
    set_env_value "$ENV_PATH" SESSION_SECRET "$(generate_session_secret)"
    UPDATED_ENV=1
  fi
  if [[ -z "${APP_MASTER_KEY_VALUE// }" ]]; then
    set_env_value "$ENV_PATH" APP_MASTER_KEY "$(generate_app_master_key)"
    UPDATED_ENV=1
  fi
  if [[ -z "${SESSION_COOKIE_NAME_VALUE// }" || "$SESSION_COOKIE_NAME_VALUE" == "session" ]]; then
    set_env_value "$ENV_PATH" SESSION_COOKIE_NAME "$(default_session_cookie_name)"
    UPDATED_ENV=1
  fi

  if [[ "$UPDATED_ENV" -eq 1 ]]; then
    echo "Updated .env with secure startup defaults"
  fi
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Creating backend virtual environment (first run only)..."
  cd "$BACKEND_DIR"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv venv
  elif command -v python >/dev/null 2>&1; then
    python -m venv venv
  else
    echo "Python was not found. Install Python 3.12+ and try again."
    exit 1
  fi
  "$VENV_PYTHON" -m pip install --upgrade pip >/dev/null
fi

BACKEND_PORT="$(get_env_value "$ENV_PATH" BACKEND_PORT)"
BACKEND_PORT="${BACKEND_PORT:-8000}"

if port_in_use "$BACKEND_PORT"; then
  echo "Backend port $BACKEND_PORT is already in use. Stop the running backend before starting another one."
  exit 1
fi

cd "$BACKEND_DIR"
echo "Checking/installing backend dependencies. This can take a minute on first run..."
"$VENV_PYTHON" -m pip install -r requirements.txt
echo "Starting backend on port $BACKEND_PORT"
exec "$VENV_PYTHON" -m uvicorn main:app --reload --host 0.0.0.0 --port "$BACKEND_PORT"
