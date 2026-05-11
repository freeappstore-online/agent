#!/bin/bash
# Tail live agent worker logs.
# Usage: bash tail-logs.sh
cd "$(dirname "$0")/.."
npx wrangler tail --format pretty
