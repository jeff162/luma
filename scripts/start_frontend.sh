#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
ENV_PATH="$ROOT_DIR/.env"
ENV_EXAMPLE_PATH="$ROOT_DIR/.env_example"
LOG_PATH="${FINTRACK_LOG_PATH:-}"

if [[ -n "$LOG_PATH" ]]; then
  mkdir -p "$(dirname "$LOG_PATH")"
  exec > >(tee "$LOG_PATH") 2>&1
fi

if [[ ! -f "$ENV_PATH" && -f "$ENV_EXAMPLE_PATH" ]]; then
  cp "$ENV_EXAMPLE_PATH" "$ENV_PATH"
  echo "Created .env from .env_example"
fi

cd "$FRONTEND_DIR"
echo "Checking/installing frontend dependencies. This can take a minute on first run..."
npm install
echo "Starting frontend"
exec npm run dev
