#!/usr/bin/env bash
set -euo pipefail

npm remove darkchair_api_youtube
npm install https://github.com/DarkNio88/DarkChair_API_YouTube.git

# Starter script for the Discord bot
# Uses xvfb-run -s "-screen 0 1280x720x24" node index.js when available
# Loads environment variables from .env (if present)

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# Load .env into environment if present
if [ -f "$ROOT_DIR/.env" ]; then
  echo "Loading environment from .env"
  set -a
  # shellcheck disable=SC1090
  . "$ROOT_DIR/.env"
  set +a
fi

if command -v xvfb-run >/dev/null 2>&1; then
  echo "Starting bot under xvfb-run (virtual X frame buffer)"
  exec xvfb-run -s "-screen 0 1280x720x24" node index.js
else
  echo "xvfb-run not found — starting node directly"
  exec node index.js
fi
