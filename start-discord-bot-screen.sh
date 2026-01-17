#!/usr/bin/env bash
set -euo pipefail

# Start the Discord bot inside a detached GNU screen session
# Usage: ./start-discord-bot-screen.sh [session-name]
# Default session name: darkchair-bot

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_NAME="${1:-darkchair-bot}"

cd "$ROOT_DIR"

# Load .env if present
if [ -f "$ROOT_DIR/.env" ]; then
  echo "Loading environment from .env"
  set -a
  # shellcheck disable=SC1090
  . "$ROOT_DIR/.env"
  set +a
fi

if ! command -v screen >/dev/null 2>&1; then
  echo "Error: 'screen' is not installed. Please install it (apt/yum/dnf) and rerun." >&2
  exit 2
fi

# Prepare the command to run (xvfb-run if available)
if command -v xvfb-run >/dev/null 2>&1; then
  CMD='xvfb-run -s "-screen 0 1280x720x24" node index.js'
else
  CMD='node index.js'
fi

echo "Starting bot in detached screen session: $SESSION_NAME"
# Use bash -lc to ensure proper quoting and environment expansion inside screen
screen -dmS "$SESSION_NAME" bash -lc "cd '$ROOT_DIR' && exec $CMD"

echo "Started. Attach with: screen -r $SESSION_NAME"
echo "To stop: attach and Ctrl-C, or kill the screen session: screen -S $SESSION_NAME -X quit"
