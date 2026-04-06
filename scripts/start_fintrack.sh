#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_PATH="$ROOT_DIR/.env"
BACKEND_SCRIPT="$SCRIPT_DIR/start_backend.sh"
FRONTEND_SCRIPT="$SCRIPT_DIR/start_frontend.sh"
SYSTEM_PYTHON=""

if command -v python3 >/dev/null 2>&1; then
  SYSTEM_PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  SYSTEM_PYTHON="python"
else
  echo "Python was not found. Install Python 3.12+ and try again."
  exit 1
fi

get_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2-
}

get_positive_int() {
  local value="${1:-}"
  local fallback="${2:-180}"
  if [[ "$value" =~ ^[0-9]+$ ]] && (( value > 0 )); then
    echo "$value"
  else
    echo "$fallback"
  fi
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

is_truthy() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    return 1
  fi
  case "${value,,}" in
    1|true|yes|on) return 0 ;;
    0|false|no|off) return 1 ;;
    *) return 1 ;;
  esac
}

wait_backend_ready() {
  local url="$1"
  local attempts="${2:-60}"

  for ((i=0; i<attempts; i++)); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$url" >/dev/null 2>&1; then
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -qO- "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      sleep 5
      return 1
    fi
    if [[ "$i" == "0" ]]; then
      echo "Backend is still starting. Waiting for it to become ready..."
    elif (( (i + 1) % 5 == 0 )); then
      echo "Still waiting for backend startup..."
    fi
    sleep 1
  done
  return 1
}

open_in_terminal() {
  local script_path="$1"
  local title="$2"
  local log_path="$3"
  local env_prefix=()
  local bash_command="bash \"$script_path\"; exec bash"

  if [[ -n "$log_path" ]]; then
    env_prefix=(env FINTRACK_LOG_PATH="$log_path")
    bash_command="FINTRACK_LOG_PATH=\"$log_path\" bash \"$script_path\"; exec bash"
  fi

  if command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -T "$title" -e "${env_prefix[@]}" bash "$script_path" &
    return 0
  fi
  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash -lc "$bash_command" &
    return 0
  fi
  if command -v konsole >/dev/null 2>&1; then
    konsole --new-tab -p tabtitle="$title" -e "${env_prefix[@]}" bash "$script_path" &
    return 0
  fi
  if command -v xterm >/dev/null 2>&1; then
    xterm -T "$title" -e "${env_prefix[@]}" bash "$script_path" &
    return 0
  fi
  return 1
}

USE_LOG_FILES_VALUE="$(get_env_value "$ENV_PATH" FINTRACK_USE_LOG_FILES)"
if is_truthy "$USE_LOG_FILES_VALUE"; then
  USE_LOG_FILES=1
else
  USE_LOG_FILES=0
fi

BACKEND_LOG="$SCRIPT_DIR/backend.log"
FRONTEND_LOG="$SCRIPT_DIR/frontend.log"
BACKEND_PORT="$(get_env_value "$ENV_PATH" BACKEND_PORT)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="$(get_env_value "$ENV_PATH" FRONTEND_PORT)"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_READY_TIMEOUT="$(get_positive_int "$(get_env_value "$ENV_PATH" FINTRACK_BACKEND_READY_TIMEOUT)" 180)"
BACKEND_HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/api/health"

if port_in_use "$BACKEND_PORT"; then
  echo "Backend port $BACKEND_PORT is already in use. Stop the running backend before running start_fintrack again."
  exit 1
fi
if port_in_use "$FRONTEND_PORT"; then
  echo "Frontend port $FRONTEND_PORT is already in use. Stop the running frontend before running start_fintrack again."
  exit 1
fi

if [[ "$USE_LOG_FILES" == "1" ]]; then
  BACKEND_TERMINAL_LOG="$BACKEND_LOG"
  FRONTEND_TERMINAL_LOG="$FRONTEND_LOG"
else
  BACKEND_TERMINAL_LOG=""
  FRONTEND_TERMINAL_LOG=""
fi

if open_in_terminal "$BACKEND_SCRIPT" "FinTrack Backend" "$BACKEND_TERMINAL_LOG"; then
  echo "Started backend in a new terminal window."
else
  echo "Could not open a new terminal window for the backend."
  if [[ "$USE_LOG_FILES" == "1" ]]; then
    echo "Starting backend in the background and writing to scripts/backend.log"
    FINTRACK_LOG_PATH="$BACKEND_LOG" bash "$BACKEND_SCRIPT" &
  else
    echo "Starting backend in the background."
    bash "$BACKEND_SCRIPT" &
  fi
fi

echo "Waiting for backend to respond on $BACKEND_HEALTH_URL ..."
if wait_backend_ready "$BACKEND_HEALTH_URL" "$BACKEND_READY_TIMEOUT"; then
  echo "Backend is ready."
else
  echo "Backend did not become ready within $BACKEND_READY_TIMEOUT seconds. Starting the frontend anyway."
fi

if open_in_terminal "$FRONTEND_SCRIPT" "FinTrack Frontend" "$FRONTEND_TERMINAL_LOG"; then
  echo "Started frontend in a new terminal window."
else
  echo "Could not open a new terminal window for the frontend."
  if [[ "$USE_LOG_FILES" == "1" ]]; then
    echo "Starting frontend in the background and writing to scripts/frontend.log"
    FINTRACK_LOG_PATH="$FRONTEND_LOG" bash "$FRONTEND_SCRIPT" &
  else
    echo "Starting frontend in the background."
    bash "$FRONTEND_SCRIPT" &
  fi
fi

echo
echo "FinTrack launch requested."
if [[ "$USE_LOG_FILES" == "1" ]]; then
  echo "Logs are overwritten on each launch:"
  echo "  $BACKEND_LOG"
  echo "  $FRONTEND_LOG"
else
  echo "Log files are disabled by FINTRACK_USE_LOG_FILES in .env."
fi
