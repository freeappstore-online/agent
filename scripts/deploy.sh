#!/bin/bash
# Deploy agent worker safely — doesn't kill active Durable Objects.
# Uses wrangler versions upload + deployments create instead of wrangler deploy.
set -e

cd "$(dirname "$0")/.."

echo "=== Safe Agent Deploy ==="

# 1. Typecheck + test
echo "Typechecking..."
npx tsc --noEmit
echo "Running tests..."
npx vitest run

# 2. Upload new version (does NOT activate)
echo "Uploading new version..."
VERSION_OUTPUT=$(npx wrangler versions upload 2>&1)
echo "$VERSION_OUTPUT"

# Extract version ID
VERSION_ID=$(echo "$VERSION_OUTPUT" | grep -o 'Version ID: [a-f0-9-]*' | head -1 | cut -d' ' -f3)
if [ -z "$VERSION_ID" ]; then
  echo "ERROR: Could not extract version ID"
  exit 1
fi
echo "Version: $VERSION_ID"

# 3. Deploy with gradual rollout (new requests get new code, existing DOs finish on old)
echo "Deploying version..."
npx wrangler deployments create --version-id "$VERSION_ID" --percentage 100 --message "$(date -u +%Y-%m-%dT%H:%M:%S)" 2>&1

echo ""
echo "Deployed. Active sessions continue on old code until idle."
