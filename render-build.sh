#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status.
set -o errexit

# Install dependencies
npm install

# Ensure the Puppeteer cache directory exists
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p "$PUPPETEER_CACHE_DIR"
export PUPPETEER_CACHE_DIR

# Install Puppeteer and download the Chrome browser
INSTALL_OUTPUT=$(npx puppeteer browsers install chrome 2>&1)
echo "$INSTALL_OUTPUT"

# Extract the full path to the chrome executable
# This assumes the path is the last word on a line containing "/opt/render/.cache/puppeteer/chrome/"
CHROME_EXECUTABLE=$(echo "$INSTALL_OUTPUT" | grep -oP '/opt/render/\.cache/puppeteer/chrome/[^[:space:]]+' | tail -n 1 || true)

# Export the path for the application to use
if [ -n "$CHROME_EXECUTABLE" ]; then
  export PUPPETEER_EXECUTABLE_PATH="$CHROME_EXECUTABLE"
  echo "PUPPETEER_EXECUTABLE_PATH set to: $PUPPETEER_EXECUTABLE_PATH"
else
  echo "Error: Could not determine Chrome executable path from puppeteer install output."
  exit 1 # Exit with an error to fail the Render build
fi
