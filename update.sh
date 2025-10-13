#!/usr/bin/env bash
# update.sh - stop existing backend node process(es) and restart with nohup
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$DIR/backend"
LOGFILE="$BACKEND_DIR/backend.log"

echo "Updating chat-app backend..."

if [ ! -d "$BACKEND_DIR" ]; then
  echo "Backend directory not found: $BACKEND_DIR"
  exit 1
fi

cd "$BACKEND_DIR"

echo "Ensuring npm is available (sourcing common shell rc files)..."
# try to source common shell files to pick up nvm or path settings
if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc" || true; fi
if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile" || true; fi
if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc" || true; fi
if [ -f "$HOME/.profile" ]; then source "$HOME/.profile" || true; fi

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

echo "Starting backend with nohup, logging to $LOGFILE"
nohup node server.js > "$LOGFILE" 2>&1 &
PID=$!
echo "Started (PID: $PID)"
echo "Tail logs with: tail -f $LOGFILE"

exit 0
