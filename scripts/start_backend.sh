#!/usr/bin/env bash

set -euo pipefail
set -m
trap 'kill -- -$$' EXIT INT TERM

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
ENV_PATH="$ROOT_DIR/.env"
VENV_DIR="$BACKEND_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
LOG_PATH="${LUMA_LOG_PATH:-}"
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
  # A missing key is normal (optional setting): grep exits 1, which under `set -o pipefail`
  # would fail the surrounding command substitution and, with `set -e`, silently kill the
  # caller. Swallow the no-match so an absent key yields an empty value, not an exit.
  grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- || true
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

# No .env is created here, and no secrets are written into one. The backend generates its session
# secret on first run and stores it in the control database; .env is only an optional override file
# for values that must be known before the app starts (ports, database locations).

# A venv is only usable if its python can import pip. A bin/python symlink alone is not enough:
# on Debian/Ubuntu/Mint, `python3 -m venv` without the python3-venv package produces a broken venv
# (no pip, no activate, no ensurepip), and a stale/half-built venv from an earlier failed run can
# linger. Checking pip — not just the symlink — lets us detect and rebuild those automatically.
venv_is_healthy() {
  [[ -x "$VENV_PYTHON" ]] && "$VENV_PYTHON" -m pip --version >/dev/null 2>&1
}

venv_package_hint() {
  echo "On Debian/Ubuntu/Mint this usually means the venv/ensurepip module is missing. Install it with:"
  echo "    sudo apt install python3-venv        # or the version-specific package, e.g. python3.12-venv"
  echo "then re-run this script."
}

# The interpreter that *builds* the venv is chosen by version, not by taking whatever `python3` points
# at. The pinned dependencies need 3.12 or newer, and a venv built from an older default Python fails
# partway through installing them with an error that says nothing about the real cause. Explicitly-named
# versions are tried first so a machine whose default is older, with a newer Python installed beside it,
# still gets a working environment instead of a diagnosis.
#
# Only venv creation is pinned. `SYSTEM_PYTHON` above just opens a socket to test a port, and any
# interpreter does that.
python_is_supported() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1
}

select_venv_python() {
  local candidate
  for candidate in python3.12 python3.13 python3.14 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && python_is_supported "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if ! venv_is_healthy; then
  if [[ -e "$VENV_DIR" ]]; then
    echo "Backend virtual environment is missing or incomplete (no working pip) — rebuilding it..."
    rm -rf "$VENV_DIR"
  else
    echo "Creating backend virtual environment (first run only)..."
  fi
  cd "$BACKEND_DIR"
  if ! VENV_CREATOR="$(select_venv_python)"; then
    echo
    echo "No supported Python was found. Luma needs Python 3.12 or newer."
    echo "Tried: python3.12, python3.13, python3.14, python3, python."
    exit 1
  fi
  echo "Using $VENV_CREATOR ($("$VENV_CREATOR" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'))"

  if ! "$VENV_CREATOR" -m venv venv; then
    echo
    echo "Could not create the virtual environment."
    venv_package_hint
    exit 1
  fi
  cd "$ROOT_DIR"
  # Even when `python3 -m venv` exits 0, a missing ensurepip can leave the venv without pip.
  if ! venv_is_healthy; then
    echo
    echo "The virtual environment was created but pip is not available inside it."
    venv_package_hint
    exit 1
  fi
  "$VENV_PYTHON" -m pip install --upgrade pip >/dev/null
fi

BACKEND_PORT="$(get_env_value "$ENV_PATH" BACKEND_PORT)"
BACKEND_PORT="${BACKEND_PORT:-8011}"

# This computer only unless BACKEND_HOST widens it: the backend serves the built interface as well as
# the API, so a wide bind is the whole application on the network over plain HTTP.
BACKEND_HOST="$(get_env_value "$ENV_PATH" BACKEND_HOST)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"

if port_in_use "$BACKEND_PORT"; then
  echo "Backend port $BACKEND_PORT is already in use. Stop the running backend before starting another one."
  exit 1
fi

cd "$ROOT_DIR"
echo "Checking/installing backend dependencies. This can take a minute on first run..."
"$VENV_PYTHON" -m pip install -r backend/requirements.txt
echo "Starting backend on $BACKEND_HOST port $BACKEND_PORT"
# watchfiles (uvicorn's reloader) force-enables stat-polling whenever the kernel release contains
# "microsoft-standard" — i.e. on all of WSL, keyed on the kernel string rather than on the path being
# watched. The heuristic exists because inotify does not fire for edits made from Windows to a /mnt/c
# DrvFs mount; it is a false positive for a checkout on the WSL2 ext4 filesystem, where inotify works.
# Polling here meant stat()-ing every file under --reload-dir (backend/, which contains the ~7.5k-file
# venv) every 300ms — a measured 28% of a core, burned continuously by the reloader while idle.
#
# Only "false", "disable", and "disabled" turn it off. "0", "no", and "off" are all read as ENABLED.
#
# Move this checkout onto /mnt/c and reload will silently stop working: drop this line if that happens.
export WATCHFILES_FORCE_POLLING=false
# --proxy-headers lets request.url.scheme reflect X-Forwarded-Proto from a trusted reverse proxy
# (Caddy terminating TLS in the client-server topology). It defaults to trusting only a loopback
# proxy, so it is safe/inert for the direct-access dev case here.
"$VENV_PYTHON" -m uvicorn backend.main:app --reload --reload-dir backend --host "$BACKEND_HOST" --port "$BACKEND_PORT" --proxy-headers
