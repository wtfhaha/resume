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
npx puppeteer browsers install chrome
