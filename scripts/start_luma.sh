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
  # A missing key is normal (optional setting): grep exits 1, which under `set -o pipefail`
  # would fail the surrounding command substitution and, with `set -e`, silently kill the
  # caller. Swallow the no-match so an absent key yields an empty value, not an exit.
  grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- || true
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

cleanup_stray_processes() {
  local root="$1"

  #echo "Checking for stray processes..."

  # Find processes whose command includes the project path
  pids=$(ps -eo pid=,args= | awk -v root="$root" '
    $0 ~ root && $0 !~ /awk/ && $0 !~ /start_luma.sh/ { print $1 }
  ')

  if [[ -z "$pids" ]]; then
    #echo "No stray processes found."
    return
  fi

  #echo "Found stray processes:"
  #ps -fp $pids

  echo "Killing stray processes..."
  ps -fp $pids
  kill -TERM $pids 2>/dev/null || true
  sleep 1

  # Force kill if still alive
  still_alive=$(ps -o pid= -p $pids 2>/dev/null || true)
  if [[ -n "$still_alive" ]]; then
    echo "Force killing remaining processes..."
    kill -KILL $still_alive 2>/dev/null || true
  fi

  #echo "Cleanup complete."
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
    env_prefix=(env LUMA_LOG_PATH="$log_path")
    bash_command="LUMA_LOG_PATH=\"$log_path\" bash \"$script_path\"; exec bash"
  fi

  #  WSL detection
  if grep -qi microsoft /proc/version 2>/dev/null; then
    if command -v wt.exe >/dev/null 2>&1; then
      wt.exe -w 0 new-tab --title "$title" wsl.exe bash -lc "\"$script_path\"" \
        || wt.exe new-tab --title "$title" wsl.exe bash -lc "\"$script_path\""
    else
      cmd.exe /c start "" wt.exe new-tab --title "$title" wsl.exe bash -ic "\"$script_path\""
    fi
    return 0
  fi
  
  #  Native Linux
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

USE_LOG_FILES_VALUE="$(get_env_value "$ENV_PATH" LUMA_USE_LOG_FILES)"
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
BACKEND_READY_TIMEOUT="$(get_positive_int "$(get_env_value "$ENV_PATH" LUMA_BACKEND_READY_TIMEOUT)" 180)"
BACKEND_HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/api/health"

if port_in_use "$BACKEND_PORT"; then
  echo "Backend port $BACKEND_PORT is already in use."
  exit 1
fi
if port_in_use "$FRONTEND_PORT"; then
  echo "Frontend port $FRONTEND_PORT is already in use."
  exit 1
fi

if [[ "$USE_LOG_FILES" == "1" ]]; then
  BACKEND_TERMINAL_LOG="$BACKEND_LOG"
  FRONTEND_TERMINAL_LOG="$FRONTEND_LOG"
else
  BACKEND_TERMINAL_LOG=""
  FRONTEND_TERMINAL_LOG=""
fi

#wsl can leave an otherwise harmless stray process around from 
#   the parent terminal. Clean them up so they don't build up
cleanup_stray_processes "$ROOT_DIR"

if open_in_terminal "$BACKEND_SCRIPT" "Luma Backend" "$BACKEND_TERMINAL_LOG"; then
  echo "Started backend in a new terminal window."
else
  echo "Could not open a new terminal window for the backend."
  bash "$BACKEND_SCRIPT" &
fi

echo "Waiting for backend to respond on $BACKEND_HEALTH_URL ..."
if wait_backend_ready "$BACKEND_HEALTH_URL" "$BACKEND_READY_TIMEOUT"; then
  echo "Backend is ready."
else
  echo "Backend did not become ready in time."
fi

if open_in_terminal "$FRONTEND_SCRIPT" "Luma Frontend" "$FRONTEND_TERMINAL_LOG"; then
  echo "Started frontend in a new terminal window."
else
  echo "Could not open a new terminal window for the frontend."
  bash "$FRONTEND_SCRIPT" &
fi

echo
echo "Luma launch requested."
