#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BRIDGE_ENTRY="$REPO_ROOT/helper/codex-bridge-server.mjs"

# Use the same project-local Node for every store hosted by this bridge. Never
# fall back to PATH: a Node 24 build can still contain a vulnerable SQLite.
NODE_VERSION="$(<"$REPO_ROOT/.node-version")"
[[ "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo "[egdesk-codex-bridge] invalid Node version pin" >&2; exit 1; }
case "$(uname -s)" in Darwin) NODE_OS=darwin ;; Linux) NODE_OS=linux ;; *) echo "[egdesk-codex-bridge] unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) NODE_ARCH=arm64 ;; x86_64|amd64) NODE_ARCH=x64 ;; *) echo "[egdesk-codex-bridge] unsupported CPU" >&2; exit 1 ;; esac
NODE_RUNTIME="$REPO_ROOT/.tmp/node-runtime/node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}/bin/node"
if [[ ! -x "$NODE_RUNTIME" ]]; then
  echo "[egdesk-codex-bridge] pinned Node missing; run: node \"$SCRIPT_DIR/install-egdesk-node.mjs\"" >&2
  exit 1
fi
if ! "$NODE_RUNTIME" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { assertPatchedSqliteRuntime } = await import(pathToFileURL(process.argv[1]).href);
  const runtime = assertPatchedSqliteRuntime();
  if (runtime.nodeVersion !== process.argv[2]) throw new Error("Node version does not match the project pin");
' "$REPO_ROOT/helper/egdesk-sqlite-runtime.mjs" "$NODE_VERSION"; then
  echo "[egdesk-codex-bridge] pinned Node/SQLite runtime verification failed" >&2
  exit 1
fi

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
  "$NODE_RUNTIME" "$BRIDGE_ENTRY" &
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
