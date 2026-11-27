#!/bin/bash
# Restart EG-Desk (bridge + Firefox) the safe way: login-flow check, Firefox quit, kill only the PIDs listening on 39218/39219, start both, wait for Marionette.
QA_DIR=$(cd "$(dirname "$0")" && pwd); D="${EGDESK_APP_DIR:-$(cd "$QA_DIR/../.." && pwd)}"; LOG="${EGDESK_BRIDGE_LOG:-${TMPDIR:-/tmp}/egdesk-codex-bridge.log}"
REAL=$(ps -axo pid=,command= | grep -E '[c]laude(\.exe)? auth login' | grep -v 'bash -c' || true); if [ -n "$REAL" ]; then echo "ABORT real login flow"; exit 1; fi
osascript -e 'tell application "Firefox" to quit' 2>/dev/null; sleep 3
BR=$(lsof -nP -t -iTCP:39218 -sTCP:LISTEN 2>/dev/null | head -1); AS=$(lsof -nP -t -iTCP:39219 -sTCP:LISTEN 2>/dev/null | head -1); for p in $BR $AS; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; sleep 2
cd "$D" && EGDESK_FIREFOX_PROFILE="${EGDESK_FIREFOX_PROFILE:?set EGDESK_FIREFOX_PROFILE to the EG-Desk Firefox profile directory}" EGDESK_CODEX_BIN="${EGDESK_CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex}" nohup scripts/run-codex-bridge.sh >> "$LOG" 2>&1 &
for i in $(seq 1 40); do sleep 1; curl -s -m 2 http://127.0.0.1:39218/v1/state >/dev/null 2>&1 && break; done
cd "$D" && (scripts/run-firefox-mcp-target.sh --automation about:blank > /tmp/egd-ff-restart.log 2>&1 &); for i in $(seq 1 40); do sleep 1; lsof -nP -iTCP:2828 -sTCP:LISTEN >/dev/null 2>&1 && break; done; sleep 5
echo "restarted $(date +%H:%M:%S) $(grep -aE 'personal flags' "$LOG" | tail -1 | grep -oE '[0-9]+ set from settings')"
