#!/usr/bin/env bash
# update.sh - stop existing backend node process(es) and restart with nohup
set -euo pipefail

# default port
PORT=""

# parse args for --port or -p
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      PORT="$2"; shift 2;;
    --help|-h)
      echo "Usage: $0 [--port <port>]"; exit 0;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

# fallback to environment variable if set
if [[ -z "$PORT" && -n "${PORT:-}" ]]; then
  PORT="${PORT:-}"
fi

# default to 3000 if still empty
if [[ -z "$PORT" ]]; then
  PORT=3000
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$DIR/backend"
LOGFILE="$BACKEND_DIR/backend.log"

echo "Updating chat-app backend..."

if [ ! -d "$BACKEND_DIR" ]; then
  echo "Backend directory not found: $BACKEND_DIR"
  exit 1
fi

cd "$BACKEND_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH. Please ensure Node.js and npm are installed and available." >&2
  exit 1
fi

echo "Running npm install to ensure dependencies are present..."
npm install || { echo "npm install failed"; exit 1; }

echo "Killing existing node server.js processes (if any)..."
# Try to kill processes matching 'node server.js' safely
pkill -f "node.*server.js" || true
sleep 1

echo "Starting backend with nohup on port $PORT, logging to $LOGFILE"
env PORT="$PORT" nohup node server.js > "$LOGFILE" 2>&1 &
PID=$!
echo "Started (PID: $PID)"
echo "Tail logs with: tail -f $LOGFILE"

exit 0
