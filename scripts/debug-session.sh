#!/bin/bash
# Debug a VibeCode agent session.
# Usage: bash debug-session.sh <session-id>
# Or: bash debug-session.sh (reads session ID from clipboard)

BASE="https://agent.freeappstore.online"
SESSION="${1:-$(pbpaste 2>/dev/null)}"

if [ -z "$SESSION" ]; then
  echo "Usage: bash debug-session.sh <session-id>"
  exit 1
fi

echo "=== Session: $SESSION ==="
echo ""

echo "--- Status ---"
curl -sf "$BASE/session/$SESSION/status" 2>&1 | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "--- Errors ---"
curl -sf "$BASE/session/$SESSION/errors" 2>&1 | python3 -c "
import sys,json
d = json.load(sys.stdin)
errors = d.get('errors',[])
if not errors:
    print('No errors.')
else:
    for e in errors:
        print(f\"[{e['timestamp']}] {e['source']}: {e['message']}\")
" 2>/dev/null || echo "(failed)"

echo ""
echo "--- Files ---"
curl -sf "$BASE/session/$SESSION/files" 2>&1 | python3 -c "
import sys,json
d = json.load(sys.stdin)
for f in d.get('files',[]):
    print(f\"  {f['path']:45s} {f['size']:>6d} bytes\")
" 2>/dev/null || echo "(failed)"

echo ""
echo "--- History (last 10 messages) ---"
curl -sf "$BASE/session/$SESSION/history" 2>&1 | python3 -c "
import sys,json
d = json.load(sys.stdin)
msgs = d.get('messages',[])
for m in msgs[-10:]:
    role = m['role']
    content = m.get('content','')[:150]
    tools = m.get('toolCalls',[]) or []
    if tools:
        tool_names = ', '.join(t['name'] for t in tools)
        print(f\"  [{role}] {content[:80]}... tools: {tool_names}\")
    else:
        print(f\"  [{role}] {content}\")
print(f\"\n  Total: {len(msgs)} messages\")
print(f\"  Deploy: {d.get('deployStatus')}\")
print(f\"  App: {d.get('appId')} ({d.get('appName')})\")
" 2>/dev/null || echo "(failed)"
