#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BRIDGE_ENTRY="$REPO_ROOT/helper/codex-bridge-server.mjs"

# Starts the bridge and starts it again when it dies unexpectedly.
# - Exit 0 is the bridge's own clean stop (SIGINT/SIGTERM shutdown, or another
#   bridge already owns :39218), so the loop ends there.
# - Any other exit waits 1s, 2s, 4s … (at most 30s, jittered) and starts it
#   again. A run of STABLE_SECONDS or longer clears the count; more than
#   MAX_RESTARTS failures in a row stops trying.
# - INT/TERM/HUP end the loop and pass TERM to the bridge this script started.
#   No other process is ever signalled.
MAX_RESTARTS="${EGDESK_BRIDGE_MAX_RESTARTS:-8}"
STABLE_SECONDS="${EGDESK_BRIDGE_STABLE_SECONDS:-60}"
[[ "$MAX_RESTARTS" =~ ^[0-9]+$ ]] || MAX_RESTARTS=8
[[ "$STABLE_SECONDS" =~ ^[0-9]+$ ]] || STABLE_SECONDS=60
MAX_DELAY_MS=30000

child=""
stopping=0
on_stop() {
  stopping=1
  if [[ -n "$child" ]]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap on_stop INT TERM HUP

log() { echo "[egdesk-codex-bridge] supervisor: $*" >&2; }

failures=0
while :; do
  started=$SECONDS
  node "$BRIDGE_ENTRY" &
  child=$!
  status=0
  wait "$child" || status=$?
  # A trapped signal interrupts wait; keep waiting for the bridge's own exit.
  while kill -0 "$child" 2>/dev/null; do
    status=0
    wait "$child" || status=$?
  done
  child=""
  if (( stopping )); then exit "$status"; fi
  if (( status == 0 )); then exit 0; fi

  if (( SECONDS - started >= STABLE_SECONDS )); then failures=0; fi
  failures=$((failures + 1))
  if (( failures > MAX_RESTARTS )); then
    log "bridge exited with status $status; stopped after $MAX_RESTARTS restarts in a row"
    exit "$status"
  fi
  shift_by=$((failures - 1))
  if (( shift_by > 15 )); then shift_by=15; fi
  delay_ms=$((1000 << shift_by))
  if (( delay_ms > MAX_DELAY_MS )); then delay_ms=$MAX_DELAY_MS; fi
  delay_ms=$((delay_ms - delay_ms * (RANDOM % 21) / 100))
  log "bridge exited with status $status; restart $failures/$MAX_RESTARTS in ${delay_ms}ms"

  # Sleep in the background so a stop request is handled at once.
  sleep "$((delay_ms / 1000)).$(printf '%03d' $((delay_ms % 1000)))" &
  child=$!
  wait "$child" || true
  child=""
  if (( stopping )); then exit 0; fi
done
