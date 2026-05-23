#!/bin/sh
# Restart both servers (run from the server/ directory or anywhere — paths resolve relative to this script)
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"

echo "Starting server.js..."
node "$SCRIPT_DIR/server.js" &

echo "Starting server-prod.js..."
node "$SCRIPT_DIR/server-prod.js" &

echo "Both servers started."
echo "PIDs: $(jobs -p)"
