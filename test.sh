#!/bin/bash
# Integration tests for the agent worker
# Usage: ./test.sh [base_url]
#   ./test.sh                                    # test apps agent
#   ./test.sh https://agent.freegamestore.online  # test games agent
set -e

BASE="${1:-https://agent.freeappstore.online}"
SESSION="test-$(date +%s)"
PASS=0
FAIL=0

# Detect store type from URL
if echo "$BASE" | grep -q "freegamestore"; then
  STORE="games"
  SHELL_FILE="GameShell.tsx"
else
  STORE="apps"
  SHELL_FILE="Shell.tsx"
fi

ok() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL+1)); }

echo "=== Agent Worker Tests ($STORE) ==="
echo "Base: $BASE"
echo "Session: $SESSION"
echo ""

# Test 1: Health check
echo "1. Health check"
HEALTH=$(curl -sf "$BASE/health" 2>&1)
echo "$HEALTH" | grep -q '"ok":true' && ok "health returns ok" || fail "health" "$HEALTH"

# Test 2: Session status (new session)
echo "2. New session status"
STATUS=$(curl -sf "$BASE/session/$SESSION/status" 2>&1)
echo "$STATUS" | grep -q '"fileCount":15' && ok "new session has 15 template files" || fail "status" "$STATUS"
echo "$STATUS" | grep -q '"messageCount":0' && ok "new session has 0 messages" || fail "messages" "$STATUS"

# Test 3: File listing
echo "3. File listing"
FILES=$(curl -sf "$BASE/session/$SESSION/files" 2>&1)
echo "$FILES" | grep -q 'App.tsx' && ok "files include App.tsx" || fail "files" "$FILES"
echo "$FILES" | grep -q "$SHELL_FILE" && ok "files include $SHELL_FILE" || fail "files" "$FILES"
echo "$FILES" | grep -q 'package.json' && ok "files include package.json" || fail "files" "$FILES"

# Test 4: History (empty)
echo "4. History (empty)"
HIST=$(curl -sf "$BASE/session/$SESSION/history" 2>&1)
echo "$HIST" | grep -q '"messages":\[\]' && ok "history starts empty" || fail "history" "$HIST"

# Test 5: Errors (empty)
echo "5. Errors (empty)"
ERRS=$(curl -sf "$BASE/session/$SESSION/errors" 2>&1)
echo "$ERRS" | grep -q '"errors":\[\]' && ok "errors starts empty" || fail "errors" "$ERRS"

# Test 6: Chat with invalid config (should return 400)
echo "6. Chat validation"
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SESSION/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"hi"}')
[ "$BAD" = "400" ] && ok "missing aiConfig returns 400" || fail "validation" "got $BAD"

# Test 7: Chat with bad API key (should stream error)
echo "7. Chat with bad key"
CHAT=$(curl -sf -X POST "$BASE/session/$SESSION/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"hi","aiConfig":{"provider":"github","model":"openai/gpt-4o-mini","apiKey":"bad-key","temperature":0.7,"maxTokens":100}}' 2>&1 | head -5)
echo "$CHAT" | grep -q '"type":"error"' && ok "bad key returns error event" || fail "bad key" "$CHAT"

# Test 8: History has message after chat
echo "8. History after chat"
sleep 1
HIST2=$(curl -sf "$BASE/session/$SESSION/history" 2>&1)
echo "$HIST2" | grep -q '"role":"user"' && ok "history has user message" || fail "history after chat" "$HIST2"

# Test 9: Reset
echo "9. Reset"
RESET=$(curl -sf -X POST "$BASE/session/$SESSION/reset" 2>&1)
echo "$RESET" | grep -q '"ok":true' && ok "reset returns ok" || fail "reset" "$RESET"
HIST3=$(curl -sf "$BASE/session/$SESSION/history" 2>&1)
echo "$HIST3" | grep -q '"messages":\[\]' && ok "history empty after reset" || fail "reset history" "$HIST3"

# Test 10: Invalid route
echo "10. Invalid route"
NOT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SESSION/invalid")
[ "$NOT" = "404" ] && ok "invalid route returns 404" || fail "invalid route" "got $NOT"

# Test 11: Session ID too long
echo "11. Session ID validation"
LONG=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$(python3 -c 'print("a"*100)')/status")
[ "$LONG" = "404" ] && ok "long session ID rejected" || fail "long session ID" "got $LONG"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
