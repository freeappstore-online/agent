#!/bin/bash
# Sync all FreeAppStore secrets from Bitwarden to Cloudflare Workers.
# Prerequisites: bw CLI installed, logged in, vault unlocked (BW_SESSION set)
# Usage: BW_SESSION="..." bash sync-secrets.sh

set -e

if [ -z "$BW_SESSION" ]; then
  echo "Error: BW_SESSION not set. Run: bw unlock"
  exit 1
fi

WORKERS="freeappstore-agent freegamestore-agent freeappstore-admin freeappstore-publisher"
API_WORKER="freeappstore-api"

echo "=== FreeAppStore Secrets Sync (from Bitwarden) ==="
echo ""

# Shared secrets → Agent, Admin, Publisher
for secret in GITHUB_TOKEN CF_API_TOKEN CF_EMAIL CF_GLOBAL_KEY; do
  echo "$secret:"
  VALUE=$(bw get password "$secret" 2>/dev/null)
  if [ -z "$VALUE" ] || [ "$VALUE" = "REPLACE_FROM_DASHBOARD" ] || [ "$VALUE" = "REPLACE_FROM_GITHUB" ]; then
    echo "  SKIP (not set in Bitwarden — update it first)"
    continue
  fi
  for w in $WORKERS; do
    echo "$VALUE" | npx wrangler secret put "$secret" --name "$w" 2>&1 | grep -q "Success" && echo "  ✓ $w" || echo "  ✗ $w"
  done
done

# API-only secrets
echo ""
echo "GITHUB_CLIENT_SECRET (API only):"
GH_SECRET=$(bw get password "GITHUB_CLIENT_SECRET" 2>/dev/null)
if [ -z "$GH_SECRET" ] || [ "$GH_SECRET" = "REPLACE_FROM_GITHUB" ]; then
  echo "  SKIP (not set in Bitwarden)"
else
  echo "$GH_SECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET --name "$API_WORKER" 2>&1 | grep -q "Success" && echo "  ✓ $API_WORKER" || echo "  ✗ $API_WORKER"
fi

# Verify
echo ""
echo "=== Verification ==="
sleep 3
echo "Agent: $(curl -s https://agent.freeappstore.online/health 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("hasSecrets","?"))')"
echo "API:   $(curl -s https://api.freeappstore.online/auth/me 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print("ok" if "user" in d else "error: " + str(d))')"

echo ""
echo "Done. Secrets synced from Bitwarden → Cloudflare Workers."
