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
CHROME_PATH=$(npx puppeteer browsers install chrome | grep -oP '(?<=Browser is downloaded to: ).*' || true)

# Export the path for the application to use
if [ -n "$CHROME_PATH" ]; then
  export PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH"
  echo "PUPPETEER_EXECUTABLE_PATH set to: $PUPPETEER_EXECUTABLE_PATH"
else
  echo "Warning: Could not determine Chrome path from puppeteer install output."
fi
