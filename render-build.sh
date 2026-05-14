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

# Extract the base directory where Chrome is downloaded
BROWSER_DIR=$(echo "$INSTALL_OUTPUT" | grep "Browser is downloaded to:" | sed -E 's/Browser is downloaded to: //')

# Construct the full executable path
if [ -n "$BROWSER_DIR" ]; then
  # Find the 'chrome' executable within the downloaded directory
  CHROME_EXECUTABLE=$(find "$BROWSER_DIR" -name "chrome" -type f -print -quit)

  if [ -n "$CHROME_EXECUTABLE" ]; then
    export PUPPETEER_EXECUTABLE_PATH="$CHROME_EXECUTABLE"
    echo "PUPPETEER_EXECUTABLE_PATH set to: $PUPPETEER_EXECUTABLE_PATH"
  else
    echo "Error: 'chrome' executable not found within $BROWSER_DIR."
    exit 1
  fi
else
  echo "Error: Could not determine browser download directory from puppeteer install output."
  exit 1
fi
