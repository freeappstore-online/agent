#!/bin/bash
# Sync consolidated agent source to the FGS agent repo.
# FAS is the source of truth. FGS gets the same src/ + tests,
# but its own wrangler.toml (STORE="games") and deploy.yml.
#
# Usage: bash scripts/sync-to-fgs.sh
set -e

SRC="$(dirname "$0")/.."
DEST="/Users/serge/dev/fgs/platform/agent"

if [ ! -d "$DEST" ]; then
  echo "ERROR: FGS agent not found at $DEST"
  exit 1
fi

echo "=== Syncing agent source: FAS → FGS ==="

# Sync src/ (the shared codebase)
echo "Syncing src/..."
rsync -a --delete --exclude='*.test.ts' "$SRC/src/" "$DEST/src/"

# Sync test files
echo "Syncing tests..."
rsync -a "$SRC/src/"*.test.ts "$DEST/src/" 2>/dev/null || true

# Sync config files (not wrangler.toml — FGS has its own)
for f in tsconfig.json package.json vitest.config.ts; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/$f"
  fi
done

# Sync scripts (except this one and sync-secrets which is FAS-specific)
cp "$SRC/scripts/deploy.sh" "$DEST/scripts/deploy.sh" 2>/dev/null || true
cp "$SRC/test.sh" "$DEST/test.sh" 2>/dev/null || true

echo "Verifying FGS typecheck..."
cd "$DEST" && npx tsc --noEmit

echo "Running FGS tests..."
cd "$DEST" && npx vitest run

echo ""
echo "Done. Review changes in $DEST, then push to deploy."
