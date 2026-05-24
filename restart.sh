#!/bin/sh
# Restart the server (run from anywhere — path resolves relative to this script)
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"

echo "Starting server.js..."
node "$SCRIPT_DIR/server.js" &

echo "PID: $!"
