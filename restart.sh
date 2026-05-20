#!/bin/sh
# Restart both servers
echo "Starting server.js (port 5000)..."
node /Users/react/Downloads/resume-optimizer-app/server/server.js &
echo "Starting server-prod.js (port 5001)..."
node /Users/react/Downloads/resume-optimizer-app/server/server-prod.js &
echo "Both servers started."
echo "PIDs: $(jobs -p)"
